import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTab, PageModeEvent } from '../src/shared/types';
import type { BrowserPageEvent } from '../src/main/browser/manager';

const native = vi.hoisted(() => ({ written: [] as unknown[] }));
vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn(async () => {}), write: vi.fn(async (items: unknown[]) => { native.written.push(...items); }) },
  ClipboardItem: class { constructor(readonly items: Record<string, unknown>) {} },
}));

const { PageModeController } = await import('../src/main/browser/page-mode');

class Image {
  constructor(readonly width: number, readonly height: number, readonly box?: { x: number; y: number; width: number; height: number }) {}
  isEmpty = () => this.width === 0;
  getSize = () => ({ width: this.width, height: this.height });
  crop = (box: { x: number; y: number; width: number; height: number }) => new Image(box.width, box.height, box);
  resize = ({ width }: { width: number }) => new Image(width, Math.round(this.height * width / this.width));
  toPNG = () => Buffer.from(JSON.stringify({ w: this.width, h: this.height, box: this.box ?? null }));
}

/** A guest page whose isolated world is scripted by the test. */
class Contents extends EventEmitter {
  destroyed = false;
  loading = false;
  url = 'https://example.test/app';
  waits: Array<(value: unknown) => void> = [];
  calls: string[] = [];
  armResult: unknown = true;
  isDestroyed = () => this.destroyed;
  isLoading = () => this.loading;
  getURL = () => this.url;
  mainFrame = { executeJavaScript: vi.fn(async () => ({ component: 'Card › Button', file: 'src/Button.tsx:3' })) };
  capturePage = vi.fn(async () => new Image(1600, 1200));
  executeJavaScriptInIsolatedWorld = vi.fn(async (_world: number, [{ code }]: Array<{ code: string }>) => {
    this.calls.push(code);
    if (code.includes('.arm(')) return this.armResult;
    if (code.includes('.wait(')) return new Promise(resolve => this.waits.push(resolve));
    if (code.includes('.beforeShot(')) return { viewport: { w: 800, h: 600 } };
    return true;
  });
  /** Answers the controller's pending long poll. */
  answer(armId: string, events: unknown[]): void {
    const next = this.waits.shift();
    if (!next) throw new Error('No wait pending.');
    next({ armId, events });
  }
}

/** A bridge call as main sends it — not the probe install, which mentions every method. */
const bridgeCall = (method: string) => `(window.__HELLO_PAGE_MODE__?window.__HELLO_PAGE_MODE__.${method}(`;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

