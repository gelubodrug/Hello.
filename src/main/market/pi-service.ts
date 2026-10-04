import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { DataStore, ResourceRow } from '../data/store';
import type { PnpmInvocation } from '../dsh/pnpm';
import { slug, type ResourceLibrary } from '../extensions/library';
import type { LibraryResource } from '../../shared/types';
import { MarketInstallError, NPM_REGISTRY_ORIGIN, safePackageName, type InstalledPlugin, type OperationPreview, type OperationResult } from './install';
import { cachedMarketHttp, createMarketHttp, type MarketHttp } from './net';
import { PiCatalog, type PiPackage } from './pi-catalog';
import { fetchGallery, GALLERY_TYPES, galleryUrl, type GalleryPage } from './pi-gallery';
import { newerVersion, piCompatibility, readPiForHello, stagePiPackage, verifyPiPackage, type PiVerified } from './pi-install';
import type { MarketItemView, MarketPageView, MarketSourceView } from './service';
import type { CatalogQuery } from './store1024';

/**
 * The Pi package market (user, 29.09: "fiecare cu fereastra lui, făcută la
 * fel ca DSH market"), behind the same window as the DSH one.
 *
 * As there, the window never names what gets installed: it browses entries
 * handed to it under opaque keys, and confirms a preview by a one-shot token
 * bound to what the preview checked. A package installs into Hello's library
 * (pi-install.ts, library.ts), where each chat turns it on; what the market
 * installed is listed again under Installed, to update or remove there
 * (user, 29.09: "să știm ce s-a instalat, să poată fi uninstall din același
 * loc sau update la versiune nouă").
 */

const SOURCE: MarketSourceView = {
  id: 'pi-gallery',
  name: 'Pi packages',
  description: 'pi.dev/packages, the official gallery of every npm package marked “pi-package”. Being listed does not mean a package was reviewed or recommended.',
  homepage: 'https://pi.dev/packages',
  endpointHost: 'pi.dev',
  builtIn: true, partner: false, selected: true, available: true, added: true,
  attribution: { name: 'pi.dev/packages', url: 'https://pi.dev/packages', notice: 'Listing from the official Pi gallery; npm’s search stands in when it does not answer. Packages install from the npm registry.' },
};
const ICON_HOSTS = new Set(['github.com', 'avatars.githubusercontent.com']);
const INTENT_TTL_MS = 5 * 60_000;
const KEPT = 10_000;
const CURSORS = 1_000;

/** A market install's source in the library. */
export const npmSource = (name: string) => `npm:${name}`;
export function npmName(source: string): string | undefined {
  const name = source.startsWith('npm:') ? source.slice(4) : '';
  return safePackageName(name) ? name : undefined;
}

interface Intent {
  preview: OperationPreview;
  verified?: PiVerified;
  /** The library row an update or removal acts on, and its version then. */
  rowId?: string;
  rowVersion?: string;
}

export class PiMarketService {
  private readonly http: MarketHttp & { clear(): void };
  private readonly catalog: PiCatalog;
  private candidates = new Map<string, PiPackage>();
  private icons = new Map<string, string[]>();
  private iconCache = new Map<string, Promise<string | null>>();
  /** Where the next page comes from: pi.dev's page number, or an offset into npm's list when pi.dev did not answer. */
  private cursors = new Map<string, { shape: string; from: 'gallery' | 'npm'; at: number }>();
  private gallery = new Map<string, { at: number; page: Promise<GalleryPage & { next?: number }> }>();
  private intents = new Map<string, Intent>();
  private active = false;
  private swept?: Promise<void>;

