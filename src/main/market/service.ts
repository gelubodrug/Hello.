import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DshLayout } from '../dsh/layout';
import type { PnpmInvocation } from '../dsh/pnpm';
import { gt, valid } from 'semver';
import { installedPlugins, MarketInstaller, NPM_REGISTRY_ORIGIN, safePackageName, type InstalledPlugin, type OperationPreview, type OperationResult } from './install';
import { cachedMarketHttp, createMarketHttp, type MarketHttp } from './net';
import { filterScanned, requestedCategories, scanCatalog, type ScannedCatalog } from './scan';
import { DSHFIND_MANIFEST, fetchSourceManifest, fetchStandard, parseSourceManifest, type SourceManifest } from './standard';
import { fetchStore1024, STORE1024_ORIGIN, type CatalogItem, type CatalogPage, type CatalogQuery } from './store1024';

/**
 * The Community Plugin Market, in Hello's main process.
 *
 * The window never names a package to install: it browses items this service
 * handed it under opaque keys, and asks to install one of those — or, typed by
 * the person in Hello's own Settings, a package by name. Icons are fetched
 * here, re-encoded, and handed over as data; the page loads nothing remote.
 */
export interface MarketSourceView {
  id: string;
  name: string;
  description: string;
  homepage: string;
  endpointHost: string;
  builtIn: boolean;
  partner: boolean;
  selected: boolean;
  /** False for a source Hello lists but cannot read yet. */
  available: boolean;
  /** In the person's list of sources; a built-in partner is listed to add until then. */
  added: boolean;
  attribution: { name: string; url: string; notice: string };
}

/** One source in the person's list, kept in `<data>/dsh/market-sources.json`. */
interface SourceRecord {
  id: string;
  kind: 'built-in' | 'standard';
  /** A built-in partner's key. */
  key?: BuiltInKey;
  /** A standard source's manifest URL and the manifest as it was checked when added. */
  manifestUrl?: string;
  manifest?: SourceManifest;
}

interface SourceState { sources: SourceRecord[]; selected?: string }

type BuiltInKey = 'dsh-1024store' | 'dshfind';

export interface MarketItemView {
  key: string;
  name: string;
  summary: string;
  publisher?: string;
  categories: string[];
  repository: string;
  installable: boolean;
  manualCommand?: string;
  sourceName: string;
  /** Opaque: pass to icon() for a data URL. */
  icon?: string;
  installs: number;
  stars: number;
  updatedAt?: string;
}

export interface MarketPageView {
  items: MarketItemView[];
  total: number;
  /** Every entry the source holds, when a filter narrows `total`. */
  unfiltered?: number;
  nextCursor?: string;
  categories: string[];
  generatedAt?: string;
}

/** What Hello holds of a source's whole catalogue (scan.ts), for the window's Catalogue button. */
export interface MarketScanView {
  sourceId: string;
  /** No scan of this source yet. */
  scanned: boolean;
  items: number;
  pages: number;
  /** False when a cap or a stop ended the walk before the source did. */
  complete: boolean;
  at?: number;
  generatedAt?: string;
}

const PARTNER_DESCRIPTION = 'Partner provider catalog. The user must add and enable it explicitly. Being listed does not mean a plugin was reviewed or recommended.';
const NOTICE = 'Community catalog data provided by a cooperating provider.';
const ICON_HOSTS = new Set(['github.com', 'avatars.githubusercontent.com', 'deepseek1024.com']);
const CANDIDATE_LIMIT = 10_000;
const CURSOR_LIMIT = 1_000;
const MAX_SOURCES = 20;

const BUILT_INS: Record<BuiltInKey, Omit<MarketSourceView, 'selected' | 'added'>> = {
  'dsh-1024store': {
    id: 'dsh-1024store', name: 'DSH 1024Store', description: PARTNER_DESCRIPTION, homepage: 'https://deepseek1024.com', endpointHost: new URL(STORE1024_ORIGIN).host,
    builtIn: true, partner: true, available: true,
    attribution: { name: 'DSH 1024Store', url: 'https://deepseek1024.com', notice: NOTICE },
  },
  dshfind: {
    id: 'dshfind', name: 'dshfind', description: PARTNER_DESCRIPTION, homepage: 'https://dshfind.com', endpointHost: new URL(DSHFIND_MANIFEST.endpoint).host,
    builtIn: true, partner: true, available: true,
    attribution: { name: 'dshfind', url: 'https://dshfind.com', notice: NOTICE },
  },
};
const DEFAULT_STATE: SourceState = { sources: [{ id: 'dsh-1024store', kind: 'built-in', key: 'dsh-1024store' }], selected: 'dsh-1024store' };

