// Unclutter end to end in main: the real page script in a JSDOM page standing
// in for the guest's isolated world, the real SQLite store, OpenJev faked.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTab } from '../src/shared/types';
import type { UnclutterTabState } from '../src/shared/unclutter';
import type { BrowserPageEvent } from '../src/main/browser/manager';
import { createDataStore, type DataStore } from '../src/main/data/store';
import { UnclutterService, eligible } from '../src/main/unclutter/service';
import { UNCLUTTER_WORLD_ID } from '../src/main/unclutter/page';

const codec = { encrypt: (text: string) => Buffer.from(text), decrypt: (bytes: Buffer) => bytes.toString() };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const step of cleanup.splice(0)) step(); });

const tab = (over: Partial<BrowserTab> = {}): BrowserTab => ({
  id: 't1', conversationId: 'c1', title: '', url: 'https://news.example/news/articles/a1', control: 'off', loading: false, progress: null, canGoBack: false, canGoForward: false, ...over,
});
const ADS = Array.from({ length: 8 }, (_, index) => `<div class="ad-slot${index}x">Advertisement</div>`).join('');
const HTML = `<meta property="og:type" content="article"><main data-testid="story"><article><h1>Story</h1><p>Editorial content stays.</p></article></main>${ADS}<div class="cookie-banner">Accept all cookies</div>`;

function setup(html = HTML, over: Partial<BrowserTab> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hello-unclutter-'));
  const store: DataStore = createDataStore(dir, codec);
  const dom = new JSDOM(html, { url: over.url ?? tab().url, runScripts: 'outside-only' });
  cleanup.push(() => { dom.window.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const worlds: number[] = [];
  const contents = { executeJavaScriptInIsolatedWorld: vi.fn(async (world: number, [{ code }]: Array<{ code: string }>) => { worlds.push(world); return JSON.parse(JSON.stringify(dom.window.eval(code))); }) };
  let current = tab(over);
  let observer: (event: BrowserPageEvent) => void = () => {};
  const pages = {
    pageFor: (id: string) => (id === current.id ? { tab: current, contents: contents as never } : undefined),
    observePages: (listener: (event: BrowserPageEvent) => void) => { observer = listener; return () => {}; },
  };
  const asked: unknown[] = [];
  const answer = vi.fn((body: { questions: Record<string, unknown> }) => ({
    answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'choice', choice: 'ad', probabilities: { ad: 0.97 }, confidence: 0.95 }])),
  }));
  const openjev = {
    status: vi.fn(async () => ({ state: 'ready' as const, detail: 'OpenJev answers', ownHelper: false })),
    ask: vi.fn(async (body: unknown) => { asked.push(body); return answer(body as never); }),
    stop: vi.fn(() => false),
    dispose: vi.fn(),
  };
  const emitted: UnclutterTabState[] = [];
  const service = new UnclutterService({ pages, store, openjev, emit: state => emitted.push(state), settleMs: 1, autoMs: 1 });
  cleanup.unshift(() => service.dispose());
  return { service, store, dom, contents, openjev, asked, answer, emitted, worlds, setTab: (next: Partial<BrowserTab>) => { current = { ...current, ...next }; }, fire: (event: BrowserPageEvent) => observer(event) };
}
const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

describe('Unclutter eligibility', () => {
  it('cleans web pages only: never a generated document, a previewed file or a local server', () => {
    expect(eligible(tab())).toBe(true);
    expect(eligible(tab({ pageOwned: true, openerId: 't0' }))).toBe(true);
    expect(eligible(tab({ source: 'artifact:a1' }))).toBe(false);
    expect(eligible(tab({ partition: 'hello-preview-x' }))).toBe(false);
    expect(eligible(tab({ error: 'failed' }))).toBe(false);
    for (const url of ['http://localhost:5173/', 'http://127.0.0.1:3000/', 'http://app.localhost/', 'https://site.test/', 'about:blank', 'file:///tmp/a.html'])
      expect(eligible(tab({ url }))).toBe(false);
  });
});