  constructor(private readonly options: {
    store: Pick<DataStore, 'listResourceRows' | 'getResourceRow' | 'findResourceRow'>;
    library: Pick<ResourceLibrary, 'installPackage' | 'remove'>;
    pnpm: PnpmInvocation;
    /** Where installs are made before they move into the library: on the same disk. */
    stagingDir: string;
    log(line: string): void;
    /** Re-encodes an image to a 128 px PNG data URL, or null when it is not an image. */
    normalizeIcon(bytes: Buffer): string | null;
    /** The library changed: Extensions and the chats' pickers read it again. */
    changed(): void;
    http?: MarketHttp;
    now?: () => number;
  }) {
    this.http = options.http ? Object.assign(options.http, { clear() {} }) : cachedMarketHttp(createMarketHttp());
    this.catalog = new PiCatalog(this.http, () => this.now());
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  sources(): MarketSourceView[] {
    return [SOURCE];
  }

  private view(item: PiPackage): MarketItemView {
    const key = `pi:${randomBytes(12).toString('base64url')}`;
    this.candidates.set(key, item);
    while (this.candidates.size > KEPT) this.candidates.delete(this.candidates.keys().next().value as string);
    let icon: string | undefined;
    if (item.icons.length) {
      icon = `icon:${randomBytes(9).toString('base64url')}`;
      this.icons.set(icon, item.icons);
      while (this.icons.size > KEPT) this.icons.delete(this.icons.keys().next().value as string);
    }
    return {
      key, name: item.name, summary: item.summary,
      ...(item.publisher ? { publisher: item.publisher } : {}),
      categories: item.types, repository: item.repository, installable: true, sourceName: SOURCE.name,
      ...(icon ? { icon } : {}),
      installs: item.installs, stars: 0,
      ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
    };
  }

  /** One pi.dev page, kept for five minutes: Discover and Installable ask for the same. */
  private galleryPage(query: CatalogQuery, page: number, signal: AbortSignal): Promise<GalleryPage & { next?: number }> {
    const request = { ...(query.q ? { q: query.q } : {}), ...(query.category ? { type: query.category } : {}), ...(query.sort ? { sort: query.sort } : {}), page };
    const key = galleryUrl(request);
    const kept = this.gallery.get(key);
    if (kept && this.now() - kept.at < 5 * 60_000) return kept.page;
    const loading = fetchGallery(this.http, request, signal);
    this.gallery.set(key, { at: this.now(), page: loading });
    loading.catch(() => { if (this.gallery.get(key)?.page === loading) this.gallery.delete(key); });
    while (this.gallery.size > 200) this.gallery.delete(this.gallery.keys().next().value as string);
    return loading;
  }

  /**
   * A page of the list: pi.dev's own, with its filters, order and counts
   * (user, 29.09), or npm's search when pi.dev does not answer.
   */
  async query(query: CatalogQuery & { reload?: boolean }, signal = new AbortController().signal): Promise<MarketPageView> {
    if (query.reload) { this.http.clear(); this.gallery.clear(); }
    // The page holds a token valid for this search only, never a position of its own.
    const shape = JSON.stringify([query.q?.trim() ?? '', query.category ?? '', query.sort ?? '', query.limit ?? 0]);
    const cursor = query.cursor ? this.cursors.get(query.cursor) : undefined;
    if (query.cursor && (!cursor || cursor.shape !== shape)) throw new Error('That page of results has expired. Search again.');
    let listed: { items: PiPackage[]; total: number; unfiltered?: number; next?: { from: 'gallery' | 'npm'; at: number }; categories: string[]; generatedAt?: string } | undefined;
    if (!cursor || cursor.from === 'gallery') {
      try {
        const page = await this.galleryPage(query, cursor?.at ?? 1, signal);
        listed = {
          items: page.items, total: page.total, unfiltered: page.all, categories: [...GALLERY_TYPES],
          ...(page.next !== undefined ? { next: { from: 'gallery' as const, at: page.next } } : {}),
        };
      } catch (error) {
        if (signal.aborted || cursor) throw error;
        this.options.log(`Pi market: pi.dev did not answer (${error instanceof Error ? error.message : String(error)}); reading npm instead.`);
      }
    }
    if (!listed) {
      const page = await this.catalog.query(query, cursor?.at ?? 0, signal);
      listed = {
        items: page.items, total: page.total, categories: page.categories,
        ...(page.next !== undefined ? { next: { from: 'npm' as const, at: page.next } } : {}),
        ...(page.loadedAt ? { generatedAt: page.loadedAt } : {}),
      };
    }
    let nextCursor: string | undefined;
    if (listed.next) {
      nextCursor = `cursor:${randomBytes(12).toString('base64url')}`;
      this.cursors.set(nextCursor, { shape, ...listed.next });
      while (this.cursors.size > CURSORS) this.cursors.delete(this.cursors.keys().next().value as string);
    }
    return {
      items: listed.items.map(item => this.view(item)), total: listed.total, categories: listed.categories,
      ...(listed.unfiltered !== undefined ? { unfiltered: listed.unfiltered } : {}),
      ...(nextCursor ? { nextCursor } : {}), ...(listed.generatedAt ? { generatedAt: listed.generatedAt } : {}),
    };
  }

  /** An entry's icon, fetched and re-encoded here, as a data URL. */
  icon(ref: string): Promise<string | null> {
    const urls = this.icons.get(ref);
    if (!urls) return Promise.resolve(null);
    const key = urls.join('\n');
    const cached = this.iconCache.get(key);
    if (cached) return cached;
    const load = (async () => {
      for (const url of urls) {
        try {
          const response = await this.http.getBytes(url, new AbortController().signal, { maxBytes: 1024 * 1024, contentType: /^image\/(?:png|jpeg|webp|gif)$/ });
          if (!ICON_HOSTS.has(new URL(response.finalUrl).hostname.toLowerCase())) continue;
          const data = this.options.normalizeIcon(response.body);
          if (data) return data;
        } catch { /* the glyph */ }
      }
      return null;
    })();
    this.iconCache.set(key, load);
    return load;
  }

  /** The market's installs, by the library row that holds each. */
  private row(name: string): ResourceRow | undefined {
    return this.options.store.listResourceRows().find(row => row.kind === 'plugin' && row.source === npmSource(name));
  }

  /**
   * What is installed: the market's packages, with npm's newest version when
   * it is newer, and the plugins that came into Hello another way.
   */
  async installed(signal = new AbortController().signal): Promise<InstalledPlugin[]> {
    const rows = this.options.store.listResourceRows().filter(row => row.kind === 'plugin');
    const listed = await Promise.all(rows.map(async (row): Promise<InstalledPlugin> => {
      const name = npmName(row.source);
      if (!name) return { packageName: row.name, version: row.version, kind: 'hello', bundle: false };
      let latest: string | undefined;
      try {
        const { value } = await this.http.getJson(`${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(name).replace('%40', '@')}/latest`, signal, { allowedOrigin: NPM_REGISTRY_ORIGIN });
        latest = newerVersion(row.version, (value as { version?: unknown } | null)?.version);
      } catch { /* no update offered while npm does not answer */ }
      return { packageName: name, version: row.version, kind: 'plugin', bundle: false, ...(latest ? { latest } : {}) };
    }));
    return listed.sort((a, b) => Number(a.kind !== 'plugin') - Number(b.kind !== 'plugin') || a.packageName.localeCompare(b.packageName));
  }

  private remember(preview: Omit<OperationPreview, 'token' | 'expiresAt' | 'profile'>, facts: Omit<Intent, 'preview'> = {}): OperationPreview {
    const now = this.now();
    for (const [token, intent] of this.intents) if (intent.preview.expiresAt <= now) this.intents.delete(token);
    const full: OperationPreview = { ...preview, token: randomBytes(32).toString('base64url'), expiresAt: now + INTENT_TTL_MS, profile: 'Hello’s library' };
    this.intents.set(full.token, { preview: full, ...facts });
    return full;
  }

  private async previewInstall(name: string, displayName: string, signal: AbortSignal): Promise<OperationPreview> {
    if (this.row(name)) throw new MarketInstallError('conflict', `${name} is already installed. Update or remove it under Installed.`);
    const clash = this.options.store.findResourceRow('plugin', slug(name));
    if (clash) throw new MarketInstallError('conflict', `Hello’s library already has a plugin named “${clash.name}” (from ${clash.source}). Remove it in Settings › Extensions first.`);
    const verified = await verifyPiPackage(this.http, name, 'latest', signal);
    const fit = piCompatibility(verified.manifest);
    return this.remember({
      action: 'install', displayName, packageName: name, version: verified.version,
      compatibility: { ok: fit.ok, ...(fit.reason ? { reason: fit.reason } : {}) },
      hello: readPiForHello(verified.manifest, fit.warnings),
    }, { verified });
  }

  /** The install preview for an entry this service listed. */
  preview(key: string, signal = new AbortController().signal): Promise<OperationPreview> {
    const item = this.candidates.get(key);
    if (!item) return Promise.reject(new Error('This package is no longer in the list. Refresh and try again.'));
    return this.previewInstall(item.name, item.name, signal);
  }

  /** The install preview for a package the person typed in Hello’s own Settings. */
  previewByName(name: string, signal = new AbortController().signal): Promise<OperationPreview> {
    const trimmed = name.trim();
    if (!safePackageName(trimmed)) return Promise.reject(new Error('That is not an npm package name.'));
    return this.previewInstall(trimmed, trimmed, signal);
  }

  /** Moving an installed package to npm's newest version. */
  async previewUpdate(name: string, signal = new AbortController().signal): Promise<OperationPreview> {
    const row = this.row(name);
    if (!row) throw new MarketInstallError('conflict', `${name} is not installed from the market.`);
    const verified = await verifyPiPackage(this.http, name, 'latest', signal);
    if (!newerVersion(row.version, verified.version)) throw new MarketInstallError('conflict', `${name} ${row.version} is already npm’s newest version.`);
    const fit = piCompatibility(verified.manifest);
    return this.remember({
      action: 'update', displayName: name, packageName: name, version: verified.version, from: row.version,
      compatibility: { ok: fit.ok, ...(fit.reason ? { reason: fit.reason } : {}) },
      hello: readPiForHello(verified.manifest, fit.warnings),
    }, { verified, rowId: row.id, rowVersion: row.version });
  }

  previewUninstall(name: string): OperationPreview {
    const row = this.row(name);
    if (!row) throw new MarketInstallError('conflict', `${name} is not installed from the market.`);
    return this.remember({ action: 'uninstall', displayName: name, packageName: name, version: row.version, compatibility: { ok: true } }, { rowId: row.id, rowVersion: row.version });
  }

  /** Installs a verified version into the library, over the row it replaces when there is one. */
  private async install(verified: PiVerified, rowId?: string): Promise<LibraryResource> {
    await (this.swept ??= rm(this.options.stagingDir, { recursive: true, force: true }).catch(() => {}));
    const staged = await stagePiPackage({ pnpm: this.options.pnpm, stagingDir: this.options.stagingDir, verified, signal: new AbortController().signal, log: this.options.log });
    try {
      return await this.options.library.installPackage(staged.project, verified.name, npmSource(verified.name), rowId);
    } finally {
      // Moved into the library when it succeeded: then there is nothing left here.
      await staged.dispose();
    }
  }

  async confirm(token: string): Promise<OperationResult> {
    const intent = this.intents.get(token);
    this.intents.delete(token);
    if (!intent || intent.preview.expiresAt <= this.now()) throw new MarketInstallError('expired', 'This confirmation has expired. Open the package again.');
    const { preview } = intent;
    if (!preview.compatibility.ok) throw new MarketInstallError('incompatible', preview.compatibility.reason ?? 'Hello cannot run this package.');
    if (this.active) throw new MarketInstallError('busy', 'Another package operation is already running.');
    // The library is as the preview found it, or the person decides again.
    const row = intent.rowId ? this.options.store.listResourceRows().find(item => item.id === intent.rowId) : undefined;
    if (intent.rowId && (!row || row.version !== intent.rowVersion)) throw new MarketInstallError('conflict', `${preview.packageName} changed since this preview. Open it again.`);
    if (preview.action === 'install' && this.row(preview.packageName)) throw new MarketInstallError('conflict', `${preview.packageName} was installed meanwhile.`);
    this.active = true;
    try {
      if (preview.action === 'uninstall') await this.options.library.remove(intent.rowId!);
      else await this.install(intent.verified!, preview.action === 'update' ? intent.rowId : undefined);
      this.options.changed();
      return { action: preview.action, packageName: preview.packageName, ...(preview.version ? { version: preview.version } : {}), installedAt: this.now() };
    } finally {
      this.active = false;
    }
  }

  /**
   * Settings' update for a package the market installed: npm's newest
   * version, installed over it — or the same version again, which repairs a
   * copy that no longer matches.
   */
  async update(row: ResourceRow): Promise<LibraryResource> {
    const name = npmName(row.source);
    if (!name) throw new Error('This plugin was not installed from the Pi market.');
    if (this.active) throw new MarketInstallError('busy', 'Another package operation is already running.');
    this.active = true;
    try {
      const verified = await verifyPiPackage(this.http, name, 'latest', new AbortController().signal);
      const fit = piCompatibility(verified.manifest);
      if (!fit.ok) throw new MarketInstallError('incompatible', fit.reason ?? 'Hello cannot run the newest version.');
      const updated = await this.install(verified, row.id);
      this.options.changed();
      return updated;
    } finally {
      this.active = false;
    }
  }
}
