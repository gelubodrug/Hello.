import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCAL_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
};
interface Preview {
  conversationId: string;
  root: string;
  attachedFolder: string;
}
class PreviewError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function inside(root: string, target: string): boolean {
  const tail = relative(root, target);
  return !tail || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`));
}
function excluded(file: string): boolean {
  return file.split(sep).some(part => part.startsWith('.') ||
    /^(?:id_rsa|id_ed25519|credentials|secrets?)(?:\.|$)/i.test(part) ||
    /\.(?:pem|p12|pfx|key)$/i.test(part));
}
function requestedFile(input: string): string {
  if (!input || input.length > 8192 || /[\u0000-\u001f]/.test(input))
    throw new PreviewError(400, 'Invalid preview path.');
  if (/^file:/i.test(input)) {
    const url = new URL(input);
    if ((url.hostname && url.hostname !== 'localhost') || url.search || url.hash)
      throw new PreviewError(400, 'Use a local file path without a query or fragment.');
    return fileURLToPath(url);
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(input))
    throw new PreviewError(400, 'Use a local HTML file path.');
  return input;
}

/** A read-only static preview; it does not grant any agent browser permissions. */
export class LocalPreviewServer {
  private server?: Server;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private host = '';
  private disposed = false;
  private previews = new Map<string, Preview>();
  private revisions = new Map<string, number>();
  private active = new Map<ServerResponse, Preview>();

  async open(conversationId: string, folder: string, requestedPath: string): Promise<string> {
    if (this.disposed) throw new Error('Local previews are closed.');
    if (!conversationId || !folder || !isAbsolute(folder))
      throw new Error('Choose a folder for this chat before opening a local preview.');
    const revision = this.revisions.get(conversationId) ?? 0;
    const root = await realpath(folder);
    if (!(await stat(root)).isDirectory()) throw new Error('The chat folder is not a directory.');
    const preview: Preview = { conversationId, root, attachedFolder: folder };
    const requested = requestedFile(requestedPath);
    // Absolute paths through the original attached-folder symlink remain valid.
    const lexical = resolve(isAbsolute(requested) ? requested : resolve(root, requested));
    if (!inside(root, lexical) && !inside(resolve(folder), lexical))
      throw new PreviewError(403, 'The preview is outside this chat’s folder.');
    if (!['.html', '.htm'].includes(extname(lexical).toLowerCase()))
      throw new PreviewError(415, 'Select an HTML file (.html or .htm) to open in the browser.');
    const target = await this.target(preview, lexical);
    if (!['.html', '.htm'].includes(extname(target).toLowerCase()))
      throw new PreviewError(415, 'Select an HTML file (.html or .htm) to open in the browser.');
    const handle = await this.file(target);
    await handle.close();
    await this.start();
    if (this.disposed || revision !== (this.revisions.get(conversationId) ?? 0))
      throw new Error('This local preview was closed before it opened.');
    const token = randomBytes(32).toString('hex');
    this.previews.set(token, preview);
    const pathname = relative(root, target).split(sep).map(encodeURIComponent).join('/');
    return `http://${this.host}/${token}/${pathname}`;
  }

  closeConversation(conversationId: string): void {
    this.revisions.set(conversationId, (this.revisions.get(conversationId) ?? 0) + 1);
    for (const [token, preview] of this.previews)
      if (preview.conversationId === conversationId) this.previews.delete(token);
    for (const [response, preview] of this.active)
      if (preview.conversationId === conversationId) response.destroy();
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    this.previews.clear();
    for (const response of this.active.keys()) response.destroy();
    this.closing = (async () => {
      await this.starting?.catch(() => {});
      const server = this.server;
      if (!server?.listening) return;
      await new Promise<void>(resolveClose => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      });
    })();
    return this.closing;
  }

  private start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Local previews are closed.'));
    if (this.starting) return this.starting;
    const server = createServer((request, response) => {
      void this.serve(request, response).catch(() => {
        this.reply(response, 404, 'Preview file is unavailable.');
      });
    });
    this.server = server;
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 1000;
    server.maxConnections = 32;
    this.starting = new Promise<void>((resolveStart, reject) => {
      const failed = (error: Error) => { this.starting = undefined; reject(error); };
      server.once('error', failed);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', failed);
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('Could not start local preview.')); return; }
        this.host = `127.0.0.1:${address.port}`;
        server.unref();
        resolveStart();
      });
    });
    return this.starting;
  }

  private async target(preview: Preview, requested: string): Promise<string> {
    // A replaced attached-folder symlink must not silently change the grant.
    if (await realpath(preview.attachedFolder) !== preview.root)
      throw new PreviewError(403, 'The chat folder changed. Open the preview again.');
    const lexical = resolve(preview.root, requested);
    const lexicalRoot = inside(preview.root, lexical) ? preview.root : resolve(preview.attachedFolder);
    if (!inside(lexicalRoot, lexical) || excluded(relative(lexicalRoot, lexical)))
      throw new PreviewError(403, 'This preview path is not allowed.');
    const target = await realpath(lexical);
    if (!inside(preview.root, target) || excluded(relative(preview.root, target)))
      throw new PreviewError(403, 'This preview path is not allowed.');
    if (!MIME[extname(target).toLowerCase()])
      throw new PreviewError(415, 'This file type is not supported by local previews.');
    return target;
  }

  private async file(target: string) {
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new PreviewError(404, 'Select a regular preview file.');
      if (info.size > LOCAL_PREVIEW_MAX_BYTES)
        throw new PreviewError(413, 'This preview file exceeds the 8 MiB limit.');
      // Catch ancestor swaps between canonicalization and opening; do not stream
      // any bytes until the open descriptor and current path refer to one file.
      const current = await stat(target);
      if (await realpath(target) !== target || current.dev !== info.dev || current.ino !== info.ino)
        throw new PreviewError(403, 'The preview file changed while opening.');
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }

  private reply(response: ServerResponse, status: number, body: string): void {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    });
    response.end(body);
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    request.resume();
    if (this.disposed || request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== this.host) {
      this.reply(response, 403, 'Local preview access denied.'); return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      this.reply(response, 405, 'Local previews are read only.'); return;
    }
    // Require an origin-form path and an unguessable preview route. No CORS
    // endpoint, arbitrary filesystem root or redirect target is exposed.
    const match = /^\/([a-f0-9]{64})\/(.*)$/.exec((request.url ?? '').split('?')[0]);
    const preview = match ? this.previews.get(match[1]) : undefined;
    if (!match || !preview) { this.reply(response, 404, 'Local preview is unavailable.'); return; }
    if (this.active.size >= 16) { this.reply(response, 503, 'Local preview is busy.'); return; }
    this.active.set(response, preview);
    response.once('close', () => this.active.delete(response));
    try {
      const requested = decodeURIComponent(match[2]);
      if (!requested || requested.length > 8192 || /[\u0000-\u001f\\]/.test(requested) || isAbsolute(requested))
        throw new PreviewError(400, 'Invalid preview path.');
      const target = await this.target(preview, requested);
      const handle = await this.file(target);
      try {
        // Bounded even if another process grows the file after stat().
        const bytes = Buffer.alloc(Math.min((await handle.stat()).size, LOCAL_PREVIEW_MAX_BYTES) + 1);
        let length = 0;
        while (length < bytes.length) {
          const chunk = await handle.read(bytes, length, bytes.length - length, null);
          if (!chunk.bytesRead) break;
          length += chunk.bytesRead;
        }
        if (length > LOCAL_PREVIEW_MAX_BYTES)
          throw new PreviewError(413, 'This preview file exceeds the 8 MiB limit.');
        if (length === bytes.length)
          throw new PreviewError(409, 'The preview file grew while loading. Reload to try again.');
        if (this.disposed || this.previews.get(match[1]) !== preview || response.destroyed) return;
        response.writeHead(200, {
          'Content-Type': MIME[extname(target).toLowerCase()], 'Content-Length': length,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        });
        response.end(request.method === 'HEAD' ? undefined : bytes.subarray(0, length));
      } finally { await handle.close(); }
    } catch (error) {
      this.reply(response, error instanceof PreviewError ? error.status : 404,
        error instanceof PreviewError ? error.message : 'Preview file is unavailable.');
    } finally { this.active.delete(response); }
  }
}
