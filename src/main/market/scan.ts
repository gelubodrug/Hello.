import type { CatalogItem, CatalogPage, CatalogQuery } from './store1024';

/**
 * The whole of one source's catalogue, read once and answered locally.
 *
 * A source's own search is one page at a time and one category at a time:
 * dshfind holds about 13,000 plugins, 50 to a page, and its endpoint takes a
 * single `category`. Browsing it that way can neither count what matches nor
 * answer "any of these categories". So the person can ask Hello to read the
 * catalogue through — the same pages, the same cursors, nothing else — and
 * every search after that is answered from what came back: exact totals, any
 * number of categories, instantly, with no further request.
 *
 * It is bounded on purpose: a cursor that repeats itself ends the walk, and so
 * do the page and item caps, because the far end of someone else's pagination
 * is not somewhere to go on forever.
 */
export interface ScannedCatalog {
  items: CatalogItem[];
  /** Every category the pages named, sorted. */
  categories: string[];
  /** The newest `generatedAt` any page carried. */
  generatedAt?: string;
  /** False when a cap or an abort ended the walk before the source did. */
  complete: boolean;
  pages: number;
  at: number;
}

export interface ScanLimits { pages: number; items: number }

/** dshfind is ~261 pages of 50. Twice that, and 20,000 items, is the ceiling. */
export const SCAN_LIMITS: ScanLimits = { pages: 600, items: 20_000 };

export interface ScanProgress { items: number; pages: number; complete: boolean }

/**
 * Follows a source's own cursors from the first page to the last. `read` is
 * the one page a source knows how to fetch; everything else here is counting
 * and stopping.
 */
export async function scanCatalog(
  read: (cursor: string | undefined, signal: AbortSignal) => Promise<CatalogPage>,
  signal: AbortSignal,
  options: { limits?: ScanLimits; onProgress?(progress: ScanProgress): void } = {},
): Promise<ScannedCatalog> {
  const limits = options.limits ?? SCAN_LIMITS;
  const items: CatalogItem[] = [];
  const ids = new Set<string>();
  const categories = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let generatedAt: string | undefined;
  let pages = 0;
  let complete = false;
  for (;;) {
    if (signal.aborted) break;
    const page = await read(cursor, signal);
    pages += 1;
    for (const item of page.items) {
      // A source that repeats an item across pages must not grow the catalogue.
      if (ids.has(item.id)) continue;
      ids.add(item.id);
      items.push(item);
      for (const category of item.categories) categories.add(category);
    }
    for (const category of page.categories) categories.add(category);
    if (page.generatedAt && (!generatedAt || page.generatedAt > generatedAt)) generatedAt = page.generatedAt;
    options.onProgress?.({ items: items.length, pages, complete: false });
    const next = page.nextCursor;
    if (!next) { complete = true; break; }
    if (seenCursors.has(next) || pages >= limits.pages || items.length >= limits.items) break;
    seenCursors.add(next);
    cursor = next;
  }
  return {
    items, categories: [...categories].sort(), ...(generatedAt ? { generatedAt } : {}),
    complete, pages, at: Date.now(),
  };
}

/** Everything the query asked for, over one scanned catalogue. */
export function requestedCategories(query: Pick<CatalogQuery, 'category' | 'categories'>): string[] {
  return [...new Set([...(query.categories ?? []), ...(query.category ? [query.category] : [])])];
}

const matchesWords = (item: CatalogItem, words: string[]): boolean => {
  if (!words.length) return true;
  const haystack = `${item.name}\n${item.summary}\n${item.publisher ?? ''}\n${item.id}\n${item.categories.join(' ')}`.toLowerCase();
  return words.every(word => haystack.includes(word));
};

const ordered = (items: CatalogItem[], sort: CatalogQuery['sort']): CatalogItem[] => {
  if (!sort) return items;
  const copy = [...items];
  if (sort === 'name') copy.sort((left, right) => left.name.localeCompare(right.name));
  else if (sort === 'downloads') copy.sort((left, right) => right.installs - left.installs);
  else if (sort === 'stars') copy.sort((left, right) => right.stars - left.stars);
  else copy.sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
  return copy;
};

/** Where a `scan:<offset>` cursor points, or 0 for the first page. */
export function scanOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^scan:(\d+)$/.exec(cursor);
  const offset = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(offset) || offset < 1) throw new Error('That page of results has expired. Search again.');
  return offset;
}

/**
 * One page of a scanned catalogue. Several categories mean "in any of them":
 * the pills are there to widen a search, not to ask for an item that is filed
 * under all of them at once.
 */
export function filterScanned(catalog: ScannedCatalog, query: CatalogQuery): CatalogPage {
  const words = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const wanted = requestedCategories(query);
  const matched = catalog.items.filter(item =>
    (!query.installable || item.npm !== undefined)
    && (!wanted.length || item.categories.some(category => wanted.includes(category)))
    && matchesWords(item, words));
  const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
  const offset = scanOffset(query.cursor);
  const sorted = ordered(matched, query.sort);
  const items = sorted.slice(offset, offset + limit);
  const unfiltered = query.installable ? catalog.items.filter(item => item.npm !== undefined).length : catalog.items.length;
  return {
    items,
    total: matched.length,
    ...(matched.length !== unfiltered ? { unfiltered } : {}),
    categories: catalog.categories,
    ...(catalog.generatedAt ? { generatedAt: catalog.generatedAt } : {}),
    ...(offset + items.length < matched.length ? { nextCursor: `scan:${offset + items.length}` } : {}),
  };
}
