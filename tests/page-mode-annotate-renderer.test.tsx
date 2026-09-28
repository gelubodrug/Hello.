// @vitest-environment jsdom
// Annotate in the window: AnnotateBar (A3 — Send only on an explicit click) and
// the `marks` counter in usePageMode.
import { createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTab, PageModeEvent } from '../src/shared/types';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  copy: vi.fn(async () => {}),
  attach: vi.fn(),
  arm: vi.fn(),
  disarm: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
  listeners: new Set<(event: PageModeEvent) => void>(),
}));
vi.mock('../src/renderer/api', () => ({
  api: {
    chat: { attach: mocks.attach },
    browser: {
      mode: {
        arm: mocks.arm, disarm: mocks.disarm, release: mocks.release, capture: mocks.capture, copy: mocks.copy,
        onEvent: (listener: (event: PageModeEvent) => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); },
      },
    },
  },
}));

import { AnnotateBar } from '../src/renderer/browser/annotate/AnnotateBar';
import { usePageMode } from '../src/renderer/browser/usePageMode';

const tab: BrowserTab = { id: 'tab-1', conversationId: 'chat-1', title: 'App', url: 'https://example.test/app', control: 'read', loading: false, progress: null, canGoBack: false, canGoForward: false };
const SHOT = { url: 'https://example.test/app', marks: [{ n: 1, color: 'yellow', text: 'Too dim', inView: true }, { n: 3, color: 'pink', text: 'Below', inView: false }] };
const PATH = '/data/page-captures/chat-1/0000.png';
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.listeners.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('AnnotateBar', () => {
  const render = (marks: number) => {
    const onQuote = vi.fn();
    const onExit = vi.fn();
    const slot = createRef<HTMLElement>();
    act(() => root.render(createElement(AnnotateBar, { tab, marks, slot, onQuote, onExit })));
    const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    return { onQuote, onExit, send: () => button('Send to chat'), copy: () => button('Copy picture and notes'), rerender: (count: number) => act(() => root.render(createElement(AnnotateBar, { tab, marks: count, slot, onQuote, onExit }))) };
  };

  it('A3: nothing goes anywhere without a click — no markers means both buttons are disabled', () => {
    const view = render(0);
    expect(view.send().disabled).toBe(true);
    expect(view.copy().disabled).toBe(true);
    expect(document.querySelector('.annotate-bar-count')!.textContent).toBe('Click the page to drop a marker');
    act(() => view.send().click());
    expect(mocks.capture).not.toHaveBeenCalled();
    view.rerender(1);
    expect(document.querySelector('.annotate-bar-count')!.textContent).toBe('1 marker');
    view.rerender(2);
    expect(document.querySelector('.annotate-bar-count')!.textContent).toBe('2 markers');
  });

  it('A3: Send → capture(tab) → chat.attach(chat, [path]) → onQuote(composed, {verbatim, attachments}) → exit', async () => {
    mocks.capture.mockResolvedValue({ path: PATH, annotations: SHOT });
    const attachment = { id: 'att-1', name: '0000.png', kind: 'image', size: 3 };
    mocks.attach.mockResolvedValue({ attachments: [attachment] });
    const view = render(2);
    await act(async () => { view.send().click(); });
    await flush();
    expect(mocks.capture).toHaveBeenCalledWith('tab-1');
    expect(mocks.attach).toHaveBeenCalledWith('chat-1', [PATH]);
    expect(view.onQuote).toHaveBeenCalledWith([
      '⟦Hello-annotations⟧ 2 markers on https://example.test/app',
      '#1 yellow — Too dim',
      '#3 pink — Below · outside the picture',
    ].join('\n'), { verbatim: true, attachments: [attachment] });
    expect(view.onQuote.mock.calls[0][0]).not.toMatch(/^shot:/m);
    expect(view.onExit).toHaveBeenCalledTimes(1);
    expect(mocks.copy).not.toHaveBeenCalled();
  });

  it('a second click while sending takes no second picture', async () => {
    let finish!: (value: unknown) => void;
    mocks.capture.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    mocks.attach.mockResolvedValue({ attachments: [] });
    const view = render(1);
    await act(async () => { view.send().click(); });
    expect(view.send().disabled).toBe(true);
    await act(async () => { view.send().click(); view.copy().click(); });
    finish({ path: PATH, annotations: SHOT });
    await flush();
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });

  it('attach fails → its reason is shown, nothing quoted, the mode stays, Send can be tried again', async () => {
    mocks.capture.mockResolvedValue({ path: PATH, annotations: SHOT });
    mocks.attach.mockRejectedValue(new Error('Attach up to 8 files per message.'));
    const view = render(2);
    await act(async () => { view.send().click(); });
    await flush();
    const error = document.querySelector('.annotate-bar-error')!;
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toBe('Attach up to 8 files per message.');
    expect(view.onQuote).not.toHaveBeenCalled();
    expect(view.onExit).not.toHaveBeenCalled();
    expect(view.send().disabled).toBe(false);
  });

  it('attach resolves with no attachments, or throws without a reason → the generic error, nothing quoted, the mode stays', async () => {
    mocks.capture.mockResolvedValue({ path: PATH, annotations: SHOT });
    const view = render(1);
    for (const answer of [() => mocks.attach.mockResolvedValueOnce({ attachments: [] }), () => mocks.attach.mockRejectedValueOnce(new Error(''))]) {
      answer();
      await act(async () => { view.send().click(); });
      await flush();
      expect(document.querySelector('.annotate-bar-error')!.textContent).toBe('The page picture could not be attached.');
      expect(view.send().disabled).toBe(false);
    }
    expect(mocks.attach).toHaveBeenCalledTimes(2);
    expect(view.onQuote).not.toHaveBeenCalled();
    expect(view.onExit).not.toHaveBeenCalled();
  });

  it('capture fails → error shown, nothing quoted, the mode stays so the markers are not lost', async () => {
    mocks.capture.mockRejectedValue(new Error('Allow Read on this tab to capture it.'));
    const view = render(1);
    await act(async () => { view.send().click(); });
    await flush();
    expect(document.querySelector('.annotate-bar-error')!.textContent).toBe('Allow Read on this tab to capture it.');
    expect(view.onQuote).not.toHaveBeenCalled();
    expect(view.onExit).not.toHaveBeenCalled();
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(view.send().disabled).toBe(false);
  });

  it('capture without annotations (mode changed meanwhile, or no committed note) → error, nothing quoted, no attach', async () => {
    const view = render(1);
    for (const answer of [{ path: PATH }, { path: PATH, annotations: { url: 'u', marks: [] } }]) {
      mocks.capture.mockResolvedValueOnce(answer);
      await act(async () => { view.send().click(); });
      await flush();
      expect(document.querySelector('.annotate-bar-error')!.textContent).toBe('Write a note on a marker first.');
    }
    expect(view.onQuote).not.toHaveBeenCalled();
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it('the error clears when the marker count changes', async () => {
    mocks.capture.mockRejectedValue(new Error('boom'));
    const view = render(1);
    await act(async () => { view.send().click(); });
    await flush();
    expect(document.querySelector('.annotate-bar-error')).not.toBeNull();
    view.rerender(2);
    expect(document.querySelector('.annotate-bar-error')).toBeNull();
  });

  it('A3: Copy is optional — mode.copy(text with path, path), status shown, mode stays, nothing quoted', async () => {
    mocks.capture.mockResolvedValue({ path: PATH, annotations: SHOT });
    const view = render(2);
    await act(async () => { view.copy().click(); });
    await flush();
    expect(mocks.copy).toHaveBeenCalledWith(expect.stringContaining(`shot: ${PATH}`), PATH);
    expect(document.querySelector('.annotate-bar-count')!.textContent).toBe('Copied with picture');
    expect(view.onExit).not.toHaveBeenCalled();
    expect(view.onQuote).not.toHaveBeenCalled();
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it('Escape inside the bar leaves the mode', () => {
    const view = render(1);
    act(() => { document.querySelector('.annotate-bar')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(view.onExit).toHaveBeenCalledTimes(1);
  });
});

describe('usePageMode — the marks counter', () => {
  let hook!: ReturnType<typeof usePageMode>;
  function Probe({ tab: current, visible }: { tab: BrowserTab; visible: boolean }) {
    hook = usePageMode(current, visible);
    return null;
  }
  const mount = (current: BrowserTab = tab, visible = true) => act(() => root.render(createElement(Probe, { tab: current, visible })));
  const emit = (event: PageModeEvent) => act(() => { for (const listener of mocks.listeners) listener(event); });
  const arm = async (armId: string) => {
    mocks.arm.mockResolvedValueOnce({ armId });
    await act(async () => { await hook.toggle('annotate'); });
  };

  it('counts for the current arming only; exit zeroes it; a re-arm starts at 0; a late event from the old arming is ignored', async () => {
    mount();
    await arm('arm-1');
    expect(hook.mode).toBe('annotate');
    emit({ type: 'marks', tabId: 'tab-1', armId: 'arm-1', count: 3 });
    emit({ type: 'marks', tabId: 'tab-2', armId: 'arm-1', count: 9 });
    expect(hook.marks).toBe(3);
    emit({ type: 'exit', tabId: 'tab-1', armId: 'arm-1', reason: 'escape' });
    expect(hook.mode).toBeNull();
    expect(hook.marks).toBe(0);

    await arm('arm-2');
    expect(hook.marks).toBe(0);
    emit({ type: 'marks', tabId: 'tab-1', armId: 'arm-1', count: 7 });
    expect(hook.marks).toBe(0);
    emit({ type: 'marks', tabId: 'tab-1', armId: 'arm-2', count: 1 });
    expect(hook.marks).toBe(1);
  });

  it('toggling Annotate off zeroes the count and tells main which arming to end', async () => {
    mount();
    await arm('arm-3');
    emit({ type: 'marks', tabId: 'tab-1', armId: 'arm-3', count: 2 });
    await act(async () => { await hook.toggle('annotate'); });
    expect(hook.mode).toBeNull();
    expect(hook.marks).toBe(0);
    expect(mocks.disarm).toHaveBeenCalledWith('tab-1', 'arm-3');
  });

  it('switching Annotate → Design zeroes the count', async () => {
    mount();
    await arm('arm-4');
    emit({ type: 'marks', tabId: 'tab-1', armId: 'arm-4', count: 2 });
    mocks.arm.mockResolvedValueOnce({ armId: 'arm-5' });
    await act(async () => { await hook.toggle('design'); });
    expect(hook.mode).toBe('design');
    expect(hook.marks).toBe(0);
  });

  it.each([
    ['grant lowered to Off', { ...tab, control: 'off' as const }, true],
    ['pane hidden', tab, false],
  ])('the window disarms on %s and zeroes the count', async (_name, next, visible) => {
    mount();
    await arm('arm-6');
    emit({ type: 'marks', tabId: 'tab-1', armId: 'arm-6', count: 4 });
    mount(next, visible);
    expect(hook.mode).toBeNull();
    expect(hook.marks).toBe(0);
    expect(mocks.disarm).toHaveBeenCalledWith('tab-1', 'arm-6');
  });

  it('A5: a url change (same-document navigation) keeps the mode and its count — main alone ends it on a new document', async () => {
    mount();
    await arm('arm-7');
    emit({ type: 'marks', tabId: 'tab-1', armId: 'arm-7', count: 4 });
    mount({ ...tab, url: 'https://example.test/app#other' }, true);
    expect(hook.mode).toBe('annotate');
    expect(hook.marks).toBe(4);
    expect(mocks.disarm).not.toHaveBeenCalled();
    emit({ type: 'exit', tabId: 'tab-1', armId: 'arm-7', reason: 'navigated' });
    expect(hook.mode).toBeNull();
    expect(hook.marks).toBe(0);
  });

  it('a failed arm shows the main-process reason and leaves nothing armed', async () => {
    mount();
    mocks.arm.mockRejectedValueOnce(new Error('Allow Read on this tab to use Annotate.'));
    await act(async () => { await hook.toggle('annotate'); });
    expect(hook.mode).toBeNull();
    expect(hook.error).toBe('Allow Read on this tab to use Annotate.');
  });
});
