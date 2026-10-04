import { randomUUID } from 'node:crypto';
import type { DshStatus } from '../../shared/types';
import type { DataStore, ResourceRow } from '../data/store';
import type { McpLink, McpTool } from '../extensions/mcp';
import type { BridgeCallResult, BridgedTool } from './tool-bridge';

/**
 * The DSH surface's plugin tools, offered to Hello's chats as one MCP server.
 *
 * It is a library row like any MCP server the person adds — named, listed,
 * switched on per chat from the composer, never active on its own — but no
 * process is spawned for it: the manager reaches the running DSH host's tool
 * bridge in-process. Calls take Hello's MCP path, so they are framed as
 * untrusted content exactly like a stdio server's.
 */

/** The command a library row carries to mean "the DSH surface". */
export const DSH_MCP_COMMAND = 'hello:dsh';
export const DSH_MCP_NAME = 'dsh-plugins';

const LIST_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_TOOLS = 200;
const MAX_SCHEMA_BYTES = 20_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export function isDshToolsRow(row: Pick<ResourceRow, 'kind' | 'config'>): boolean {
  if (row.kind !== 'mcp') return false;
  try { return (JSON.parse(row.config) as { command?: unknown }).command === DSH_MCP_COMMAND; } catch { return false; }
}

/** The row, when the person has put the DSH tools in the library. */
export function dshToolsRow(store: Pick<DataStore, 'listResourceRows'>): ResourceRow | undefined {
  return store.listResourceRows().find(isDshToolsRow);
}

/** Puts the DSH tools in the library, or takes them out; returns whether they are in. */
export function setDshToolsRow(store: Pick<DataStore, 'listResourceRows' | 'saveResourceRow' | 'deleteResourceRow'>, wanted: boolean): ResourceRow | undefined {
  const existing = dshToolsRow(store);
  if (!wanted) {
    if (existing) store.deleteResourceRow(existing.id);
    return undefined;
  }
  if (existing) return existing;
  return store.saveResourceRow({
    id: randomUUID(), kind: 'mcp', name: DSH_MCP_NAME,
    description: 'Tools of the plugins installed on Hello.’s DSH surface. Starts the surface when a chat that uses them needs it.',
    source: DSH_MCP_COMMAND, version: '', fingerprint: '',
    config: JSON.stringify({ command: DSH_MCP_COMMAND, args: [], cwd: null, envNames: [] }),
  });
}

/** What the link needs from the DSH service. */
export interface DshToolSource {
  status(): DshStatus;
  start(): Promise<DshStatus>;
  bridge(): { port: number; token: string; generation: number } | undefined;
}

async function bridgeRequest<T>(address: { port: number; token: string }, path: string, init: { method: 'GET' | 'POST'; body?: unknown; signal: AbortSignal; timeoutMs: number }, fetchImpl: typeof fetch): Promise<T> {
  const signal = AbortSignal.any([init.signal, AbortSignal.timeout(init.timeoutMs)]);
  let response: Response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${address.port}${path}`, {
      method: init.method,
      headers: { authorization: `Bearer ${address.token}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal,
      redirect: 'error',
    });
  } catch (error) {
    init.signal.throwIfAborted();
    if (signal.aborted) throw new Error(`The DSH surface did not answer within ${Math.round(init.timeoutMs / 1000)}s.`);
    throw new Error(`The DSH surface could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('The DSH surface sent a larger answer than Hello accepts.');
  if (!response.ok) throw new Error(`The DSH surface refused the request (${response.status}).`);
  try { return JSON.parse(text) as T; } catch { throw new Error('The DSH surface sent an answer Hello could not read.'); }
}

/** One chat-facing connection to the running host's tool bridge. */
export class DshToolLink implements McpLink {
  toolsDirty = false;
  tools: McpTool[] = [];
  private generation?: number;

  constructor(private readonly source: DshToolSource, private readonly fetchImpl: typeof fetch = fetch) {}

  /** Live only while the host it listed is: a restart is another set of plugins. */
  get running(): boolean {
    return this.generation !== undefined && this.source.bridge()?.generation === this.generation;
  }

  private async address(): Promise<{ port: number; token: string; generation: number }> {
    const ready = this.source.bridge();
    if (ready) return ready;
    const status = this.source.status();
    if (status.state === 'absent') throw new Error('The DSH surface is not installed. Open DSH in the sidebar to install it.');
    if (status.profileChange) throw new Error('The DSH profile changed outside Hello.; open DSH in the sidebar to review it before its tools run.');
    const started = await this.source.start();
    const address = this.source.bridge();
    if (!address) throw new Error(started.message ?? 'The DSH surface did not start.');
    return address;
  }

  async start(): Promise<void> {
    const address = await this.address();
    this.generation = address.generation;
    await this.refreshTools();
  }

  async refreshTools(signal: AbortSignal = new AbortController().signal): Promise<McpTool[]> {
    const address = this.source.bridge();
    if (!address || address.generation !== this.generation) throw new Error('The DSH surface restarted; its tools are listed again on the next turn.');
    const listed = await bridgeRequest<{ tools?: BridgedTool[] }>(address, '/tools', { method: 'GET', signal, timeoutMs: LIST_TIMEOUT_MS }, this.fetchImpl);
    const rows = Array.isArray(listed.tools) ? listed.tools : [];
    if (rows.length > MAX_TOOLS) throw new Error(`The DSH surface offers more than Hello's ${MAX_TOOLS}-tool limit.`);
    this.tools = rows.flatMap(tool => {
      if (!tool || typeof tool.name !== 'string' || !tool.name) return [];
      const schema = tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} };
      if (Buffer.byteLength(JSON.stringify(schema)) > MAX_SCHEMA_BYTES) return [];
      return [{ name: tool.name, description: String(tool.description ?? '').slice(0, 4000), schema }];
    });
    return this.tools;
  }

  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const address = this.source.bridge();
    if (!address || address.generation !== this.generation) throw new Error('The DSH surface restarted while this chat was using it. Ask again.');
    const result = await bridgeRequest<BridgeCallResult>(address, '/call', { method: 'POST', body: { name, arguments: args }, signal, timeoutMs: CALL_TIMEOUT_MS }, this.fetchImpl);
    const text = typeof result.text === 'string' && result.text ? result.text : 'The dsh tool returned no content.';
    if (result.isError) throw new Error(`The dsh tool reported an error:\n${text}`);
    return text;
  }

  /** Forgets the listing; the surface itself is the person's and keeps running. */
  async stop(): Promise<void> {
    this.generation = undefined;
    this.tools = [];
  }
}
