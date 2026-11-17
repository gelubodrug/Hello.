import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { CHILD_PLATFORM_KEYS, shellEnvironment } from '../shell-env';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import type { McpServerStatus } from '../../shared/types';
import type { DataStore, ResourceRow } from '../data/store';
import { mcpServerUrl, parseConfig, type McpConfig } from './library';
import { McpAuthRequiredError, McpClient, McpSessionExpiredError, StreamableHttpTransport, type AuthProvider } from '@earendil-works/pi-mcp';
import { McpOAuthAuthorizationRequiredError, McpOAuthProvider, OAuthCallbackServer, adaptOAuthProvider, authorizeMcp, type McpOAuthState, type McpOAuthStateStore } from '@earendil-works/pi-mcp/oauth';

// Hello connects to MCP servers itself, lists and calls their tools, then
// offers them to the model through the existing tool bridge — the same
// approval-capable host path as every other Hello tool. A local server is a
// process Hello starts over stdio, with a minimal environment, never the
// renderer, the browser session or Hello's own credentials. A remote one is
// reached over streamable HTTP through @earendil-works/pi-mcp (Pi's own MCP
// client, MIT): https, or http on this Mac, its headers and its sign-in kept
// encrypted in Hello's store (user, 03.11: Neon was "Not supported").

const PROTOCOL_VERSION = '2025-06-18';
const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOOLS = 200;
const MAX_RESULT_CHARS = 60_000;
/** A server connected only by a Settings probe is stopped once it goes idle. */
const IDLE_TIMEOUT_MS = 5 * 60_000;
/** How long the browser sign-in waits for the person. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
/** Who Hello says it is when it registers with a server's authorization server. */
const CLIENT_METADATA = {
  client_name: 'Hello.', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  token_endpoint_auth_method: 'none', application_type: 'native',
};

/** The server wants a sign-in Hello does not have, or no longer has: the person signs in from Settings. */
export class McpSignInRequiredError extends Error {
  constructor(name: string) { super(`${name} needs you to sign in. Use Sign in beside it in Settings › Extensions.`); }
}
export interface McpOptions {
  connectTimeoutMs?: number; callTimeoutMs?: number; maxMessageBytes?: number;
}

interface JsonRpcResponse { jsonrpc: '2.0'; id?: number | string | null; result?: unknown; error?: { code?: number; message?: string }; method?: string; }

export interface McpTool { name: string; description: string; schema: Record<string, unknown>; }

/** One connected server as the manager uses it, whatever carries its messages. */
export interface McpLink {
  readonly running: boolean;
  toolsDirty: boolean;
  tools: McpTool[];
  start(): Promise<void>;
  refreshTools(signal?: AbortSignal): Promise<McpTool[]>;
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  stop(reason?: Error): Promise<void>;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Hello tool names are `[a-z][a-z0-9_]*`; MCP names are far more permissive. */
export function toolNameFor(serverName: string, toolName: string): string {
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const name = `mcp_${clean(serverName) || 'server'}_${clean(toolName) || 'tool'}`;
  return name.length <= 64 ? name : `${name.slice(0, 51)}_${createHash('sha256').update(`${serverName}\0${toolName}`).digest('hex').slice(0, 12)}`;
}

/** Flatten an MCP result into the plain text Hello's tool host returns. */
export function resultText(payload: unknown): string {
  if (!object(payload)) return 'The MCP server returned no content.';
  const content = Array.isArray(payload.content) ? payload.content : [];
  const parts: string[] = [];
  for (const item of content) {
    if (!object(item)) continue;
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    else if (item.type === 'image') parts.push(`[image ${typeof item.mimeType === 'string' ? item.mimeType : 'attachment'} returned by the MCP server; Hello does not forward it to the model]`);
    else if (item.type === 'resource' && object(item.resource)) {
      const resource = item.resource;
      parts.push(typeof resource.text === 'string'
        ? `${typeof resource.uri === 'string' ? `${resource.uri}\n` : ''}${resource.text}`
        : `[resource ${typeof resource.uri === 'string' ? resource.uri : 'without text'}]`);
    } else parts.push(`[${String(item.type ?? 'unknown')} content]`);
  }
  if (object(payload.structuredContent) && !parts.length) parts.push(JSON.stringify(payload.structuredContent));
  const text = parts.join('\n').trim() || 'The MCP server returned an empty result.';
  const flagged = payload.isError === true ? `The MCP server reported an error:\n${text}` : text;
  return flagged.length > MAX_RESULT_CHARS
    ? `${flagged.slice(0, MAX_RESULT_CHARS)}\n[truncated by Hello at ${MAX_RESULT_CHARS} characters]`
    : flagged;
}

class McpConnection implements McpLink {
  private child?: ChildProcessWithoutNullStreams;
  /** Configured values, longest first, so a message never carries a secret. */
  private readonly secrets: string[];
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number | string, { resolve(value: unknown): void; reject(reason: Error): void; timer: NodeJS.Timeout }>();
  private stderr = '';
  private closed = false;
  private stopping?: Promise<void>;
  private toolsSupported = false;
  toolsDirty = false;
  tools: McpTool[] = [];

