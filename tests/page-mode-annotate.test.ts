// @vitest-environment jsdom
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PAGE_MODE_PROBE, probeCall } from '../src/main/browser/page-mode-probe';
import { composeAnnotations, parseProbeAnnotations, parseProbeBatch } from '../src/shared/page-mode-format';
import type { BrowserTab, PageModeEvent } from '../src/shared/types';
import { dispatchTrusted } from './trusted-event';

vi.mock('electron', () => ({ clipboard: { writeText: vi.fn(), write: vi.fn() }, ClipboardItem: class {} }));
const { PageModeController } = await import('../src/main/browser/page-mode');

interface Bridge {
  arm(kind: string, armId: string): boolean;
  disarm(armId?: string): boolean;
  wait(armId: string, ms: number): Promise<unknown>;
  beforeShot(): Promise<{ viewport: { w: number; h: number }; extra: unknown }>;
  afterShot(): boolean;
  kinds(): string[];
}
const run = (code: string): unknown => (0, eval)(code);
const bridge = () => (window as unknown as { __HELLO_PAGE_MODE__?: Bridge }).__HELLO_PAGE_MODE__!;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// The marker layer is a closed shadow root; the test keeps a handle the page never gets.
const roots: ShadowRoot[] = [];
beforeAll(() => {
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const root = attach.call(this, init);
    roots.push(root);
    return root;
  };
});
const markerRoot = () => roots.find(root => (root.host as HTMLElement).hasAttribute('data-hello-annotations'))!;
const click = (target: EventTarget, x: number, y: number) =>
  dispatchTrusted(target, new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y }));

