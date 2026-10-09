import { dialog, ipcMain, type BrowserWindow } from 'electron';
import type { InstalledPlugin, OperationPreview, OperationResult } from './install';
import type { MarketPageView, MarketScanView, MarketSourceView } from './service';
import type { CatalogQuery } from './store1024';

const SORTS = new Set(['downloads', 'updated', 'name', 'stars']);

/** What a market's window may call. A market leaves out what it does not do, and so does its channel list. */
export interface MarketBackend {
  sources(): MarketSourceView[];
  addSource?(key: string): MarketSourceView[];
  addStandardSource?(manifestUrl: string): Promise<MarketSourceView[]>;
  removeSource?(id: string): MarketSourceView[];
  selectSource?(id: string): MarketSourceView[];
  moveSource?(id: string, direction: 'up' | 'down'): MarketSourceView[];
  /** Reading the selected source's whole catalogue, and what is held of it. */
  scan?(): Promise<MarketScanView>;
  scanState?(): MarketScanView;
  query(query: CatalogQuery & { reload?: boolean }): Promise<MarketPageView>;
  icon(ref: string): Promise<string | null>;
  installed(): InstalledPlugin[] | Promise<InstalledPlugin[]>;
  preview(key: string): Promise<OperationPreview>;
  previewByName(name: string): Promise<OperationPreview>;
  previewUninstall(name: string): OperationPreview | Promise<OperationPreview>;
  previewUpdate?(name: string): Promise<OperationPreview>;
  previewFolder?(folder: string): OperationPreview;
  confirm(token: string): Promise<OperationResult>;
}

/**
 * The window's handles on one market: the DSH one on `hello:market.*`, the Pi
 * one on `hello:piMarket.*`. Only the app's own top frame may call.
 */
export function registerMarketIPC(window: BrowserWindow, market: MarketBackend, options: { channel?: 'market' | 'piMarket'; folderTitle?: string } = {}): () => void {
  const registered: string[] = [];
  const prefix = options.channel ?? 'market';
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
  const sourceId = (value: unknown) => { if (typeof value !== 'string' || !/^[\w-]{1,80}$/.test(value)) throw new Error('Invalid source.'); return value; };
  const { addSource, addStandardSource, removeSource, selectSource, moveSource, scan, scanState, previewUpdate, previewFolder } = market;
  if (addSource) handle('addSource', key => addSource.call(market, sourceId(key)));
  if (addStandardSource) handle('addStandardSource', url => { if (typeof url !== 'string' || !url.trim() || url.length > 2048) throw new Error('Enter the source manifest URL.'); return addStandardSource.call(market, url); });
  if (removeSource) handle('removeSource', id => removeSource.call(market, sourceId(id)));
  if (selectSource) handle('selectSource', id => selectSource.call(market, sourceId(id)));
  if (moveSource) handle('moveSource', (id, direction) => {
    if (direction !== 'up' && direction !== 'down') throw new Error('Invalid direction.');
    return moveSource.call(market, sourceId(id), direction);
  });
  if (scan) handle('scan', () => scan.call(market));
  if (scanState) handle('scanState', () => scanState.call(market));
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
  if (previewUpdate) handle('previewUpdate', name => { if (typeof name !== 'string' || name.length > 214) throw new Error('Invalid package name.'); return previewUpdate.call(market, name); });
  if (previewFolder) handle('previewFolder', async () => {
    // The folder is chosen here, in main: the page never names a path.
    const picked = await dialog.showOpenDialog(window, { title: options.folderTitle ?? 'Add a DSH plugin from a folder', properties: ['openDirectory'], buttonLabel: 'Add plugin' });
    if (picked.canceled || !picked.filePaths[0]) return null;
    return previewFolder.call(market, picked.filePaths[0]);
  });
  handle('confirm', token => { if (typeof token !== 'string' || token.length > 100) throw new Error('Invalid confirmation.'); return market.confirm(token); });
  return () => { for (const channel of registered) ipcMain.removeHandler(channel); };
}