export class MarketService {
  private http: MarketHttp & { clear(): void };
  private installer: MarketInstaller;
  private candidates = new Map<string, CatalogItem>();
  private icons = new Map<string, string[]>();
  private iconCache = new Map<string, Promise<string | null>>();
  /** Opaque paging tokens → the provider's cursor, for the source and query that produced it. */
  private cursors = new Map<string, { source: string; query: string; value: string }>();
  /** A standard source lists no categories of its own: the ones its pages showed so far stand in. */
  private seenCategories = new Map<string, Set<string>>();
  /** A source read through, by source id: every search of it is then answered here (scan.ts). */
  private scans = new Map<string, ScannedCatalog>();

  constructor(private readonly options: {
    layout: DshLayout;
    pnpm: PnpmInvocation;
    log(line: string): void;
    /** Re-encodes an image to a 128 px PNG data URL, or null when it is not an image. */
    normalizeIcon(bytes: Buffer): string | null;
    http?: MarketHttp;
  }) {
    this.http = options.http ? Object.assign(options.http, { clear() {} }) : cachedMarketHttp(createMarketHttp());
    this.installer = new MarketInstaller({ layout: options.layout, pnpm: options.pnpm, http: this.http, log: options.log });
  }

  private get stateFile(): string {
    return join(this.options.layout.root, 'market-sources.json');
  }