describe('annotate probe', () => {
  afterEach(() => {
    (window as unknown as { __HELLO_PAGE_MODE__?: Bridge }).__HELLO_PAGE_MODE__?.disarm();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('drops numbered markers, keeps notes with words, and reports them for the picture', async () => {
    run(PAGE_MODE_PROBE);
    expect(bridge().kinds()).toEqual(['design', 'annotate']);
    document.body.innerHTML = '<main><button class="cta">Buy</button><p>text</p></main>';
    const button = document.querySelector('button')!;
    let pageSawClick = false;
    button.addEventListener('click', () => { pageSawClick = true; });
    expect(bridge().arm('annotate', 'ann-1')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('cursor')).toBe('crosshair');

    click(button, 40, 200);
    expect(pageSawClick).toBe(false);
    const root = markerRoot();
    const input = () => root.querySelector<HTMLInputElement>('.mark:last-child input')!;
    expect(input().placeholder).toBe('#1 what is wrong or wanted here');
    input().value = '  Too   dim ';
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(root.querySelector('.mark input')).toBeNull();

    const batch = parseProbeBatch(await bridge().wait('ann-1', 50));
    const marks = batch?.events.find(event => event.type === 'marks');
    expect(marks).toMatchObject({ type: 'marks', count: 1, mark: { n: 1 } });
    const token = (marks as { mark: { token: string } }).mark.token;
    expect(button.getAttribute('data-hello-pick')).toBe(token);

    // A note left empty is dropped by the click away; its number is not reused.
    click(document.querySelector('p')!, 60, 300);
    click(document.querySelector('p')!, 70, 310);
    expect(root.querySelectorAll('.mark')).toHaveLength(1);
    click(document.querySelector('p')!, 80, 320);
    expect(input().placeholder).toBe('#3 what is wrong or wanted here');

    // The component main read from the page world becomes the marker's `at`.
    expect(run(probeCall('call', ['annotate', 'setAt', ['ann-1', 1, 'Card › Button', 'src/Button.tsx:4']]))).toBe(true);
    expect(run(probeCall('call', ['design', 'setAt', ['ann-1', 1, 'X', null]]))).toBeNull();

    // A pin is in the picture only when it has a box on screen.
    const pinBox = { left: 40, top: 176, right: 64, bottom: 200, width: 24, height: 24 } as DOMRect;
    const measure = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this.classList.contains('pin') ? pinBox : { left: 40, top: 200, right: 40, bottom: 200, width: 0, height: 0 } as DOMRect;
    });
    const shot = await bridge().beforeShot();
    measure.mockRestore();
    const pending = root.querySelector<HTMLElement>('.mark:last-child')!;
    expect(pending.style.opacity).toBe('0');
    expect(shot.extra).toEqual({ marks: [{ n: 1, color: 'yellow', text: 'Too dim', at: 'Card › Button <button> (src/Button.tsx:4)', inView: true }] });
    bridge().afterShot();
    expect(pending.style.opacity).toBe('');

    // Clicking a pin removes that marker.
    const pin = root.querySelector<HTMLElement>('.mark .pin')!;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return (this === pin ? { left: 100, top: 100, right: 124, bottom: 124, width: 24, height: 24 } : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
    });
    click(pin, 110, 110);
    expect(root.querySelectorAll('.mark')).toHaveLength(1);
    const removed = parseProbeBatch(await bridge().wait('ann-1', 50));
    expect(removed?.events.at(-1)).toEqual({ type: 'marks', count: 0 });
  });

  it('reports a marker scrolled out of the viewport, and forgets everything on disarm', async () => {
    run(PAGE_MODE_PROBE);
    document.body.innerHTML = '<div id="zone">zone</div>';
    bridge().arm('annotate', 'ann-2');
    click(document.getElementById('zone')!, 30, 30);
    const root = markerRoot();
    const input = root.querySelector<HTMLInputElement>('input')!;
    input.value = 'Move this';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    click(document.getElementById('zone')!, 50, 50);
    root.querySelector<HTMLInputElement>('input')!.value = 'typed, then Send';

    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 30, top: -400, right: 54, bottom: -376, width: 24, height: 24 } as DOMRect);
    const shot = await bridge().beforeShot();
    bridge().afterShot();
    // Send/Copy commits a note that has words: it goes with the picture.
    expect(shot.extra).toEqual({ marks: [
      expect.objectContaining({ n: 1, text: 'Move this', inView: false }),
      expect.objectContaining({ n: 2, text: 'typed, then Send', inView: false }),
    ] });
    expect(root.querySelector('input')).toBeNull();

    // Escape reaches main, which disarms: the note being typed goes, and so does every marker.
    expect(bridge().disarm('ann-2')).toBe(true);
    expect(document.querySelector('[data-hello-annotations]')).toBeNull();
    expect(document.querySelector('[data-hello-pick]')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('cursor')).toBe('');
    bridge().arm('annotate', 'ann-3');
    click(document.getElementById('zone')!, 30, 30);
    expect(markerRoot().querySelectorAll('.mark')).toHaveLength(1);
    expect(markerRoot().querySelector<HTMLInputElement>('input')!.placeholder).toBe('#1 what is wrong or wanted here');
  });
});

describe('annotate format', () => {
  it('checks the marks event and the markers a page reports', () => {
    expect(parseProbeBatch({ armId: 'a', events: [
      { type: 'marks', count: 2, mark: { n: 2, token: 'abc123' } },
      { type: 'marks', count: 1, mark: { n: 1, token: '"]; x' } },
      { type: 'marks', count: -1 },
      { type: 'marks', count: 'many' },
    ] })?.events).toEqual([
      { type: 'marks', count: 2, mark: { n: 2, token: 'abc123' } },
      { type: 'marks', count: 1 },
    ]);

    const shot = parseProbeAnnotations({ url: 'https://evil.test', marks: [
      { n: 1, color: 'yellow', text: ' Too dim ', at: 'main > p', inView: true },
      { n: 1, color: 'blue', text: 'duplicate number' },
      { n: 3, color: 'red; background:url(x)', text: 'x'.repeat(5000), inView: false },
      { n: 4, color: 'green', text: '   ' },
      { n: 0, text: 'zero' },
    ] }, 'https://example.test/app');
    expect(shot?.url).toBe('https://example.test/app');
    expect(shot?.marks).toHaveLength(2);
    expect(shot?.marks[0]).toEqual({ n: 1, color: 'yellow', text: 'Too dim', at: 'main > p', inView: true });
    expect(shot?.marks[1]).toMatchObject({ n: 3, color: 'marker', inView: false });
    expect(shot?.marks[1].text).toHaveLength(1000);
    expect(parseProbeAnnotations(null, 'u')).toBeNull();
    expect(parseProbeAnnotations({ marks: 'nope' }, 'u')).toBeNull();

    expect(composeAnnotations({ url: 'https://example.test/app', marks: [
      { n: 3, color: 'green', text: 'Off screen', inView: false },
      { n: 1, color: 'yellow', text: 'Too dim', at: 'Card › Button <button>' },
    ] }, null)).toBe([
      '⟦Hello-annotations⟧ 2 markers on https://example.test/app',
      '#1 yellow — Too dim · at Card › Button <button>',
      '#3 green — Off screen · outside the picture',
    ].join('\n'));
  });
});