  constructor(private readonly row: ResourceRow, private readonly env: Record<string, string>, private readonly options: McpOptions = {}) {
    this.secrets = Object.values(env)
      .filter(value => value.length >= 6)
      .sort((a, b) => b.length - a.length);
  }

  /** A server's own stderr may echo a token Hello passed to it. */
  private redact(text: string): string {
    let result = text;
    for (const secret of this.secrets) result = result.split(secret).join('[redacted]');
    return result;
  }

  get running(): boolean { return Boolean(this.child) && !this.closed; }

  async start(): Promise<void> {
    const config = parseConfig(this.row) as McpConfig;
    if (!config.command) throw new Error('This MCP server has no command.');
    const environment: NodeJS.ProcessEnv = {};
    const source = shellEnvironment();
    for (const name of CHILD_PLATFORM_KEYS)
      if (source[name] !== undefined) environment[name] = source[name];
    Object.assign(environment, this.env);
    const child = spawn(config.command, config.args, {
      cwd: config.cwd ?? undefined,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Never a shell: arguments stay separate values, not a command string.
      shell: false,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.receive(String(chunk)));
    child.stdin.on('error', error => this.fail(new Error(this.redact(error.message))));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { this.stderr = this.redact(this.stderr + String(chunk)).slice(-4000); });
    child.once('error', error => this.fail(new Error(this.redact(error instanceof Error ? error.message : String(error)))));
    child.once('exit', (code, signal) => this.fail(new Error(
      `The MCP server stopped (${signal ? `signal ${signal}` : `exit code ${code ?? 0}`}).${this.stderr.trim() ? ` Output: ${this.stderr.trim().slice(-500)}` : ''}`)));
    const startup = await Promise.race([
      this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'Hello.', version: '0.1.0' },
      }, this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS),
      once(child, 'exit').then(() => { throw new Error(`The MCP server exited during startup.${this.stderr.trim() ? ` Output: ${this.stderr.trim().slice(-500)}` : ''}`); }),
    ]);
    if (!object(startup)) throw new Error('The MCP server returned an invalid initialize response.');
    if (!['2024-11-05', '2025-03-26', PROTOCOL_VERSION].includes(String(startup.protocolVersion)))
      throw new Error(`Unsupported MCP protocol version: ${String(startup.protocolVersion).slice(0, 80)}.`);
    this.toolsSupported = object(startup.capabilities) && object(startup.capabilities.tools);
    this.notify('notifications/initialized', {});
    await this.refreshTools();
  }

  async refreshTools(signal?: AbortSignal): Promise<McpTool[]> {
    if (!this.toolsSupported) return this.tools = [];
    const rows: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const listed = await this.request('tools/list', cursor ? { cursor } : {}, this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, signal);
      if (!object(listed) || !Array.isArray(listed.tools)) throw new Error('Invalid MCP tools/list response.');
      rows.push(...listed.tools);
      if (rows.length > MAX_TOOLS) throw new Error(`This server exceeds Hello's ${MAX_TOOLS}-tool limit.`);
      cursor = typeof listed.nextCursor === 'string' && listed.nextCursor ? listed.nextCursor : undefined;
      if (cursor && (cursors.has(cursor) || cursors.size >= 20)) throw new Error('The MCP server returned invalid tool pagination.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    this.tools = rows.flatMap(item => {
      if (!object(item) || typeof item.name !== 'string' || !item.name) return [];
      const schema = object(item.inputSchema) ? item.inputSchema : { type: 'object', properties: {} };
      if (Buffer.byteLength(JSON.stringify(schema)) > 20_000) throw new Error(`MCP tool “${item.name.slice(0, 100)}” has an input schema larger than Hello's 20 KB limit.`);
      return [{
        name: item.name,
        description: (typeof item.description === 'string' ? item.description : '').slice(0, 4000),
        schema: schema as Record<string, unknown>,
      }];
    });
    this.toolsDirty = false;
    return this.tools;
  }

  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const payload = await this.request('tools/call', { name, arguments: args }, this.options.callTimeoutMs ?? CALL_TIMEOUT_MS, signal);
    const text = resultText(payload);
    if (object(payload) && payload.isError === true) throw new Error(this.redact(text));
    return text;
  }

  private receive(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > (this.options.maxMessageBytes ?? MAX_MESSAGE_BYTES)) {
      // Ends the child too: a server streaming one endless line would
      // otherwise keep growing Hello's heap after every failure.
      void this.stop(new Error('The MCP server sent a message larger than Hello accepts.'));
      return;
    }
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf('\n');
      if (!line) continue;
      let message: JsonRpcResponse;
      try { message = JSON.parse(line) as JsonRpcResponse; } catch { continue; }
      if (!object(message) || message.jsonrpc !== '2.0') continue;
      // Server requests have their own ID namespace; never settle a client
      // request just because its ID happens to match a server's request.
      if (message.method) {
        if (message.method === 'notifications/tools/list_changed') this.toolsDirty = true;
        if (message.id !== undefined && message.id !== null)
          this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
            ...(message.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Hello does not support this client capability.' } }),
          }) + '\n', () => {});
        continue;
      }
      if (message.id === undefined || message.id === null) continue;
      const waiting = this.pending.get(message.id);
      if (!waiting) continue;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(this.redact(String(message.error.message ?? 'The MCP server reported an error.')).slice(0, 2000)));
      else waiting.resolve(message.result);
    }
  }

  private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Stopped.'));
    if (!this.child || this.closed) return Promise.reject(new Error('The MCP server is not connected.'));
    const id = this.nextId++;
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    if (Buffer.byteLength(payload) > (this.options.maxMessageBytes ?? MAX_MESSAGE_BYTES)) return Promise.reject(new Error('The MCP request is too large.'));
    return new Promise<unknown>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.pending.delete(id); signal?.removeEventListener('abort', abort); };
      const abort = () => {
        cleanup();
        this.notify('notifications/cancelled', { requestId: id, reason: 'Stopped by the user.' });
        reject(signal?.reason ?? new Error('Stopped.'));
      };
      const timer = setTimeout(() => {
        cleanup();
        if (method !== 'initialize') this.notify('notifications/cancelled', { requestId: id, reason: 'Request timed out.' });
        reject(new Error(`The MCP server did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); }, timer });
      signal?.addEventListener('abort', abort, { once: true });
      this.child!.stdin.write(payload, error => {
        if (!error) return;
        cleanup();
        reject(new Error(`Could not reach the MCP server: ${error.message}`));
      });
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`, () => {});
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = '';
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }

  stop(reason?: Error): Promise<void> {
    return this.stopping ??= this.stopChild(reason);
  }

  private async stopChild(reason?: Error): Promise<void> {
    this.fail(reason ?? new Error('The MCP server was disconnected.'));
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.stdout.removeAllListeners('data');
    child.stderr.removeAllListeners('data');
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit').catch(() => {});
    child.stdin.end();
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    timer.unref();
    await exited;
    clearTimeout(timer);
  }
}

/** A tools/list answer as Hello keeps it, within the same limits for every transport. */
function keptTools(rows: unknown[]): McpTool[] {
  if (rows.length > MAX_TOOLS) throw new Error(`This server exceeds Hello's ${MAX_TOOLS}-tool limit.`);
  return rows.flatMap(item => {
    if (!object(item) || typeof item.name !== 'string' || !item.name) return [];
    const schema = object(item.inputSchema) ? item.inputSchema : { type: 'object', properties: {} };
    if (Buffer.byteLength(JSON.stringify(schema)) > 20_000) throw new Error(`MCP tool “${item.name.slice(0, 100)}” has an input schema larger than Hello's 20 KB limit.`);
    return [{
      name: item.name,
      description: (typeof item.description === 'string' ? item.description : '').slice(0, 4000),
      schema: schema as Record<string, unknown>,
    }];
  });
}

/**
 * A server reached over streamable HTTP. It never opens a browser: a server
 * that wants a sign-in Hello lacks ends the connection with
 * McpSignInRequiredError, and the person signs in from Settings. Its stored
 * tokens are refreshed as they expire; a session the server forgot is opened
 * again once.
 */
class McpHttpConnection implements McpLink {
  private client?: McpClient;
  private closed = false;
  private toolsSupported = false;
  /** Header values and tokens, longest first, so a message never carries a secret. */
  private readonly secrets: string[];
  toolsDirty = false;
  tools: McpTool[] = [];

  constructor(
    private readonly row: ResourceRow,
    private readonly headers: Record<string, string>,
    private readonly auth: McpOAuthStateStore,
    private readonly options: McpOptions = {},
  ) {
    this.secrets = Object.values(headers).filter(value => value.length >= 6).sort((a, b) => b.length - a.length);
  }

  get running(): boolean { return Boolean(this.client) && !this.closed; }

  private redact(text: string): string {
    let result = text;
    for (const secret of this.secrets) result = result.split(secret).join('[redacted]');
    return result;
  }

  /** What went wrong, said for the person: a sign-in when that is what the server wants. */
  private problem(error: unknown): Error {
    if (error instanceof McpSignInRequiredError) return error;
    if (error instanceof McpAuthRequiredError || error instanceof McpOAuthAuthorizationRequiredError) return new McpSignInRequiredError(this.row.name);
    return new Error(this.redact(error instanceof Error ? error.message : 'The MCP server could not be reached.'));
  }

  async start(): Promise<void> {
    const config = parseConfig(this.row) as McpConfig;
    const url = mcpServerUrl(config.url ?? '');
    // A refused request refreshes a grant the person already gave, and nothing
    // more: no registration, no authorization — those are the sign-in's, which
    // only a click starts. Without a grant the answer is "needs sign-in".
    const provider = new McpOAuthProvider({ serverUrl: url, redirectUrl: 'http://127.0.0.1/callback', clientMetadata: CLIENT_METADATA, store: this.auth, onRedirect: () => {} });
    const refresh = adaptOAuthProvider(provider);
    const auth: AuthProvider = {
      token: refresh.token,
      onUnauthorized: async context => {
        if (!(await provider.tokens())?.refresh_token) throw new McpSignInRequiredError(this.row.name);
        await refresh.onUnauthorized?.(context);
      },
    };
    const client = new McpClient({ name: 'Hello.', version: '1', requestTimeoutMs: this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS });
    const transport = new StreamableHttpTransport({ url, headers: this.headers, authProvider: auth, maxMessageBytes: this.options.maxMessageBytes ?? MAX_MESSAGE_BYTES });
    client.onNotification('notifications/tools/list_changed', () => { this.toolsDirty = true; });
    // Only the client in use closes the connection: the one a forgotten session replaced does not.
    client.onClose(() => { if (this.client === client) this.closed = true; });
    try {
      const started = await client.connect(transport);
      this.client = client;
      this.closed = false;
      this.toolsSupported = object(started.capabilities) && object(started.capabilities.tools);
      await this.refreshTools();
    } catch (error) {
      this.closed = true;
      await client.close().catch(() => {});
      throw this.problem(error);
    }
  }

  async refreshTools(signal?: AbortSignal): Promise<McpTool[]> {
    if (!this.client) throw new Error('The MCP server is not connected.');
    if (!this.toolsSupported) return this.tools = [];
    try { this.tools = keptTools(await this.client.listTools({ signal, timeoutMs: this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS })); }
    catch (error) { throw this.problem(error); }
    this.toolsDirty = false;
    return this.tools;
  }

  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const attempt = async () => {
      if (!this.client) throw new Error('The MCP server is not connected.');
      return this.client.callTool(name, args, { signal, timeoutMs: this.options.callTimeoutMs ?? CALL_TIMEOUT_MS });
    };
    let payload: unknown;
    try { payload = await attempt(); }
    catch (error) {
      // The server forgot the session, so the call never ran: open a new one and ask once more.
      if (!(error instanceof McpSessionExpiredError)) throw this.problem(error);
      const forgotten = this.client;
      this.client = undefined;
      await forgotten?.close().catch(() => {});
      await this.start();
      try { payload = await attempt(); } catch (again) { throw this.problem(again); }
    }
    const text = resultText(payload);
    if (object(payload) && payload.isError === true) throw new Error(this.redact(text));
    return text;
  }

  async stop(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => {});
  }
}

