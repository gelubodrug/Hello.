// Annotate in main: criteria A2, A4, A5, A6 against the real PageModeController,
// with the guest page scripted. The [BUG] / [RISC] findings of the first test
// round are fixed; their tests now pin the fixed behaviour.
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTab, PageModeEvent } from '../src/shared/types';
import type { BrowserPageEvent } from '../src/main/browser/manager';

vi.mock('electron', () => ({ clipboard: { writeText: vi.fn(), write: vi.fn() }, ClipboardItem: class {} }));
const { PageModeController } = await import('../src/main/browser/page-mode');

const image = { isEmpty: () => false, getSize: () => ({ width: 800, height: 600 }), toPNG: () => Buffer.from('png') };

class Contents extends EventEmitter {
  destroyed = false;
  url = 'https://example.test/app';
  waits: Array<(value: unknown) => void> = [];
  calls: string[] = [];
  extra: unknown = { marks: [{ n: 1, color: 'yellow', text: 'Too dim', inView: true }] };
  fiber: unknown = { component: 'Card › Button', file: 'src/Button.tsx:3' };
  isDestroyed = () => this.destroyed;
  isLoading = () => false;
  getURL = () => this.url;
  mainFrame = { executeJavaScript: vi.fn(async (_code: string) => this.fiber) };
  capturePage = vi.fn(async () => image);
  executeJavaScriptInIsolatedWorld = vi.fn(async (_world: number, [{ code }]: Array<{ code: string }>) => {
    this.calls.push(code);
    if (code.includes('.arm(')) return true;
    if (code.includes('.wait(')) return new Promise(resolve => this.waits.push(resolve));
    if (code.includes('.beforeShot(')) return { viewport: { w: 800, h: 600 }, extra: this.extra };
    return true;
  });
  answer(armId: string, events: unknown[]): void {
    const next = this.waits.shift();
    if (!next) throw new Error('No wait pending.');
    next({ armId, events });
  }
}
const bridgeCall = (method: string) => `(window.__HELLO_PAGE_MODE__?window.__HELLO_PAGE_MODE__.${method}(`;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

