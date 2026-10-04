/**
 * The market's only way onto the network, ported from dsh-community-market
 * (lib/network/restricted-http.js and blocked-subnets.js, MIT, Anywhere Labs).
 *
 * HTTPS on port 443 only; no credentials or fragments in URLs; at most three
 * redirects; every name resolved once and pinned, and refused when any of its
 * addresses is loopback, private, link-local, multicast or a tunnel that could
 * carry one; 2 MiB per answer; 8 s to connect, 12 s to the first byte, 30 s in
 * all. What comes back is data from a stranger: JSON only, parsed, never run.
 */
import dns from 'node:dns';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { BlockList, isIP } from 'node:net';

export class MarketNetworkError extends Error {
  constructor(readonly code: 'invalid-url' | 'blocked-address' | 'redirect' | 'http' | 'response' | 'timeout') {
    super(`market request failed: ${code}`);
    this.name = 'MarketNetworkError';
  }
}

const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 8_000;
const FIRST_BYTE_TIMEOUT_MS = 12_000;
const TOTAL_TIMEOUT_MS = 30_000;

export function blockedAddresses(): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
  ] as const) list.addSubnet(network, prefix, 'ipv4');
  for (const [network, prefix] of [
    ['::', 128], ['::1', 128], ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
    ['2001::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  ] as const) list.addSubnet(network, prefix, 'ipv6');
  return list;
}

const BLOCKED = blockedAddresses();

export interface Pinned { address: string; family: 4 | 6 }

export function safeAddress(address: string): 4 | 6 {
  const normalized = address.replace(/^\[|\]$/g, '').split('%', 1)[0];
  const family = isIP(normalized);
  if (family === 0 || BLOCKED.check(normalized, family === 4 ? 'ipv4' : 'ipv6')) throw new MarketNetworkError('blocked-address');
  return family as 4 | 6;
}

export function validateUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new MarketNetworkError('invalid-url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443'))
    throw new MarketNetworkError('invalid-url');
  return url;
}

async function pin(hostname: string, lookup: (hostname: string) => Promise<Pinned[]>): Promise<Pinned> {
  const literal = hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal)) return { address: literal, family: safeAddress(literal) };
  const addresses = await lookup(hostname);
  if (!addresses.length) throw new MarketNetworkError('blocked-address');
  for (const entry of addresses) if (entry.family !== safeAddress(entry.address)) throw new MarketNetworkError('blocked-address');
  return addresses[0];
}

async function systemLookup(hostname: string): Promise<Pinned[]> {
  const entries = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return entries.map(entry => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
}

export interface RawResponse { statusCode: number; headers: IncomingHttpHeaders; body: Buffer }

export type RequestOnce = (url: URL, signal: AbortSignal, pinned: Pinned, accept: string, maxBytes: number) => Promise<RawResponse>;

const requestOnce: RequestOnce = (url, signal, pinned, accept, maxBytes) => new Promise((resolve, reject) => {
  let settled = false;
  let firstByte: NodeJS.Timeout | undefined;
  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    if (firstByte) clearTimeout(firstByte);
    callback();
  };
  const request = https.request(url, {
    method: 'GET',
    headers: { accept, 'accept-encoding': 'identity', 'user-agent': 'Hello.-market/0.1 (dsh-community-market compatible)' },
    servername: url.hostname,
    lookup: (_hostname, options, callback) => {
      if ((options as { all?: boolean }).all) (callback as (error: null, addresses: Pinned[]) => void)(null, [pinned]);
      else (callback as (error: null, address: string, family: number) => void)(null, pinned.address, pinned.family);
    },
    signal,
    timeout: CONNECT_TIMEOUT_MS,
  }, response => {
    if (firstByte) { clearTimeout(firstByte); firstByte = undefined; }
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { response.destroy(new MarketNetworkError('response')); return; }
      chunks.push(chunk);
    });
    response.once('end', () => finish(() => resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) })));
    response.once('error', error => finish(() => reject(error)));
  });
  firstByte = setTimeout(() => request.destroy(new MarketNetworkError('timeout')), FIRST_BYTE_TIMEOUT_MS);
  request.once('error', error => finish(() => reject(error)));
  request.once('timeout', () => request.destroy(new MarketNetworkError('timeout')));
  request.end();
});

export interface FetchPolicy {
  /** A redirect off this origin is refused. */
  allowedOrigin?: string;
  /** What to ask for, when it is not an image (getBytes asks for images by default). */
  accept?: string;
}