export interface McpToolHandle {
  /** Hello tool name offered to the model. */
  name: string;
  description: string;
  schema: Record<string, unknown>;
  serverId: string;
  serverName: string;
  remoteName: string;
}

/** One process per configured server, shared by the conversations using it. */
export class McpManager {
  private readonly connections = new Map<string, McpLink>();
  private readonly starting = new Map<string, { connection: McpLink; promise: Promise<McpLink> }>();
  private disposed = false;
  private readonly errors = new Map<string, string>();
  /** Bumped on disconnect so an in-flight start cannot resurrect a server. */
  private readonly generations = new Map<string, number>();
  private readonly lastUsed = new Map<string, number>();
  private idleTimer?: NodeJS.Timeout;
  /** HTTP servers that answered with a sign-in Hello does not have. */
  private readonly signInNeeded = new Set<string>();
  private readonly signingIn = new Map<string, Promise<McpServerStatus>>();

  constructor(private readonly store: DataStore, private readonly options: McpOptions = {}) {}

  /** A server's sign-in, read and written through the encrypted store. */
  private authStore(id: string): McpOAuthStateStore {
    return {
      load: () => this.store.resourceAuth(id) as McpOAuthState | undefined,
      save: state => this.store.saveResourceAuth(id, state as unknown as Record<string, unknown>),
    };
  }

