import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

/**
 * The model the DSH surface's sessions talk to: Hello's own active connection,
 * reached through this proxy.
 *
 * The dsh host runs third-party plugin code, so the real API key never enters
 * it. The host gets a token that is good only here, only for this start, only
 * on 127.0.0.1; the proxy swaps it for the key on the way out and reads the
 * connection fresh on every request — address, key and model — so a model
 * changed in Hello's settings is the model the next DSH request uses.
 */
export interface ModelConnection {
  /** OpenAI-compatible base, as Hello stores it: `…/v1`. */
  endpointUrl: string;
  model: string;
  apiKey: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ProxyAddress {
  port: number;
  token: string;
  /** What dsh's llm-pi-ai route is pointed at. */
  baseURL: string;
}

const BODY_LIMIT = 32 * 1024 * 1024;
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'accept-encoding', 'user-agent', 'x-stainless-lang', 'x-stainless-package-version'];
const DROPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length']);

/** The upstream URL for a proxied path, under the connection's own base. */
export function upstreamUrl(endpointUrl: string, requestUrl: string): string | undefined {
  const incoming = new URL(requestUrl, 'http://127.0.0.1');
  if (incoming.pathname !== '/v1' && !incoming.pathname.startsWith('/v1/')) return undefined;
  const rest = incoming.pathname.slice('/v1'.length);
  const base = new URL(endpointUrl);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return undefined;
  base.pathname = `${base.pathname.replace(/\/+$/, '')}${rest}`;
  base.search = incoming.search;
  return base.toString();
}

/**
 * The request with Hello's model in place of the one dsh named. dsh was told
 * the model in use when it started, while the connection is read fresh on
 * every request: without this, a model changed in Hello sent the old model's
 * name to the new server (user, 01.10: "model … not found"). A body that is not
 * a JSON object naming a model goes on exactly as it came.
 */
export function withModel(body: Buffer, model: string): Buffer {
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return body; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body;
  const named = (parsed as { model?: unknown }).model;
  if (typeof named !== 'string' || named === model) return body;
  return Buffer.from(JSON.stringify({ ...(parsed as Record<string, unknown>), model }));
}

function sameToken(given: string | undefined, token: string): boolean {
  if (!given) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class ModelProxy {
  private server?: Server;
  private address?: ProxyAddress;

  constructor(
    private readonly connection: () => ModelConnection | undefined,
    private readonly log: (line: string) => void = () => {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get current(): ProxyAddress | undefined {
    return this.address;
  }

  async start(): Promise<ProxyAddress> {
    if (this.address) return this.address;
    const token = randomBytes(24).toString('base64url');
    const server = createServer((request, response) => { void this.handle(request, response, token); });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const port = (server.address() as AddressInfo).port;
    this.server = server;
    this.address = { port, token, baseURL: `http://127.0.0.1:${port}/v1` };
    return this.address;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.address = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    const fail = (status: number, message: string) => {
      if (!response.headersSent) response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message, type: 'hello_proxy' } }));
    };
    if (!sameToken(request.headers.authorization, token)) { fail(401, 'This proxy answers only the DSH surface Hello. started.'); return; }
    if (request.method !== 'GET' && request.method !== 'POST') { fail(405, 'Only GET and POST reach the model.'); return; }
    const connection = this.connection();
    if (!connection?.endpointUrl) { fail(503, 'Hello. has no model connection. Add one in Settings › Connection.'); return; }
    const target = upstreamUrl(connection.endpointUrl, request.url ?? '/');
    if (!target) { fail(404, 'Only the /v1 API is proxied.'); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    if (request.method === 'POST') {
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > BODY_LIMIT) { fail(413, 'The request is larger than the proxy passes on.'); request.destroy(); return; }
        chunks.push(chunk as Buffer);
      }
    }
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    if (connection.apiKey) headers.authorization = `Bearer ${connection.apiKey}`;
    const controller = new AbortController();
    response.on('close', () => { if (!response.writableFinished) controller.abort(); });
    try {
      const upstream = await this.fetchImpl(target, {
        method: request.method,
        headers,
        ...(request.method === 'POST' ? { body: withModel(Buffer.concat(chunks), connection.model) } : {}),
        signal: controller.signal,
      });
      const out: Record<string, string> = {};
      upstream.headers.forEach((value, name) => { if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) out[name] = value; });
      response.writeHead(upstream.status, out);
      if (upstream.body) Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(response);
      else response.end();
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Model proxy: ${message.split(connection.apiKey || '\u0000').join('[redacted]')}`);
      fail(502, 'The model connection did not answer.');
    }
  }
}
