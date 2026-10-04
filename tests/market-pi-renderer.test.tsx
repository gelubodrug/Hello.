// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketItem, MarketPage, MarketPreview } from '../src/shared/types';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  installed: vi.fn(),
  previewUpdate: vi.fn(),
  confirm: vi.fn(),
  dshRestart: vi.fn(),
}));
vi.mock('../src/renderer/api', () => ({
  api: {
    piMarket: {
      sources: async () => [{ id: 'pi-gallery', name: 'Pi packages', description: '', homepage: 'https://pi.dev/packages', endpointHost: 'pi.dev', builtIn: true, partner: false, selected: true, available: true, added: true, attribution: { name: 'pi.dev/packages', url: 'https://pi.dev/packages', notice: '' } }],
      query: mocks.query, icon: async () => null, installed: mocks.installed,
      preview: vi.fn(), previewByName: vi.fn(), previewUninstall: vi.fn(), previewUpdate: mocks.previewUpdate, confirm: mocks.confirm,
    },
    dsh: { status: async () => ({ state: 'running' }), restart: mocks.dshRestart },
    system: { openExternal: vi.fn(async () => {}) },
  },
}));

import { MarketDialog, monthlyDownloads, publishedAgo } from '../src/renderer/market/MarketDialog';

const item = (name: string, extra: Partial<MarketItem> = {}): MarketItem => ({
  key: `pi:${name}`, name, summary: `${name} summary`, publisher: 'nicopreme', categories: ['extension'], repository: `https://github.com/nicobailon/${name}`,
  installable: true, sourceName: 'Pi packages', installs: 1_200_000, stars: 0, updatedAt: new Date(Date.now() - 19 * 3600_000).toISOString(), ...extra,
});
const page = (items: MarketItem[], extra: Partial<MarketPage> = {}): MarketPage => ({ items, total: 5548, categories: ['extension', 'skill', 'theme', 'prompt'], ...extra });

let host: HTMLDivElement;
let root: Root;
async function render() {
  await act(async () => { root.render(createElement(MarketDialog, { kind: 'pi', open: true, initialView: 'discover', onClose: () => {} })); });
  await act(async () => { await Promise.resolve(); });
}
async function change(select: HTMLSelectElement, value: string) {
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); });
}
async function click(node: Element) {
  await act(async () => { node.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); });
}
const button = (text: string) => [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === text || node.getAttribute('aria-label') === text)!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.query.mockResolvedValue(page([item('pi-mcp-adapter'), item('pi-subagents', { installs: 1740, publisher: 'charly-vibes' })]));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the Pi market window', () => {
  it('is the market window with pi.dev’s own filters, count and card details', async () => {
    await render();
    expect(host.querySelector('h1')?.textContent).toBe('Pi Package Market');
    expect(host.querySelector('.dshMarketOverlay')?.getAttribute('data-market')).toBe('pi');
    // pi.dev's two menus, not category pills.
    const [type, order] = [...host.querySelectorAll<HTMLSelectElement>('.dshMarketSelect select')];
    expect([...type.options].map(option => option.textContent)).toEqual(['All types', 'extension', 'skill', 'theme', 'prompt']);
    expect([...order.options].map(option => option.textContent)).toEqual(['Most downloads', 'Recently published', 'A-Z']);
    expect(host.querySelector('.dshMarketCategories')).toBeNull();
    expect(host.querySelector('.dshMarketCount')?.textContent).toBe('1–2 / 5,548');
    const meta = [...host.querySelectorAll('.dshMarketCardMeta')].map(node => node.textContent);
    expect(meta).toEqual(['nicopreme1.2M/mo19h ago', 'charly-vibes1,740/mo19h ago']);
    expect(mocks.query).toHaveBeenLastCalledWith({ limit: 50 });

    mocks.query.mockResolvedValue(page([item('pi-skill-one', { categories: ['skill'] })], { total: 305, unfiltered: 5548 }));
    await change(type, 'skill');
    expect(mocks.query).toHaveBeenLastCalledWith({ category: 'skill', limit: 50 });
    await change(order, 'updated');
    expect(mocks.query).toHaveBeenLastCalledWith({ category: 'skill', sort: 'updated', limit: 50 });
    expect(host.querySelector('.dshMarketCount')?.textContent).toBe('1–1 / 305 (of 5,548)');
    await click(button('Reset'));
    expect(mocks.query).toHaveBeenLastCalledWith({ limit: 50 });
    expect(type.value).toBe('');
    expect(order.value).toBe('downloads');
  });

  it('offers an update from Installed, and needs no restart afterwards', async () => {
    mocks.installed.mockResolvedValue([
      { packageName: 'pi-demo', version: '1.0.0', kind: 'plugin', bundle: false, latest: '1.1.0' },
      { packageName: 'folder-plugin', version: '', kind: 'hello', bundle: false },
    ]);
    const preview: MarketPreview = { token: 't', action: 'update', displayName: 'pi-demo', packageName: 'pi-demo', version: '1.1.0', from: '1.0.0', profile: 'Hello’s library', expiresAt: Date.now() + 60_000, compatibility: { ok: true }, hello: { ui: false, skills: false, mcp: false, lines: ['Added to Hello’s library.'] } };
    mocks.previewUpdate.mockResolvedValue(preview);
    mocks.confirm.mockResolvedValue({ action: 'update', packageName: 'pi-demo', version: '1.1.0', installedAt: Date.now() });
    await render();
    await click(button('Installed'));
    expect(host.textContent).toContain('Installed from the market');
    expect(host.textContent).toContain('Imported into Hello.');
    expect(host.textContent).toContain('1.1.0 available');
    await click(button('Update pi-demo to 1.1.0'));
    expect(mocks.previewUpdate).toHaveBeenCalledWith('pi-demo');
    expect(host.textContent).toContain('Confirm package update');
    expect(host.textContent).toContain('Installed version');
    await click(button('Confirm update'));
    expect(mocks.confirm).toHaveBeenCalledWith('t');
    expect(host.textContent).toContain('Package updated');
    expect(host.textContent).toContain('pi-demo is updated to 1.1.0.');
    // Nothing of DSH's is restarted for a Pi package.
    expect(button('Restart now')).toBeUndefined();
    expect(mocks.dshRestart).not.toHaveBeenCalled();
  });

  it('writes downloads and dates the way pi.dev does', () => {
    expect(monthlyDownloads(1740)).toBe('1,740/mo');
    expect(monthlyDownloads(1_151_974)).toBe('1.2M/mo');
    expect(monthlyDownloads(12_000_000)).toBe('12M/mo');
    const now = Date.parse('2026-09-29T12:00:00Z');
    expect(publishedAgo('2026-09-29T11:16:00Z', now)).toBe('44m ago');
    expect(publishedAgo('2026-09-28T17:00:00Z', now)).toBe('19h ago');
    expect(publishedAgo('2026-09-26T12:00:00Z', now)).toBe('3d ago');
    expect(publishedAgo('2026-07-20T12:00:00Z', now)).toBe('2mo ago');
  });
});
