/**
 * The Pi package catalog, read from the npm registry (user, 29.09).
 *
 * pi.dev/packages is the gallery people know, but it has no API; it lists
 * the npm packages carrying the "pi-package" keyword, and so does this. npm's
 * search answers 250 at a time, reaches only its first 5250 results, cannot
 * sort and does not filter on free text, and it turns a quick run of requests
 * away (about ten in a row). So the list is read a page at a time, kept for
 * half an hour, and searched, sorted and paged here. A package's types follow
 * pi.dev's own rule, from its keywords: extension, skill, prompt, theme — and
 * "package" for one that names none.
 */
import { MarketNetworkError, type MarketHttp } from './net';
import { safePackageName } from './install';
import type { CatalogQuery } from './store1024';

export const NPM_ORIGIN = 'https://registry.npmjs.org';
export const NPM_SEARCH = `${NPM_ORIGIN}/-/v1/search`;
const PAGE_SIZE = 250;
/** npm answers from=0 for anything past this. */
const LAST_FROM = 5000;
/** The first thousand, read one request after another when the market opens. */
const FIRST_PAGES = 4;
const KEPT_MS = 30 * 60_000;
const RELOAD_EVERY_MS = 60_000;
export const PI_TYPES = ['extension', 'skill', 'prompt', 'theme', 'package'] as const;

export interface PiPackage {
  name: string;
  summary: string;
  publisher?: string;
  types: string[];
  keywords: string[];
  /** Where to read about it: its repository, else its npm page. */
  repository: string;
  /** Downloads in the last month. */
  installs: number;
  updatedAt?: string;
  /** Candidate icons: its GitHub owner's avatar. */
  icons: string[];
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** pi.dev's type rule: a keyword X, Xs, pi-X or pi-Xs names the type; none makes it a "package". */
export function piTypes(keywords: readonly string[]): string[] {
  const types = new Set<string>();
  for (const keyword of keywords) {
    const word = keyword.toLowerCase().replace(/^pi-/, '').replace(/s$/, '');
    if (word === 'extension' || word === 'skill' || word === 'theme') types.add(word);
    else if (word === 'prompt' || word === 'prompt-template') types.add('prompt');
  }
  return types.size ? PI_TYPES.filter(type => types.has(type)) : ['package'];
}

/** A repository link a person can open: GitHub's in its plain form, another https host as given. */
export function repositoryUrl(links: Record<string, unknown>): string | undefined {
  const raw = typeof links.repository === 'string' ? links.repository.slice(0, 500) : '';
  const github = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(raw);
  if (github) return `https://github.com/${github[1]}/${github[2]}`;
  try {
    const url = new URL(raw.replace(/^git\+/, ''));
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href.replace(/\.git$/, '');
  } catch { /* none */ }
  return undefined;
}

/** One npm search result as a catalog entry; null for anything that is not a well-formed Pi package. */
export function normalizePiObject(raw: unknown): PiPackage | null {
  const object = record(raw);
  const found = record(object.package);
  const name = found.name;
  if (!safePackageName(name)) return null;
  const keywords = (Array.isArray(found.keywords) ? found.keywords : [])
    .filter((word): word is string => typeof word === 'string').slice(0, 40).map(word => text(word, 60)).filter(Boolean);
  const maintainer = record(Array.isArray(found.maintainers) ? found.maintainers[0] : undefined).username;
  const publisher = typeof maintainer === 'string' && /^[\w.-]{1,100}$/.test(maintainer) ? maintainer : undefined;
  const repository = repositoryUrl(record(found.links)) ?? `https://www.npmjs.com/package/${name}`;
  const owner = /^https:\/\/github\.com\/([^/]+)\//.exec(repository)?.[1];
  const monthly = record(object.downloads).monthly;
  const date = typeof found.date === 'string' && Number.isFinite(Date.parse(found.date)) ? new Date(found.date).toISOString() : undefined;
  return {
    name,
    summary: text(found.description, 500) || 'No description.',
    ...(publisher ? { publisher } : {}),
    types: piTypes(keywords),
    keywords,
    repository,
    installs: typeof monthly === 'number' && Number.isFinite(monthly) && monthly >= 0 ? Math.round(monthly) : 0,
    ...(date ? { updatedAt: date } : {}),
    icons: owner ? [`https://github.com/${owner}.png?size=96`] : [],
  };
}

/** Whether every word of a search is in the name, description, keywords or author, as pi.dev searches. */
function matches(item: PiPackage, words: string[]): boolean {
  const haystack = `${item.name} ${item.summary} ${item.keywords.join(' ')} ${item.publisher ?? ''}`.toLowerCase();
  return words.every(word => haystack.includes(word));
}

export interface PiCatalogPage {
  items: PiPackage[];
  total: number;
  /** Where the next page starts, when there is one. */
  next?: number;
  categories: string[];
  loadedAt?: string;
}

export class PiCatalog {
  private packages = new Map<string, PiPackage>();
  private nextFrom = 0;
  private total = 0;
  private loadedAt = 0;
  private reloadedAt = 0;
  private loading?: Promise<void>;
  /** Searches already asked of npm, so a search reaches past the first thousand once. */
  private searched = new Set<string>();

