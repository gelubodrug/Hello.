/**
 * Internationalization groundwork (06.10): the one module that knows the
 * person's locale and speaks for everything that varies with it — plural
 * choices, number shapes, the document's language and direction. English is
 * the only catalog shipped and the fallback for every key another locale
 * lacks; adding a language is adding its catalog here, never a call site.
 */

/** A message that changes with the count, by CLDR plural rule. */
type Plural = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

const english = {
  models: { one: '{n} model', other: '{n} models' } as Plural,
  replies: { one: '{n} reply', other: '{n} replies' } as Plural,
  tokens: '{n} tokens',
  perMonth: '{n}/mo',
  millions: '{n}M',
};
export type TextKey = keyof typeof english;

/** Every locale Hello ships a catalog for. */
const catalogs: Record<string, Partial<typeof english>> = { en: english };

/** The person's locale where a catalog exists — exact, then language — else English. */
export function resolveLocale(requested?: string): string {
  const asked = (requested ?? (typeof navigator !== 'undefined' ? navigator.language : undefined) ?? 'en').toLowerCase();
  if (catalogs[asked]) return asked;
  const language = asked.split('-')[0];
  return catalogs[language] ? language : 'en';
}

const active = resolveLocale();
export const locale = (): string => active;

/** Languages written right to left; everything else reads left to right. */
const RTL = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv']);
export const directionOf = (value: string): 'ltr' | 'rtl' =>
  RTL.has(value.split('-')[0]) ? 'rtl' : 'ltr';

/**
 * Stamps the resolved locale on the document: lang for assistive technology
 * and spellcheck, dir for layout the day a right-to-left catalog ships. The
 * lang="en" in index.html is only what is true before scripts run.
 */
export function applyDocumentLocale(value: string = active, doc?: Document): void {
  const target = doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (!target) return;
  target.documentElement.lang = value;
  target.documentElement.dir = directionOf(value);
}
applyDocumentLocale();

const numbers = new Intl.NumberFormat(active);
const compact = new Intl.NumberFormat(active, { notation: 'compact' });
const plurals = new Intl.PluralRules(active);

export const formatNumber = (value: number): string => numbers.format(value);
export const compactNumber = (value: number): string => compact.format(value);

/**
 * The string for a key in the active locale, English where it is missing.
 * A number picks the plural form and lands as {n}, already formatted; a
 * record fills each {name} exactly as given.
 */
export function t(key: TextKey, values?: number | Record<string, string | number>): string {
  const entry = catalogs[active]?.[key] ?? english[key];
  const text = typeof entry === 'string' ? entry
    : typeof values === 'number' ? entry[plurals.select(values)] ?? entry.other
    : entry.other;
  const filled: Record<string, string | number> =
    typeof values === 'number' ? { n: formatNumber(values) } : values ?? {};
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in filled ? String(filled[name]) : match));
}
