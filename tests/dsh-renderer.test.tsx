// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DshStatus, MarketItem, MarketPreview } from '../src/shared/types';

const state = vi.hoisted(() => ({
  status: { state: 'absent', version: '0.1.7-rc.2', profileDir: '/p', logFile: '/l', checkpoints: [] } as DshStatus,
  listeners: new Set<(status: DshStatus) => void>(),
}));
const mocks = vi.hoisted(() => ({
  attach: vi.fn(async () => 'about:blank#hello-dsh-11111111-2222-3333-4444-555555555555'),
  detach: vi.fn(async () => {}),
  install: vi.fn(async () => state.status),
  start: vi.fn(async (_accept?: boolean) => state.status),
  restore: vi.fn(async () => state.status),
  query: vi.fn(),
  preview: vi.fn(),
  confirm: vi.fn(),
  installed: vi.fn(async () => []),
  sources: vi.fn(async () => [] as unknown[]),
  addSource: vi.fn(),
  selectSource: vi.fn(),
}));
vi.mock('../src/renderer/api', () => ({
  api: {
    dsh: {
      status: async () => state.status,
      onStatus: (listener: (status: DshStatus) => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
      onOpenLink: () => () => {},
      attach: mocks.attach, detach: mocks.detach, install: mocks.install, start: mocks.start, stop: vi.fn(), restart: vi.fn(),
      restore: mocks.restore, reload: vi.fn(), revealLogs: vi.fn(),
    },
    market: {
      sources: mocks.sources,
      addSource: mocks.addSource,
      selectSource: mocks.selectSource,
      addStandardSource: vi.fn(),
      removeSource: vi.fn(),
      query: mocks.query,
      icon: async () => null,
      installed: mocks.installed,
      preview: mocks.preview,
      previewByName: vi.fn(),
      previewUninstall: vi.fn(),
      previewFolder: vi.fn(),
      confirm: mocks.confirm,
    },
    system: { openExternal: vi.fn(async () => {}) },
  },
}));

import { DshView } from '../src/renderer/dsh/DshView';
import { MarketDialog } from '../src/renderer/market/MarketDialog';

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
    state.status = { state: 'absent', version: '0.1.7-rc.2', profileDir: '/p', logFile: '/l', checkpoints: [] };
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
    state.status = { state: 'stopped', version: '0.1.7-rc.2', installedVersion: '0.1.7-rc.2', profileDir: '/p', logFile: '/l', checkpoints: [] };
    act(() => root.render(createElement(DshView, { open: true, onClose: () => {} })));
    await flush();
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it('asks before starting with a profile changed outside Hello', async () => {
    state.status = { state: 'stopped', version: '0.1.7-rc.2', profileDir: '/p', logFile: '/l', checkpoints: [{ id: 'a1', kind: 'healthy', at: 1, label: 'x' }], profileChange: { added: ['sneaky'], removed: [], changed: [] } };
    act(() => root.render(createElement(DshView, { open: true, onClose: () => {} })));
    await flush();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Added sneaky');
    const accept = [...host.querySelectorAll('button')].find(button => button.textContent === 'Start with these changes')!;
    await act(async () => { accept.click(); });
    expect(mocks.start).toHaveBeenCalledWith(true);
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
    state.status = { state: 'installing', version: '0.2.0-rc.2', profileDir: '/p', logFile: '/l', checkpoints: [],
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

  it('names plugins the page could not start, with a way back', async () => {
    state.status = { state: 'running', version: '0.1.7-rc.2', profileDir: '/p', logFile: '/l', checkpoints: [{ id: 'a1', kind: 'healthy', at: 1, label: 'x' }] };
    act(() => root.render(createElement(DshView, { open: true, onClose: () => {}, onOpenMarket: () => {} })));
    await flush();
    emit({ ...state.status, bootFailure: ['dsh-better-sidebar'] });
    expect(host.querySelector('.dsh-banner')?.textContent).toContain('dsh-better-sidebar');
  });
});

describe('the market', () => {
  const item: MarketItem = { key: '1024:x', name: 'dsh-memory-plugin', summary: 'Memory.', publisher: 'volcengine', categories: ['memory'], repository: 'https://github.com/volcengine/OpenViking', installable: true, sourceName: 'DSH 1024Store', installs: 386, stars: 1 };
  const preview: MarketPreview = { token: 't', action: 'install', displayName: 'dsh-memory-plugin', packageName: '@openviking/dsh-memory-plugin', version: '0.5.8', profile: 'Hello', expiresAt: Date.now() + 60_000, compatibility: { ok: true }, hello: { ui: false, skills: true, mcp: true, lines: ['No interface of its own.'] } };

  it('lists the installable plugins and confirms an install with the exact version', async () => {
    mocks.query.mockResolvedValue({ items: [item], total: 1, categories: ['memory'] });
    mocks.preview.mockResolvedValue(preview);
    mocks.confirm.mockResolvedValue({ action: 'install', packageName: preview.packageName, version: '0.5.8', installedAt: Date.now() });
    act(() => root.render(createElement(MarketDialog, { open: true, onClose: () => {} })));
    await flush();
    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({ installable: true }));
    const card = host.querySelector('.dshMarketCard') as HTMLButtonElement;
    expect(card.textContent).toContain('dsh-memory-plugin');
    await act(async () => { card.click(); });
    await flush();
    expect(host.textContent).toContain('Confirm plugin installation');
    expect(host.textContent).toContain('0.5.8');
    const confirm = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Confirm install'))!;
    await act(async () => { confirm.click(); });
    await flush();
    expect(mocks.confirm).toHaveBeenCalledWith('t');
    expect(host.textContent).toContain('Plugin installed');
  });

  it('adds a partner source, switches to it, and reads the new source’s list', async () => {
    const base = { description: 'Partner.', homepage: 'https://dshfind.com', endpointHost: 'api.dshfind.com', builtIn: true, partner: true, available: true, attribution: { name: 'x', url: 'https://x.com', notice: '' } };
    const store = { ...base, id: 'dsh-1024store', name: 'DSH 1024Store', added: true, selected: true };
    const find = { ...base, id: 'dshfind', name: 'dshfind', added: false, selected: false };
    mocks.sources.mockResolvedValue([store, find]);
    mocks.addSource.mockResolvedValue([store, { ...find, added: true }]);
    mocks.selectSource.mockResolvedValue([{ ...store, selected: false }, { ...find, added: true, selected: true }]);
    mocks.query.mockResolvedValue({ items: [item], total: 1, categories: [] });
    act(() => root.render(createElement(MarketDialog, { open: true, onClose: () => {}, initialView: 'sources' })));
    await flush();
    expect(host.querySelector('.dshMarketCurrentSource')?.textContent).toContain('DSH 1024Store');
    const add = [...host.querySelectorAll('.dshMarketAvailableSources button')].find(button => button.textContent === 'Add') as HTMLButtonElement;
    await act(async () => { add.click(); });
    await flush();
    expect(mocks.addSource).toHaveBeenCalledWith('dshfind');
    const select = [...host.querySelectorAll('[role=radio]')].find(button => button.textContent === 'Select this source') as HTMLButtonElement;
    await act(async () => { select.click(); });
    await flush();
    expect(mocks.selectSource).toHaveBeenCalledWith('dshfind');
    expect(host.querySelector('.dshMarketCurrentSource')?.textContent).toContain('dshfind');
    mocks.sources.mockResolvedValue([]);
  });

  it('will not confirm a plugin that does not fit the dsh Hello runs', async () => {
    mocks.query.mockResolvedValue({ items: [item], total: 1, categories: [] });
    mocks.preview.mockResolvedValue({ ...preview, compatibility: { ok: false, reason: 'Needs @deepseek-ai/dsh-llm ^0.2.0-rc.1; Hello. runs dsh 0.1.7-rc.2.' } });
    act(() => root.render(createElement(MarketDialog, { open: true, onClose: () => {} })));
    await flush();
    await act(async () => { (host.querySelector('.dshMarketCard') as HTMLButtonElement).click(); });
    await flush();
    expect(host.textContent).toContain('Needs @deepseek-ai/dsh-llm ^0.2.0-rc.1');
    const confirm = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Confirm install')) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });
});
