/**
 * Standard catalog sources and dshfind, ported from dsh-community-market
 * (lib/adapters/standard-http.js, lib/adapters/dshfind.js,
 * lib/contracts/validate.js and query.js, and the catalog-source and
 * catalog-provider-page schemas; MIT, Anywhere Labs).
 *
 * A standard source is a manifest the person registers by URL. It names one
 * HTTPS endpoint on the manifest's own origin, ending in /v1/plugins, and the
 * query features it answers. Its pages, like every catalog page, are
 * untrusted: checked field by field, a page that does not fit is refused, an
 * item that does not fit is dropped. dshfind is a built-in standard source.
 */
import type { MarketHttp } from './net';
import type { CatalogItem, CatalogPage, CatalogQuery } from './store1024';

const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
const PROVIDER_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
const CATEGORY = /^[a-z0-9][a-z0-9._:-]*$/;
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const OWNER = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const REPOSITORY = /^[a-z0-9._-]{1,100}$/i;
const QUERY_FEATURES = ['q', 'category', 'capability', 'cursor', 'limit', 'sort', 'locale'] as const;
const SORTS = ['relevance', 'updated', 'name', 'downloads'] as const;
/** The market checks a page against a limit of at most 100, whatever a manifest allows. */
const MAX_PAGE_LIMIT = 100;

export class StandardSourceError extends Error {}

