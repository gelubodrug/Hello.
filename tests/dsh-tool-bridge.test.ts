import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDataStore, type DataStore } from '../src/main/data/store';
import { ResourceLibrary } from '../src/main/extensions/library';
import { McpManager } from '../src/main/extensions/mcp';
import { bridgeable, contentText, startToolBridge, type ToolBridgeServer, type ToolRegistryLike } from '../src/main/dsh/tool-bridge';
import { DSH_MCP_NAME, DshToolLink, dshToolsRow, isDshToolsRow, setDshToolsRow, type DshToolSource } from '../src/main/dsh/tool-link';
import type { DshStatus } from '../src/shared/types';

const TOKEN = 'bridge-token-for-this-test-only-000000000';

/** dsh's registry as the bridge sees it: one plugin tool, the reserved transport, and a slow one. */
function registry(calls: Array<{ name: string; arguments: Record<string, unknown> }> = []): ToolRegistryLike {
  return {
    schemas: () => [
      { name: 'word_count', description: 'Count words.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      { name: 'run_code', description: 'Reserved.', parameters: { type: 'object', properties: {} } },
      { name: 'slow', description: 'Waits.', parameters: undefined },
    ],
    async execute(input) {
      calls.push({ name: input.name, arguments: input.arguments });
      if (input.name === 'slow') {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          input.signal.addEventListener('abort', () => { clearTimeout(timer); reject(input.signal.reason); }, { once: true });
        });
        return { isError: false, content: [{ type: 'text', text: 'late' }] };
      }
      if (typeof input.arguments.text !== 'string') return { isError: true, content: [{ type: 'text', text: 'Error: invalid arguments: missing required property "text"' }] };
      return { isError: false, content: [{ type: 'text', text: `${input.arguments.text.split(/\s+/).length} words` }] };
    },
  };
}

const servers: ToolBridgeServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
async function bridge(tools: ToolRegistryLike | null = registry()) {
  const server = await startToolBridge(() => tools ?? undefined, TOKEN);
  servers.push(server);
  return server;
}
const auth = { authorization: `Bearer ${TOKEN}` };

