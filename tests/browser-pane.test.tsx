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
  downloadsList: vi.fn(async () => [] as unknown[]),
  reveal: vi.fn(async () => {}),
  open: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  revealPath: vi.fn(async () => {}),
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
      downloads: { list: mocks.downloadsList, onChange: () => () => {}, reveal: mocks.reveal, open: mocks.open, remove: mocks.remove,
        cancel: vi.fn(), clear: vi.fn(), folder: async () => '/chat' },
    },
    system: { revealPath: mocks.revealPath, copy: vi.fn() },
  },
  onNativeBrowserFocus: () => () => {},
}));
import { downloadDetail, formatBytes, savingProgress, timeAgo } from '../src/renderer/browser/DownloadsMenu';

import { BrowserPane } from '../src/renderer/browser/BrowserPane';

const tab: BrowserTab = {
  id: 'tab-1', conversationId: 'chat', title: 'Probe', url: 'https://example.com',
  control: 'off', loading: false, progress: null, canGoBack: false, canGoForward: false,
};
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.attach.mockResolvedValue('about:blank#hello-attach-11111111-2222-3333-4444-555555555555');
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  mocks.downloadsList.mockResolvedValue([]);
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

  it('lets a page going full screen cover the window, and puts it back when it leaves', async () => {
    await render();
    const host = document.querySelector<HTMLElement>('.browser-guest-host')!;
    expect(host.classList.contains('is-fullscreen')).toBe(false);
    await act(async () => { guest()!.dispatchEvent(new Event('enter-html-full-screen')); });
    expect(host.classList.contains('is-fullscreen')).toBe(true);
    await act(async () => { guest()!.dispatchEvent(new Event('leave-html-full-screen')); });
    expect(host.classList.contains('is-fullscreen')).toBe(false);
    // Nothing about the tab itself changed.
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.detach).not.toHaveBeenCalled();
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

// The chat's downloads, on the toolbar the way a browser has them (user,
// 24.09: "ca în Chrome, profesional — cu tab de download, cu View in Finder").
describe('the downloads on the toolbar', () => {
  const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(item => item.querySelector('.menu-item-copy')?.firstChild?.textContent?.trim() === label);
  const sixHours = 6 * 3600_000;

  it('says size, state and when the way a browser does', () => {
    expect(formatBytes(16793)).toBe('16.4 KB');
    expect(formatBytes(1_217_536)).toBe('1.2 MB');
    expect(formatBytes(512)).toBe('512 B');
    expect(timeAgo(Date.now() - 30_000)).toBe('just now');
    expect(timeAgo(Date.now() - sixHours)).toBe('6 hours ago');
    expect(timeAgo(Date.now() - 26 * 3600_000)).toBe('yesterday');
    const done = { id: 'd', conversationId: 'chat', name: 'a.html', state: 'saved' as const, bytes: 16793, startedAt: 1, finishedAt: Date.now() - sixHours };
    expect(downloadDetail(done)).toBe('16.4 KB · Done · 6 hours ago');
    expect(downloadDetail({ ...done, state: 'saving', bytes: 1_217_536, total: 4_194_304 })).toBe('1.2 MB of 4.0 MB · Saving…');
    expect(downloadDetail({ ...done, state: 'failed', reason: 'interrupted' })).toBe('16.4 KB · Failed: interrupted · 6 hours ago');
    expect(savingProgress([done])).toBeNull();
    expect(savingProgress([{ ...done, state: 'saving', bytes: 2, total: 4 }, { ...done, state: 'saving', bytes: 4, total: 4 }])).toBe(0.75);
  });

  it('lists the chat’s downloads with Show in Finder, Open and Remove on each, and the folder they land in', async () => {
    mocks.downloadsList.mockResolvedValue([
      { id: 'd1', conversationId: 'chat', name: 'Hello. Design Audit.html', path: '/chat/Hello. Design Audit.html', state: 'saved', bytes: 16793, startedAt: Date.now() - sixHours, finishedAt: Date.now() - sixHours },
    ]);
    await render();
    expect(mocks.downloadsList).toHaveBeenCalledWith('chat');
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Downloads"]');
    expect(trigger).not.toBeNull();
    await act(async () => { trigger!.click(); });
    const row = menuItem('Hello. Design Audit.html');
    expect(row?.textContent).toContain('16.4 KB · Done · 6 hours ago');
    await act(async () => { row!.click(); });
    for (const label of ['Open', 'Show in Finder', 'Copy path', 'Remove from list']) expect(menuItem(label), label).toBeDefined();
    await act(async () => { menuItem('Show in Finder')!.click(); });
    expect(mocks.reveal).toHaveBeenCalledWith('d1');
    await act(async () => { trigger!.click(); });
    expect(menuItem('Open downloads folder')).toBeDefined();
    expect(menuItem('Clear list')).toBeDefined();
  });

  it('says so when there is nothing yet', async () => {
    await render();
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Downloads"]')!.click(); });
    expect(menuItem('No downloads yet')).toBeDefined();
  });
});