  constructor(private readonly http: MarketHttp, private readonly now: () => number = () => Date.now()) {}

  private async page(query: string, from: number, signal: AbortSignal): Promise<{ items: PiPackage[]; total: number }> {
    const url = new URL(NPM_SEARCH);
    url.searchParams.set('text', query);
    url.searchParams.set('size', String(PAGE_SIZE));
    url.searchParams.set('from', String(from));
    let value: unknown;
    try {
      ({ value } = await this.http.getJson(url.href, signal, { allowedOrigin: NPM_ORIGIN }));
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(error instanceof MarketNetworkError && error.code === 'http'
        ? 'npm is turning requests away for the moment. Try again in a minute.'
        : 'The npm registry did not answer. Try again in a minute.');
    }
    const answer = record(value);
    const objects = Array.isArray(answer.objects) ? answer.objects : [];
    return {
      items: objects.map(normalizePiObject).filter((item): item is PiPackage => item !== null && item.keywords.includes('pi-package')),
      total: typeof answer.total === 'number' && answer.total >= 0 ? answer.total : 0,
    };
  }

  private more(): boolean {
    return this.nextFrom <= LAST_FROM && (!this.loadedAt || this.nextFrom < this.total);
  }

  private async loadNext(signal: AbortSignal): Promise<void> {
    const page = await this.page('keywords:pi-package', this.nextFrom, signal);
    this.total = page.total;
    for (const item of page.items) if (!this.packages.has(item.name)) this.packages.set(item.name, item);
    this.nextFrom = page.items.length ? this.nextFrom + PAGE_SIZE : LAST_FROM + 1;
  }

  /** The first thousand, read once and kept for half an hour; a refresh at most once a minute. */
  private async ensure(signal: AbortSignal, reload: boolean): Promise<void> {
    const expired = this.loadedAt > 0 && this.now() - this.loadedAt >= KEPT_MS;
    if ((reload && this.now() - this.reloadedAt >= RELOAD_EVERY_MS) || expired) {
      this.reloadedAt = this.now();
      this.packages.clear();
      this.searched.clear();
      this.nextFrom = 0;
      this.loadedAt = 0;
    }
    if (this.loadedAt) return;
    this.loading ??= (async () => {
      try {
        for (let index = 0; index < FIRST_PAGES && this.nextFrom <= LAST_FROM; index += 1) await this.loadNext(signal);
      } catch (error) {
        // What arrived before npm turned us away is still the catalog.
        if (!this.packages.size) throw error;
      } finally {
        if (this.packages.size) this.loadedAt = this.now();
        this.loading = undefined;
      }
    })();
    await this.loading;
  }

  async query(query: CatalogQuery & { reload?: boolean }, offset: number, signal: AbortSignal): Promise<PiCatalogPage> {
    await this.ensure(signal, query.reload === true);
    const words = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
    const search = words.join(' ');
    // npm ranks a search by relevance over all 5250: one request finds the
    // matches the first thousand do not hold. Its answer still only ranks, so
    // the words are matched here.
    if (search && !this.searched.has(search)) {
      this.searched.add(search);
      try {
        for (const item of (await this.page(`keywords:pi-package ${search}`, 0, signal)).items)
          if (!this.packages.has(item.name)) this.packages.set(item.name, item);
      } catch (error) {
        if (signal.aborted) throw error;
        this.searched.delete(search);
      }
    }
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const listed = () => {
      let list = [...this.packages.values()];
      if (words.length) list = list.filter(item => matches(item, words));
      if (query.category) list = list.filter(item => item.types.includes(query.category!));
      return list.sort(query.sort === 'name' ? (a, b) => a.name.localeCompare(b.name)
        : query.sort === 'updated' ? (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || b.installs - a.installs
          : (a, b) => b.installs - a.installs || a.name.localeCompare(b.name));
    };
    let list = listed();
    // Past what is here: npm's next page, one per request for more.
    if (offset + limit > list.length && !words.length && this.more()) {
      try { await this.loadNext(signal); } catch (error) { if (signal.aborted) throw error; }
      list = listed();
    }
    const items = list.slice(offset, offset + limit);
    const present = new Set([...this.packages.values()].flatMap(item => item.types));
    const hasNext = offset + limit < list.length || (!words.length && this.more());
    return {
      items,
      total: words.length || query.category ? list.length : Math.max(this.total, list.length),
      ...(hasNext ? { next: offset + limit } : {}),
      categories: PI_TYPES.filter(type => present.has(type)),
      ...(this.loadedAt ? { loadedAt: new Date(this.loadedAt).toISOString() } : {}),
    };
  }
}