describe('the tool bridge in the host', () => {
  it('answers only its token', async () => {
    const { port } = await bridge();
    for (const authorization of [undefined, 'Bearer wrong', `Bearer ${TOKEN}x`, TOKEN])
      expect((await fetch(`http://127.0.0.1:${port}/tools`, { headers: authorization ? { authorization } : {} })).status).toBe(401);
  });

  it('lists plugin tools only, with an object schema each', async () => {
    const { port } = await bridge();
    const listed = await (await fetch(`http://127.0.0.1:${port}/tools`, { headers: auth })).json() as { tools: Array<{ name: string; parameters: unknown }> };
    expect(listed.tools.map(tool => tool.name)).toEqual(['word_count', 'slow']);
    expect(listed.tools[1].parameters).toEqual({ type: 'object', properties: {} });
    expect(bridgeable('run_code')).toBe(false);
  });

  it('runs a plugin tool and refuses dsh’s own', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const { port } = await bridge(registry(calls));
    const call = (body: unknown) => fetch(`http://127.0.0.1:${port}/call`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(await (await call({ name: 'word_count', arguments: { text: 'a b c' } })).json()).toEqual({ isError: false, text: '3 words' });
    expect(await (await call({ name: 'word_count', arguments: {} })).json()).toMatchObject({ isError: true, text: expect.stringContaining('missing required property') });
    expect((await call({ name: 'run_code', arguments: { code: '1' } })).status).toBe(403);
    expect((await call({ name: 'word_count' })).status).toBe(400);
    expect(calls.map(entry => entry.name)).toEqual(['word_count', 'word_count']);
  });

  it('says so when dsh has no registry, and knows only its two routes', async () => {
    const empty = await bridge(null);
    expect((await fetch(`http://127.0.0.1:${empty.port}/tools`, { headers: auth })).status).toBe(503);
    const { port } = await bridge();
    expect((await fetch(`http://127.0.0.1:${port}/admin`, { headers: auth })).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/tools`, { method: 'DELETE', headers: auth })).status).toBe(404);
  });

  it('flattens dsh content blocks into text Hello can return', () => {
    expect(contentText([{ type: 'text', text: 'one' }, { type: 'image', data: 'x' }, { type: 'resource' }])).toBe(
      'one\n[image returned by the dsh tool; Hello does not forward it to the model]\n[resource content]');
    expect(contentText(undefined)).toBe('');
    expect(contentText([{ type: 'text', text: 'x'.repeat(70_000) }])).toMatch(/\[truncated by Hello at 60000 characters\]$/);
  });
});

/** The DSH service as the link sees it, with a real bridge behind it. */
function source(port: number, state: DshStatus['state'] = 'running', extra: Partial<DshStatus> = {}) {
  const status: DshStatus = { state, version: '0.1.7-rc.2', profileDir: '/p', logFile: '/l', checkpoints: [], ...extra };
  let generation = state === 'running' ? 1 : 0;
  let starts = 0;
  const value: DshToolSource & { restart(): void; starts(): number } = {
    status: () => status,
    async start() { starts += 1; status.state = 'running'; generation += 1; return status; },
    bridge: () => (status.state === 'running' ? { port, token: TOKEN, generation } : undefined),
    restart() { generation += 1; },
    starts: () => starts,
  };
  return value;
}

describe('the chat’s link to the bridge', () => {
  it('lists and calls a running host’s plugin tools', async () => {
    const { port } = await bridge();
    const link = new DshToolLink(source(port));
    await link.start();
    expect(link.running).toBe(true);
    expect(link.tools.map(tool => tool.name)).toEqual(['word_count', 'slow']);
    expect(await link.call('word_count', { text: 'salut de la Hello' }, new AbortController().signal)).toBe('4 words');
    await expect(link.call('word_count', {}, new AbortController().signal)).rejects.toThrow(/reported an error:\nError: invalid arguments/);
  });

  it('starts a stopped surface, and will not install or override a changed profile', async () => {
    const { port } = await bridge();
    const stopped = source(port, 'stopped');
    await new DshToolLink(stopped).start();
    expect(stopped.starts()).toBe(1);
    await expect(new DshToolLink(source(port, 'absent')).start()).rejects.toThrow(/not installed/);
    const changed = source(port, 'stopped', { profileChange: { added: ['x'], removed: [], changed: [] } });
    await expect(new DshToolLink(changed).start()).rejects.toThrow(/changed outside Hello/);
    expect(changed.starts()).toBe(0);
  });

  it('is no longer live after the host restarts, and refuses a call made across it', async () => {
    const { port } = await bridge();
    const host = source(port);
    const link = new DshToolLink(host);
    await link.start();
    host.restart();
    expect(link.running).toBe(false);
    await expect(link.call('word_count', { text: 'a' }, new AbortController().signal)).rejects.toThrow(/restarted/);
  });

  it('carries Hello’s Stop to the tool', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const { port } = await bridge(registry(calls));
    const link = new DshToolLink(source(port));
    await link.start();
    const controller = new AbortController();
    const pending = link.call('slow', {}, controller.signal);
    setTimeout(() => controller.abort(new Error('Stopped.')), 50);
    await expect(pending).rejects.toThrow('Stopped.');
  });
});

describe('dsh-plugins in Hello’s library', () => {
  let directory: string;
  let store: DataStore;
  let manager: McpManager;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hello-dsh-tools-'));
    store = createDataStore(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  });
  afterEach(async () => {
    await manager?.dispose();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('is one switchable row, marked as built in', async () => {
    expect(dshToolsRow(store)).toBeUndefined();
    const row = setDshToolsRow(store, true)!;
    expect(setDshToolsRow(store, true)!.id).toBe(row.id);
    expect(row).toMatchObject({ kind: 'mcp', name: DSH_MCP_NAME, source: 'hello:dsh' });
    expect(isDshToolsRow(row)).toBe(true);
    const described = await new ResourceLibrary(store).describe(row);
    expect(described.detail).toBe('Built into Hello. · DSH surface');
    setDshToolsRow(store, false);
    expect(dshToolsRow(store)).toBeUndefined();
  });

  it('reaches chats through the MCP manager, in the chats that turned it on', async () => {
    const { port } = await bridge();
    manager = new McpManager(store, { links: row => (isDshToolsRow(row) ? new DshToolLink(source(port)) : undefined) });
    const row = setDshToolsRow(store, true)!;
    const conversation = store.createConversation().id;
    expect(await manager.toolsFor([row], conversation)).toEqual([]);
    store.setResourceActive(conversation, row.id, true);
    const handles = await manager.toolsFor([row], conversation);
    expect(handles.map(handle => handle.name)).toEqual(['mcp_dsh_plugins_word_count', 'mcp_dsh_plugins_slow']);
    expect(await manager.call(handles[0], { text: 'unu doi' }, new AbortController().signal, conversation)).toBe('2 words');
    expect(manager.status()).toEqual([expect.objectContaining({ name: DSH_MCP_NAME, connected: true, tools: ['word_count', 'slow'] })]);
  });
});
