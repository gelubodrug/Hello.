/**
 * Decider V1.3 — Perplexity's decision model on OpenRouter, the classifier
 * Unclutter asks by default (user, 27.11: "pune și acest model … pe asta default").
 *
 * It answers on OpenRouter's Decisions API (`/api/alpha/decisions`), not the
 * chat endpoint, in the hosted Jev shape Unclutter already speaks: a `state`,
 * and `questions` keyed by element whose `choice` answers carry a probability
 * per category. Being hosted, it answers a request's questions together, so a
 * batch can be large; its free tier allows 20 requests a minute and 50 a day
 * without bought credits, so a page costs a few requests, not ten.
 *
 * The key is the person's OpenRouter connection, read from the encrypted store
 * at the moment of asking and sent only to openrouter.ai.
 */
import type { AppSettings } from '../../shared/types';

export const DECIDER_MODEL = 'perplexity/pplx-decider-v1.3:free';
export const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
/** Elements per request: one request answers them together. */
export const DECIDER_BATCH = 20;
const REQUEST_MS = 120_000;

export interface DeciderKeys {
  getSettings(): Pick<AppSettings, 'endpointUrl' | 'connections'>;
  getApiKey(endpointUrl: string): string;
}

const isOpenRouter = (url: string): boolean => {
  try { return new URL(url).hostname.toLowerCase() === 'openrouter.ai'; } catch { return false; }
};

/** PURE but for the store. The key of the first OpenRouter connection that has one: the chat's own, then a kept one. */
export function openRouterKey(keys: DeciderKeys): string {
  const settings = keys.getSettings();
  const urls = [settings.endpointUrl, ...settings.connections.map(connection => connection.endpointUrl)].filter(isOpenRouter);
  for (const url of [...new Set(urls)]) {
    let key = '';
    try { key = keys.getApiKey(url).trim(); } catch { /* A locked keychain is as good as no key here. */ }
    if (key) return key;
  }
  return '';
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

export class Decider {
  readonly name = 'Decider V1.3';
  readonly model = DECIDER_MODEL;
  readonly batchSize = DECIDER_BATCH;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: { keys: DeciderKeys; fetch?: typeof fetch }) {
    this.fetch = options.fetch ?? fetch;
  }

  async status(): Promise<{ state: 'ready' | 'missing'; detail: string; ownHelper: false }> {
    return openRouterKey(this.options.keys)
      ? { state: 'ready', detail: 'Decider V1.3 answers on OpenRouter, free (50 requests a day without credits)', ownHelper: false }
      : { state: 'missing', detail: 'Add an OpenRouter connection with its key in Settings to use Decider V1.3.', ownHelper: false };
  }

  /** One request to the Decisions API; the body is already the Jev shape. */
  async ask(body: unknown, signal?: AbortSignal): Promise<unknown> {
    const key = openRouterKey(this.options.keys);
    if (!key) throw new Error('Decider V1.3 needs an OpenRouter key: add an OpenRouter connection in Settings.');
    const timeout = AbortSignal.timeout(REQUEST_MS);
    const response = await this.fetch(DECISIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-Title': 'Hello.' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    let json: unknown = null;
    try { json = await response.json(); } catch { /* reported below */ }
    if (!response.ok) {
      const message = record(record(json).error).message;
      const said = typeof message === 'string' ? `: ${message.slice(0, 200)}` : '.';
      if (response.status === 429) throw new Error(`Decider V1.3's free tier is at its limit for now (20 requests a minute, 50 a day without credits)${said}`);
      if (response.status === 401 || response.status === 403) throw new Error(`OpenRouter refused the key (HTTP ${response.status})${said}`);
      throw new Error(`Decider V1.3 refused the request (HTTP ${response.status})${said}`);
    }
    if (json === null) throw new Error('Decider V1.3 returned no JSON.');
    return json;
  }

  /** Nothing runs here to stop. */
  stop(): boolean { return false; }
  dispose(): void {}
}