describe('Annotate — PageModeController', () => {
  let dataDir: string;
  let tab: BrowserTab;
  let contents: Contents;
  let observers: Array<(event: BrowserPageEvent) => void>;
  let events: PageModeEvent[];
  let controller: InstanceType<typeof PageModeController>;
  const page = (event: BrowserPageEvent) => { for (const listener of observers) listener(event); };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'hello-annotate-ctl-'));
    tab = { id: 'tab-1', conversationId: 'chat-1', title: 'App', url: 'https://example.test/app', control: 'read', loading: false, progress: null, canGoBack: false, canGoForward: false };
    contents = new Contents();
    observers = [];
    events = [];
    controller = new PageModeController({
      dataDir, kinds: ['design', 'annotate'], emit: event => events.push(event),
      pages: {
        pageFor: id => id === tab.id ? { tab: { ...tab }, contents: contents as never } : undefined,
        observePages: listener => { observers.push(listener); return () => { observers = observers.filter(item => item !== listener); }; },
      },
    });
  });
  afterEach(() => { controller.dispose(); rmSync(dataDir, { recursive: true, force: true }); });

  describe('A2 — at least Read, refused in main', () => {
    it('Off: arm is refused before anything runs in the page', async () => {
      tab.control = 'off';
      await expect(controller.arm('tab-1', 'annotate')).rejects.toThrow('Allow Read on this tab to use Annotate.');
      expect(contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
      expect(controller.armed('tab-1')).toBeNull();
    });

    it('Off: capture is refused and no picture is taken', async () => {
      tab.control = 'off';
      await expect(controller.capture('tab-1')).rejects.toThrow('Allow Read on this tab to capture it.');
      expect(contents.capturePage).not.toHaveBeenCalled();
    });

    it('Full works like Read', async () => {
      tab.control = 'full';
      await expect(controller.arm('tab-1', 'annotate')).resolves.toHaveProperty('armId');
    });

    it('Off chosen while the page was arming wins: exit revoked, and the arm call fails', async () => {
      let answer!: (value: unknown) => void;
      contents.executeJavaScriptInIsolatedWorld.mockImplementationOnce(async () => new Promise(resolve => { answer = resolve; }));
      const arming = controller.arm('tab-1', 'annotate');
      await tick();
      tab.control = 'off';
      answer(true);
      await expect(arming).rejects.toThrow('Read access was turned off.');
      expect(events.at(-1)).toMatchObject({ type: 'exit', reason: 'revoked' });
      expect(controller.armed('tab-1')).toBeNull();
    });

    it('Off chosen during a capture: no picture is returned', async () => {
      await controller.arm('tab-1', 'annotate');
      contents.capturePage.mockImplementationOnce(async () => { tab.control = 'off'; return image; });
      await expect(controller.capture('tab-1')).rejects.toThrow('Allow Read on this tab to capture it.');
    });

    it.each([
      ['grant lowered', (_c: Contents) => { tab.control = 'off'; page({ type: 'updated', tab: { ...tab } }); }, 'revoked'],
      ['cross-document navigation', (c: Contents) => c.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }), 'navigated'],
      ['tab closed', (_c: Contents) => page({ type: 'closed', id: 'tab-1' }), 'closed'],
      ['another tab shown', (_c: Contents) => page({ type: 'active', id: 'tab-2' }), 'hidden'],
      ['page detached', (_c: Contents) => page({ type: 'detached', id: 'tab-1' }), 'hidden'],
      ['renderer gone', (c: Contents) => c.emit('render-process-gone'), 'hidden'],
    ] as const)('disarms on %s (%s) and tells the page to forget', async (_name, act, reason) => {
      const { armId } = await controller.arm('tab-1', 'annotate');
      const before = contents.calls.length;
      act(contents);
      expect(events.at(-1)).toEqual({ type: 'exit', tabId: 'tab-1', armId, reason });
      expect(controller.armed('tab-1')).toBeNull();
      expect(contents.calls.slice(before).some(code => code.includes(`${bridgeCall('disarm')}${JSON.stringify(armId)})`))).toBe(true);
    });

    it('Escape is kept from the page and ends the mode', async () => {
      const { armId } = await controller.arm('tab-1', 'annotate');
      const event = { preventDefault: vi.fn() };
      contents.emit('before-input-event', event, { type: 'keyUp', key: 'Escape' });
      expect(controller.armed('tab-1')).not.toBeNull();
      contents.emit('before-input-event', event, { type: 'keyDown', key: 'Escape' });
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toEqual({ type: 'exit', tabId: 'tab-1', armId, reason: 'escape' });
    });

    it('no tab shown (a hidden pane mounting) is not a hide: the mode stays, the page is not told to forget', async () => {
      await controller.arm('tab-1', 'annotate');
      const before = contents.calls.length;
      page({ type: 'active', id: null });
      expect(controller.armed('tab-1')).not.toBeNull();
      expect(events.some(event => event.type === 'exit')).toBe(false);
      expect(contents.calls.slice(before).some(code => code.includes(bridgeCall('disarm')))).toBe(false);
      page({ type: 'active', id: 'tab-1' });
      expect(controller.armed('tab-1')).not.toBeNull();
    });

    it('Escape during IME composition cancels the composition, not the mode; the page keeps that Escape', async () => {
      await controller.arm('tab-1', 'annotate');
      const event = { preventDefault: vi.fn() };
      contents.emit('before-input-event', event, { type: 'keyDown', key: 'Escape', isComposing: true });
      expect(controller.armed('tab-1')).not.toBeNull();
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('a subframe navigation does not end the mode', async () => {
      await controller.arm('tab-1', 'annotate');
      contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
      expect(controller.armed('tab-1')).not.toBeNull();
    });

    it('A5 — a same-document navigation (pushState / #hash) is not an exit: main is the only authority, and it keeps the mode', async () => {
      await controller.arm('tab-1', 'annotate');
      contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
      expect(controller.armed('tab-1')).not.toBeNull();
    });
  });

  describe('marks and the component under a marker', () => {
    it('relays the count and hands the component back to the page for that marker', async () => {
      const { armId } = await controller.arm('tab-1', 'annotate');
      await tick();
      contents.answer(armId, [{ type: 'marks', count: 2, mark: { n: 2, token: 'tok2' } }]);
      await settle();
      expect(events).toContainEqual({ type: 'marks', tabId: 'tab-1', armId, count: 2 });
      expect(contents.mainFrame.executeJavaScript.mock.calls[0][0]).toContain('"tok2"');
      expect(contents.calls.some(code => code.includes(`.call("annotate","setAt",[${JSON.stringify(armId)},2,"Card › Button","src/Button.tsx:3"])`))).toBe(true);
    });

    it('a marks event without a valid token never runs the page-world probe', async () => {
      const { armId } = await controller.arm('tab-1', 'annotate');
      await tick();
      contents.answer(armId, [{ type: 'marks', count: 1, mark: { n: 1, token: '"]),alert(1)//' } }]);
      await settle();
      expect(events).toContainEqual({ type: 'marks', tabId: 'tab-1', armId, count: 1 });
      expect(contents.mainFrame.executeJavaScript).not.toHaveBeenCalled();
    });

    it('no component (not React) → no setAt; `at` stays the DOM path', async () => {
      contents.fiber = { component: null, file: null };
      const { armId } = await controller.arm('tab-1', 'annotate');
      await tick();
      contents.answer(armId, [{ type: 'marks', count: 1, mark: { n: 1, token: 'tok1' } }]);
      await settle();
      expect(contents.mainFrame.executeJavaScript).toHaveBeenCalledTimes(1);
      expect(contents.calls.some(code => code.includes('"setAt"'))).toBe(false);
    });

    it('disarmed while the component was being read → setAt is not sent to the page', async () => {
      let resolveFiber!: (value: unknown) => void;
      contents.mainFrame.executeJavaScript.mockImplementationOnce(() => new Promise(resolve => { resolveFiber = resolve; }));
      const { armId } = await controller.arm('tab-1', 'annotate');
      await tick();
      contents.answer(armId, [{ type: 'marks', count: 1, mark: { n: 1, token: 'tok1' } }]);
      await settle();
      controller.disarm('tab-1', armId);
      resolveFiber({ component: 'Late', file: null });
      await settle();
      expect(contents.calls.some(code => code.includes('"setAt"'))).toBe(false);
    });

    it('re-armed while the component was being read → the old reading never reaches the new arming', async () => {
      let resolveFiber!: (value: unknown) => void;
      contents.mainFrame.executeJavaScript.mockImplementationOnce(() => new Promise(resolve => { resolveFiber = resolve; }));
      const first = await controller.arm('tab-1', 'annotate');
      await tick();
      contents.answer(first.armId, [{ type: 'marks', count: 1, mark: { n: 1, token: 'tok1' } }]);
      await settle();
      const second = await controller.arm('tab-1', 'annotate');
      expect(second.armId).not.toBe(first.armId);
      resolveFiber({ component: 'StaleCard', file: null });
      await settle();
      expect(contents.calls.some(code => code.includes('StaleCard'))).toBe(false);
    });

    it('a batch naming a different armId ends the arming (the document went away)', async () => {
      const { armId } = await controller.arm('tab-1', 'annotate');
      await tick();
      contents.answer('someone-else', [{ type: 'marks', count: 5 }]);
      await settle();
      expect(events.some(event => event.type === 'marks')).toBe(false);
      expect(events.at(-1)).toEqual({ type: 'exit', tabId: 'tab-1', armId, reason: 'navigated' });
    });

    it('a design arming never relays marks as annotate data in capture', async () => {
      await controller.arm('tab-1', 'design');
      expect((await controller.capture('tab-1')).annotations).toBeUndefined();
    });
  });

  describe('A6 — capture', () => {
    it('whole viewport only: capturePage is called without a rect; the address is main’s', async () => {
      contents.extra = { url: 'https://evil.test', marks: [{ n: 1, color: 'yellow', text: 'x', inView: false }] };
      await controller.arm('tab-1', 'annotate');
      contents.url = 'https://example.test/app#after';
      const shot = await controller.capture('tab-1');
      expect(contents.capturePage).toHaveBeenCalledWith();
      expect(shot.annotations).toEqual({ url: 'https://example.test/app#after', marks: [{ n: 1, color: 'yellow', text: 'x', inView: false }] });
      expect(contents.calls.filter(code => code.includes(bridgeCall('afterShot')))).toHaveLength(1);
    });

    it('a page that answers garbage for its markers yields a picture without annotations', async () => {
      contents.extra = 'marks';
      await controller.arm('tab-1', 'annotate');
      const shot = await controller.capture('tab-1');
      expect(shot.path.endsWith('.png')).toBe(true);
      expect(shot.annotations).toBeUndefined();
    });

    it('afterShot still runs when the picture fails', async () => {
      await controller.arm('tab-1', 'annotate');
      contents.capturePage.mockRejectedValueOnce(new Error('gpu'));
      await expect(controller.capture('tab-1')).rejects.toThrow('gpu');
      expect(contents.calls.some(code => code.includes(bridgeCall('afterShot')))).toBe(true);
    });

    it('mode ended (Escape) while the picture was being taken → no annotations for a picture taken after the pins were removed', async () => {
      let shoot!: (value: typeof image) => void;
      contents.capturePage.mockImplementationOnce(() => new Promise(resolve => { shoot = resolve; }));
      await controller.arm('tab-1', 'annotate');
      const capturing = controller.capture('tab-1');
      await settle();
      contents.emit('before-input-event', { preventDefault: () => {} }, { type: 'keyDown', key: 'Escape' });
      expect(controller.armed('tab-1')).toBeNull();
      shoot(image);
      const shot = await capturing;
      expect(shot.path.endsWith('.png')).toBe(true);
      expect(shot.annotations).toBeUndefined();
    });

    it('mode switched Annotate → Design during the capture → no annotations of the old arming', async () => {
      let shoot!: (value: typeof image) => void;
      contents.capturePage.mockImplementationOnce(() => new Promise(resolve => { shoot = resolve; }));
      await controller.arm('tab-1', 'annotate');
      const capturing = controller.capture('tab-1');
      await settle();
      await controller.arm('tab-1', 'design');
      shoot(image);
      expect((await capturing).annotations).toBeUndefined();
    });
  });

  describe('A4 / A5 — static', () => {
    const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

    it('A4: no agent tool reaches page modes — nothing under src/main/chat names them', () => {
      const dir = join(__dirname, '..', 'src/main/chat');
      for (const file of readdirSync(dir).filter(name => /\.ts$/.test(name))) {
        expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(/annotat|page-?mode|browser\.mode|pageModes/i);
      }
      // The controller is only handed to IPC (the window), not to the chat service.
      // Every use of it in index.ts: construction, chat-deleted cleanup, the IPC argument, dispose.
      const uses = read('src/main/index.ts').split('\n').filter(line => line.includes('pageModes')).map(line => line.trim());
      expect(uses).toHaveLength(4);
      expect(uses[0]).toMatch(/^const pageModes=new PageModeController\(/);
      expect(uses[1]).toBe('await pageModes.removeConversation(id).catch(()=>{});');
      expect(uses[2]).toBe("},()=>emit('hello:extensions-changed',{}),pageModes);");
      expect(uses[3]).toBe("{name:'page modes',dispose:()=>pageModes.dispose()},");
    });

    it('A5: Annotate keeps nothing in SQLite — the controller and format never touch the store', () => {
      for (const path of ['src/main/browser/page-mode.ts', 'src/main/browser/page-mode-probe.ts', 'src/shared/page-mode-format.ts']) {
        expect(read(path), path).not.toMatch(/data\/store|sqlite|DataStore|localStorage|indexedDB/i);
      }
    });

    it('A5: probe state lives only in the page’s isolated world memory — no storage APIs in the probe', async () => {
      const { PAGE_MODE_PROBE } = await import('../src/main/browser/page-mode-probe');
      expect(PAGE_MODE_PROBE).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    });
  });
});