  /** The person's sources. A file that does not read back is the default, not an error. */
  private state(): SourceState {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as { sources?: unknown; selected?: unknown };
      const sources: SourceRecord[] = [];
      for (const entry of Array.isArray(raw.sources) ? raw.sources.slice(0, MAX_SOURCES) : []) {
        const record = entry as Partial<SourceRecord> | null;
        if (!record || typeof record.id !== 'string' || !record.id || sources.some(source => source.id === record.id)) continue;
        if (record.kind === 'built-in' && (record.key === 'dsh-1024store' || record.key === 'dshfind') && record.id === record.key) sources.push({ id: record.id, kind: 'built-in', key: record.key });
        else if (record.kind === 'standard' && typeof record.manifestUrl === 'string') {
          // Checked again on every read: the file is the person's to edit.
          try { sources.push({ id: record.id, kind: 'standard', manifestUrl: record.manifestUrl, manifest: parseSourceManifest(toManifestJson(record.manifest)) }); } catch { /* dropped */ }
        }
      }
      const selected = typeof raw.selected === 'string' && sources.some(source => source.id === raw.selected) ? raw.selected : undefined;
      return { sources, ...(selected ? { selected } : {}) };
    } catch {
      return structuredClone(DEFAULT_STATE);
    }
  }

  private save(state: SourceState): void {
    mkdirSync(this.options.layout.root, { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ sources: state.sources.map(source => (source.manifest ? { ...source, manifest: toManifestJson(source.manifest) } : source)), ...(state.selected ? { selected: state.selected } : {}) }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.stateFile);
    this.cursors.clear();
  }

  private sourceView(record: SourceRecord, selected: boolean): MarketSourceView {
    if (record.key) return { ...BUILT_INS[record.key], selected, added: true };
    const manifest = record.manifest!;
    return {
      id: record.id, name: manifest.name, description: manifest.description ?? manifest.endpoint,
      homepage: manifest.homepage ?? manifest.attribution.url, endpointHost: new URL(manifest.endpoint).host,
      builtIn: false, partner: false, selected, available: true, added: true,
      attribution: { name: manifest.attribution.name, url: manifest.attribution.url, notice: manifest.attribution.notice ?? '' },
    };
  }

  sources(): MarketSourceView[] {
    const state = this.state();
    const added = state.sources.map(record => this.sourceView(record, record.id === state.selected));
    const available = (Object.keys(BUILT_INS) as BuiltInKey[]).filter(key => !state.sources.some(record => record.key === key))
      .map(key => ({ ...BUILT_INS[key], selected: false, added: false }));
    return [...added, ...available];
  }

  /** Adds a built-in partner to the person's list; it becomes the source in use when none is. */
  addSource(key: string): MarketSourceView[] {
    if (key !== 'dsh-1024store' && key !== 'dshfind') throw new Error('Unknown built-in source.');
    const state = this.state();
    if (!state.sources.some(record => record.key === key)) {
      state.sources.push({ id: key, kind: 'built-in', key });
      state.selected ??= key;
      this.save(state);
    }
    return this.sources();
  }

  /** Reads a standard source's manifest from the URL the person typed, checks it, and adds it. */
  async addStandardSource(manifestUrl: string, signal = new AbortController().signal): Promise<MarketSourceView[]> {
    const read = await fetchSourceManifest(this.http, manifestUrl.trim(), signal);
    const state = this.state();
    if (state.sources.some(record => record.manifestUrl === read.manifestUrl || record.manifest?.providerId === read.manifest.providerId || (record.key === 'dshfind' && read.manifest.providerId === DSHFIND_MANIFEST.providerId)))
      throw new Error('This source is already in your list.');
    if (state.sources.length >= MAX_SOURCES) throw new Error(`Hello. keeps at most ${MAX_SOURCES} sources.`);
    const id = `standard-${randomUUID()}`;
    state.sources.push({ id, kind: 'standard', manifestUrl: read.manifestUrl, manifest: read.manifest });
    state.selected ??= id;
    this.save(state);
    return this.sources();
  }

  removeSource(id: string): MarketSourceView[] {
    const state = this.state();
    const next = state.sources.filter(record => record.id !== id);
    if (next.length === state.sources.length) throw new Error('That source is not in your list.');
    const selected = state.selected === id ? next[0]?.id : state.selected;
    this.save({ sources: next, ...(selected ? { selected } : {}) });
    return this.sources();
  }

  selectSource(id: string): MarketSourceView[] {
    const state = this.state();
    if (!state.sources.some(record => record.id === id)) throw new Error('That source is not in your list.');
    this.save({ ...state, selected: id });
    return this.sources();
  }

  /**
   * The person's own order for their sources. The list is the order they put it
   * in — which source is used is `selected`, not the first row — and a source
   * at an end stays there rather than wrapping around.
   */
  moveSource(id: string, direction: 'up' | 'down'): MarketSourceView[] {
    const state = this.state();
    const at = state.sources.findIndex(record => record.id === id);
    if (at < 0) throw new Error('That source is not in your list.');
    const to = direction === 'up' ? at - 1 : at + 1;
    if (to < 0 || to >= state.sources.length) return this.sources();
    const sources = [...state.sources];
    [sources[at], sources[to]] = [sources[to], sources[at]];
    this.save({ ...state, sources });
    return this.sources();
  }

  private view(item: CatalogItem, source: SourceRecord): MarketItemView {
    const key = `${source.key === 'dsh-1024store' ? '1024' : source.id}:${item.id}`;
    this.candidates.delete(key);
    this.candidates.set(key, item);
    while (this.candidates.size > CANDIDATE_LIMIT) this.candidates.delete(this.candidates.keys().next().value as string);
    let icon: string | undefined;
    if (item.icons.length) {
      icon = `icon:${randomBytes(9).toString('base64url')}`;
      this.icons.set(icon, item.icons);
      while (this.icons.size > CANDIDATE_LIMIT) this.icons.delete(this.icons.keys().next().value as string);
    }
    return {
      key,
      name: item.name,
      summary: item.summary,
      ...(item.publisher ? { publisher: item.publisher } : {}),
      categories: item.categories,
      repository: item.repository,
      installable: item.npm !== undefined,
      ...(item.manualCommand ? { manualCommand: item.manualCommand } : {}),
      sourceName: source.key ? BUILT_INS[source.key].name : source.manifest!.name,
      ...(icon ? { icon } : {}),
      installs: item.installs,
      stars: item.stars,
      ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
    };
  }

  /** The selected source, or the reason there is none. */
  private selected(): SourceRecord {
    const state = this.state();
    const source = state.sources.find(record => record.id === state.selected);
    if (!source) throw new Error('No source selected. Choose one under Sources.');
    return source;
  }

  /** One page of a source, by its own paging: 1024Store's page numbers, a standard source's cursors. */
  private readPage(source: SourceRecord, query: CatalogQuery, signal: AbortSignal): Promise<CatalogPage> {
    if (source.key === 'dsh-1024store') return fetchStore1024(this.http, query, signal);
    const manifest = source.key === 'dshfind' ? DSHFIND_MANIFEST : source.manifest!;
    return fetchStandard(this.http, manifest, query, signal);
  }

  scanState(): MarketScanView {
    const source = this.selected();
    const scan = this.scans.get(source.id);
    if (!scan) return { sourceId: source.id, scanned: false, items: 0, pages: 0, complete: false };
    return {
      sourceId: source.id, scanned: true, items: scan.items.length, pages: scan.pages,
      complete: scan.complete, at: scan.at, ...(scan.generatedAt ? { generatedAt: scan.generatedAt } : {}),
    };
  }

  /**
   * Reads the selected source's catalogue through, page by page, and keeps it:
   * after this, every search of that source is answered here — exact counts,
   * any number of categories at once — with no further request. The person asks
   * for it; nothing scans by itself, because it is a few hundred requests to
   * someone else's service.
   */
  async scan(signal = new AbortController().signal): Promise<MarketScanView> {
    const source = this.selected();
    const catalogue = await scanCatalog(
      (cursor, inner) => this.readPage(source, { limit: 200, ...(cursor ? { cursor } : {}) }, inner),
      signal,
    );
    this.scans.set(source.id, catalogue);
    return this.scanState();
  }

  async query(query: CatalogQuery & { reload?: boolean }, signal = new AbortController().signal): Promise<MarketPageView> {
    if (query.reload) this.http.clear();
    const state = this.state();
    const source = state.sources.find(record => record.id === state.selected);
    if (!source) throw new Error('No source selected. Choose one under Sources.');
    // Read through once, answered here ever after: this is the only path that
    // can count what matches and take more than one category.
    if (query.reload) this.scans.delete(source.id);
    const scanned = this.scans.get(source.id);
    if (scanned) {
      const page = filterScanned(scanned, query);
      return {
        items: page.items.map(item => this.view(item, source)), total: page.total,
        ...(page.unfiltered !== undefined ? { unfiltered: page.unfiltered } : {}),
        categories: page.categories,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        ...(page.generatedAt ? { generatedAt: page.generatedAt } : {}),
      };
    }
    // Without a scan, a source's endpoint takes one category: one goes to the
    // source as it always did. For several, Hello asks for none — sending one
    // of them would narrow the page to that one — and keeps the items in any.
    const wanted = requestedCategories(query);
    const narrow = wanted.length > 1;
    query = { ...query, categories: undefined, category: narrow ? undefined : wanted[0] };
    let page: CatalogPage;
    if (source.key === 'dsh-1024store') page = await fetchStore1024(this.http, query, signal);
    else {
      // A standard source's cursor never leaves main: the page gets a token
      // valid only for this source and this search.
      // The categories Hello narrows by are part of the search a cursor belongs
      // to, even though they never reach the source.
      const shape = JSON.stringify([query.q?.trim() ?? '', query.category ?? '', [...wanted].sort(), query.installable === true, query.limit ?? 0, query.sort ?? '']);
      const cursor = query.cursor ? this.cursors.get(query.cursor) : undefined;
      if (query.cursor && (!cursor || cursor.source !== source.id || cursor.query !== shape)) throw new Error('That page of results has expired. Search again.');
      const manifest = source.key === 'dshfind' ? DSHFIND_MANIFEST : source.manifest!;
      page = await fetchStandard(this.http, manifest, { ...query, ...(cursor ? { cursor: cursor.value } : { cursor: undefined }) }, signal);
      const seen = this.seenCategories.get(source.id) ?? new Set<string>();
      for (const category of page.categories) if (seen.size < 100) seen.add(category);
      this.seenCategories.set(source.id, seen);
      page = { ...page, categories: [...seen] };
      if (page.nextCursor) {
        const token = `cursor:${randomBytes(12).toString('base64url')}`;
        this.cursors.set(token, { source: source.id, query: shape, value: page.nextCursor });
        while (this.cursors.size > CURSOR_LIMIT) this.cursors.delete(this.cursors.keys().next().value as string);
        page = { ...page, nextCursor: token };
      }
    }
    const items = narrow ? page.items.filter(item => item.categories.some(category => wanted.includes(category))) : page.items;
    return { items: items.map(item => this.view(item, source)), total: page.total, categories: page.categories, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), ...(page.generatedAt ? { generatedAt: page.generatedAt } : {}) };
  }

  /** An item's icon, fetched and re-encoded here, as a data URL. */
  icon(ref: string): Promise<string | null> {
    const urls = this.icons.get(ref);
    if (!urls) return Promise.resolve(null);
    const cacheKey = urls.join('\n');
    const cached = this.iconCache.get(cacheKey);
    if (cached) return cached;
    const load = (async () => {
      for (const url of urls) {
        try {
          const response = await this.http.getBytes(url, new AbortController().signal, { maxBytes: 1024 * 1024, contentType: /^image\/(?:png|jpeg|webp|gif)$/ });
          if (!ICON_HOSTS.has(new URL(response.finalUrl).hostname.toLowerCase())) continue;
          const data = this.options.normalizeIcon(response.body);
          if (data) return data;
        } catch { /* the next candidate, or the glyph */ }
      }
      return null;
    })();
    this.iconCache.set(cacheKey, load);
    return load;
  }

  /** The profile's plugins, each removable one with npm's newest version when it is newer. */
  async installed(signal = new AbortController().signal): Promise<InstalledPlugin[]> {
    return Promise.all(installedPlugins(this.options.layout).map(async row => {
      if (row.kind !== 'plugin' || !valid(row.version)) return row;
      try {
        const { value } = await this.http.getJson(`${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(row.packageName).replace('%40', '@')}/latest`, signal, { allowedOrigin: NPM_REGISTRY_ORIGIN });
        const latest = (value as { version?: unknown } | null)?.version;
        return typeof latest === 'string' && valid(latest) && gt(latest, row.version) ? { ...row, latest } : row;
      } catch {
        return row;
      }
    }));
  }

  previewUpdate(name: string, signal = new AbortController().signal): Promise<OperationPreview> {
    return this.installer.previewUpdate(name, signal);
  }

  /** The install preview for an item this service listed. */
  preview(key: string, signal = new AbortController().signal): Promise<OperationPreview> {
    const item = this.candidates.get(key);
    if (!item) return Promise.reject(new Error('This plugin is no longer in the list. Refresh and try again.'));
    if (!item.npm) return Promise.reject(new Error('This plugin cannot be installed automatically in Hello.'));
    return this.installer.previewInstall(item.npm, item.name, signal);
  }

  /** The install preview for a package the person typed in Hello’s own Settings. */
  previewByName(name: string, signal = new AbortController().signal): Promise<OperationPreview> {
    const trimmed = name.trim();
    if (!safePackageName(trimmed)) return Promise.reject(new Error('That is not an npm package name.'));
    return this.installer.previewInstall(trimmed, trimmed, signal);
  }

  previewUninstall(name: string): OperationPreview {
    return this.installer.previewUninstall(name);
  }

  /** The install preview for a plugin folder main let the person pick. */
  previewFolder(folder: string): OperationPreview {
    return this.installer.previewFolder(folder);
  }

  confirm(token: string): Promise<OperationResult> {
    return this.installer.confirm(token);
  }
}

/** A checked manifest back in the manifest file's own shape, to store and to check again on read. */
function toManifestJson(manifest: unknown): unknown {
  if (!manifest || typeof manifest !== 'object' || 'manifestVersion' in (manifest as object)) return manifest;
  const value = manifest as SourceManifest;
  return {
    manifestVersion: '1.0.0', providerId: value.providerId, name: value.name,
    ...(value.description !== undefined ? { description: value.description } : {}),
    ...(value.homepage !== undefined ? { homepage: value.homepage } : {}),
    attribution: value.attribution,
    transport: { kind: 'https-json', endpoint: value.endpoint, method: 'GET' },
    query: { supported: value.supported, defaultLimit: value.defaultLimit, maxLimit: value.maxLimit, sorts: value.sorts },
  };
}
