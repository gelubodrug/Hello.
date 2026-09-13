// Design mode, main process: the grant, the armId and the other mode, checked
// where they are enforced — PageModeController, alone and wired to a real
// BrowserManager (Electron itself is faked, as in browser-manager.test.ts).
import { EventEmitter as Emitter, type EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { BrowserTab, PageModeEvent } from '../src/shared/types';
import type { BrowserPageEvent } from '../src/main/browser/manager';

const native = vi.hoisted(() => ({
  guests: [] as unknown[],
  host: null as unknown,
  makeGuest: null as unknown as (session: unknown) => unknown,
  partition: null as unknown,
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const makePartition = () => Object.assign(new EventEmitter(), {
    setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(),
    clearStorageData: vi.fn().mockResolvedValue(undefined), clearCache: vi.fn().mockResolvedValue(undefined),
  });
  const partition = makePartition();
  const partitions = new Map<string, unknown>();
  native.partition = partition;
  class Contents extends EventEmitter {
    constructor(readonly session: unknown = native.partition) { super(); }
    destroyed = false;
    loading = false;
    url = 'about:blank';
    title = 'Page';
    navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() };
    mainFrame = { executeJavaScript: vi.fn(async () => null), isDestroyed: () => this.destroyed };
    executeJavaScript = vi.fn();
    setWindowOpenHandler = vi.fn();
    isDestroyed = () => this.destroyed;
    isLoading = () => this.loading;
    getURL = () => this.url;
    getTitle = () => this.title;
    loadURL = vi.fn(async (url: string) => { this.url = url; });
    stop = vi.fn();
    reload = vi.fn();
    // Electron reports `destroyed` after close() returns, not inside it.
    close = vi.fn(() => { this.destroyed = true; queueMicrotask(() => this.emit('destroyed')); });
    getType = () => 'webview';
    hostWebContents: unknown = native.host;
    /** The page-mode probe, answered the way an armed page answers. */
    isolated: string[] = [];
    waits: Array<(value: unknown) => void> = [];
    executeJavaScriptInIsolatedWorld = vi.fn(async (_world: number, [{ code }]: Array<{ code: string }>) => {
      this.isolated.push(code);
      if (code.includes('.wait(')) return new Promise(resolve => this.waits.push(resolve));
      return true;
    });
  }
  native.makeGuest = (session: unknown) => new Contents(session);
  return {
    BrowserWindow: class {},
    WebContentsView: class {},
    clipboard: { writeText: vi.fn(), write: vi.fn() },
    ClipboardItem: class {},
    session: { fromPartition: (name: string) => {
      if (name === 'persist:hello-web') return partition;
      if (!partitions.has(name)) partitions.set(name, makePartition());
      return partitions.get(name);
    } },
  };
});

const { BrowserManager } = await import('../src/main/browser/manager');
const { PageModeController } = await import('../src/main/browser/page-mode');

const bridgeCall = (method: string) => `(window.__HELLO_PAGE_MODE__?window.__HELLO_PAGE_MODE__.${method}(`;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

type Guest = EventEmitter & {
  url: string; loading: boolean; destroyed: boolean; isolated: string[]; waits: Array<(value: unknown) => void>;
  mainFrame: { executeJavaScript: ReturnType<typeof vi.fn> };
  executeJavaScriptInIsolatedWorld: ReturnType<typeof vi.fn>;
  capturePage?: unknown;
};

class Image {
  constructor(readonly width: number, readonly height: number) {}
  isEmpty = () => this.width === 0;
  getSize = () => ({ width: this.width, height: this.height });
  crop = (box: { width: number; height: number }) => new Image(box.width, box.height);
  resize = ({ width }: { width: number }) => new Image(width, this.height);
  toPNG = () => Buffer.from('png');
}

const pick = (overrides: Record<string, unknown> = {}) => ({
  type: 'pick', token: 'tok1', tag: 'button', selector: '#go', text: 'Go', styles: 'font 13px/500', dom: 'main > button#go',
  url: 'https://page-says.test/', rect: { x: 10, y: 20, w: 100, h: 30 }, point: { x: 12, y: 22 }, viewport: { w: 800, h: 600 },
  ...overrides,
});

// ── The controller on its own: a scripted page and a tab the test owns ─────────

describe('Design mode — controller gating', () => {
  let dataDir: string;
  let tab: BrowserTab;
  let guest: Guest;
  let observers: Array<(event: BrowserPageEvent) => void>;
  let events: PageModeEvent[];
  let controller: InstanceType<typeof PageModeController>;
  const notify = (event: BrowserPageEvent) => { for (const listener of observers) listener(event); };
  const calls = (method: string) => guest.isolated.filter(code => code.startsWith(bridgeCall(method)));
  const answer = (armId: string, list: unknown[]) => { const next = guest.waits.shift(); if (!next) throw new Error('No wait pending.'); next({ armId, events: list }); };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'hello-design-'));
    tab = { id: 'tab-1', conversationId: 'chat-1', title: 'App', url: 'https://example.test/app', control: 'read', loading: false, canGoBack: false, canGoForward: false };
    guest = native.makeGuest(native.partition) as Guest;
    guest.url = tab.url;
    guest.capturePage = vi.fn(async () => new Image(1600, 1200));
    guest.executeJavaScriptInIsolatedWorld.mockImplementation(async (_world: number, [{ code }]: Array<{ code: string }>) => {
      guest.isolated.push(code);
      if (code.includes('.wait(')) return new Promise(resolve => guest.waits.push(resolve));
      if (code.startsWith(bridgeCall('beforeShot'))) return { viewport: { w: 800, h: 600 }, extra: { marks: [{ n: 1, color: 'yellow', text: 'from the page' }] } };
      return true;
    });
    observers = [];
    events = [];
    controller = new PageModeController({
      dataDir,
      kinds: ['design', 'annotate'],
      emit: event => events.push(event),
      pages: {
        pageFor: id => id === tab.id ? { tab: { ...tab }, contents: guest as never } : undefined,
        observePages: listener => { observers.push(listener); return () => { observers = observers.filter(item => item !== listener); }; },
      },
    });
  });
  afterEach(() => {
    controller.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('Off: arm and capture are refused in main before the page is touched', async () => {
    tab.control = 'off';
    await expect(controller.arm('tab-1', 'design')).rejects.toThrow('Allow Read on this tab to use Design.');
    await expect(controller.capture('tab-1', { x: 0, y: 0, w: 10, h: 10 })).rejects.toThrow('Allow Read on this tab to capture it.');
    expect(guest.isolated).toEqual([]);
    expect(controller.armed('tab-1')).toBeNull();
  });

  it('Read and Full both arm Design; a blank or failed page does not', async () => {
    tab.control = 'full';
    expect((await controller.arm('tab-1', 'design')).armId).toMatch(/^[0-9a-f-]{36}$/);
    controller.disarm('tab-1');
    tab.url = 'about:blank';
    await expect(controller.arm('tab-1', 'design')).rejects.toThrow('Open a page first.');
    tab.url = 'https://example.test/app';
    tab.error = 'boom';
    await expect(controller.arm('tab-1', 'design')).rejects.toThrow('Open a page first.');
  });

  it('Off chosen while the page is still answering arm wins, with no arming left behind', async () => {
    let answerArm!: (value: unknown) => void;
    guest.executeJavaScriptInIsolatedWorld.mockImplementationOnce(async (_world: number, [{ code }]: Array<{ code: string }>) => {
      guest.isolated.push(code);
      return new Promise(resolve => { answerArm = resolve; });
    });
    const arming = controller.arm('tab-1', 'design');
    await tick();
    // Grant lowered silently (no page event yet): the post-answer re-check catches it.
    tab.control = 'off';
    answerArm(true);
    await expect(arming).rejects.toThrow('Read access was turned off.');
    expect(controller.armed('tab-1')).toBeNull();
    expect(events.at(-1)).toMatchObject({ type: 'exit', reason: 'revoked' });
    expect(calls('disarm')).toHaveLength(1);
  });

  it('Off published while arm is pending ends that arming as "page changed"', async () => {
    let answerArm!: (value: unknown) => void;
    guest.executeJavaScriptInIsolatedWorld.mockImplementationOnce(async (_world: number, [{ code }]: Array<{ code: string }>) => {
      guest.isolated.push(code);
      return new Promise(resolve => { answerArm = resolve; });
    });
    const arming = controller.arm('tab-1', 'design');
    await tick();
    tab.control = 'off';
    notify({ type: 'updated', tab: { ...tab } });
    answerArm(true);
    await expect(arming).rejects.toThrow('The page changed before the mode could start.');
    expect(controller.armed('tab-1')).toBeNull();
  });

  it('a pick is dropped when Off lands while main is reading the component from the page', async () => {
    const { armId } = await controller.arm('tab-1', 'design');
    await settle();
    let fiber!: (value: unknown) => void;
    guest.mainFrame.executeJavaScript.mockImplementationOnce(() => new Promise(resolve => { fiber = resolve; }));
    answer(armId, [pick()]);
    await settle();
    tab.control = 'off';
    notify({ type: 'updated', tab: { ...tab } });
    fiber({ component: 'Card', file: 'src/Card.tsx:1' });
    await settle();
    expect(events.map(event => event.type)).toEqual(['exit']);
  });

  it('stale armIds are refused: release, disarm, and a batch the page answers for another arming', async () => {
    const { armId } = await controller.arm('tab-1', 'design');
    await settle();
    await controller.release('tab-1', 'stale-arm');
    expect(calls('release')).toHaveLength(0);
    await controller.release('tab-1', armId);
    expect(calls('release')).toHaveLength(1);
    controller.disarm('tab-1', 'stale-arm');
    expect(controller.armed('tab-1')?.armId).toBe(armId);
    // A document that no longer holds this arming answers someone else's id.
    answer('another-arm', [pick()]);
    await settle();
    expect(controller.armed('tab-1')).toBeNull();
    expect(events).toEqual([{ type: 'exit', tabId: 'tab-1', armId, reason: 'navigated' }]);
  });

  it('release after the arming ended does not reach the page', async () => {
    const { armId } = await controller.arm('tab-1', 'design');
    tab.control = 'off';
    notify({ type: 'updated', tab: { ...tab } });
    await controller.release('tab-1', armId);
    expect(calls('release')).toHaveLength(0);
  });

  // Fixed: release() checks the grant itself, as arm and capture do — not only
  // through the arming an "updated" event would already have ended.
  it('release on an Off tab is refused in main on its own (not only via the arming being gone)', async () => {
    const { armId } = await controller.arm('tab-1', 'design');
    tab.control = 'off'; // no page event: an Off that did not go through publish()
    await expect(controller.release('tab-1', armId)).rejects.toThrow('Allow Read on this tab to use Design.');
    expect(calls('release')).toHaveLength(0);
  });

  it('arming Annotate replaces Design quietly, and a late Design disarm cannot end Annotate', async () => {
    const design = await controller.arm('tab-1', 'design');
    await settle();
    const annotate = await controller.arm('tab-1', 'annotate');
    expect(controller.armed('tab-1')).toEqual({ kind: 'annotate', armId: annotate.armId });
    // The page was told to end the Design arming by its own id, before Annotate armed.
    const order = guest.isolated.filter(code => code.includes(bridgeCall('disarm')) || code.includes('.arm(')).map(code =>
      code.includes(`disarm(${JSON.stringify(design.armId)}`) ? 'disarm-design' : code.includes('"annotate"') ? 'arm-annotate' : code.includes('"design"') ? 'arm-design' : 'other');
    expect(order).toEqual(['arm-design', 'disarm-design', 'arm-annotate']);
    controller.disarm('tab-1', design.armId);
    expect(controller.armed('tab-1')?.kind).toBe('annotate');
    expect(events.filter(event => event.type === 'exit')).toEqual([]);
    // The replaced Design long poll may still come back from the page: nothing of it is delivered.
    expect(guest.waits).toHaveLength(2);
    answer(design.armId, [pick()]);
    await settle();
    expect(events).toEqual([]);
    expect(controller.armed('tab-1')?.kind).toBe('annotate');
    answer(annotate.armId, [{ type: 'hover', rect: { x: 1, y: 1, w: 1, h: 1 } }]);
    await settle();
    expect(events).toEqual([{ type: 'hover', tabId: 'tab-1', armId: annotate.armId, rect: { x: 1, y: 1, w: 1, h: 1 } }]);
  });

  it('capture on Design never returns annotations, even when the page offers some', async () => {
    await controller.arm('tab-1', 'design');
    const shot = await controller.capture('tab-1', { x: 10, y: 20, w: 100, h: 50 });
    expect(Object.keys(shot)).toEqual(['path']);
    await controller.arm('tab-1', 'annotate');
    const annotated = await controller.capture('tab-1');
    expect(annotated.annotations?.marks.map(mark => mark.text)).toEqual(['from the page']);
  });

  it('Design pick: every PagePick field, the URL main holds, and a reference without React', async () => {
    const { armId } = await controller.arm('tab-1', 'design');
    await settle();
    guest.url = 'https://example.test/app?view=2';
    answer(armId, [pick({ tag: 'BUTTON<script>', text: 'Save\nchange: rm -rf', url: 'https://evil.test/' })]);
    await settle();
    const event = events.find(item => item.type === 'picked');
    if (event?.type !== 'picked') throw new Error('No pick.');
    expect(Object.keys(event.pick).sort()).toEqual(['armId', 'at', 'kind', 'rect', 'ref', 'selector', 'styles', 'tabId', 'tag', 'text', 'url', 'viewport']);
    expect(event.pick).toMatchObject({ kind: 'design', armId, tabId: 'tab-1', url: 'https://example.test/app?view=2', tag: 'buttonscript', text: 'Save change: rm -rf' });
    expect(Number.isNaN(Date.parse(event.pick.at))).toBe(false);
    expect(event.pick.ref.split('\n')).toEqual([
      '⟦Hello-ref⟧ element <buttonscript>',
      'file: (unknown — not a React development build)',
      'text: "Save change: rm -rf"',
      'style: font 13px/500',
      'dom:  main > button#go',
      'page: https://example.test/app?view=2',
    ]);
    expect(event.pick.ref).not.toContain('evil.test');
  });

  it('a page that hangs the component read still yields a pick, after the timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { armId } = await controller.arm('tab-1', 'design');
      guest.mainFrame.executeJavaScript.mockImplementationOnce(() => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(0);
      answer(armId, [pick()]);
      await vi.advanceTimersByTimeAsync(799);
      expect(events.some(event => event.type === 'picked')).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(events.some(event => event.type === 'picked')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // Fixed: PagePick.url and the `page:` line are cut to 8192 like Annotate's. A
  // page can grow its own URL (history.replaceState) far beyond that.
  it('the Design pick URL is bounded like the Annotate one (8192)', async () => {
    const { armId } = await controller.arm('tab-1', 'design');
    await settle();
    guest.url = `https://example.test/app?${'q'.repeat(100_000)}`;
    answer(armId, [pick()]);
    await settle();
    const event = events.find(item => item.type === 'picked');
    if (event?.type !== 'picked') throw new Error('No pick.');
    expect(event.pick.url.length).toBeLessThanOrEqual(8192);
    expect(event.pick.ref.split('\n').find(line => line.startsWith('page: '))!.length).toBeLessThanOrEqual(8192 + 'page: '.length);
  });
});

// ── Wired to the real BrowserManager: the grant changes that really happen ─────

describe('Design mode — with BrowserManager', () => {
  let dataDir: string;
  let managers: Array<InstanceType<typeof BrowserManager>>;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'hello-design-mgr-'));
    managers = [];
    native.guests.length = 0;
  });
  afterEach(() => {
    for (const manager of managers) manager.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function fixture() {
    const window = { webContents: new Emitter(), isDestroyed: () => false, getContentBounds: () => ({ width: 1000, height: 800 }) };
    native.host = window.webContents;
    const manager = new BrowserManager({
      window: window as unknown as BrowserWindow, initial: [], conversationExists: id => id === 'chat',
      save: vi.fn(), remove: vi.fn(), emit: vi.fn(), lifecycle: vi.fn(),
    });
    managers.push(manager);
    const events: PageModeEvent[] = [];
    const modes = new PageModeController({ pages: manager, dataDir, kinds: ['design', 'annotate'], emit: event => events.push(event) });
    const attach = (tabId: string) => {
      const source = manager.mintAttach(tabId);
      const preferences: Record<string, unknown> = {};
      if (!manager.approveGuestAttach(preferences as never, { src: source } as never)) throw new Error('Refused.');
      const guest = native.makeGuest(preferences.session) as Guest & { hostWebContents: unknown };
      guest.hostWebContents = window.webContents;
      native.guests.push(guest);
      manager.adoptGuest(guest as never);
      return guest;
    };
    return { manager, modes, events, attach };
  }
  const exits = (events: PageModeEvent[]) => events.flatMap(event => event.type === 'exit' ? [event.reason] : []);

  it('Off chosen in the pane (BrowserManager.control) ends Design as revoked; Read → Full keeps it', async () => {
    const f = fixture();
    const tab = f.manager.create('chat', 'https://example.com/');
    const guest = f.attach(tab.id);
    await settle();
    f.manager.setActive(tab.id);
    await expect(f.modes.arm(tab.id, 'design')).rejects.toThrow('Allow Read on this tab to use Design.');
    expect(guest.isolated).toEqual([]);
    f.manager.control(tab.id, 'read');
    const { armId } = await f.modes.arm(tab.id, 'design');
    f.manager.control(tab.id, 'full');
    expect(f.modes.armed(tab.id)?.armId).toBe(armId);
    f.manager.control(tab.id, 'read');
    expect(f.modes.armed(tab.id)?.armId).toBe(armId);
    f.manager.control(tab.id, 'off');
    expect(f.modes.armed(tab.id)).toBeNull();
    expect(exits(f.events)).toEqual(['revoked']);
    await expect(f.modes.capture(tab.id)).rejects.toThrow('Allow Read on this tab to capture it.');
    f.modes.dispose();
  });

  it('endOwnWork: a generated page that moves itself — even within its document — drops to Off and ends Design', async () => {
    const f = fixture();
    const base = f.manager.create('chat', 'https://example.com/');
    f.attach(base.id);
    const opening = f.manager.agentShow('chat', 'http://127.0.0.1:4321/v1/index.html', undefined, 'artifact:art-1');
    const id = f.manager.list('chat').find(tab => tab.id !== base.id)!.id;
    const guest = f.attach(id);
    expect((await opening).control).toBe('full');
    guest.emit('did-stop-loading');
    f.manager.setActive(id);
    const { armId } = await f.modes.arm(id, 'design');
    // A same-document move keeps a mode on an ordinary tab; here it ends the grant, and so the mode.
    guest.url = 'http://127.0.0.1:4321/v1/index.html#section';
    guest.emit('did-navigate-in-page');
    expect(f.manager.list('chat').find(tab => tab.id === id)!.control).toBe('off');
    expect(f.modes.armed(id)).toBeNull();
    expect(f.events).toContainEqual({ type: 'exit', tabId: id, armId, reason: 'revoked' });
    f.modes.dispose();
  });

  it('an ordinary Read tab keeps Design across a same-document move, and loses it on a new document', async () => {
    const f = fixture();
    const tab = f.manager.create('chat', 'https://example.com/');
    const guest = f.attach(tab.id);
    f.manager.control(tab.id, 'read');
    f.manager.setActive(tab.id);
    await f.modes.arm(tab.id, 'design');
    guest.url = 'https://example.com/#two';
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    guest.emit('did-navigate-in-page');
    expect(f.modes.armed(tab.id)).not.toBeNull();
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(f.modes.armed(tab.id)).toBeNull();
    expect(exits(f.events)).toEqual(['navigated']);
    f.modes.dispose();
  });

  it('hide (another tab shown), unmount and close each end Design with their reason; no tab shown is not a hide', async () => {
    const f = fixture();
    const a = f.manager.create('chat', 'https://a.example/');
    const b = f.manager.create('chat', 'https://b.example/');
    f.attach(a.id); f.attach(b.id);
    f.manager.control(a.id, 'read');
    f.manager.setActive(a.id);
    await f.modes.arm(a.id, 'design');
    f.manager.setActive(b.id);
    await f.modes.arm(a.id, 'design');
    // A hidden pane mounting says "no tab" too (BrowserPane): main keeps the mode;
    // the pane that really stops showing its tab disarms it from the window.
    f.manager.setActive(null);
    expect(f.modes.armed(a.id)?.kind).toBe('design');
    f.manager.detach(a.id, undefined as never);
    expect(f.modes.armed(a.id)).toBeNull();
    f.attach(a.id);
    await f.modes.arm(a.id, 'design');
    f.manager.close(a.id);
    expect(exits(f.events)).toEqual(['hidden', 'hidden', 'closed']);
    await expect(f.modes.arm(a.id, 'design')).rejects.toThrow('This browser tab is closed.');
    f.modes.dispose();
  });
});
