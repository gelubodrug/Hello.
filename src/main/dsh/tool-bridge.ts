import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * The bridge that lets Hello's chats call tools dsh plugins register.
 *
 * It runs inside the DSH host, next to dsh's own tool registry, and answers
 * main only: 127.0.0.1, a token minted for this start, two routes. Calls run
 * in dsh's global view — no dsh agent, no dsh session — through the same
 * policy and guards a dsh agent's calls go through.
 *
 * Only plugin tools cross. dsh's own tools (a shell, files, the web, its
 * agent machinery) either need a dsh session or would duplicate what Hello
 * does with its own approvals, so neither the listing nor a call reaches them.
 */

/** The environment variable carrying this start's bridge token into the host. */
export const BRIDGE_TOKEN_ENV = 'HELLO_DSH_BRIDGE_TOKEN';

/**
 * Global tools the pinned dsh (0.1.7-rc.2, `web` profile) owns. Its own tools
 * (shell, files, web, subagents) register per agent, so the global view a
 * profile without plugins lists is empty but for the reserved `run_code`
 * transport. Measured on 28.09; re-measure on a dsh upgrade.
 */
export const DSH_PRODUCT_TOOLS: ReadonlySet<string> = new Set([
  'run_code',
]);

/** Whether a tool is one a plugin brought, and so may be offered to Hello. */
export function bridgeable(name: string): boolean {
  return !DSH_PRODUCT_TOOLS.has(name);
}

export interface BridgedTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface BridgeCallResult {
  isError: boolean;
  text: string;
}

/** The part of dsh's ToolRegistry the bridge uses. */
export interface ToolRegistryLike {
  schemas(): Array<{ name: string; description?: string; parameters?: unknown }>;
  execute(input: { callId: string; name: string; arguments: Record<string, unknown>; signal: AbortSignal }): Promise<{
    isError: boolean;
    content?: unknown;
    error?: { message?: string };
  }>;
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESULT_CHARS = 60_000;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** dsh's content blocks as the plain text Hello's tool host returns. */
export function contentText(content: unknown): string {
  const parts: string[] = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!object(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image returned by the dsh tool; Hello does not forward it to the model]');
    else parts.push(`[${String(block.type ?? 'unknown')} content]`);
  }
  const text = parts.join('\n').trim();
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated by Hello at ${MAX_RESULT_CHARS} characters]` : text;
}

function tokenMatches(header: string | undefined, token: Buffer): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? '');
  if (!match) return false;
  const given = Buffer.from(match[1]);
  return given.length === token.length && timingSafeEqual(given, token);
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(text);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export interface ToolBridgeServer {
  port: number;
  close(): Promise<void>;
}

/** Starts the bridge on 127.0.0.1 and an ephemeral port. */
export async function startToolBridge(registry: () => ToolRegistryLike | undefined, token: string): Promise<ToolBridgeServer> {
  const secret = Buffer.from(token);
  const running = new Set<AbortController>();
  const server: Server = createServer((request, response) => {
    void (async () => {
      if (!tokenMatches(request.headers.authorization, secret)) return reply(response, 401, { error: 'unauthorized' });
      const tools = registry();
      if (!tools) return reply(response, 503, { error: 'dsh has no tool registry' });
      if (request.method === 'GET' && request.url === '/tools') {
        const listed: BridgedTool[] = tools.schemas().filter(tool => bridgeable(tool.name)).map(tool => ({
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          parameters: object(tool.parameters) ? tool.parameters : { type: 'object', properties: {} },
        }));
        return reply(response, 200, { tools: listed });
      }
      if (request.method === 'POST' && request.url === '/call') {
        let body: unknown;
        try { body = JSON.parse(await readBody(request)); } catch { return reply(response, 400, { error: 'bad request' }); }
        if (!object(body) || typeof body.name !== 'string' || !object(body.arguments)) return reply(response, 400, { error: 'bad request' });
        if (!bridgeable(body.name)) return reply(response, 403, { error: 'not a plugin tool' });
        const controller = new AbortController();
        running.add(controller);
        // Main's request going away is Hello's Stop reaching the tool.
        response.on('close', () => { if (!response.writableFinished) controller.abort(new Error('Stopped.')); });
        try {
          const result = await tools.execute({ callId: `hello-${randomUUID()}`, name: body.name, arguments: body.arguments, signal: controller.signal });
          const text = contentText(result.content) || (result.isError ? result.error?.message ?? 'The dsh tool failed.' : 'The dsh tool returned no content.');
          return reply(response, 200, { isError: result.isError === true, text } satisfies BridgeCallResult);
        } catch (error) {
          return reply(response, 200, { isError: true, text: error instanceof Error ? error.message : String(error) } satisfies BridgeCallResult);
        } finally {
          running.delete(controller);
        }
      }
      return reply(response, 404, { error: 'not found' });
    })().catch(() => { if (!response.headersSent) reply(response, 500, { error: 'bridge failure' }); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>(resolve => {
      for (const controller of running) controller.abort(new Error('The DSH host is stopping.'));
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
