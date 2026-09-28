// @vitest-environment jsdom
// Design mode, the window: the switch, the hook that asks main, and the
// "Describe the change" composer that turns a pick into a chat note.
import { createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTab, ChatQuoteExtra, PageModeEvent, PagePick } from '../src/shared/types';
import { composeDesignNote } from '../src/shared/page-mode-format';

const mocks = vi.hoisted(() => ({
  listeners: [] as Array<(event: PageModeEvent) => void>,
  arm: vi.fn(),
  disarm: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
  capture: vi.fn(),
  copy: vi.fn(async () => {}),
  attach: vi.fn(),
}));
vi.mock('../src/renderer/api', () => ({
  api: {
    chat: { attach: mocks.attach },
    browser: {
      mode: {
        arm: mocks.arm, disarm: mocks.disarm, release: mocks.release, capture: mocks.capture, copy: mocks.copy,
        onEvent: (listener: (event: PageModeEvent) => void) => {
          mocks.listeners.push(listener);
          return () => { mocks.listeners = mocks.listeners.filter(item => item !== listener); };
        },
      },
    },
  },
}));

const { usePageMode } = await import('../src/renderer/browser/usePageMode');
const { PageModeSwitch } = await import('../src/renderer/browser/PageModeSwitch');
const { DesignComposer } = await import('../src/renderer/browser/design/DesignComposer');

const baseTab: BrowserTab = {
  id: 'tab-1', conversationId: 'chat-1', title: 'App', url: 'https://example.test/app',
  control: 'read', loading: false, progress: null, canGoBack: false, canGoForward: false,
};
const makePick = (overrides: Partial<PagePick> = {}): PagePick => ({
  kind: 'design', armId: 'arm-1', tabId: 'tab-1', url: 'https://example.test/app', selector: '#go', tag: 'button',
  text: 'Go', styles: 'font 13px/500', ref: '⟦Hello-ref⟧ Card › Button <button>\nfile: src/Button.tsx:3\npage: https://example.test/app',
  rect: { x: 10, y: 20, w: 100, h: 30 }, viewport: { w: 800, h: 600 }, at: '2026-09-13T10:00:00.000Z', ...overrides,
});
const emit = (event: PageModeEvent) => { for (const listener of [...mocks.listeners]) listener(event); };
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.listeners = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── usePageMode + PageModeSwitch ─────────────────────────────────────────────

type Hook = ReturnType<typeof usePageMode>;
function mountHook(initial: { tab?: BrowserTab; visible?: boolean } = {}) {
  let hook!: Hook;
  let props = { tab: initial.tab ?? baseTab, visible: initial.visible ?? true };
  function Probe({ tab, visible }: { tab: BrowserTab; visible: boolean }) {
    hook = usePageMode(tab, visible);
    return createElement(PageModeSwitch, { tab, mode: hook.mode, pending: hook.pending, available: hook.available, onToggle: kind => void hook.toggle(kind) });
  }
  const render = (next: Partial<typeof props> = {}) => { props = { ...props, ...next }; act(() => root.render(createElement(Probe, props))); };
  render();
  return { get hook() { return hook; }, render, button: (kind: string) => host.querySelector<HTMLButtonElement>(`[data-kind="${kind}"]`)! };
}

