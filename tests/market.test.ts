import { describe, expect, it } from 'vitest';
import { cachedMarketHttp, createMarketHttp, MarketNetworkError, safeAddress, validateUrl, type MarketHttp, type RawResponse } from '../src/main/market/net';

describe('the market’s network rules', () => {
  it('accepts only plain HTTPS on 443', () => {
    expect(validateUrl('https://deepseek1024.com/api').host).toBe('deepseek1024.com');
    for (const bad of ['http://deepseek1024.com/', 'https://user:pw@x.com/', 'https://x.com/#f', 'https://x.com:8443/', 'not a url'])
      expect(() => validateUrl(bad)).toThrow(MarketNetworkError);
  });

  it('refuses loopback, private, link-local and tunnel addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.9', '169.254.1.1', '100.64.0.1', '::1', 'fe80::1', 'fc00::1', '64:ff9b::7f00:1', '::ffff:127.0.0.1'])
      expect(() => safeAddress(address), address).toThrow(MarketNetworkError);
    expect(safeAddress('104.16.1.1')).toBe(4);
    expect(safeAddress('2606:4700::1')).toBe(6);
  });

  function http(responses: Record<string, RawResponse>, lookup: Record<string, string> = {}) {
    const asked: string[] = [];
    const client = createMarketHttp({
      lookup: async hostname => [{ address: lookup[hostname] ?? '104.16.1.1', family: 4 }],
      request: async url => { asked.push(url.href); const response = responses[url.href]; if (!response) throw new Error(`unexpected ${url.href}`); return response; },
    });
    return { client, asked };
  }
  const json = (value: unknown): RawResponse => ({ statusCode: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify(value)) });

  it('follows up to three redirects on the allowed origin, and no further', async () => {
    const hop = (to: string): RawResponse => ({ statusCode: 302, headers: { location: to }, body: Buffer.alloc(0) });
    const ok = http({ 'https://a.com/1': hop('/2'), 'https://a.com/2': hop('/3'), 'https://a.com/3': json({ ok: true }) });
    expect((await ok.client.getJson('https://a.com/1', new AbortController().signal)).value).toEqual({ ok: true });
    const tooMany = http({ 'https://a.com/1': hop('/2'), 'https://a.com/2': hop('/3'), 'https://a.com/3': hop('/4'), 'https://a.com/4': hop('/5'), 'https://a.com/5': json({}) });
    await expect(tooMany.client.getJson('https://a.com/1', new AbortController().signal)).rejects.toThrow('redirect');
    const offOrigin = http({ 'https://a.com/1': hop('https://evil.com/x') });
    await expect(offOrigin.client.getJson('https://a.com/1', new AbortController().signal, { allowedOrigin: 'https://a.com' })).rejects.toThrow('redirect');
  });

  it('refuses a name that resolves to a private address, and a non-JSON answer', async () => {
    const privateName = http({ 'https://intranet.com/x': json({}) }, { 'intranet.com': '10.0.0.5' });
    await expect(privateName.client.getJson('https://intranet.com/x', new AbortController().signal)).rejects.toThrow('blocked-address');
    const html = http({ 'https://a.com/x': { statusCode: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>') } });
    await expect(html.client.getJson('https://a.com/x', new AbortController().signal)).rejects.toThrow('response');
  });
});

describe('the shared read of one URL', () => {
  it('is not ended by one caller’s Stop, and each caller stops waiting on its own', async () => {
    let answer!: (value: { value: unknown; finalUrl: string }) => void;
    const seen: AbortSignal[] = [];
    const cached = cachedMarketHttp({
      getJson: (_url, signal) => { seen.push(signal); return new Promise(resolve => { answer = resolve; }); },
      getBytes: async () => { throw new Error('unused'); },
    });
    const first = new AbortController();
    const a = cached.getJson('https://skills.sh/api/search?q=x', first.signal);
    const b = cached.getJson('https://skills.sh/api/search?q=x', new AbortController().signal);
    first.abort();
    await expect(a).rejects.toBeInstanceOf(MarketNetworkError);
    expect(seen).toHaveLength(1);
    expect(seen[0].aborted).toBe(false);
    answer({ value: { ok: true }, finalUrl: 'https://skills.sh/api/search?q=x' });
    await expect(b).resolves.toMatchObject({ value: { ok: true } });
  });
});
