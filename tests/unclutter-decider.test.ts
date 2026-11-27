import { describe, expect, it, vi } from 'vitest';
import { DECIDER_MODEL, DECISIONS_URL, Decider, openRouterKey, type DeciderKeys } from '../src/main/unclutter/decider';
import { evaluationRequest } from '../src/main/unclutter/model';

const keys = (stored: Record<string, string>, endpointUrl = 'http://127.0.0.1:8000/v1', kept: string[] = []): DeciderKeys => ({
  getSettings: () => ({ endpointUrl, connections: kept.map(url => ({ name: url, endpointUrl: url, model: 'm', apiKeySet: true })) }),
  getApiKey: url => stored[url] ?? '',
});
const candidate = { id: 'e0', selector: 'div.ad-0x', tag: 'div', signals: 'class=ad', text: 'Advertisement', position: 'right', count: 1 };

describe('Decider V1.3 on OpenRouter', () => {
  it('uses the key of an OpenRouter connection only, the chat’s own first', () => {
    expect(openRouterKey(keys({ 'https://openrouter.ai/api/v1': 'k1' }, 'https://openrouter.ai/api/v1'))).toBe('k1');
    expect(openRouterKey(keys({ 'https://openrouter.ai/api/v1': 'k2' }, 'http://127.0.0.1:8000/v1', ['https://openrouter.ai/api/v1']))).toBe('k2');
    expect(openRouterKey(keys({ 'https://openrouter.ai.evil.example/v1': 'x' }, 'https://openrouter.ai.evil.example/v1'))).toBe('');
  });

  it('is missing, not broken, without a key', async () => {
    const decider = new Decider({ keys: keys({}), fetch: vi.fn() as never });
    expect((await decider.status()).state).toBe('missing');
    await expect(decider.ask({})).rejects.toThrow(/OpenRouter key/);
  });

  it('asks the Decisions API with the Jev-shaped request and the person’s key', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ answers: { e0: { type: 'choice', choice: 'ad' } } }), { status: 200 }));
    const decider = new Decider({ keys: keys({ 'https://openrouter.ai/api/v1': 'sk-test' }, 'https://openrouter.ai/api/v1'), fetch: fetch as never });
    const body = evaluationRequest('article', [candidate], decider.model);
    expect(body.model).toBe(DECIDER_MODEL);
    await decider.ask(body);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DECISIONS_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body as string).questions.e0.type).toBe('choice');
  });

  it('says when the free tier is at its limit', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded' } }), { status: 429 }));
    const decider = new Decider({ keys: keys({ 'https://openrouter.ai/api/v1': 'sk-test' }, 'https://openrouter.ai/api/v1'), fetch: fetch as never });
    await expect(decider.ask({})).rejects.toThrow(/free tier is at its limit/);
  });
});
