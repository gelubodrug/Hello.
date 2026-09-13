// @vitest-environment jsdom
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
  read: vi.fn(),
  navigate: vi.fn(async () => {}),
  action: vi.fn(async () => {}),
  control: vi.fn(),
}));
vi.mock('../src/renderer/api', () => ({
  api: {
    browser: {
      attach: mocks.attach,
      detach: mocks.detach,
      setActive: mocks.setActive,
      close: mocks.close,
      read: mocks.read,
      navigate: mocks.navigate,
      action: mocks.action,
      control: mocks.control,
      onUpdate: () => () => {},
    },
  },
  onNativeBrowserFocus: () => () => {},
}));

import { BrowserPane } from '../src/renderer/browser/BrowserPane';

const tab: BrowserTab = {
  id: 'tab-1', conversationId: 'chat', title: 'Probe', url: 'https://example.com',
  control: 'off', loading: false, canGoBack: false, canGoForward: false,
};
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.attach.mockResolvedValue('about:blank#hello-attach-11111111-2222-3333-4444-555555555555');
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

async function render(visible = true) {
  await act(async () => {
    root.render(createElement(BrowserPane, { tab, visible, onTabChange: vi.fn(), onQuote: vi.fn() }));
  });
  await act(async () => { await Promise.resolve(); });
}
const guest = () => document.querySelector<HTMLElement>('.browser-guest-host webview');

describe('the browser pane hosting a page', () => {
  it('asks main for one page, mounts it outside the pane and names it back when unmounting', async () => {
    await render();
    expect(mocks.attach).toHaveBeenCalledWith('tab-1');
    const element = guest();
    expect(element?.getAttribute('src')).toBe('about:blank#hello-attach-11111111-2222-3333-4444-555555555555');
    // The page must not live inside the pane: a hidden pane is display:none,
    // and Chromium creates no page for an element that never has a box.
    expect(element?.closest('.browser-pane')).toBeNull();
    await act(async () => root.unmount());
    // Named, so a late unmount cannot close a page a newer host already made.
    expect(mocks.detach).toHaveBeenCalledWith('tab-1', '11111111-2222-3333-4444-555555555555');
    root = createRoot(host);
  });

  it('closes the tab when the page itself asks to close', async () => {
    await render();
    expect(mocks.close).not.toHaveBeenCalled();
    await act(async () => { guest()!.dispatchEvent(new Event('close')); });
    expect(mocks.close).toHaveBeenCalledWith('tab-1');
  });

  it('tells main which tab the window is showing', async () => {
    await render(true);
    expect(mocks.setActive).toHaveBeenLastCalledWith('tab-1');
    await act(async () => {
      root.render(createElement(BrowserPane, { tab, visible: false, onTabChange: vi.fn(), onQuote: vi.fn() }));
    });
    expect(mocks.setActive).toHaveBeenLastCalledWith(null);
  });

  it('keeps a page behind a start page, because navigating from it is what loads one', async () => {
    await act(async () => {
      root.render(createElement(BrowserPane, {
        tab: { ...tab, url: 'about:blank' }, visible: true, onTabChange: vi.fn(), onQuote: vi.fn(),
      }));
    });
    await act(async () => { await Promise.resolve(); });
    // The page exists — an empty tab must still be able to navigate — but it is
    // parked behind the pane's own start screen rather than covering it.
    expect(mocks.attach).toHaveBeenCalledWith('tab-1');
    const host = document.querySelector<HTMLElement>('.browser-guest-host');
    expect(host?.querySelector('webview')).not.toBeNull();
    expect(host?.style.zIndex).toBe('-1');
  });
});
