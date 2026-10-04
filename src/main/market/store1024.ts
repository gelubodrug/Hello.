/**
 * The DSH 1024Store source, ported from dsh-community-market
 * (lib/adapters/dsh-1024store.js, MIT, Anywhere Labs).
 *
 * The provider's paginated v2 API is asked for every page, search and
 * category. Every record is checked field by field and dropped when it does
 * not fit; the one thing taken from its displayed install command is an npm
 * package name, and only from the exact inert shape
 * `dsh plugin --profile <p> add <package>` — the command itself is never
 * kept, shown as runnable or run.
 */
import type { MarketHttp } from './net';

export const STORE1024_ENDPOINT = 'https://deepseek1024.com/api/v2/plugins';
export const STORE1024_ORIGIN = new URL(STORE1024_ENDPOINT).origin;
const MAX_PAGE_SIZE = 200;
const MAX_ITEMS = 100_000;
const OWNER = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const REPOSITORY = /^[a-z0-9._-]{1,100}$/i;
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PROFILE = /^[A-Za-z0-9_-]+$/;
const COMMAND_TOKEN = /^[A-Za-z0-9@:/._#+=-]+$/;
const CATEGORY = /^[a-z0-9][a-z0-9._:-]*$/;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

export interface CatalogItem {
  id: string;
  name: string;
  summary: string;
  publisher?: string;
  categories: string[];
  repository: string;
  /** Set only when the source names an npm package the market may install. */
  npm?: string;
  /** The command the source displays for a target it cannot install, for reference only. */
  manualCommand?: string;
  updatedAt?: string;
  stars: number;
  installs: number;
  /** Candidate icon URLs, best first; fetched by main, never by the page. */
  icons: string[];
}

export interface CatalogPage {
  items: CatalogItem[];
  total: number;
  nextCursor?: string;
  categories: string[];
  generatedAt?: string;
}

export interface CatalogQuery {
  q?: string;
  category?: string;
  sort?: 'downloads' | 'updated' | 'name' | 'stars';
  cursor?: string;
  limit?: number;
  locale?: string;
  /** Installable view: only entries with an npm target. */
  installable?: boolean;
}

export function plainText(value: unknown, max: number, fallback: string): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(value)) return fallback;
  return value;
}

/** The npm package in `dsh plugin --profile <p> add <package>[@version]`, or undefined. */
export function reviewedNpmTarget(install: unknown): string | undefined {
  if (typeof install !== 'string' || install.length > 1024) return undefined;
  const tokens = install.trim().split(/\s+/);
  if (tokens.length !== 6 || tokens[0] !== 'dsh' || tokens[1] !== 'plugin' || tokens[2] !== '--profile' || !PROFILE.test(tokens[3]) || tokens[4] !== 'add' || !tokens.every(token => COMMAND_TOKEN.test(token))) return undefined;
  const target = tokens[5];
  const at = target.startsWith('@') ? target.indexOf('@', target.indexOf('/') + 1) : target.indexOf('@');
  const name = at < 0 ? target : target.slice(0, at);
  return NPM_PACKAGE.test(name) ? name : undefined;
}

function repositoryOf(item: Record<string, unknown>): string | undefined {
  try {
    if (typeof item.url !== 'string') return undefined;
    const url = new URL(item.url);
    const path = url.pathname.split('/').filter(Boolean);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.search || url.hash || path.length !== 2) return undefined;
    const owner = path[0];
    const repository = path[1].replace(/\.git$/i, '');
    if (!OWNER.test(owner) || !REPOSITORY.test(repository)) return undefined;
    return `https://github.com/${owner}/${repository}`;
  } catch {
    return undefined;
  }
}

function iconCandidates(item: Record<string, unknown>, repository: string): string[] {
  const icons: string[] = [];
  const media = item.media as { icon?: { url?: unknown } } | undefined;
  if (media && typeof media === 'object' && typeof media.icon?.url === 'string') {
    try {
      const url = new URL(media.icon.url);
      if (url.protocol === 'https:' && ['deepseek1024.com', 'github.com', 'avatars.githubusercontent.com'].includes(url.hostname.toLowerCase()) && !url.username && !url.hash) icons.push(url.href);
    } catch { /* not offered */ }
  }
  const owner = new URL(repository).pathname.split('/').filter(Boolean)[0];
  if (owner && OWNER.test(owner)) icons.push(`https://github.com/${owner.toLowerCase()}.png?size=96`);
  return icons;
}

export function normalizeItem(entry: unknown, locale?: string): CatalogItem | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const item = entry as Record<string, unknown>;
  const id = plainText(item.id, 201, '');
  const name = plainText(item.name, 120, '');
  if (!id || !name || !ITEM_ID.test(id)) return undefined;
  const repository = repositoryOf(item);
  if (!repository) return undefined;
  const description = item.description && typeof item.description === 'object' && !Array.isArray(item.description) ? item.description as Record<string, unknown> : {};
  const chinese = locale?.toLowerCase().startsWith('zh') ?? false;
  const summary = plainText(chinese ? description.zh ?? description.en : description.en ?? description.zh, 1000, name);
  const category = typeof item.category === 'string' && CATEGORY.test(item.category) ? item.category : undefined;
  const repositoryOwner = new URL(repository).pathname.split('/')[1]?.toLowerCase();
  const suppliedOwner = plainText(item.owner, 120, '');
  const publisher = suppliedOwner && suppliedOwner.toLowerCase() === repositoryOwner ? suppliedOwner : repositoryOwner;
  const npm = reviewedNpmTarget(item.install);
  const manual = !npm && typeof item.install === 'string' && item.install.length <= 1024 && /^dsh plugin /.test(item.install.trim()) && item.install.trim().split(/\s+/).every(token => COMMAND_TOKEN.test(token))
    ? item.install.trim()
    : undefined;
  const pushedAt = typeof item.pushedAt === 'string' && !Number.isNaN(Date.parse(item.pushedAt)) ? new Date(item.pushedAt).toISOString() : undefined;
  return {
    id,
    name,
    summary,
    ...(publisher ? { publisher } : {}),
    categories: category ? [category] : [],
    repository,
    ...(npm ? { npm } : {}),
    ...(manual ? { manualCommand: manual } : {}),
    ...(pushedAt ? { updatedAt: pushedAt } : {}),
    stars: typeof item.stars === 'number' && Number.isFinite(item.stars) ? item.stars : 0,
    installs: typeof item.installCount === 'number' && Number.isFinite(item.installCount) ? item.installCount : 0,
    icons: iconCandidates(item, repository),
  };
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`1024Store ${label} is invalid`);
  return value;
}

