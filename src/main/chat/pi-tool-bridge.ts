import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ToolDefinition } from './tools';
import type { ToolCatalog } from './tool-groups';
import { readToolOutput, type ToolOutput } from './tool-output';

// One bridge belongs to one headless Pi process and one Hello conversation.
// Keep execution in Hello's main process: Pi never receives a filesystem or
// browser capability that bypasses the existing executeTool approval gates.
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 10_000;
const EXECUTION_TIMEOUT_MS = 30 * 60_000;
const MAX_ACTIVE_REQUESTS = 32;

export interface PiToolBridgeOptions {
  getTools(): ToolDefinition[] | Promise<ToolDefinition[]>;
  execute(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    toolCallId: string,
  ): Promise<ToolOutput>;
  /** Current browser/tab guidance, computed afresh before every model request. */
  getContext?(): string | Promise<string>;
  /** Which tools are core and which the model loads by group (tool-groups.ts). */
  getCatalog?(tools: ToolDefinition[]): ToolCatalog | Promise<ToolCatalog>;
}

export interface PiToolBridge {
  /** Pass only to the Pi child's environment, never to the renderer or argv. */
  env: { HELLO_PI_BRIDGE_URL: string; HELLO_PI_BRIDGE_TOKEN: string };
  /** True only after the authenticated extension has activated Hello's tools. */
  readonly ready: boolean;
  close(): Promise<void>;
}

export interface PiBridgeContextResponse {
  context: string;
}

export interface PiBridgeExecuteRequest {
  name: string;
  args: Record<string, unknown>;
  toolCallId: string;
}

class BridgeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    send(response, 413, { error: 'Hello tool result exceeds the bridge size limit.' });
    return;
  }
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function withAbort<T>(signal: AbortSignal, operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Hello tool call cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function readBody(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES))
    throw new BridgeError(413, 'Hello tool arguments exceed the bridge size limit.');
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json')
    throw new BridgeError(415, 'Expected JSON tool arguments.');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    signal.throwIfAborted();
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES)
      throw new BridgeError(413, 'Hello tool arguments exceed the bridge size limit.');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BridgeError(400, 'Invalid JSON tool arguments.');
  }
}

export async function createPiToolBridge(options: PiToolBridgeOptions): Promise<PiToolBridge> {
  const token = randomBytes(32).toString('hex');
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  const active = new Set<AbortController>();
  const calls = new Set<string>();
  let ready = false;
  let closed = false;
  let host = '';
  const server = createServer((request, response) => {
    // No CORS endpoint, DNS-rebinding host, redirects or public listener.
    const auth = request.headers.authorization;
    if (closed || request.socket.remoteAddress !== '127.0.0.1' ||
        request.headers.host !== host || request.headers.origin !== undefined ||
        !auth || Buffer.byteLength(auth) !== expectedAuth.length ||
        !timingSafeEqual(Buffer.from(auth), expectedAuth)) {
      send(response, 403, { error: 'Hello tool bridge access denied.' });
      request.resume();
      return;
    }
    if (active.size >= MAX_ACTIVE_REQUESTS) {
      send(response, 429, { error: 'Too many active Hello tool requests.' });
      request.resume();
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    const cancel = () => controller.abort(new Error('Hello tool request disconnected.'));
    request.once('aborted', cancel);
    response.once('close', cancel);
    const execution = request.method === 'POST' && request.url === '/execute';
    const timeout = setTimeout(() => {
      controller.abort(new BridgeError(504, 'Hello tool request timed out.'));
      send(response, 504, { error: 'Hello tool request timed out.' });
    }, execution ? EXECUTION_TIMEOUT_MS : METADATA_TIMEOUT_MS);
    timeout.unref();

    void (async () => {
      const { signal } = controller;
      if (request.method === 'GET' && request.url === '/tools') {
        const tools = await withAbort(signal, Promise.resolve(options.getTools()));
        const catalog = options.getCatalog ? await withAbort(signal, Promise.resolve(options.getCatalog(tools))) : undefined;
        send(response, 200, { tools, ...(catalog ?? {}) });
        return;
      }
      if (request.method === 'GET' && request.url === '/ready') {
        ready = true;
        send(response, 200, { ready: true });
        return;
      }
      if (request.method === 'GET' && request.url === '/context') {
        const context = await withAbort(signal, Promise.resolve(options.getContext?.() ?? ''));
        send(response, 200, { context });
        return;
      }
      if (!execution) throw new BridgeError(404, 'Unknown Hello tool bridge operation.');
      const body = await withAbort(signal, readBody(request, signal));
      if (!object(body) || typeof body.name !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(body.name) ||
          typeof body.toolCallId !== 'string' || !body.toolCallId || body.toolCallId.length > 512 ||
          !object(body.args))
        throw new BridgeError(400, 'Invalid Hello tool request.');
      if (calls.has(body.toolCallId)) throw new BridgeError(409, 'Hello tool call is already running.');
      // Re-check current availability; a folder or browser permission may have
      // changed since Pi last obtained the schema. execute() enforces the rest.
      const available = await withAbort(signal, Promise.resolve(options.getTools()));
      if (!available.some(tool => tool.function.name === body.name))
        throw new BridgeError(403, 'This Hello tool is currently unavailable.');
      signal.throwIfAborted();
      const { name, args, toolCallId } = body as unknown as PiBridgeExecuteRequest;
      if (calls.has(toolCallId)) throw new BridgeError(409, 'Hello tool call is already running.');
      calls.add(toolCallId);
      try {
        const result = readToolOutput(await withAbort(signal, options.execute(name, args, signal, toolCallId)));
        signal.throwIfAborted();
        send(response, 200, { result });
      } finally {
        calls.delete(toolCallId);
      }
    })().catch((error: unknown) => {
      const status = error instanceof BridgeError ? error.status : 500;
      // Whatever a tool threw says why; only nothing at all falls back to the generic words.
      const message = error instanceof Error ? error.message.slice(0, 2048)
        : typeof error === 'string' && error.trim() ? error.slice(0, 2048) : 'Hello tool execution failed.';
      send(response, status, { error: message });
      request.resume();
    }).finally(() => {
      clearTimeout(timeout);
      active.delete(controller);
      request.removeListener('aborted', cancel);
      response.removeListener('close', cancel);
    });
  });
  server.maxConnections = 64;
  server.maxHeadersCount = 32;
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Hello tool bridge could not bind a loopback port.');
  }
  host = `127.0.0.1:${address.port}`;
  server.unref();
  let closing: Promise<void> | undefined;
  return {
    env: { HELLO_PI_BRIDGE_URL: `http://${host}`, HELLO_PI_BRIDGE_TOKEN: token },
    get ready() { return ready && !closed; },
    close() {
      if (closing) return closing;
      closed = true;
      for (const controller of active) controller.abort(new Error('Hello chat stopped.'));
      closing = new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