describe('annotate in the controller', () => {
  class Contents extends EventEmitter {
    waits: Array<(value: unknown) => void> = [];
    calls: string[] = [];
    extra: unknown = null;
    isDestroyed = () => false;
    isLoading = () => false;
    isLoadingMainFrame = () => false;
    getURL = () => 'https://example.test/app#main';
    mainFrame = { executeJavaScript: vi.fn(async () => ({ component: 'Card › Button', file: 'src/Button.tsx:3' })) };
    capturePage = vi.fn(async () => ({ isEmpty: () => false, getSize: () => ({ width: 800, height: 600 }), toPNG: () => Buffer.from('png') }));
    executeJavaScriptInIsolatedWorld = vi.fn(async (_world: number, [{ code }]: Array<{ code: string }>) => {
      this.calls.push(code);
      if (code.includes('.arm(')) return true;
      if (code.includes('.wait(')) return new Promise(resolve => this.waits.push(resolve));
      if (code.includes('.beforeShot(')) return { viewport: { w: 800, h: 600 }, extra: this.extra };
      return true;
    });
  }
  let dataDir = '';
  afterEach(() => { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); });

  const setup = (kinds?: Array<'design' | 'annotate'>) => {
    dataDir = mkdtempSync(join(tmpdir(), 'hello-annotate-'));
    const tab: BrowserTab = { id: 'tab-1', conversationId: 'chat-1', title: 'App', url: 'https://example.test/app', control: 'read', loading: false, progress: null, canGoBack: false, canGoForward: false };
    const contents = new Contents();
    const events: PageModeEvent[] = [];
    const controller = new PageModeController({
      dataDir, kinds, emit: event => events.push(event),
      pages: { pageFor: id => id === tab.id ? { tab, contents: contents as never } : undefined, observePages: () => () => {} },
    });
    return { contents, events, controller };
  };

  it('arms only when its kind is enabled, relays marker counts and hands the component back to the page', async () => {
    const off = setup();
    await expect(off.controller.arm('tab-1', 'annotate')).rejects.toThrow('Annotate is not available yet.');
    off.controller.dispose();

    const { contents, events, controller } = setup(['design', 'annotate']);
    const { armId } = await controller.arm('tab-1', 'annotate');
    await tick();
    contents.waits.shift()!({ armId, events: [{ type: 'marks', count: 1, mark: { n: 1, token: 'tok9' } }] });
    for (let i = 0; i < 5; i++) await tick();
    expect(events).toContainEqual({ type: 'marks', tabId: 'tab-1', armId, count: 1 });
    expect(contents.mainFrame.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(contents.calls.some(code => code.includes(`.call("annotate","setAt",[${JSON.stringify(armId)},1,"Card › Button","src/Button.tsx:3"])`))).toBe(true);

    contents.extra = { marks: [{ n: 1, color: 'yellow', text: 'Too dim', inView: true }] };
    const captured = await controller.capture('tab-1');
    expect(captured.annotations).toEqual({ url: 'https://example.test/app#main', marks: [{ n: 1, color: 'yellow', text: 'Too dim', inView: true }] });

    await controller.arm('tab-1', 'design');
    expect((await controller.capture('tab-1')).annotations).toBeUndefined();
    controller.dispose();
  });
});