export interface ProviderPage { records: unknown[]; page: number; limit: number; total: number; totalPages: number; catalogTotal: number; categories: string[]; generatedAt: string }

/** The provider's page, checked the way the market checks it: a page that does not add up is refused. */
export function parseProviderPage(value: unknown, requestedPage: number, requestedLimit: number): ProviderPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('1024Store response is not an object');
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.plugins)) throw new Error('1024Store plugins page is invalid');
  const limit = integer(raw.limit, 'page limit', 1, MAX_PAGE_SIZE);
  if (limit !== requestedLimit) throw new Error('1024Store changed the requested page limit');
  const total = integer(raw.total, 'query total', 0, MAX_ITEMS);
  const catalogTotal = integer(raw.catalogTotal, 'catalog total', 0, MAX_ITEMS);
  if (total > catalogTotal) throw new Error('1024Store query total exceeds the catalog total');
  const totalPages = integer(raw.totalPages, 'page count', 1, MAX_ITEMS);
  if (totalPages !== Math.max(1, Math.ceil(total / limit))) throw new Error('1024Store page count is inconsistent');
  const page = integer(raw.page, 'page number', 1, totalPages);
  if (page !== Math.min(requestedPage, totalPages)) throw new Error('1024Store returned an unexpected page');
  const expected = total === 0 ? 0 : Math.min(limit, total - (page - 1) * limit);
  if (raw.plugins.length !== expected) throw new Error('1024Store page length is inconsistent');
  if (typeof raw.generatedAt !== 'string' || Number.isNaN(Date.parse(raw.generatedAt))) throw new Error('1024Store generation time is invalid');
  const categories: string[] = [];
  if (Array.isArray(raw.categories)) {
    for (const entry of raw.categories.slice(0, 100)) {
      const id = (entry as { id?: unknown } | null)?.id;
      if (typeof id === 'string' && CATEGORY.test(id) && !categories.includes(id)) categories.push(id);
    }
  }
  return { records: raw.plugins, page, limit, total, totalPages, catalogTotal, categories, generatedAt: new Date(raw.generatedAt).toISOString() };
}

function providerSort(sort: CatalogQuery['sort']): string | undefined {
  return sort === 'name' ? 'name' : sort === 'updated' ? 'active' : sort === 'downloads' ? 'installs' : undefined;
}

export function providerUrl(query: CatalogQuery, page: number, limit: number): string {
  const url = new URL(STORE1024_ENDPOINT);
  url.searchParams.set('page', String(page));
  url.searchParams.set('limit', String(limit));
  if (query.q) url.searchParams.set('q', query.q.slice(0, 200));
  if (query.category && CATEGORY.test(query.category)) url.searchParams.set('category', query.category);
  const sort = providerSort(query.sort);
  if (sort) url.searchParams.set('sort', sort);
  return url.href;
}

function cursorPage(cursor: string | undefined): number {
  if (cursor === undefined) return 1;
  const match = /^page:(\d+)$/.exec(cursor);
  const page = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(page) || page < 2 || page > MAX_ITEMS) throw new Error('1024Store cursor is invalid');
  return page;
}

async function readPage(http: MarketHttp, query: CatalogQuery, page: number, limit: number, signal: AbortSignal): Promise<ProviderPage> {
  const response = await http.getJson(providerUrl(query, page, limit), signal, { allowedOrigin: STORE1024_ORIGIN });
  if (new URL(response.finalUrl).origin !== STORE1024_ORIGIN) throw new Error('1024Store response changed the reviewed provider origin');
  return parseProviderPage(response.value, page, limit);
}

/** One page of the catalog. The installable view keeps only npm targets, reading 200 entries per batch. */
export async function fetchStore1024(http: MarketHttp, query: CatalogQuery, signal: AbortSignal): Promise<CatalogPage> {
  const page = cursorPage(query.cursor);
  const limit = query.installable ? MAX_PAGE_SIZE : Math.min(Math.max(query.limit ?? 50, 1), MAX_PAGE_SIZE);
  const read = await readPage(http, query, page, limit, signal);
  const items = read.records.map(entry => normalizeItem(entry, query.locale)).filter((item): item is CatalogItem => item !== undefined)
    .filter(item => !query.installable || item.npm !== undefined);
  return {
    items,
    total: read.total,
    categories: read.categories,
    generatedAt: read.generatedAt,
    ...(read.page < read.totalPages ? { nextCursor: `page:${read.page + 1}` } : {}),
  };
}