describe('Unclutter service', () => {
  it('analyses a page type in batches, saves its rules and hides them on the page', async () => {
    const { service, asked, dom, store, emitted, worlds } = setup();
    await service.sync('t1');
    expect(service.tabState('t1')).toMatchObject({ eligible: true, hidden: 0, profile: null });
    const state = await service.analyze('t1');
    // Nine candidates: two requests, each state holding only its own batch.
    expect(asked).toHaveLength(2);
    expect((asked as Array<{ state: { elements: unknown[] } }>).map(body => body.state.elements.length)).toEqual([6, 3]);
    expect(JSON.stringify(asked)).not.toContain('news.example');
    expect(state.profile).toMatchObject({ enabled: true, rules: 9, categories: { ad: 9 } });
    expect(state.hidden).toBe(9);
    expect((dom.window.document.querySelector('.ad-slot0x') as HTMLElement).style.display).toBe('none');
    expect((dom.window.document.querySelector('article') as HTMLElement).style.display).toBe('');
    expect(emitted.some(item => item.analyzing?.total === 2 && item.analyzing.done === 1)).toBe(true);
    expect(new Set(worlds)).toEqual(new Set([UNCLUTTER_WORLD_ID]));
    // Another article of the same site shares the rules.
    const key = String((dom.window.eval('window.__HELLO_UNCLUTTER__.context()') as { key: string }).key);
    expect(store.getUnclutterProfile(key)).toMatchObject({ key, origin: 'https://news.example' });
  });

  it('keeps nothing OpenJev is not sure of', async () => {
    const { service, answer } = setup();
    answer.mockImplementation(body => ({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'choice', choice: 'ad', probabilities: { ad: 0.6 }, confidence: 0.6 }])) }));
    await service.sync('t1');
    const state = await service.analyze('t1');
    expect(state.profile).toMatchObject({ rules: 0 });
    expect(state.hidden).toBe(0);
  });

  it('keeps the rules it had when an answer is incomplete, and says why', async () => {
    const { service, answer } = setup();
    await service.sync('t1');
    await service.analyze('t1');
    answer.mockImplementation(() => ({ answers: {} }));
    await expect(service.analyze('t1')).rejects.toThrow(/incomplete/);
    expect(service.tabState('t1')).toMatchObject({ hidden: 9, profile: { rules: 9 }, error: expect.stringMatching(/incomplete/) });
  });

  it('runs one analysis at a time', async () => {
    const { service, openjev } = setup();
    await service.sync('t1');
    let release: () => void = () => {};
    openjev.ask.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ answers: {} }); }));
    const first = service.analyze('t1');
    await wait();
    await expect(service.analyze('t1')).rejects.toThrow(/already being analysed/);
    release();
    await expect(first).rejects.toThrow();
  });

  it('switches: a page type off, Unclutter off, a page type forgotten — each shows its blocks again', async () => {
    const { service, dom } = setup();
    const ad = () => (dom.window.document.querySelector('.ad-slot0x') as HTMLElement).style.display;
    await service.sync('t1');
    await service.analyze('t1');
    expect(ad()).toBe('none');
    service.setTypeEnabled('t1', false);
    await wait();
    expect(ad()).toBe('');
    expect(service.tabState('t1').profile?.enabled).toBe(false);
    // A new analysis does not overrule the person's off.
    expect((await service.analyze('t1')).profile?.enabled).toBe(false);
    service.setTypeEnabled('t1', true);
    await wait();
    expect(ad()).toBe('none');
    expect(service.setSwitches({ enabled: false })).toEqual({ enabled: false, auto: false });
    await wait();
    expect(ad()).toBe('');
    await expect(service.analyze('t1')).rejects.toThrow(/off/);
    service.setSwitches({ enabled: true });
    await wait();
    expect(ad()).toBe('none');
    service.forgetType('t1');
    await wait();
    expect(ad()).toBe('');
    expect(service.tabState('t1').profile).toBeNull();
  });

  it('refuses and leaves alone a page that is not a web page', async () => {
    const { service, contents, openjev } = setup(HTML, { url: 'http://localhost:5173/news/articles/a1' });
    await service.sync('t1');
    expect(contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    await expect(service.analyze('t1')).rejects.toThrow(/web pages only/);
    expect(openjev.ask).not.toHaveBeenCalled();
  });

  it('with Auto on, analyses a new page type of the tab on screen, once', async () => {
    const { service, openjev, fire } = setup();
    service.setSwitches({ auto: true });
    fire({ type: 'active', id: 't1' });
    await wait(60);
    expect(openjev.ask).toHaveBeenCalledTimes(2);
    expect(service.tabState('t1').profile?.rules).toBe(9);
    service.forgetType('t1');
    await wait(60);
    expect(openjev.ask).toHaveBeenCalledTimes(2);
  });

  it('does not analyse unasked with Auto off, or a tab that is not on screen', async () => {
    const { service, openjev, fire } = setup();
    fire({ type: 'updated', tab: tab() });
    await wait(40);
    expect(openjev.ask).not.toHaveBeenCalled();
    service.setSwitches({ auto: true });
    fire({ type: 'updated', tab: tab() });
    await wait(40);
    expect(openjev.ask).not.toHaveBeenCalled();
  });
});
