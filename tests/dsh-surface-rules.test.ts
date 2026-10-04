import { describe, expect, it } from 'vitest';
import { attachNonce, attachUrl, hostOrigin, navigationFor, parseSetCookie } from '../src/main/dsh/surface-rules';

describe('surface attach URLs', () => {
  it('round-trips a nonce and refuses anything else', () => {
    const nonce = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(attachNonce(attachUrl(nonce))).toBe(nonce);
    expect(attachNonce(`about:blank#hello-attach-${nonce}`)).toBeUndefined();
    expect(attachNonce('http://127.0.0.1:1/')).toBeUndefined();
    expect(attachNonce(undefined)).toBeUndefined();
  });
});

describe('hostOrigin', () => {
  it('accepts only the loopback address the host listens on', () => {
    expect(hostOrigin('http://127.0.0.1:53827/?token=x')).toBe('http://127.0.0.1:53827');
    expect(() => hostOrigin('http://localhost:53827/')).toThrow();
    expect(() => hostOrigin('https://127.0.0.1:53827/')).toThrow();
    expect(() => hostOrigin('http://10.0.0.2:53827/')).toThrow();
  });
});

describe('parseSetCookie', () => {
  it('reads the host’s login cookie', () => {
    const cookie = parseSetCookie('dsh-auth-abc=v1.2.3; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000', 1_000_000);
    expect(cookie).toEqual({ name: 'dsh-auth-abc', value: 'v1.2.3', path: '/', httpOnly: true, secure: false, sameSite: 'strict', expirationDate: 1000 + 2_592_000 });
  });

  it('reads Expires when there is no Max-Age, and refuses a nameless cookie', () => {
    expect(parseSetCookie('a=b; Expires=Wed, 21 Oct 2035 07:28:00 GMT')?.expirationDate).toBe(Math.floor(Date.parse('Wed, 21 Oct 2035 07:28:00 GMT') / 1000));
    expect(parseSetCookie('=b')).toBeUndefined();
    expect(parseSetCookie('novalue')).toBeUndefined();
  });
});

describe('navigationFor', () => {
  const origin = 'http://127.0.0.1:53827';
  it('keeps the page on its own origin', () => {
    expect(navigationFor('http://127.0.0.1:53827/plugins', origin)).toBe('allow');
  });
  it('sends web links elsewhere', () => {
    expect(navigationFor('https://deepseek1024.com/', origin)).toBe('elsewhere');
    expect(navigationFor('http://example.com/x', origin)).toBe('elsewhere');
  });
  it('refuses other loopback ports, files and custom schemes', () => {
    expect(navigationFor('http://127.0.0.1:3000/', origin)).toBe('block');
    expect(navigationFor('http://localhost:53827/', origin)).toBe('block');
    expect(navigationFor('file:///etc/passwd', origin)).toBe('block');
    expect(navigationFor('javascript:alert(1)', origin)).toBe('block');
    expect(navigationFor('not a url', origin)).toBe('block');
  });
  it('without a running host, nothing but the web leaves and nothing loads', () => {
    expect(navigationFor('http://127.0.0.1:53827/', undefined)).toBe('block');
  });
});

describe('parseBootFailure', () => {
  it('names the entries dsh’s client could not activate', async () => {
    const { parseBootFailure } = await import('../src/main/dsh/surface-rules');
    const text = 'Uncaught (in promise) Error: web boot: 2 entries did not activate\ndsh-better-sidebar: pending (waiting for services: settingsScope)\n@linxin666/dsh-doctor: import failed: boom';
    expect(parseBootFailure(text)).toEqual(['dsh-better-sidebar', '@linxin666/dsh-doctor']);
    expect(parseBootFailure('web boot: 1 entry did not activate\nx: failed')).toEqual(['x']);
    expect(parseBootFailure('all good')).toBeUndefined();
    expect(parseBootFailure(undefined)).toBeUndefined();
  });
});