describe('PageModeController', () => {
  let dataDir: string;
  let tab: BrowserTab;
  let contents: Contents | undefined;
  let observers: Array<(event: BrowserPageEvent) => void>;
  let events: PageModeEvent[];
  let controller: InstanceType<typeof PageModeController>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'hello-page-mode-'));
    tab = { id: 'tab-1', conversationId: 'chat-1', title: 'App', url: 'https://example.test/app', control: 'read', loading: false, progress: null, canGoBack: false, canGoForward: false };
    contents = new Contents();
    observers = [];
    events = [];
    native.written = [];
    controller = new PageModeController({
      dataDir,
      emit: event => events.push(event),
      pages: {
        pageFor: id => id === tab.id ? { tab: { ...tab }, ...(contents ? { contents: contents as never } : {}) } : undefined,
        observePages: listener => { observers.push(listener); return () => { observers = observers.filter(item => item !== listener); }; },
      },
    });
  });
  afterEach(() => {
    controller.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const notify = (event: BrowserPageEvent) => { for (const listener of observers) listener(event); };

  it('needs Read, a loaded page, and a kind the page implements', async () => {
    tab.control = 'off';
    await expect(controller.arm('tab-1', 'design')).rejects.toThrow('Allow Read on this tab to use Design.');
    tab.control = 'read';
    contents!.loading = true;
    await expect(controller.arm('tab-1', 'design')).rejects.toThrow('Wait for this page to finish loading.');
    contents!.loading = false;
    await expect(controller.arm('tab-1', 'annotate')).rejects.toThrow('Annotate is not available yet.');
    await expect(controller.arm('tab-2', 'design')).rejects.toThrow('This browser tab is closed.');
    contents!.armResult = false;
    await expect(controller.arm('tab-1', 'design')).rejects.toThrow('could not enter Design mode');
    expect(controller.armed('tab-1')).toBeNull();
  });

  it('turns a pick into a reference, with the address main knows', async () => {
    const { armId } = await controller.arm('tab-1', 'design');
    expect(contents!.executeJavaScriptInIsolatedWorld.mock.calls[0][0]).toBe(1207);
    await settle();
    contents!.url = 'https://example.test/app#now';
    contents!.answer(armId, [
      { type: 'hover', rect: { x: 1, y: 2, w: 3, h: 4 } },
      { type: 'pick', token: 'tok1', tag: 'button', selector: '#go', text: 'Go', styles: 'font 13px/500', dom: 'div > button#go', url: 'https://evil.test/',
        rect: { x: 10, y: 20, w: 100, h: 30 }, point: { x: 15, y: 25 }, viewport: { w: 800, h: 600 } },
    ]);
    await settle();
    expect(events[0]).toEqual({ type: 'hover', tabId: 'tab-1', armId, rect: { x: 1, y: 2, w: 3, h: 4 } });
    const picked = events[1];
    expect(picked.type).toBe('picked');
    if (picked.type !== 'picked') return;
    expect(picked.point).toEqual({ x: 15, y: 25 });
    expect(picked.pick).toMatchObject({ kind: 'design', armId, tabId: 'tab-1', url: 'https://example.test/app#now', selector: '#go', tag: 'button', viewport: { w: 800, h: 600 } });
    expect(picked.pick.ref).toContain('⟦Hello-ref⟧ Card › Button <button>');
    expect(picked.pick.ref).toContain('file: src/Button.tsx:3');
    expect(picked.pick.ref).toContain('page: https://example.test/app#now');
    expect(picked.pick.ref).not.toContain('evil.test');
    expect(contents!.mainFrame.executeJavaScript).toHaveBeenCalledTimes(1);
    // The controller keeps listening.
    expect(contents!.waits).toHaveLength(1);
  });

  it('ends on a lowered grant, a new document, Escape, hide and close — each with its reason', async () => {
    const reasons: string[] = [];
    const armAgain = async () => (await controller.arm('tab-1', 'design')).armId;
    const lastExit = () => { const exit = events.filter(event => event.type === 'exit').at(-1); return exit?.type === 'exit' ? exit.reason : null; };

    await armAgain();
    tab.control = 'off';
    notify({ type: 'updated', tab: { ...tab } });
    reasons.push(lastExit()!);
    tab.control = 'full';

    await armAgain();
    contents!.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(controller.armed('tab-1')).not.toBeNull();
    contents!.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    expect(controller.armed('tab-1')).not.toBeNull();
    contents!.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    reasons.push(lastExit()!);

    await armAgain();
    const escape = { preventDefault: vi.fn() };
    contents!.emit('before-input-event', escape, { type: 'keyUp', key: 'Escape' });
    expect(escape.preventDefault).not.toHaveBeenCalled();
    contents!.emit('before-input-event', escape, { type: 'keyDown', key: 'Escape' });
    expect(escape.preventDefault).toHaveBeenCalled();
    reasons.push(lastExit()!);

    await armAgain();
    notify({ type: 'active', id: 'tab-1' });
    expect(controller.armed('tab-1')).not.toBeNull();
    notify({ type: 'active', id: 'other' });
    reasons.push(lastExit()!);

    await armAgain();
    notify({ type: 'detached', id: 'tab-1' });
    reasons.push(lastExit()!);

    await armAgain();
    notify({ type: 'closed', id: 'tab-1' });
    reasons.push(lastExit()!);

    expect(reasons).toEqual(['revoked', 'navigated', 'escape', 'hidden', 'hidden', 'closed']);
    // Every ending gave a page that is still there its clicks back.
    expect(contents!.calls.filter(code => code.startsWith(bridgeCall('disarm'))).length).toBe(6);
    // After an exit, the page's own Escape is the page's again.
    expect(contents!.listenerCount('before-input-event')).toBe(0);
  });

  it('a window-asked disarm and a replaced arming end quietly, and only their own', async () => {
    const first = (await controller.arm('tab-1', 'design')).armId;
    const second = (await controller.arm('tab-1', 'design')).armId;
    controller.disarm('tab-1', first);
    expect(controller.armed('tab-1')?.armId).toBe(second);
    controller.disarm('tab-1');
    expect(controller.armed('tab-1')).toBeNull();
    expect(events.filter(event => event.type === 'exit')).toEqual([]);
  });

  it('captures the element from the viewport picture, without its own overlay, under app data', async () => {
    const { armId } = await controller.arm('tab-1', 'design');
    const hooks = { beforeCapture: vi.fn(), afterCapture: vi.fn() };
    controller.defineKind('design', hooks);
    const { path } = await controller.capture('tab-1', { x: 10, y: 20, w: 100, h: 50 });
    expect(path.startsWith(join(dataDir, 'page-captures', 'chat-1'))).toBe(true);
    // 1600×1200 picture of an 800×600 viewport: everything doubles.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ w: 200, h: 100, box: { x: 20, y: 40, width: 200, height: 100 } });
    const order = contents!.calls.filter(code => code.startsWith(bridgeCall('beforeShot')) || code.startsWith(bridgeCall('afterShot'))).map(code => code.includes('beforeShot') ? 'before' : 'after');
    expect(order).toEqual(['before', 'after']);
    expect(hooks.beforeCapture).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab-1', armId, kind: 'design' }));
    expect(hooks.afterCapture).toHaveBeenCalled();

    await expect(controller.capture('tab-1', { x: 0, y: 900, w: 10, h: 10 })).rejects.toThrow('outside the visible page');
    await expect(controller.capture('tab-1', { x: 0, y: 0, w: 0, h: 10 })).rejects.toThrow('Invalid capture area.');
    tab.control = 'off';
    await expect(controller.capture('tab-1')).rejects.toThrow('Allow Read on this tab to capture it.');
    tab.control = 'read';
    contents = undefined;
    await expect(controller.capture('tab-1')).rejects.toThrow('not open in the app window');
  });

  it('copies only its own captures, and forgets a deleted chat', async () => {
    const { path } = await controller.capture('tab-1');
    await controller.copy('note', path);
    expect(native.written).toHaveLength(1);
    await expect(controller.copy('note', '/etc/passwd')).rejects.toThrow('Only a page capture can be copied.');
    await expect(controller.copy('note', join(dataDir, 'page-captures', '..', 'hello.db'))).rejects.toThrow('Only a page capture can be copied.');
    await controller.removeConversation('chat-1');
    expect(existsSync(path)).toBe(false);
  });
});