describe('Design switch and usePageMode', () => {
  it('Off disables the Design pill in the window; main is never asked', () => {
    const view = mountHook({ tab: { ...baseTab, control: 'off' } });
    expect(view.button('design').disabled).toBe(true);
    expect(view.button('design').title).toBe('Enable read access to use Design');
    view.render({ tab: { ...baseTab, url: 'about:blank' } });
    expect(view.button('design').disabled).toBe(true);
    view.render({ tab: { ...baseTab, loading: true } });
    expect(view.button('design').disabled).toBe(true);
    expect(mocks.arm).not.toHaveBeenCalled();
  });

  it('arms, surfaces picks for its own armId only, and clears on its own exit', async () => {
    mocks.arm.mockResolvedValue({ armId: 'arm-1' });
    const view = mountHook();
    await act(async () => { view.button('design').click(); await flush(); });
    expect(mocks.arm).toHaveBeenCalledWith('tab-1', 'design');
    expect(view.hook.mode).toBe('design');
    expect(view.button('design').getAttribute('aria-pressed')).toBe('true');

    act(() => emit({ type: 'picked', tabId: 'tab-1', armId: 'old-arm', pick: makePick({ armId: 'old-arm' }), point: { x: 1, y: 1 } }));
    act(() => emit({ type: 'picked', tabId: 'tab-2', armId: 'arm-1', pick: makePick(), point: { x: 1, y: 1 } }));
    expect(view.hook.picked).toBeNull();
    act(() => emit({ type: 'picked', tabId: 'tab-1', armId: 'arm-1', pick: makePick(), point: { x: 1, y: 1 } }));
    expect(view.hook.picked?.pick.selector).toBe('#go');
    // The page scrolled: the pick follows its rect.
    act(() => emit({ type: 'hover', tabId: 'tab-1', armId: 'arm-1', rect: { x: 10, y: -80, w: 100, h: 30 } }));
    expect(view.hook.picked?.pick.rect.y).toBe(-80);

    act(() => emit({ type: 'exit', tabId: 'tab-1', armId: 'old-arm', reason: 'escape' }));
    expect(view.hook.mode).toBe('design');
    act(() => emit({ type: 'exit', tabId: 'tab-1', armId: 'arm-1', reason: 'escape' }));
    expect(view.hook.mode).toBeNull();
    expect(view.hook.picked).toBeNull();
    // Main ended it; the window does not ask main to end it again.
    expect(mocks.disarm).not.toHaveBeenCalled();
  });

  it('lets go with its armId when the grant drops to Off, the pane hides, or it unmounts', async () => {
    mocks.arm.mockResolvedValueOnce({ armId: 'a1' }).mockResolvedValueOnce({ armId: 'a2' }).mockResolvedValueOnce({ armId: 'a3' });
    const view = mountHook();
    await act(async () => { await view.hook.toggle('design'); });
    view.render({ tab: { ...baseTab, control: 'off' } });
    expect(mocks.disarm).toHaveBeenLastCalledWith('tab-1', 'a1');
    expect(view.hook.mode).toBeNull();

    view.render({ tab: baseTab });
    await act(async () => { await view.hook.toggle('design'); });
    view.render({ visible: false });
    expect(mocks.disarm).toHaveBeenLastCalledWith('tab-1', 'a2');

    view.render({ visible: true });
    await act(async () => { await view.hook.toggle('design'); });
    act(() => root.unmount());
    expect(mocks.disarm).toHaveBeenLastCalledWith('tab-1', 'a3');
    root = createRoot(host);
  });

  it('toggling Design again disarms; switching to Annotate asks main to replace, with no Design disarm sent', async () => {
    mocks.arm.mockResolvedValueOnce({ armId: 'd1' }).mockResolvedValueOnce({ armId: 'n1' });
    const view = mountHook();
    await act(async () => { await view.hook.toggle('design'); });
    act(() => emit({ type: 'picked', tabId: 'tab-1', armId: 'd1', pick: makePick({ armId: 'd1' }), point: { x: 1, y: 1 } }));
    await act(async () => { await view.hook.toggle('annotate'); });
    expect(mocks.arm).toHaveBeenLastCalledWith('tab-1', 'annotate');
    expect(mocks.disarm).not.toHaveBeenCalled();
    expect(view.hook.mode).toBe('annotate');
    expect(view.hook.picked).toBeNull();
    // A late Design pick no longer reaches the window.
    act(() => emit({ type: 'picked', tabId: 'tab-1', armId: 'd1', pick: makePick({ armId: 'd1' }), point: { x: 1, y: 1 } }));
    expect(view.hook.picked).toBeNull();
    await act(async () => { await view.hook.toggle('annotate'); });
    expect(mocks.disarm).toHaveBeenCalledWith('tab-1', 'n1');
  });

  it('each armed pill says how to stop it, Esc included', async () => {
    mocks.arm.mockResolvedValueOnce({ armId: 'd2' }).mockResolvedValueOnce({ armId: 'n2' });
    const view = mountHook();
    await act(async () => { await view.hook.toggle('design'); });
    expect(view.button('design').title).toMatch(/\bEsc\b/);
    await act(async () => { await view.hook.toggle('annotate'); });
    expect(view.button('annotate').getAttribute('aria-pressed')).toBe('true');
    expect(view.button('annotate').title).toBe('Annotate on — click the page to drop a marker. Esc or click here to stop');
  });

  it('shows main\'s refusal as the error and stays off', async () => {
    mocks.arm.mockRejectedValue(new Error('Allow Read on this tab to use Design.'));
    const view = mountHook();
    await act(async () => { await view.hook.toggle('design'); });
    expect(view.hook.mode).toBeNull();
    expect(view.hook.error).toBe('Allow Read on this tab to use Design.');
  });

  // Decision: main alone ends a mode on navigation. A same-document move (hash,
  // pushState/replaceState) keeps it there, so the window does not end it either.
  it('a same-document URL change (hash) does not end Design from the window', async () => {
    mocks.arm.mockResolvedValue({ armId: 'arm-1' });
    const view = mountHook();
    await act(async () => { await view.hook.toggle('design'); });
    view.render({ tab: { ...baseTab, url: 'https://example.test/app#section' } });
    expect(mocks.disarm).not.toHaveBeenCalled();
    expect(view.hook.mode).toBe('design');
  });

  // Fixed: the arming is known to the event listener as soon as arm() resolves,
  // not on the next render, so an exit main sends at once still clears the pill.
  it('an exit that lands before the re-render after arm still clears the switch', async () => {
    mocks.arm.mockResolvedValue({ armId: 'arm-1' });
    const view = mountHook();
    await act(async () => {
      const toggling = view.hook.toggle('design');
      await toggling;
      emit({ type: 'exit', tabId: 'tab-1', armId: 'arm-1', reason: 'navigated' });
    });
    expect(view.hook.mode).toBeNull();
  });
});

