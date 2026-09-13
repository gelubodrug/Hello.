// @vitest-environment jsdom
// Invariant: with page modes unused, the pane talks to main exactly as at dbfb5eb, and "Add page to chat" hands over the same text.
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTab } from '../src/shared/types';

const mocks = vi.hoisted(() => ({
  attach: vi.fn(async () => 'about:blank#hello-attach-11111111-2222-3333-4444-555555555555'),
  detach: vi.fn(async () => {}),
  setActive: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  read: vi.fn(async () => ({ title: 'Example Domain', url: 'https://example.com/', text: 'Example Domain\n\nMore information...' })),
  navigate: vi.fn(async () => {}),
  action: vi.fn(async () => {}),
  control: vi.fn(),
  mode: {
    arm: vi.fn(async () => ({ armId: 'a1' })),
    disarm: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    capture: vi.fn(),
    copy: vi.fn(),
    onEvent: vi.fn(() => () => {}),
  },
}));
vi.mock('../src/renderer/api', () => ({
  api: {
    browser: {
      attach: mocks.attach, detach: mocks.detach, setActive: mocks.setActive, close: mocks.close,
      read: mocks.read, navigate: mocks.navigate, action: mocks.action, control: mocks.control,
      onUpdate: () => () => {}, mode: mocks.mode,
    },
  },
  onNativeBrowserFocus: () => () => {},
}));

import { BrowserPane } from '../src/renderer/browser/BrowserPane';

const tab: BrowserTab = {
  id: 'tab-1', conversationId: 'chat', title: 'Example Domain', url: 'https://example.com/',
  control: 'read', loading: false, canGoBack: false, canGoForward: false,
};
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.querySelectorAll('.browser-guest-host').forEach(node => node.remove());
  vi.unstubAllGlobals();
});

const pane = (props: Partial<{ tab: BrowserTab; visible: boolean; onQuote: (...args: unknown[]) => void }> = {}) =>
  createElement(BrowserPane, { tab, visible: true, onTabChange: vi.fn(), onQuote: vi.fn(), ...props });
const modeCalls = () => [mocks.mode.arm, mocks.mode.disarm, mocks.mode.release, mocks.mode.capture, mocks.mode.copy]
  .reduce((sum, fn) => sum + fn.mock.calls.length, 0);

describe('browser invariant: the pane with page modes present but unused', () => {
  it('mounts, shows, hides, navigates, revokes and unmounts with no page-mode call to main', async () => {
    await act(async () => { root.render(pane()); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { root.render(pane({ visible: false })); });
    await act(async () => { root.render(pane({ visible: false, tab: { ...tab, url: 'https://example.org/' } })); });
    await act(async () => { root.render(pane({ visible: true, tab: { ...tab, url: 'https://example.org/', control: 'off' } })); });
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(modeCalls()).toBe(0);
    // The existing traffic, unchanged: one page asked for, shown, hidden, shown, named back.
    expect(mocks.attach.mock.calls).toEqual([['tab-1']]);
    expect(mocks.setActive.mock.calls).toEqual([['tab-1'], [null], ['tab-1']]);
    expect(mocks.detach.mock.calls).toEqual([['tab-1', '11111111-2222-3333-4444-555555555555']]);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it('"Add page to chat" still reads the page and hands over one string, with no extra', async () => {
    const onQuote = vi.fn();
    await act(async () => { root.render(pane({ onQuote })); });
    await act(async () => { await Promise.resolve(); });
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Add page to chat"]')!;
    expect(button.disabled).toBe(false);
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(mocks.read).toHaveBeenCalledWith('tab-1');
    expect(onQuote.mock.calls).toEqual([['Page: Example Domain\nSource: https://example.com/\n\nExample Domain\n\nMore information...']]);
    expect(modeCalls()).toBe(0);
  });

  it('"Add page to chat" stays disabled while the tab is Off or blank, as before', async () => {
    await act(async () => { root.render(pane({ tab: { ...tab, control: 'off' } })); });
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Add page to chat"]')!.disabled).toBe(true);
    await act(async () => { root.render(pane({ tab: { ...tab, url: 'about:blank' } })); });
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Add page to chat"]')!.disabled).toBe(true);
  });
});
