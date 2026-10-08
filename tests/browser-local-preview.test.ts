import { mkdtemp, mkdir, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalPreviewServer, LOCAL_PREVIEW_MAX_BYTES } from '../src/main/browser/local-preview';

let root: string;
let folder: string;
let preview: LocalPreviewServer;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hello-local-preview-'));
  folder = join(root, 'workspace');
  await mkdir(join(folder, 'assets'), { recursive: true });
  await writeFile(join(folder, 'index.html'), '<!doctype html><link rel="stylesheet" href="assets/style.css"><p>Hello preview</p>');
  await writeFile(join(folder, 'assets', 'style.css'), 'body { color: red; }');
  preview = new LocalPreviewServer();
});
afterEach(async () => {
  await preview.dispose();
  await rm(root, { recursive: true, force: true });
});

function raw(url: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const target = new URL(url);
    const req = request({ hostname: target.hostname, port: target.port, path, headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('Preview request timed out.')));
    req.end();
  });
}
const get = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(3000) });

describe('conversation-scoped local HTML previews', () => {
  it('opens HTML as HTTP with relative static assets, without exposing a file URL or CORS wildcard', async () => {
    const url = await preview.open('chat-a', folder, 'index.html');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\/index\.html$/);
    const page = await get(url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('access-control-allow-origin')).toBeNull();
    expect(await page.text()).toContain('Hello preview');
    const asset = await get(new URL('assets/style.css', url).href);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/css');
    expect(await asset.text()).toContain('color: red');
    const head = await get(url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(0);
    expect(await head.text()).toBe('');
  });

  // A page in a tab computes with WebGPU (navigator.gpu, pi-instructions.ts's
  // browser manual), which Chromium gives a secure origin: 127.0.0.1 is one,
  // a file:// URL would not be. What it does not give is cross-origin
  // isolation, so SharedArrayBuffer stays unavailable and a wasm runtime has to
  // run single-threaded — require-corp here would instead break every
  // cross-origin subresource a page legitimately loads.
  it('serves a preview as a secure context that is not cross-origin isolated', async () => {
    const url = await preview.open('chat-gpu', folder, 'index.html');
    expect(new URL(url).hostname).toBe('127.0.0.1');
    expect(new URL(url).protocol).toBe('http:');
    const page = await get(url);
    expect(page.headers.get('cross-origin-opener-policy')).toBeNull();
    expect(page.headers.get('cross-origin-embedder-policy')).toBeNull();
  });

  it('accepts absolute and encoded local file paths and shares one lazy listener', async () => {
    const html = join(folder, 'a page.html');
    await writeFile(html, '<p>Encoded path</p>');
    const [absolute, file] = await Promise.all([
      preview.open('chat-a', folder, html),
      preview.open('chat-a', folder, pathToFileURL(html).href),
    ]);
    expect(new URL(absolute).origin).toBe(new URL(file).origin);
    expect(absolute).not.toBe(file);
    expect(absolute.endsWith('/a%20page.html')).toBe(true);
    expect(await (await get(file)).text()).toContain('Encoded path');
  });

  it('supports an attached-folder symlink but revokes access if that link is retargeted', async () => {
    const attached = join(root, 'attached');
    await symlink(folder, attached);
    const url = await preview.open('chat-a', attached, join(attached, 'index.html'));
    expect((await get(url)).status).toBe(200);
    await rm(attached);
    await mkdir(join(root, 'replacement'));
    await writeFile(join(root, 'replacement', 'index.html'), 'Do not serve replacement');
    await symlink(join(root, 'replacement'), attached);
    const response = await get(url);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('Do not serve replacement');
  });

  it('rejects entry files outside the folder, symlink escapes, secret paths and non-HTML files', async () => {
    await writeFile(join(root, 'outside.html'), 'outside');
    await symlink(join(root, 'outside.html'), join(folder, 'escape.html'));
    await mkdir(join(folder, '.secrets'));
    await writeFile(join(folder, '.secrets', 'index.html'), 'secret');
    await writeFile(join(folder, 'credentials.html'), 'secret');
    await mkdir(join(folder, 'directory.html'));
    for (const path of ['../outside.html', join(root, 'outside.html'), 'escape.html', '.secrets/index.html', 'credentials.html', 'assets/style.css', 'directory.html']) {
      await expect(preview.open('chat-a', folder, path)).rejects.toThrow();
    }
    await expect(preview.open('chat-a', folder, 'https://example.com')).rejects.toThrow();
    await expect(preview.open('chat-a', folder, 'file://other-host/private/index.html')).rejects.toThrow();
  });

  it('requires a matching loopback Host and live token, supports no writes or directory listing', async () => {
    const url = await preview.open('chat-a', folder, 'index.html');
    const parsed = new URL(url);
    expect((await raw(url, parsed.pathname, { Host: 'attacker.example' })).status).toBe(403);
    expect((await raw(url, '/index.html')).status).toBe(404);
    expect((await raw(url, '/' + 'a'.repeat(64) + '/index.html')).status).toBe(404);
    expect((await get(url, { method: 'POST', body: 'replace' })).status).toBe(405);
    expect((await get(new URL('assets/', url).href)).status).toBe(415);
    expect(await (await get(url)).text()).toContain('Hello preview');
  });

  it('rechecks asset containment, secret exclusions, extension allowlist and symlinks on each request', async () => {
    const url = await preview.open('chat-a', folder, 'index.html');
    const base = new URL('.', url).pathname;
    await writeFile(join(root, 'outside.css'), 'outside');
    await writeFile(join(folder, 'credentials.json'), '{"secret":true}');
    await writeFile(join(folder, 'run.sh'), 'do not serve');
    await mkdir(join(folder, '.git'));
    await writeFile(join(folder, '.git', 'config.json'), '{}');
    await symlink(join(root, 'outside.css'), join(folder, 'assets', 'escape.css'));
    for (const path of ['../outside.css', '%2e%2e%2foutside.css', 'assets/escape.css', 'credentials.json', '.git/config.json']) {
      expect((await raw(url, base + path)).status).toBe(403);
    }
    expect((await get(new URL('run.sh', url).href)).status).toBe(415);
    await rm(join(folder, 'assets', 'style.css'));
    await symlink(join(root, 'outside.css'), join(folder, 'assets', 'style.css'));
    expect((await get(new URL('assets/style.css', url).href)).status).toBe(403);
    expect((await raw(url, base + '%ZZ')).status).toBe(404);
  });

  it('bounds entry and asset sizes and rejects replacements that become directories', async () => {
    await writeFile(join(folder, 'large.html'), '');
    await truncate(join(folder, 'large.html'), LOCAL_PREVIEW_MAX_BYTES + 1);
    await expect(preview.open('chat-a', folder, 'large.html')).rejects.toThrow(/limit/);
    const url = await preview.open('chat-a', folder, 'index.html');
    await writeFile(join(folder, 'assets', 'large.json'), '');
    await truncate(join(folder, 'assets', 'large.json'), LOCAL_PREVIEW_MAX_BYTES + 1);
    expect((await get(new URL('assets/large.json', url).href)).status).toBe(413);
    await rename(join(folder, 'index.html'), join(folder, 'original.html'));
    await mkdir(join(folder, 'index.html'));
    expect((await get(url)).status).toBe(404);
  });

  it('revokes only the closed conversation, can reopen it, and permanently closes on dispose', async () => {
    const first = await preview.open('chat-a', folder, 'index.html');
    const other = await preview.open('chat-b', folder, 'index.html');
    preview.closeConversation('chat-a');
    expect((await get(first)).status).toBe(404);
    expect((await get(other)).status).toBe(200);
    const reopened = await preview.open('chat-a', folder, 'index.html');
    expect((await get(reopened)).status).toBe(200);
    await preview.dispose();
    await expect(get(reopened)).rejects.toThrow();
    await expect(preview.open('chat-a', folder, 'index.html')).rejects.toThrow(/closed/);
    await preview.dispose();
  });

  it('does not publish a preview if the conversation closes while it is opening', async () => {
    const pending = preview.open('chat-a', folder, 'index.html');
    preview.closeConversation('chat-a');
    await expect(pending).rejects.toThrow(/closed/);
  });
});
