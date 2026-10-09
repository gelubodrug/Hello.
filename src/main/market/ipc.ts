import { ipcMain, type BrowserWindow } from 'electron';
import type { InstalledPlugin, OperationPreview, OperationResult } from './install';
import type { MarketPageView, MarketSourceView } from './types';
import type { CatalogQuery } from './types';

const SORTS = new Set(['downloads', 'updated', 'name', 'stars']);

/** What a market's window may call. A market leaves out what it does not do, and so does its channel list. */
export interface MarketBackend {
  sources(): MarketSourceView[];
  query(query: CatalogQuery & { reload?: boolean }): Promise<MarketPageView>;
  icon(ref: string): Promise<string | null>;
  installed(): InstalledPlugin[] | Promise<InstalledPlugin[]>;
  preview(key: string): Promise<OperationPreview>;
  previewByName(name: string): Promise<OperationPreview>;
  previewUninstall(name: string): OperationPreview | Promise<OperationPreview>;
  previewUpdate?(name: string): Promise<OperationPreview>;
  confirm(token: string): Promise<OperationResult>;
}

export function registerMarketIPC(window: BrowserWindow, market: MarketBackend, options: { channel?: 'piMarket' } = {}): () => void {
  const registered: string[] = [];
  const prefix = options.channel ?? 'piMarket';
  const handle = (name: string, run: (...args: any[]) => unknown) => {
    const channel = `hello:${prefix}.${name}`;
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender.');
      return run(...args);
    });
    registered.push(channel);
  };
  const text = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit ? value : undefined;
  /** Several categories, as the window's pills send them: at most sixteen names. */
  const categories = (value: unknown) => (Array.isArray(value) ? value : [])
    .filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 80)
    .slice(0, 16);
  handle('sources', () => market.sources());
  handle('query', (raw: unknown) => {
    const query = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const sort = text(query.sort, 20);
    const limit = typeof query.limit === 'number' && Number.isSafeInteger(query.limit) ? Math.min(Math.max(query.limit, 1), 200) : undefined;
    return market.query({
      ...(text(query.q, 200)?.trim() ? { q: text(query.q, 200)!.trim() } : {}),
      ...(text(query.category, 80) ? { category: text(query.category, 80) } : {}),
      ...(categories(query.categories).length ? { categories: categories(query.categories) } : {}),
      ...(sort && SORTS.has(sort) ? { sort: sort as 'downloads' } : {}),
      ...(text(query.cursor, 40) ? { cursor: text(query.cursor, 40) } : {}),
      ...(limit ? { limit } : {}),
      ...(query.installable === true ? { installable: true } : {}),
      ...(query.reload === true ? { reload: true } : {}),
    });
  });
  handle('icon', ref => typeof ref === 'string' && /^icon:[\w-]{8,40}$/.test(ref) ? market.icon(ref) : null);
  handle('installed', () => market.installed());
  handle('preview', key => { if (typeof key !== 'string' || key.length > 300) throw new Error('Invalid plugin.'); return market.preview(key); });
  handle('previewByName', name => { if (typeof name !== 'string' || name.length > 214) throw new Error('Invalid package name.'); return market.previewByName(name); });
  handle('previewUninstall', name => { if (typeof name !== 'string' || name.length > 214) throw new Error('Invalid package name.'); return market.previewUninstall(name); });
  const { previewUpdate } = market;
  if (previewUpdate) handle('previewUpdate', name => { if (typeof name !== 'string' || name.length > 214) throw new Error('Invalid package name.'); return previewUpdate.call(market, name); });
  handle('confirm', token => { if (typeof token !== 'string' || token.length > 100) throw new Error('Invalid confirmation.'); return market.confirm(token); });
  return () => { for (const channel of registered) ipcMain.removeHandler(channel); };
}