export interface SourceManifest {
  providerId: string;
  name: string;
  description?: string;
  homepage?: string;
  attribution: { name: string; url: string; notice?: string };
  endpoint: string;
  supported: string[];
  defaultLimit: number;
  maxLimit: number;
  sorts: string[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max: number, min = 1): string | undefined {
  if (typeof value !== 'string' || value.length < min || value.length > max || UNSAFE_TEXT.test(value)) return undefined;
  return value;
}

/** An https URL with no credentials, no explicit port and no fragment. */
function httpsUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function integer(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

function onlyKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const extra = Object.keys(value).find(key => !keys.includes(key));
  if (extra) throw new StandardSourceError(`${label} has an unknown field: ${extra.slice(0, 40)}`);
}

/** A catalog-source manifest, checked as the schema and the market's semantic rules check it. */
export function parseSourceManifest(value: unknown): SourceManifest {
  if (!object(value)) throw new StandardSourceError('The source manifest is not an object.');
  onlyKeys(value, ['manifestVersion', 'providerId', 'name', 'description', 'homepage', 'attribution', 'transport', 'query'], 'The source manifest');
  if (value.manifestVersion !== '1.0.0') throw new StandardSourceError('The source manifest version is not 1.0.0.');
  const providerId = typeof value.providerId === 'string' && value.providerId.length >= 3 && value.providerId.length <= 128 && PROVIDER_ID.test(value.providerId) ? value.providerId : undefined;
  if (!providerId) throw new StandardSourceError('The source manifest has no valid providerId.');
  const name = text(value.name, 120);
  if (!name) throw new StandardSourceError('The source manifest has no valid name.');
  const description = value.description === undefined ? undefined : text(value.description, 500, 0);
  if (value.description !== undefined && description === undefined) throw new StandardSourceError('The source description is invalid.');
  const homepage = value.homepage === undefined ? undefined : httpsUrl(value.homepage)?.href;
  if (value.homepage !== undefined && !homepage) throw new StandardSourceError('The source homepage is invalid.');
  const attribution = value.attribution;
  if (!object(attribution)) throw new StandardSourceError('The source manifest has no attribution.');
  onlyKeys(attribution, ['name', 'url', 'notice'], 'The source attribution');
  const attributionName = text(attribution.name, 120);
  const attributionUrl = httpsUrl(attribution.url)?.href;
  const notice = attribution.notice === undefined ? undefined : text(attribution.notice, 500, 0);
  if (!attributionName || !attributionUrl || (attribution.notice !== undefined && notice === undefined)) throw new StandardSourceError('The source attribution is invalid.');
  const transport = value.transport;
  if (!object(transport)) throw new StandardSourceError('The source manifest has no transport.');
  onlyKeys(transport, ['kind', 'endpoint', 'method'], 'The source transport');
  const endpoint = httpsUrl(transport.endpoint);
  if (transport.kind !== 'https-json' || transport.method !== 'GET' || !endpoint || endpoint.search || !endpoint.pathname.endsWith('/v1/plugins'))
    throw new StandardSourceError('The source endpoint must be credential-free HTTPS on port 443, without query or fragment, ending in /v1/plugins.');
  const query = value.query;
  if (!object(query)) throw new StandardSourceError('The source manifest has no query block.');
  onlyKeys(query, ['supported', 'defaultLimit', 'maxLimit', 'sorts'], 'The source query block');
  const supported = Array.isArray(query.supported) && query.supported.length <= 7 && query.supported.every(item => (QUERY_FEATURES as readonly unknown[]).includes(item)) && new Set(query.supported).size === query.supported.length
    ? query.supported as string[] : undefined;
  const sorts = Array.isArray(query.sorts) && query.sorts.length <= 4 && query.sorts.every(item => (SORTS as readonly unknown[]).includes(item)) && new Set(query.sorts).size === query.sorts.length
    ? query.sorts as string[] : undefined;
  const defaultLimit = integer(query.defaultLimit, 1, 200);
  const maxLimit = integer(query.maxLimit, 1, 200);
  if (!supported || !sorts || defaultLimit === undefined || maxLimit === undefined) throw new StandardSourceError('The source query block is invalid.');
  if (defaultLimit > maxLimit) throw new StandardSourceError('The source defaultLimit exceeds its maxLimit.');
  if (supported.includes('sort') !== (sorts.length > 0)) throw new StandardSourceError('The source sorts do not match whether it supports sort.');
  return {
    providerId, name,
    ...(description ? { description } : {}),
    ...(homepage ? { homepage } : {}),
    attribution: { name: attributionName, url: attributionUrl, ...(notice ? { notice } : {}) },
    endpoint: endpoint.href, supported, defaultLimit, maxLimit, sorts,
  };
}

/** The manifest the market ships for dshfind (lib/adapters/dshfind.js), the same one api.dshfind.com serves. */
export const DSHFIND_MANIFEST: SourceManifest = {
  providerId: 'com.dshfind.catalog',
  name: 'dshfind',
  description: 'Community catalog of DeepSeek Harness plugins indexed by dshfind.',
  homepage: 'https://dshfind.com',
  attribution: { name: 'dshfind', url: 'https://dshfind.com' },
  endpoint: 'https://api.dshfind.com/market/v1/plugins',
  supported: ['q', 'category', 'cursor', 'limit'],
  defaultLimit: 50,
  maxLimit: 100,
  sorts: [],
};

/** How many items a page for this query may hold. */
export function pageLimit(manifest: SourceManifest, requested: number | undefined): number {
  const limit = manifest.supported.includes('limit') ? Math.min(requested ?? 50, manifest.maxLimit) : manifest.defaultLimit;
  return Math.max(1, Math.min(limit, MAX_PAGE_LIMIT));
}

/** The request URL for one page: only the features the source declares. */
export function standardUrl(manifest: SourceManifest, query: CatalogQuery, limit: number): string {
  const url = new URL(manifest.endpoint);
  const supports = (feature: string) => manifest.supported.includes(feature);
  const q = query.q?.trim();
  if (supports('q') && q) url.searchParams.set('q', q.slice(0, 200));
  if (supports('category') && query.category && CATEGORY.test(query.category)) url.searchParams.append('category', query.category);
  if (supports('cursor') && query.cursor) url.searchParams.set('cursor', query.cursor);
  if (supports('limit')) url.searchParams.set('limit', String(limit));
  const sort = query.sort === 'downloads' ? 'downloads' : query.sort === 'updated' ? 'updated' : query.sort === 'name' ? 'name' : undefined;
  if (supports('sort') && sort && manifest.sorts.includes(sort)) url.searchParams.set('sort', sort);
  if (supports('locale') && query.locale && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(query.locale)) url.searchParams.set('locale', query.locale);
  return url.href;
}

function githubRepository(value: unknown): string | undefined {
  if (!object(value)) return undefined;
  const url = httpsUrl(value.url);
  if (!url || url.hostname.toLowerCase() !== 'github.com' || url.search) return undefined;
  const path = url.pathname.split('/').filter(Boolean);
  if (path.length !== 2) return undefined;
  const owner = path[0];
  const repository = path[1].replace(/\.git$/i, '');
  return OWNER.test(owner) && REPOSITORY.test(repository) ? `https://github.com/${owner}/${repository}` : undefined;
}

/** One item of a standard page as the market's catalog item, or undefined when it does not fit. */
export function normalizeStandardItem(entry: unknown): CatalogItem | undefined {
  if (!object(entry)) return undefined;
  const id = typeof entry.id === 'string' && entry.id.length <= 160 && ITEM_ID.test(entry.id) ? entry.id : undefined;
  const name = text(entry.displayName, 120) ?? text(entry.name, 160);
  const summary = text(entry.summary, 1000);
  if (!id || !name || !summary) return undefined;
  const pkg = object(entry.package) && entry.package.registry === 'npm' && typeof entry.package.name === 'string' && entry.package.name.length <= 214 && NPM_PACKAGE.test(entry.package.name)
    ? entry.package.name : undefined;
  const github = githubRepository(entry.repository);
  // The schema needs a repository or a package; a link is kept only to GitHub or npm.
  const repository = github ?? (pkg ? `https://www.npmjs.com/package/${pkg}` : undefined);
  if (!repository) return undefined;
  const categories = Array.isArray(entry.categories)
    ? [...new Set(entry.categories.filter((item): item is string => typeof item === 'string' && item.length <= 64 && CATEGORY.test(item)))].slice(0, 32)
    : [];
  const owner = github ? new URL(github).pathname.split('/')[1] : undefined;
  const suppliedPublisher = object(entry.publisher) ? text(entry.publisher.name, 120) : undefined;
  const publisher = suppliedPublisher ?? owner;
  const updatedAt = typeof entry.updatedAt === 'string' && !Number.isNaN(Date.parse(entry.updatedAt)) ? new Date(entry.updatedAt).toISOString() : undefined;
  return {
    id,
    name,
    summary,
    ...(publisher ? { publisher } : {}),
    categories,
    repository,
    ...(pkg ? { npm: pkg } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    stars: 0,
    installs: 0,
    icons: owner ? [`https://github.com/${owner.toLowerCase()}.png?size=96`] : [],
  };
}

export interface StandardPage { records: unknown[]; nextCursor?: string; total?: number; generatedAt?: string }

/** A provider page, checked as parseCatalogProviderPage checks it. */
export function parseStandardPage(value: unknown, limit: number): StandardPage {
  if (!object(value)) throw new StandardSourceError('The catalog page is not an object.');
  onlyKeys(value, ['schemaVersion', 'generatedAt', 'revision', 'items', 'page'], 'The catalog page');
  if (value.schemaVersion !== '1.0.0') throw new StandardSourceError('The catalog page version is not 1.0.0.');
  if (!Array.isArray(value.items) || value.items.length > 200) throw new StandardSourceError('The catalog page items are invalid.');
  if (value.items.length > limit) throw new StandardSourceError(`The catalog page holds more than the requested ${limit} items.`);
  const seen = new Set<string>();
  for (const item of value.items) {
    const id = object(item) && typeof item.id === 'string' ? item.id : undefined;
    if (!id) throw new StandardSourceError('A catalog item has no id.');
    if (seen.has(id)) throw new StandardSourceError('The catalog page repeats an item id.');
    seen.add(id);
  }
  if (!object(value.page)) throw new StandardSourceError('The catalog page has no page block.');
  onlyKeys(value.page, ['nextCursor', 'total'], 'The catalog page block');
  const nextCursor = value.page.nextCursor;
  if (nextCursor !== undefined && (typeof nextCursor !== 'string' || !nextCursor.length || nextCursor.length > 2048)) throw new StandardSourceError('The catalog page cursor is invalid.');
  const total = value.page.total;
  if (total !== undefined && integer(total, 0, Number.MAX_SAFE_INTEGER) === undefined) throw new StandardSourceError('The catalog page total is invalid.');
  const generatedAt = typeof value.generatedAt === 'string' && !Number.isNaN(Date.parse(value.generatedAt)) ? new Date(value.generatedAt).toISOString() : undefined;
  return { records: value.items, ...(nextCursor ? { nextCursor } : {}), ...(typeof total === 'number' ? { total } : {}), ...(generatedAt ? { generatedAt } : {}) };
}

/** Reads and checks a manifest the person gave by URL; the endpoint must share its origin. */
export async function fetchSourceManifest(http: MarketHttp, manifestUrl: string, signal: AbortSignal): Promise<{ manifest: SourceManifest; manifestUrl: string }> {
  const url = httpsUrl(manifestUrl);
  if (!url || url.search) throw new StandardSourceError('Enter an https:// manifest URL without a port, query or fragment.');
  const response = await http.getJson(url.href, signal, { allowedOrigin: url.origin });
  if (new URL(response.finalUrl).origin !== url.origin) throw new StandardSourceError('The manifest moved to another origin.');
  const manifest = parseSourceManifest(response.value);
  if (new URL(manifest.endpoint).origin !== url.origin) throw new StandardSourceError('The source endpoint must be on the manifest’s own origin.');
  return { manifest, manifestUrl: url.href };
}

/** One page from a standard source. The installable view keeps only items with an npm package. */
export async function fetchStandard(http: MarketHttp, manifest: SourceManifest, query: CatalogQuery, signal: AbortSignal): Promise<CatalogPage> {
  const origin = new URL(manifest.endpoint).origin;
  const limit = pageLimit(manifest, query.installable ? MAX_PAGE_LIMIT : query.limit);
  const response = await http.getJson(standardUrl(manifest, query, limit), signal, { allowedOrigin: origin });
  if (new URL(response.finalUrl).origin !== origin) throw new StandardSourceError('The catalog response changed the registered source origin.');
  const page = parseStandardPage(response.value, limit);
  const items = page.records.map(normalizeStandardItem).filter((item): item is CatalogItem => item !== undefined)
    .filter(item => !query.installable || item.npm !== undefined);
  const categories = [...new Set(items.flatMap(item => item.categories))];
  return {
    items,
    total: page.total ?? items.length,
    categories,
    ...(page.generatedAt ? { generatedAt: page.generatedAt } : {}),
    ...(page.nextCursor && manifest.supported.includes('cursor') ? { nextCursor: page.nextCursor } : {}),
  };
}