export interface MarketHttp {
  getJson(url: string, signal: AbortSignal, policy?: FetchPolicy): Promise<{ value: unknown; finalUrl: string }>;
  getBytes(url: string, signal: AbortSignal, policy: FetchPolicy & { maxBytes: number; contentType: RegExp }): Promise<{ body: Buffer; contentType: string; finalUrl: string }>;
}

export function createMarketHttp(options: { lookup?: (hostname: string) => Promise<Pinned[]>; request?: RequestOnce; totalTimeoutMs?: number } = {}): MarketHttp {
  const lookup = options.lookup ?? systemLookup;
  const request = options.request ?? requestOnce;
  const totalTimeoutMs = options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  const follow = async (start: string, signal: AbortSignal, accept: string, maxBytes: number, policy: FetchPolicy, redirects = 0): Promise<{ response: RawResponse; url: URL }> => {
    if (signal.aborted) throw new MarketNetworkError('timeout');
    const url = validateUrl(start);
    if (policy.allowedOrigin && url.origin !== policy.allowedOrigin) throw new MarketNetworkError('redirect');
    if (redirects > MAX_REDIRECTS) throw new MarketNetworkError('redirect');
    const pinned = await pin(url.hostname, lookup);
    const response = await request(url, signal, pinned, accept, maxBytes);
    if (response.statusCode >= 300 && response.statusCode < 400) {
      const location = response.headers.location;
      if (!location) throw new MarketNetworkError('redirect');
      return follow(new URL(location, url).href, signal, accept, maxBytes, policy, redirects + 1);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) throw new MarketNetworkError('http');
    const encoding = response.headers['content-encoding'];
    if (encoding !== undefined && encoding !== 'identity') throw new MarketNetworkError('response');
    return { response, url };
  };
  const bounded = async <T>(signal: AbortSignal, run: (inner: AbortSignal) => Promise<T>): Promise<T> => {
    if (signal.aborted) throw new MarketNetworkError('timeout');
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new MarketNetworkError('timeout')); }, totalTimeoutMs);
    });
    try { return await Promise.race([run(controller.signal), timeout]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
  };
  return {
    getJson: (start, signal, policy = {}) => bounded(signal, async inner => {
      const { response, url } = await follow(start, inner, 'application/json', MAX_BODY_BYTES, policy);
      const type = String(response.headers['content-type'] ?? '');
      if (!/^(?:application\/json|application\/[^;]+\+json)(?:;|$)/i.test(type)) throw new MarketNetworkError('response');
      try { return { value: JSON.parse(response.body.toString('utf8')) as unknown, finalUrl: url.href }; }
      catch { throw new MarketNetworkError('response'); }
    }),
    getBytes: (start, signal, policy) => bounded(signal, async inner => {
      const { response, url } = await follow(start, inner, policy.accept ?? 'image/png,image/jpeg,image/webp,image/gif;q=0.8', policy.maxBytes, policy);
      const type = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!policy.contentType.test(type)) throw new MarketNetworkError('response');
      return { body: response.body, contentType: type, finalUrl: url.href };
    }),
  };
}

/** A shared answer, or this caller's abort, whichever comes first. */
function untilAborted<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new MarketNetworkError('timeout'));
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new MarketNetworkError('timeout'));
    signal.addEventListener('abort', stop, { once: true });
    value.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** Collapses repeated reads of one URL for a few minutes: browsing asks the same pages again and again. */
export function cachedMarketHttp(delegate: MarketHttp, ttlMs = 5 * 60_000, maxEntries = 256): MarketHttp & { clear(): void } {
  const cache = new Map<string, { at: number; value: Promise<{ value: unknown; finalUrl: string }> }>();
  return {
    getJson(url, signal, policy = {}) {
      const key = `${policy.allowedOrigin ?? ''}\0${url}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return untilAborted(hit.value, signal);
      // Shared by every caller asking meanwhile, so no one caller's Stop ends
      // it: the request keeps its own time limit, and each caller stops
      // waiting on its own signal.
      const value = delegate.getJson(url, new AbortController().signal, policy);
      cache.set(key, { at: Date.now(), value });
      value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
      return untilAborted(value, signal);
    },
    getBytes: (url, signal, policy) => delegate.getBytes(url, signal, policy),
    clear: () => cache.clear(),
  };
}
