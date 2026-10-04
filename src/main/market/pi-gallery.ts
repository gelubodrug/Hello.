/**
 * pi.dev/packages, the official Pi package gallery, as the Pi market's list
 * (user, 29.09: "pune filtrele de la pagina oficială pi"). Its filters are
 * the market's: a type (extension, skill, theme, prompt), an order (most
 * downloads, recently published, A–Z) and words to filter by, fifty to a
 * page, with the count it shows ("1-50 / 305 (of 5548)"). Each card carries
 * what a person decides by: the author, downloads a month, when it was last
 * published, its types and its repository.
 *
 * The gallery has no API, so its page is read: the card attributes it
 * publishes for its own filtering and the text beside them. Only data leaves
 * the page. When it cannot be read, the market falls back to npm's search
 * (pi-catalog.ts), where the gallery finds the same packages.
 */
import type { MarketHttp } from './net';
import { safePackageName } from './install';
import { repositoryUrl, type PiPackage } from './pi-catalog';

export const PI_GALLERY_ORIGIN = 'https://pi.dev';
export const GALLERY_TYPES = ['extension', 'skill', 'theme', 'prompt'] as const;
const PAGE_SIZE = 50;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

export interface GalleryQuery {
  q?: string;
  type?: string;
  sort?: 'downloads' | 'updated' | 'name' | 'stars';
  /** 1-based. */
  page?: number;
}

export interface GalleryPage {
  items: PiPackage[];
  /** What the filters match. */
  total: number;
  /** Every package in the gallery. */
  all: number;
  page: number;
}

/** The gallery's own address for a search: its defaults are left out, as its links leave them. */
export function galleryUrl(query: GalleryQuery): string {
  const url = new URL('/packages', PI_GALLERY_ORIGIN);
  const words = query.q?.trim().slice(0, 200);
  if (words) url.searchParams.set('name', words);
  if (query.type && (GALLERY_TYPES as readonly string[]).includes(query.type)) url.searchParams.set('type', query.type);
  if (query.sort === 'updated') url.searchParams.set('sort', 'recent');
  else if (query.sort === 'name') url.searchParams.set('sort', 'name');
  if (query.page && query.page > 1) url.searchParams.set('page', String(Math.min(query.page, 1000)));
  return url.href;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : '';
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}
/** Visible text: tags dropped, entities decoded, controls and bidi overrides gone. */
function plain(html: string, max: number): string {
  return decode(html.replace(/<[^>]*>/g, ' '))
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}
const count = (text: string | undefined) => text ? Number(text.replace(/,/g, '')) : NaN;

/** The cards and the count of one gallery page. */
export function parseGallery(html: string, page = 1): GalleryPage {
  const items: PiPackage[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<article\b([^>]*\bdata-package-card="true"[^>]*)>([\s\S]*?)<\/article>/g)) {
    const attributes = Object.fromEntries([...match[1].matchAll(/\bdata-package-([a-z-]+)="([^"]*)"/g)].map(([, key, value]) => [key, decode(value)]));
    const name = attributes.name;
    if (!safePackageName(name) || seen.has(name)) continue;
    seen.add(name);
    const body = match[2];
    const meta = /<div class="packages-meta">([\s\S]*?)<\/div>/.exec(body)?.[1] ?? '';
    const spans = [...meta.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map(span => plain(span[1], 100));
    // The first of author · downloads · date, when it is an author and not a count.
    const author = spans[0] && !/\/mo$|\bago$/.test(spans[0]) && /^[\w.@-]{1,100}$/.test(spans[0]) ? spans[0] : undefined;
    // Each link on its own: the one that reads "repo".
    const repo = [...body.matchAll(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].find(link => plain(link[2], 20) === 'repo')?.[1];
    const repository = (repo && repositoryUrl({ repository: decode(repo) })) ?? `https://www.npmjs.com/package/${name}`;
    const owner = /^https:\/\/github\.com\/([^/]+)\//.exec(repository)?.[1];
    const types = (attributes.types ?? '').split(/\s+/).filter(type => (GALLERY_TYPES as readonly string[]).includes(type));
    const downloads = Number(attributes.downloads);
    const published = Number(attributes.date);
    items.push({
      name,
      summary: plain(/<p class="packages-desc">([\s\S]*?)<\/p>/.exec(body)?.[1] ?? '', 500) || 'No description.',
      ...(author ? { publisher: author } : {}),
      types: types.length ? types : ['package'],
      keywords: [],
      repository,
      installs: Number.isFinite(downloads) && downloads >= 0 ? Math.round(downloads) : 0,
      ...(Number.isFinite(published) && published > 0 ? { updatedAt: new Date(published).toISOString() } : {}),
      icons: owner ? [`https://github.com/${owner}.png?size=96`] : [],
    });
  }
  const shown = /class="packages-count"[^>]*>\s*([\d,]+)\s*-\s*([\d,]+)\s*\/\s*([\d,]+)(?:\s*\(of\s*([\d,]+)\))?/.exec(html);
  const total = count(shown?.[3]);
  const all = count(shown?.[4]);
  return {
    items,
    total: Number.isFinite(total) ? total : items.length,
    all: Number.isFinite(all) ? all : Number.isFinite(total) ? total : items.length,
    page,
  };
}

/** One gallery page for a search. A page without the gallery's cards and count is an error, not an empty list. */
export async function fetchGallery(http: MarketHttp, query: GalleryQuery, signal: AbortSignal): Promise<GalleryPage & { next?: number }> {
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const { body } = await http.getBytes(galleryUrl({ ...query, page }), signal, {
    allowedOrigin: PI_GALLERY_ORIGIN, accept: 'text/html', maxBytes: MAX_PAGE_BYTES, contentType: /^text\/html$/,
  });
  const html = body.toString('utf8');
  if (!/class="packages-count"/.test(html)) throw new Error('pi.dev’s package page did not read as the gallery.');
  const parsed = parseGallery(html, page);
  return { ...parsed, ...(page * PAGE_SIZE < parsed.total && parsed.items.length ? { next: page + 1 } : {}) };
}
