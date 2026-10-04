/**
 * The decisions the DSH surface makes, as plain functions: which webview is
 * ours, what a login answer sets, where a page may go.
 */

export const DSH_PARTITION = 'persist:hello-dsh';

const ATTACH = /^about:blank#hello-dsh-([\da-f-]{36})$/i;

export function attachUrl(nonce: string): string {
  return `about:blank#hello-dsh-${nonce}`;
}

export function attachNonce(src: unknown): string | undefined {
  if (typeof src !== 'string') return undefined;
  return ATTACH.exec(src.trim())?.[1];
}

/** The host's own origin, from the URL its ready message carried. Loopback only. */
export function hostOrigin(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port)
    throw new Error('The DSH host must listen on 127.0.0.1.');
  return parsed.origin;
}

export interface ParsedCookie {
  name: string;
  value: string;
  path?: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'strict' | 'lax' | 'no_restriction';
  /** Seconds since the epoch. */
  expirationDate?: number;
}

/** One Set-Cookie header, as Electron's cookie store takes it. */
export function parseSetCookie(header: string, now = Date.now()): ParsedCookie | undefined {
  const [pair, ...attributes] = header.split(';');
  const equals = pair.indexOf('=');
  if (equals <= 0) return undefined;
  const cookie: ParsedCookie = {
    name: pair.slice(0, equals).trim(),
    value: pair.slice(equals + 1).trim(),
    httpOnly: false,
    secure: false,
  };
  if (!cookie.name) return undefined;
  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split('=');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join('=').trim();
    if (key === 'path' && value) cookie.path = value;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'samesite') {
      const same = value.toLowerCase();
      cookie.sameSite = same === 'strict' ? 'strict' : same === 'lax' ? 'lax' : same === 'none' ? 'no_restriction' : undefined;
    } else if (key === 'max-age' && /^-?\d+$/.test(value)) cookie.expirationDate = Math.floor(now / 1000) + Number(value);
    else if (key === 'expires' && cookie.expirationDate === undefined) {
      const time = Date.parse(value);
      if (!Number.isNaN(time)) cookie.expirationDate = Math.floor(time / 1000);
    }
  }
  return cookie;
}

export type Navigation = 'allow' | 'elsewhere' | 'block';

/**
 * Where the surface's own page may go. It stays on the host's origin; a link
 * to the web leaves the surface for the person's browser tab; anything else —
 * files, custom schemes, other loopback ports — is refused.
 */
export function navigationFor(url: string, origin: string | undefined): Navigation {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'block'; }
  if (origin && parsed.origin === origin) return 'allow';
  if (parsed.protocol === 'about:' && parsed.href.startsWith('about:blank')) return 'allow';
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'block';
  const host = parsed.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost')) return 'block';
  return 'elsewhere';
}

/**
 * dsh's client names the plugins that stopped its boot in one console error:
 * `web boot: N entries did not activate` followed by a line per entry. The
 * entry names come back; the page itself shows its own failure screen.
 */
export function parseBootFailure(text: unknown): string[] | undefined {
  if (typeof text !== 'string') return undefined;
  const start = text.search(/web boot: \d+ entr(?:y|ies) did not activate/);
  if (start < 0) return undefined;
  const entries = text.slice(start).split('\n').slice(1)
    .map(line => /^\s*([^\s:][^:]{0,200}):\s/.exec(line)?.[1]?.trim())
    .filter((name): name is string => Boolean(name));
  return [...new Set(entries)].slice(0, 20);
}
