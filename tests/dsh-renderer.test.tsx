// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DshStatus } from '../src/shared/types';

const state = vi.hoisted(() => ({
  status: { state: 'absent', version: '0.1.7-rc.2', profileDir: '/p', logFile: '/l' } as DshStatus,
  listeners: new Set<(status: DshStatus) => void>(),
}));
const mocks = vi.hoisted(() => ({
  attach: vi.fn(async () => 'about:blank#hello-dsh-11111111-2222-3333-4444-555555555555'),
  detach: vi.fn(async () => {}),
  install: vi.fn(async () => state.status),
  start: vi.fn(async (_accept?: boolean) => state.status),
}));
vi.mock('../src/renderer/api', () => ({
  api: {
    dsh: {
      status: async () => state.status,
      onStatus: (listener: (status: DshStatus) => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
      onOpenLink: () => () => {},
      attach: mocks.attach, detach: mocks.detach, install: mocks.install, start: mocks.start, stop: vi.fn(), restart: vi.fn(),
      reload: vi.fn(), revealLogs: vi.fn(),
    },
    system: { openExternal: vi.fn(async () => {}) },
  },
}));

import { DshView } from '../src/renderer/dsh/DshView';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} disconnect() {} };
  host = document.createElement('div');
  host.id = 'root';
  document.body.appendChild(host);
  root = createRoot(host);
  for (const mock of Object.values(mocks)) mock.mockClear();
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.querySelectorAll('.dsh-guest-host').forEach(node => node.remove()); });

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const emit = (status: DshStatus) => act(() => { state.status = status; for (const listener of state.listeners) listener(status); });

describe('the DSH view', () => {
  it('offers the install and does not install on its own', async () => {
    state.status = { state: 'absent', version: '0.1.7-rc.2', profileDir: '/p', logFile: '/l' };
    act(() => root.render(createElement(DshView, { open: true, onClose: () => {} })));
    await flush();
    expect(host.textContent).toContain('DeepSeek Harness, inside Hello.');
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    // The page's guest is created once, with only the src main minted.
    const webview = document.querySelector('.dsh-guest-host webview');
    expect(webview?.getAttribute('src')).toBe('about:blank#hello-dsh-11111111-2222-3333-4444-555555555555');
    expect(webview?.attributes).toHaveLength(1);
  });

  it('starts a stopped host when opened', async () => {
    state.status = { state: 'stopped', version: '0.1.7-rc.2', installedVersion: '0.1.7-rc.2', profileDir: '/p', logFile: '/l' };
    act(() => root.render(createElement(DshView, { open: true, onClose: () => {} })));
    await flush();
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  // User, 01.10: with Hello's sidebar hidden the surface had no way back to the chats.
  it('leads back to the chats from its own header while the sidebar is hidden', async () => {
    const show = vi.fn();
    const render = (sidebarHidden: boolean) => act(() => root.render(createElement(DshView, { open: true, onClose: () => {}, sidebarHidden, onShowSidebar: show })));
    render(true);
    await flush();
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Pin chats sidebar"]')!.click());
    expect(show).toHaveBeenCalledOnce();
    render(false);
    expect(host.querySelector('button[aria-label="Pin chats sidebar"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Close DSH"]')).not.toBeNull();
  });

  // User, 01.10: "pune ceva viu aici, că nu știi nimic ce face… e blocat, se
  // reia, verifică conexiunea" — the panel held 315 of 592 for two hours.
  it('shows what the install is doing, and how long pnpm has been quiet', async () => {
    const now = Date.now();
    state.status = { state: 'installing', version: '0.2.0-rc.2', profileDir: '/p', logFile: '/l',
      progress: { resolved: 592, downloaded: 323, added: 315, total: 315, done: true, startedAt: now - 95_000, at: now - 45_000,
        activity: 'Retrying @deepseek-ai/libreoffice-kit-wasm in 10 seconds (2 tries left, error 23). If this keeps repeating, check the connection.' } };
    act(() => root.render(createElement(DshView, { open: true, onClose: () => {} })));
    await flush();
    expect(host.textContent).toContain('All 315 packages in place · finishing · 1:35');
    expect(host.querySelector('.dsh-progress span')?.getAttribute('style')).toContain('width: 100%');
    expect(host.querySelector('.dsh-activity')?.textContent).toContain('Retrying @deepseek-ai/libreoffice-kit-wasm');
    expect(host.querySelector('.dsh-quiet')?.textContent).toContain('Nothing from pnpm for 0:45');
    expect(host.querySelector('.dsh-progress')?.hasAttribute('data-live')).toBe(false);
  });

  it('names plugins the page could not start, with a host error banner', async () => {
    state.status = { state: 'running', version: '0.1.7-rc.2', profileDir: '/p', logFile: '/l' };
    act(() => root.render(createElement(DshView, { open: true, onClose: () => {} })));
    await flush();
    emit({ ...state.status, bootFailure: ['dsh-better-sidebar'] });
    expect(host.querySelector('.dsh-banner')?.textContent).toContain('dsh-better-sidebar');
  });
});