// ── DesignComposer ───────────────────────────────────────────────────────────

function mountComposer(pick = makePick(), tab = baseTab) {
  const onQuote = vi.fn<(text: string, extra?: ChatQuoteExtra) => void>();
  const onRelease = vi.fn();
  const onExit = vi.fn();
  function Harness({ value }: { value: PagePick }) {
    const slot = useRef<HTMLDivElement>(null);
    return createElement('div', { ref: slot },
      createElement(DesignComposer, { tab, picked: { pick: value, point: { x: 1, y: 1 } }, slot, onQuote, onRelease, onExit }));
  }
  const render = (value: PagePick) => act(() => root.render(createElement(Harness, { value })));
  render(pick);
  const field = () => document.querySelector<HTMLInputElement>('.design-composer input')!;
  const type = (text: string) => act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(field(), text);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
  const key = (target: Element, init: KeyboardEventInit) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });
  const button = (label: string) => document.querySelector<HTMLButtonElement>(`.design-composer button[aria-label="${label}"]`)!;
  return { onQuote, onRelease, onExit, field, type, key, button, render };
}

describe('DesignComposer', () => {
  beforeEach(() => {
    mocks.capture.mockResolvedValue({ path: '/data/page-captures/chat-1/shot.png' });
    mocks.attach.mockResolvedValue({ attachments: [{ id: 'att-1', name: 'shot.png', kind: 'image', size: 10 }] });
  });

  it('takes one picture of the picked rect when the pick arrives, not again as the page scrolls', async () => {
    const view = mountComposer();
    await act(flush);
    expect(mocks.capture).toHaveBeenCalledWith('tab-1', { x: 10, y: 20, w: 100, h: 30 });
    view.render(makePick({ rect: { x: 10, y: -50, w: 100, h: 30 } }));
    await act(flush);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    view.render(makePick({ at: '2026-09-13T10:00:05.000Z' }));
    await act(flush);
    expect(mocks.capture).toHaveBeenCalledTimes(2);
  });

  it('Enter: the note verbatim, with the picture attached to this chat, then releases the pick', async () => {
    const pick = makePick();
    const view = mountComposer(pick);
    await act(flush);
    view.key(view.field(), { key: 'Enter' });
    await act(flush);
    expect(view.onQuote).not.toHaveBeenCalled();
    view.type('  make it bolder ');
    view.key(view.field(), { key: 'Enter' });
    await act(flush);
    expect(mocks.attach).toHaveBeenCalledWith('chat-1', ['/data/page-captures/chat-1/shot.png']);
    expect(view.onQuote).toHaveBeenCalledTimes(1);
    const [text, extra] = view.onQuote.mock.calls[0];
    expect(text).toBe(composeDesignNote({ text: 'make it bolder', ref: pick.ref, selector: pick.selector, tag: pick.tag, url: pick.url }));
    expect(text.split('\n').at(-1)).toBe('change: make it bolder');
    expect(extra).toEqual({ verbatim: true, attachments: [{ id: 'att-1', name: 'shot.png', kind: 'image', size: 10 }] });
    expect(view.onRelease).toHaveBeenCalledTimes(1);
  });

  it('↑ sends like Enter; an IME composition Enter does not', async () => {
    const view = mountComposer();
    await act(flush);
    view.type('spacing');
    view.key(view.field(), { key: 'Enter', isComposing: true });
    await act(flush);
    expect(view.onQuote).not.toHaveBeenCalled();
    await act(async () => { view.button('Add to chat').click(); await flush(); });
    expect(view.onQuote).toHaveBeenCalledTimes(1);
  });

  it('no picture, or a picture the chat refuses: the words still go, without attachments', async () => {
    mocks.capture.mockRejectedValueOnce(new Error('Allow Read on this tab to capture it.'));
    const first = mountComposer();
    await act(flush);
    expect(document.querySelector('.design-composer-tag')!.getAttribute('data-shot')).toBe('none');
    first.type('a');
    first.key(first.field(), { key: 'Enter' });
    await act(flush);
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(first.onQuote.mock.calls[0][1]).toEqual({ verbatim: true });

    mocks.attach.mockRejectedValueOnce(new Error('too big'));
    const second = mountComposer(makePick({ at: 'later' }));
    await act(flush);
    second.type('b');
    second.key(second.field(), { key: 'Enter' });
    await act(flush);
    expect(second.onQuote.mock.calls[0][1]).toEqual({ verbatim: true });
  });

  it('Copy: the same note and the capture path go to main; the pick is released after the status', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pick = makePick();
    const view = mountComposer(pick);
    await act(flush);
    view.type('rounder');
    await act(async () => { view.button('Copy note').click(); await flush(); });
    expect(mocks.copy).toHaveBeenCalledWith(
      composeDesignNote({ text: 'rounder', ref: pick.ref, selector: pick.selector, tag: pick.tag, url: pick.url }),
      '/data/page-captures/chat-1/shot.png');
    expect(document.querySelector('.design-composer-status')!.textContent).toBe('Copied with picture');
    expect(view.onQuote).not.toHaveBeenCalled();
    expect(view.onRelease).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(700); });
    expect(view.onRelease).toHaveBeenCalledTimes(1);
  });

  it('Escape leaves Design, and does not bubble to the window', async () => {
    const view = mountComposer();
    await act(flush);
    const outside = vi.fn();
    document.addEventListener('keydown', outside);
    view.key(view.field(), { key: 'Escape' });
    document.removeEventListener('keydown', outside);
    expect(view.onExit).toHaveBeenCalledTimes(1);
    expect(outside).not.toHaveBeenCalled();
    expect(view.onQuote).not.toHaveBeenCalled();
  });

  it('a new pick clears the words typed for the previous one', async () => {
    const view = mountComposer();
    await act(flush);
    view.type('for the first');
    view.render(makePick({ at: 'next' }));
    await act(flush);
    expect(view.field().value).toBe('');
  });

  // Fixed: the 700 ms release after Copy belongs to its pick; a new pick (or the
  // composer closing) cancels it.
  it('a Copy of one pick does not release the next pick made within 700 ms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const view = mountComposer();
    await act(flush);
    view.type('x');
    await act(async () => { view.button('Copy note').click(); await flush(); });
    view.render(makePick({ at: 'the next pick' }));
    await act(flush);
    act(() => { vi.advanceTimersByTime(700); });
    expect(view.onRelease).not.toHaveBeenCalled();
  });

  it('a Copy whose composer closes within 700 ms releases nothing afterwards', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const view = mountComposer();
    await act(flush);
    view.type('x');
    await act(async () => { view.button('Copy note').click(); await flush(); });
    act(() => root.unmount());
    root = createRoot(host);
    vi.advanceTimersByTime(700);
    expect(view.onRelease).not.toHaveBeenCalled();
  });
});
