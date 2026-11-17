import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDataStore, type DataStore } from '../src/main/data/store';
import { ResourceLibrary, mcpServerUrl } from '../src/main/extensions/library';
import { McpManager } from '../src/main/extensions/mcp';

// MCP servers reached over streamable HTTP (user, 03.11: Neon and armada were
// "Not supported"). A server written for this test on 127.0.0.1: no network
// beyond this Mac, no real sign-in, no model.

interface Fixture {
  /** What a request must carry in Authorization; unset, anything goes. */
  bearer?: string;
  /** Forget the session once, the way a restarted server does. */
  forgetOnce?: boolean;
  seen: Array<{ method: string; authorization?: string; apiKey?: string }>;
}

let directory: string;
let store: DataStore;
let library: ResourceLibrary;
let manager: McpManager;
let server: Server;
let base: string;
let fixture: Fixture;
let sessions = 0;
let oauth: { registeredAs?: string; tokenRequest?: Record<string, string> };

const body = async (request: IncomingMessage) => {
  let text = '';
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : undefined;
};
const reply = (response: ServerResponse, status: number, value?: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, { ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers });
  response.end(value === undefined ? undefined : JSON.stringify(value));
};

/** A fake authorization server beside the MCP endpoint, as a server following the MCP auth spec has. */
async function authServer(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = new URL(request.url ?? '/', base);
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
    return reply(response, 200, { resource: `${base}/mcp`, authorization_servers: [base] }), true;
  if (url.pathname === '/.well-known/oauth-authorization-server')
    return reply(response, 200, {
      issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    }), true;
  if (url.pathname === '/register') {
    const registration = await body(request);
    oauth.registeredAs = registration.client_name;
    return reply(response, 201, { ...registration, client_id: 'hello-client' }), true;
  }
  if (url.pathname === '/token') {
    let form = '';
    for await (const chunk of request) form += chunk;
    oauth.tokenRequest = Object.fromEntries(new URLSearchParams(form));
    return reply(response, 200, { access_token: 'signed-in-token', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-token' }), true;
  }
  return false;
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (await authServer(request, response)) return;
  // No server-to-client stream here: a server may say so with 405.
  if (request.method === 'GET') return reply(response, 405);
  if (request.method === 'DELETE') return reply(response, 200);
  const authorization = request.headers.authorization;
  if (fixture.bearer && authorization !== `Bearer ${fixture.bearer}`)
    return reply(response, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
  const message = await body(request);
  fixture.seen.push({ method: message.method, authorization, apiKey: request.headers['x-api-key'] as string | undefined });
  if (message.method === 'initialize') {
    sessions += 1;
    return reply(response, 200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } } }, { 'Mcp-Session-Id': `session-${sessions}` });
  }
  if (request.headers['mcp-session-id'] !== `session-${sessions}`) return reply(response, 404, { error: 'unknown session' });
  if (message.id === undefined) return reply(response, 202);
  if (message.method === 'tools/list')
    return reply(response, 200, { jsonrpc: '2.0', id: message.id, result: { tools: [
      { name: 'echo', description: 'Echo the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    ] } });
  if (message.method === 'tools/call') {
    if (fixture.forgetOnce) { fixture.forgetOnce = false; sessions += 1; return reply(response, 404, { error: 'unknown session' }); }
    return reply(response, 200, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `echo: ${message.params.arguments.text}` }] } });
  }
  return reply(response, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unsupported ${message.method}` } });
}

beforeEach(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'hello-mcp-http-'));
  store = createDataStore(directory, {
    encrypt: text => Buffer.from(text.split('').reverse().join('')),
    decrypt: bytes => bytes.toString().split('').reverse().join(''),
  });
  library = new ResourceLibrary(store);
  manager = new McpManager(store, { connectTimeoutMs: 5000, callTimeoutMs: 5000 });
  fixture = { seen: [] };
  sessions = 0;
  oauth = {};
  server = createServer((request, response) => { void handle(request, response).catch(() => reply(response, 500)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await manager.dispose();
  store.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

describe('an MCP server reached over HTTP', () => {
  it('connects, lists its tools and calls one, with its headers', async () => {
    const saved = library.addMcp({ name: 'Remote', command: '', args: [], url: `${base}/mcp`, env: { 'X-Api-Key': 'header-test-value' } });
    expect(saved.detail).toBe(`http · 127.0.0.1:${new URL(base).port}/mcp`);
    expect(saved.entries).toEqual(['header: X-Api-Key']);
    // The header's value is in the encrypted store, never the row.
    expect(store.getResourceRow(saved.id).config).not.toContain('header-test-value');
    const status = await manager.probe(saved.id);
    expect(status).toMatchObject({ connected: true, tools: ['echo'] });
    const [handle] = await manager.toolsFor([store.getResourceRow(saved.id)]);
    expect(handle).toMatchObject({ name: 'mcp_remote_echo', remoteName: 'echo' });
    expect(await manager.call(handle, { text: 'hi' }, new AbortController().signal)).toBe('echo: hi');
    expect(fixture.seen.every(request => request.apiKey === 'header-test-value')).toBe(true);
  });

  it('says a server wants a sign-in instead of failing, and connects with the token a sign-in stored', async () => {
    fixture.bearer = 'stored-access-token';
    const saved = library.addMcp({ name: 'Neon-like', command: '', args: [], url: `${base}/mcp`, env: {} });
    const refused = await manager.probe(saved.id);
    expect(refused).toMatchObject({ connected: false, needsSignIn: true });
    expect(refused.error).toMatch(/needs you to sign in/);
    expect(manager.status().find(item => item.id === saved.id)).toMatchObject({ needsSignIn: true });
    // What a finished sign-in leaves behind, encrypted beside the server.
    store.saveResourceAuth(saved.id, { serverUrl: mcpServerUrl(`${base}/mcp`), tokens: { access_token: 'stored-access-token', token_type: 'Bearer' } });
    // Nowhere on disk in the clear: the database and its write-ahead log alike.
    for (const file of readdirSync(directory).filter(name => name.startsWith('hello.sqlite')))
      expect(readFileSync(path.join(directory, file)).includes(Buffer.from('stored-access-token'))).toBe(false);
    expect(readdirSync(directory).some(name => name.startsWith('hello.sqlite'))).toBe(true);
    expect(store.allResourceSecrets()).toContain('stored-access-token');
    const connected = await manager.probe(saved.id);
    expect(connected).toMatchObject({ connected: true, tools: ['echo'] });
    expect(connected.needsSignIn).toBeUndefined();
    expect(fixture.seen.at(-1)?.authorization).toBe('Bearer stored-access-token');
    // Removing the server removes its sign-in with it.
    await library.remove(saved.id);
    expect(store.resourceAuth(saved.id)).toBeUndefined();
  });

  it('signs in the way the MCP spec says — discovered, registered, approved in the browser — and then connects', async () => {
    fixture.bearer = 'signed-in-token';
    const saved = library.addMcp({ name: 'Signed', command: '', args: [], url: `${base}/mcp`, env: {} });
    expect(await manager.probe(saved.id)).toMatchObject({ needsSignIn: true });
    const opened: string[] = [];
    // The person's browser: it gets the page, they approve, the server sends it back to Hello's callback.
    const browser = async (page: string) => {
      opened.push(page);
      const asked = new URL(page);
      const back = new URL(asked.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'approved-code');
      back.searchParams.set('state', asked.searchParams.get('state')!);
      setTimeout(() => { void fetch(back).catch(() => {}); }, 10);
    };
    const status = await manager.signIn(saved.id, browser);
    expect(status).toMatchObject({ connected: true, tools: ['echo'] });
    expect(opened).toHaveLength(1);
    expect(opened[0].startsWith(`${base}/authorize?`)).toBe(true);
    expect(new URL(opened[0]).searchParams.get('code_challenge_method')).toBe('S256');
    expect(new URL(new URL(opened[0]).searchParams.get('redirect_uri')!).hostname).toBe('127.0.0.1');
    expect(oauth.registeredAs).toBe('Hello.');
    expect(oauth.tokenRequest).toMatchObject({ grant_type: 'authorization_code', code: 'approved-code' });
    expect(oauth.tokenRequest?.code_verifier).toBeTruthy();
    // The grant is kept, encrypted, for the next connection.
    expect(store.resourceAuth(saved.id)).toMatchObject({ tokens: { access_token: 'signed-in-token', refresh_token: 'refresh-token' } });
    expect(manager.status().find(item => item.id === saved.id)?.needsSignIn).toBeUndefined();
  });

  it('refreshes an expired grant by itself, without a browser, and keeps the new token', async () => {
    fixture.bearer = 'signed-in-token';
    const saved = library.addMcp({ name: 'Expired', command: '', args: [], url: `${base}/mcp`, env: {} });
    // An hour after the sign-in: the access token is refused, the refresh token still good.
    store.saveResourceAuth(saved.id, {
      serverUrl: mcpServerUrl(`${base}/mcp`), clientInformation: { client_id: 'hello-client' },
      tokens: { access_token: 'expired-token', token_type: 'Bearer', refresh_token: 'refresh-token' },
    });
    const status = await manager.probe(saved.id);
    expect(status).toMatchObject({ connected: true, tools: ['echo'] });
    expect(oauth.tokenRequest).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-token' });
    expect(store.resourceAuth(saved.id)).toMatchObject({ tokens: { access_token: 'signed-in-token' } });
  });

  it('opens a session again once when the server forgot it, and the call goes through', async () => {
    const saved = library.addMcp({ name: 'Restarting', command: '', args: [], url: `${base}/mcp`, env: {} });
    const [handle] = await manager.toolsFor([store.getResourceRow(saved.id)]);
    fixture.forgetOnce = true;
    expect(await manager.call(handle, { text: 'again' }, new AbortController().signal)).toBe('echo: again');
    expect(sessions).toBe(3);
  });

  it('reaches only https, or http on this Mac, and keeps credentials out of the address', () => {
    expect(mcpServerUrl('https://mcp.neon.tech/mcp')).toBe('https://mcp.neon.tech/mcp');
    expect(mcpServerUrl('http://localhost:7891/rpc')).toBe('http://localhost:7891/rpc');
    expect(() => mcpServerUrl('http://example.test/mcp')).toThrow(/https, or http on this Mac/);
    expect(() => mcpServerUrl('https://user:secret@example.test/mcp')).toThrow(/header/);
    expect(() => library.addMcp({ name: 'Bad', command: '', args: [], url: 'ftp://example.test', env: {} })).toThrow(/https/);
  });
});