  private linkFor(row: ResourceRow): McpLink {
    const config = parseConfig(row) as McpConfig;
    return config.transport === 'http'
      ? new McpHttpConnection(row, this.store.resourceSecret(row.id), this.authStore(row.id), this.options)
      : new McpConnection(row, this.store.resourceSecret(row.id), this.options);
  }

  /**
   * Signs in to an HTTP server the way the MCP specification says: the
   * authorization server is discovered from the server, Hello registers
   * itself, and the person approves in their own browser — opened only by
   * this call, which only a click in Settings makes — with the answer coming
   * back to a one-time callback on 127.0.0.1. Then the server is connected.
   */
  signIn(id: string, openUrl: (url: string) => Promise<void>): Promise<McpServerStatus> {
    const running = this.signingIn.get(id);
    if (running) return running;
    const attempt = (async () => {
      const row = this.store.getResourceRow(id);
      const config = parseConfig(row) as McpConfig;
      if (row.kind !== 'mcp' || config.transport !== 'http' || !config.url) throw new Error('Only an MCP server reached over HTTP signs in.');
      const url = mcpServerUrl(config.url);
      const callback = await OAuthCallbackServer.listen({ host: '127.0.0.1', path: '/callback', timeoutMs: SIGN_IN_TIMEOUT_MS });
      try {
        const provider = new McpOAuthProvider({
          serverUrl: url, redirectUrl: callback.redirectUrl, clientMetadata: CLIENT_METADATA, store: this.authStore(id),
          onRedirect: target => {
            if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)))
              throw new Error('The server sent a sign-in page that is not https.');
            return openUrl(target.href);
          },
        });
        // A registration made for another callback address does not hold for this one.
        await provider.invalidateCredentials('client');
        let result = await authorizeMcp(provider, { serverUrl: url, skipRefresh: true });
        if (result === 'REDIRECT') {
          const answer = await callback.waitForCallback(await provider.state());
          result = await authorizeMcp(provider, { serverUrl: url, authorizationCode: answer.code, iss: answer.iss });
        }
        if (result !== 'AUTHORIZED') throw new Error('The sign-in did not finish.');
      } finally { await callback.close(); }
      this.signInNeeded.delete(id);
      await this.disconnect(id);
      return this.probe(id);
    })();
    this.signingIn.set(id, attempt);
    void attempt.finally(() => { if (this.signingIn.get(id) === attempt) this.signingIn.delete(id); }).catch(() => {});
    return attempt;
  }

  private async connect(row: ResourceRow): Promise<McpLink> {
    if (this.disposed) throw new Error('MCP manager is closed.');
    const existing = this.connections.get(row.id);
    if (existing?.running) return existing;
    // A dead-but-not-stopped connection still owns a child process.
    if (existing) { this.connections.delete(row.id); await existing.stop(); }
    if (this.disposed) throw new Error('MCP manager is closed.');
    const pending = this.starting.get(row.id);
    if (pending) return pending.promise;
    const generation = (this.generations.get(row.id) ?? 0);
    const connection = this.linkFor(row);
    const attempt = (async () => {
      try {
        await connection.start();
        // Deactivated while starting: end it instead of publishing it.
        if ((this.generations.get(row.id) ?? 0) !== generation) {
          await connection.stop();
          throw new Error('The MCP server was turned off while it was starting.');
        }
        this.connections.set(row.id, connection);
        this.errors.delete(row.id);
        this.signInNeeded.delete(row.id);
        this.lastUsed.set(row.id, Date.now());
        this.scheduleIdleSweep();
        return connection;
      } catch (error) {
        await connection.stop();
        if ((this.generations.get(row.id) ?? 0) === generation) {
          this.connections.delete(row.id);
          this.errors.set(row.id, error instanceof Error ? error.message : 'The MCP server could not start.');
          if (error instanceof McpSignInRequiredError) this.signInNeeded.add(row.id);
        }
        throw error;
      } finally {
        if (this.starting.get(row.id)?.connection === connection) this.starting.delete(row.id);
      }
    })();
    this.starting.set(row.id, { connection, promise: attempt });
    return attempt;
  }

  private async connectFor(row: ResourceRow, conversationId?: string, signal?: AbortSignal): Promise<McpLink> {
    signal?.throwIfAborted();
    if (!signal) return this.connect(row);
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => {
        reject(signal.reason ?? new Error('Stopped.'));
        if (!this.store.conversationsUsing(row.id).some(id => id !== conversationId)) void this.disconnect(row.id).catch(() => {});
      };
      signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([this.connect(row), stopped]); }
    finally { signal.removeEventListener('abort', abort); }
  }

  /** Tools of every server activated in this conversation, name-collision free. */
  async toolsFor(rows: ResourceRow[], conversationId?: string, signal?: AbortSignal): Promise<McpToolHandle[]> {
    const handles: McpToolHandle[] = [];
    const used = new Set<string>();
    for (const row of rows) {
      signal?.throwIfAborted();
      if (conversationId && !this.store.activeResourceIds(conversationId).includes(row.id)) continue;
      let connection: McpLink;
      try {
        connection = await this.connectFor(row, conversationId, signal);
        if (connection.toolsDirty) await connection.refreshTools(signal);
      } catch { signal?.throwIfAborted(); continue; }
      signal?.throwIfAborted();
      if (conversationId && !this.store.activeResourceIds(conversationId).includes(row.id)) continue;
      for (const tool of connection.tools) {
        let name = toolNameFor(row.name, tool.name);
        if (used.has(name)) {
          let suffix = 2;
          const base = name.slice(0, 56);
          while (used.has(`${base}_${suffix}`)) suffix++;
          name = `${base}_${suffix}`;
        }
        used.add(name);
        handles.push({
          name, description: tool.description || `${tool.name} on the ${row.name} MCP server.`,
          schema: tool.schema, serverId: row.id, serverName: row.name, remoteName: tool.name,
        });
      }
    }
    return handles;
  }

  /** Stop servers that nothing activates and nothing has used for a while. */
  private scheduleIdleSweep(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const id of [...this.connections.keys()]) {
        if (this.store.conversationsUsing(id).length) continue;
        if (now - (this.lastUsed.get(id) ?? 0) < IDLE_TIMEOUT_MS) continue;
        void this.disconnect(id).catch(() => {});
      }
      if (!this.connections.size && this.idleTimer) {
        clearInterval(this.idleTimer);
        this.idleTimer = undefined;
      }
    }, 60_000);
    this.idleTimer.unref();
  }

  async call(handle: McpToolHandle, args: Record<string, unknown>, signal: AbortSignal, conversationId?: string): Promise<string> {
    signal.throwIfAborted();
    const row = this.store.getResourceRow(handle.serverId);
    // Turning a server off mid-turn must stop it being used, not restart it.
    if (conversationId && !this.store.activeResourceIds(conversationId).includes(row.id))
      throw new Error(`The ${row.name} MCP server was turned off for this chat. Its tools are unavailable until you turn it back on.`);
    const connection = await this.connectFor(row, conversationId, signal);
    signal.throwIfAborted();
    if (conversationId && !this.store.activeResourceIds(conversationId).includes(row.id))
      throw new Error(`The ${row.name} MCP server was turned off for this chat.`);
    this.lastUsed.set(row.id, Date.now());
    return connection.call(handle.remoteName, args, signal);
  }

  /** The servers among these that want the person to sign in first, by name. */
  needingSignIn(rows: ResourceRow[]): string[] {
    return rows.filter(row => this.signInNeeded.has(row.id)).map(row => row.name);
  }

  /** Connect on demand so Settings can show what a server actually offers. */
  async probe(id: string): Promise<McpServerStatus> {
    const row = this.store.getResourceRow(id);
    if (row.kind !== 'mcp') throw new Error('That extension is not an MCP server.');
    try {
      const connection = await this.connect(row);
      await connection.refreshTools();
      return { id, name: row.name, connected: true, tools: connection.tools.map(tool => tool.name) };
    } catch (error) {
      return {
        id, name: row.name, connected: false, tools: [], error: error instanceof Error ? error.message : 'The MCP server could not start.',
        ...(error instanceof McpSignInRequiredError ? { needsSignIn: true } : {}),
      };
    }
  }

  status(): McpServerStatus[] {
    return this.store.listResourceRows().filter(row => row.kind === 'mcp').map(row => {
      const connection = this.connections.get(row.id);
      return {
        id: row.id, name: row.name, connected: Boolean(connection?.running),
        tools: connection?.tools.map(tool => tool.name) ?? [],
        error: this.errors.get(row.id) ?? null,
        ...(this.signInNeeded.has(row.id) ? { needsSignIn: true } : {}),
      };
    });
  }

  /** Deactivating or removing a server ends its process, not just its listing. */
  async disconnect(id: string): Promise<void> {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    const connection = this.connections.get(id);
    const pending = this.starting.get(id);
    this.connections.delete(id);
    this.starting.delete(id);
    this.errors.delete(id);
    this.lastUsed.delete(id);
    await Promise.all([connection?.stop(), pending?.connection.stop()]);
    await pending?.promise.catch(() => {});
  }

  /** Stop servers no conversation activates any more. */
  async reconcile(): Promise<void> {
    const wanted = new Set<string>();
    for (const row of this.store.listResourceRows()) {
      if (row.kind !== 'mcp') continue;
      if (this.store.conversationsUsing(row.id).length) wanted.add(row.id);
    }
    await Promise.all([...new Set([...this.connections.keys(), ...this.starting.keys()])].filter(id => !wanted.has(id)).map(id => this.disconnect(id)));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = undefined; }
    await Promise.all([...new Set([...this.connections.keys(), ...this.starting.keys()])].map(id => this.disconnect(id)));
  }
}
