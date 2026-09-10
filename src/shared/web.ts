import type { Message, MessagePart } from './types';

export interface WebSource { id: number; url: string; title: string; fetchedAt: string; }
export interface SearchHit { title: string; url: string; snippet: string; }
export interface WebSearchResult {
  kind: 'web_search'; query: string; engine: string; results: SearchHit[];
  broadenedTo?: string; note: string;
}
export interface WebPageResult {
  kind: 'fetch_url'; source: WebSource; status: number; contentType: string;
  text: string; truncated: boolean; bytes: number; note: string;
}
export type WebResult = WebSearchResult | WebPageResult;

export function webURL(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8_192) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

/** Only successful, structured tool output may create a source in the UI. */
export function readWebResult(part: MessagePart): WebResult | null {
  if (part.type !== 'tool' || part.status !== 'complete' || !part.output ||
      !['web_search', 'fetch_url'].includes(part.name)) return null;
  try {
    const value = JSON.parse(part.output);
    if (value?.kind !== part.name) return null;
    if (value.kind === 'fetch_url') {
      const source = value.source;
      if (!source || !Number.isSafeInteger(source.id) || source.id < 1 ||
          !webURL(source.url) || typeof source.title !== 'string' ||
          typeof source.fetchedAt !== 'string' || typeof value.text !== 'string' ||
          !Number.isInteger(value.status) || value.status < 200 || value.status >= 300 ||
          typeof value.contentType !== 'string' || typeof value.note !== 'string' ||
          typeof value.truncated !== 'boolean' || !Number.isFinite(value.bytes)) return null;
      return value as WebPageResult;
    }
    if (!Array.isArray(value.results) || typeof value.query !== 'string' ||
        typeof value.engine !== 'string' || typeof value.note !== 'string') return null;
    return { ...value, results: value.results.filter((hit: SearchHit) => hit &&
      webURL(hit.url) && typeof hit.title === 'string' && typeof hit.snippet === 'string') };
  } catch { return null; }
}

export function fetchedSources(messages: readonly Message[]): WebSource[] {
  const sources = new Map<number, WebSource>();
  for (const message of messages) for (const part of message.parts ?? []) {
    const result = readWebResult(part);
    if (result?.kind === 'fetch_url') sources.set(result.source.id, result.source);
  }
  return [...sources.values()];
}

export function sourcesForMessage(message: Message, known: readonly WebSource[] = []): WebSource[] {
  const ids = new Set<number>();
  for (const match of message.content.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g))
    for (const id of match[1].split(',')) ids.add(Number(id.trim()));
  const sources = new Map<number, WebSource>();
  for (const source of known) if (ids.has(source.id)) sources.set(source.id, source);
  for (const source of fetchedSources([message])) sources.set(source.id, source);
  return [...sources.values()];
}

export function withSourceLinks(text: string, sources: readonly WebSource[]): string {
  if (!sources.length) return text;
  const rows = sources.map(source => `[${source.id}] ${source.title.replace(/[\r\n]/g, ' ')} — ${source.url}`);
  return `${text}\n\nSources:\n${rows.join('\n')}`;
}
