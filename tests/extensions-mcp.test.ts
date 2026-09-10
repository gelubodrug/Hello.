import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDataStore, type DataStore } from '../src/main/data/store';
import { ResourceLibrary } from '../src/main/extensions/library';
import { McpManager } from '../src/main/extensions/mcp';

// A real MCP handshake against a local stdio server written for this test.
// No network, no installed package, no model: the point is that Hello's own
// client speaks the protocol and that stopping a server stops its process.
const SERVER = `
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index = buffer.indexOf('\\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\\n');
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize')
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } } });
    else if (message.method === 'tools/list')
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [
        { name: 'echo', description: 'Echo the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        { name: 'read-token', description: 'Return the configured token.', inputSchema: { type: 'object', properties: {} } },
      ] } });
    else if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params;
      if (name === 'echo') send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo: ' + args.text }] } });
      else if (name === 'read-token') send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: process.env.FIXTURE_TOKEN || 'missing' }] } });
      else send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown tool ' + name } });
    } else if (message.id !== undefined)
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported ' + message.method } });
  }
});
process.on('SIGTERM', () => process.exit(0));
`;

let directory: string;
let store: DataStore;
let library: ResourceLibrary;
let manager: McpManager;
let serverFile: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hello-mcp-'));
  serverFile = path.join(directory, 'fixture-server.mjs');
  writeFileSync(serverFile, SERVER);
  store = createDataStore(directory, {
    encrypt: text => Buffer.from(text.split('').reverse().join('')),
    decrypt: bytes => bytes.toString().split('').reverse().join(''),
  });
  library = new ResourceLibrary(store);
  manager = new McpManager(store);
});
afterEach(async () => {
  await manager.dispose();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('MCP client', () => {
  it('connects, lists tools, calls one and passes only the configured environment', async () => {
    const saved = library.addMcp({
      name: 'fixture', command: process.execPath, args: [serverFile],
      env: { FIXTURE_TOKEN: 'from-secret-store', ELECTRON_RUN_AS_NODE: '1' },
    });
    const probed = await manager.probe(saved.id);
    expect(probed.connected).toBe(true);
    expect(probed.tools).toEqual(['echo', 'read-token']);

    const handles = await manager.toolsFor([store.getResourceRow(saved.id)]);
    expect(handles.map(handle => handle.name)).toEqual(['mcp_fixture_echo', 'mcp_fixture_read_token']);
    const controller = new AbortController();
    expect(await manager.call(handles[0], { text: 'hi' }, controller.signal)).toBe('echo: hi');
    // The value came from Hello's encrypted store, not the app's own env.
    expect(await manager.call(handles[1], {}, controller.signal)).toBe('from-secret-store');

    expect(manager.status()[0].connected).toBe(true);
    await manager.disconnect(saved.id);
    expect(manager.status()[0].connected).toBe(false);
  }, 20_000);

  it('reports a failing command instead of pretending it connected', async () => {
    const saved = library.addMcp({
      name: 'broken', command: process.execPath, args: ['--eval', 'process.exit(3)'], env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    const probed = await manager.probe(saved.id);
    expect(probed.connected).toBe(false);
    expect(probed.error).toMatch(/exit|stopped/i);
    expect(await manager.toolsFor([store.getResourceRow(saved.id)])).toEqual([]);
  }, 20_000);

  it('stops servers no conversation activates any more', async () => {
    const saved = library.addMcp({
      name: 'fixture', command: process.execPath, args: [serverFile], env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    const conversationId = store.createConversation().id;
    store.setResourceActive(conversationId, saved.id, true);
    await manager.probe(saved.id);
    expect(manager.status()[0].connected).toBe(true);
    await manager.reconcile();
    expect(manager.status()[0].connected).toBe(true);
    store.setResourceActive(conversationId, saved.id, false);
    await manager.reconcile();
    expect(manager.status()[0].connected).toBe(false);
  }, 20_000);

  it('keeps a configured secret out of an error built from the server output', async () => {
    const noisy = path.join(directory, 'noisy-server.mjs');
    writeFileSync(noisy, `
      process.stderr.write('startup failed using token ' + process.env.FIXTURE_TOKEN + '\\n');
      process.exit(2);
    `);
    const saved = library.addMcp({
      name: 'noisy', command: process.execPath, args: [noisy],
      env: { FIXTURE_TOKEN: 'super-secret-value', ELECTRON_RUN_AS_NODE: '1' },
    });
    const probed = await manager.probe(saved.id);
    expect(probed.connected).toBe(false);
    expect(probed.error).not.toContain('super-secret-value');
    expect(probed.error).toContain('[redacted]');
  }, 20_000);

  it('refuses a call for a server the conversation just turned off, instead of restarting it', async () => {
    const saved = library.addMcp({
      name: 'fixture', command: process.execPath, args: [serverFile], env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    const conversationId = store.createConversation().id;
    store.setResourceActive(conversationId, saved.id, true);
    const handles = await manager.toolsFor([store.getResourceRow(saved.id)], conversationId);
    const controller = new AbortController();
    expect(await manager.call(handles[0], { text: 'before' }, controller.signal, conversationId)).toBe('echo: before');
    // The human unchecks it while the turn is still running.
    store.setResourceActive(conversationId, saved.id, false);
    await manager.reconcile();
    await expect(manager.call(handles[0], { text: 'after' }, controller.signal, conversationId))
      .rejects.toThrow(/turned off for this chat/i);
    expect(manager.status()[0].connected).toBe(false);
  }, 20_000);

  it('keeps two servers offering the same tool name apart', async () => {
    const first = library.addMcp({ name: 'alpha', command: process.execPath, args: [serverFile], env: { ELECTRON_RUN_AS_NODE: '1' } });
    const second = library.addMcp({ name: 'beta', command: process.execPath, args: [serverFile], env: { ELECTRON_RUN_AS_NODE: '1' } });
    const handles = await manager.toolsFor([store.getResourceRow(first.id), store.getResourceRow(second.id)]);
    const names = handles.map(handle => handle.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('mcp_alpha_echo');
    expect(names).toContain('mcp_beta_echo');
    const controller = new AbortController();
    // Each name still routes to its own server.
    for (const handle of handles.filter(item => item.remoteName === 'echo'))
      expect(await manager.call(handle, { text: handle.serverName }, controller.signal)).toBe(`echo: ${handle.serverName}`);
  }, 25_000);

  it('cancels a call when the run is stopped', async () => {
    const slow = path.join(directory, 'slow-server.mjs');
    writeFileSync(slow, `
      let buffer = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => {
        buffer += chunk;
        let index = buffer.indexOf('\\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\\n');
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.method === 'initialize')
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } }) + '\\n');
          else if (message.method === 'tools/list')
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'wait', description: 'never answers', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');
        }
      });
    `);
    const saved = library.addMcp({ name: 'slow', command: process.execPath, args: [slow], env: { ELECTRON_RUN_AS_NODE: '1' } });
    const handles = await manager.toolsFor([store.getResourceRow(saved.id)]);
    const controller = new AbortController();
    const call = manager.call(handles[0], {}, controller.signal);
    controller.abort(new Error('Stopped by you.'));
    await expect(call).rejects.toThrow(/Stopped by you/);
  }, 20_000);
});

function fixture(options: { initialize?: string; list?: string; call?: string; setup?: string; other?: string } = {}) {
  const file = path.join(directory, 'edge-fixture.mjs');
  writeFileSync(file, `
    import { writeFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    ${options.setup ?? ''}
    const send = data => process.stdout.write(JSON.stringify(data) + '\\n');
    const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
    createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') { ${options.initialize ?? "reply(m.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} } });"} }
      else if (m.method === 'tools/list') { ${options.list ?? "reply(m.id, { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] });"} }
      else if (m.method === 'tools/call') { ${options.call ?? "reply(m.id, { content: [{ type: 'text', text: 'ok' }] });"} }
      else { ${options.other ?? ''} }
    });
  `);
  return library.addMcp({ name: 'edge-fixture', command: process.execPath, args: [file], env: { ELECTRON_RUN_AS_NODE: '1' } });
}

describe('MCP protocol and lifecycle regressions', () => {
  it('fails a missing executable promptly without waiting forever for exit', async () => {
    const saved = library.addMcp({ name: 'absent', command: path.join(directory, 'does-not-exist'), args: [], env: {} });
    const result = await manager.probe(saved.id);
    expect(result.connected).toBe(false);
    expect(result.error).toContain('ENOENT');
  }, 2000);

  it('disconnects a process that is still initializing when its chat deactivates it', async () => {
    const pidFile = path.join(directory, 'pid');
    const saved = fixture({ setup: `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`, initialize: '' });
    const chat = store.createConversation().id;
    store.setResourceActive(chat, saved.id, true);
    const probe = manager.probe(saved.id);
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    store.setResourceActive(chat, saved.id, false);
    await manager.reconcile();
    expect((await probe).connected).toBe(false);
    expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow();
  }, 3000);

  it('disposes a process still initializing before the store can close', async () => {
    const pidFile = path.join(directory, 'pid');
    const saved = fixture({ setup: `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`, initialize: '' });
    const probe = manager.probe(saved.id);
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    await manager.dispose();
    expect((await probe).connected).toBe(false);
    expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow();
  }, 3000);

  it('loads all tool pages and preserves long-name collisions within provider limits', async () => {
    const saved = fixture({ list: `reply(m.id, m.params.cursor ? { tools: [{ name: '${'x'.repeat(140)}b' }] } : { tools: [{ name: '${'x'.repeat(140)}a' }], nextCursor: 'second' });` });
    const handles = await manager.toolsFor([store.getResourceRow(saved.id)]);
    expect(handles).toHaveLength(2);
    expect(new Set(handles.map(h => h.name)).size).toBe(2);
    expect(handles.every(h => h.name.length <= 64)).toBe(true);
  });

  it('rejects unsupported versions and cyclic pagination', async () => {
    const saved = fixture({ initialize: "reply(m.id, { protocolVersion: '2099-01-01', capabilities: { tools: {} } });" });
    expect((await manager.probe(saved.id)).error).toMatch(/Unsupported MCP protocol/);
    await library.remove(saved.id);
    const second = fixture({ list: "reply(m.id, { tools: [], nextCursor: 'again' });" });
    expect((await manager.probe(second.id)).error).toMatch(/pagination/);
  });

  it('does not call tools/list when the server has no tools capability', async () => {
    const saved = fixture({ initialize: "reply(m.id, { protocolVersion: '2025-06-18', capabilities: {} });", list: "throw new Error('unexpected tools/list');" });
    expect(await manager.probe(saved.id)).toMatchObject({ connected: true, tools: [] });
  });

  it('never executes an already-cancelled call and removes abort listeners after success', async () => {
    const marker = path.join(directory, 'called');
    const saved = fixture({ call: `writeFileSync(${JSON.stringify(marker)}, 'called'); reply(m.id, { content: [{ type: 'text', text: 'ok' }] });` });
    const [handle] = await manager.toolsFor([store.getResourceRow(saved.id)]);
    const stopped = new AbortController(); stopped.abort(new Error('Stopped before call'));
    await expect(manager.call(handle, {}, stopped.signal)).rejects.toThrow('Stopped before call');
    expect(existsSync(marker)).toBe(false);
    const run = new AbortController();
    for (let i = 0; i < 12; i++) expect(await manager.call(handle, {}, run.signal)).toBe('ok');
    expect(getEventListeners(run.signal, 'abort')).toHaveLength(0);
  });

  it('propagates tool execution failures instead of reporting success', async () => {
    const saved = fixture({ call: "reply(m.id, { isError: true, content: [{ type: 'text', text: 'not found' }] });" });
    const [handle] = await manager.toolsFor([store.getResourceRow(saved.id)]);
    await expect(manager.call(handle, {}, new AbortController().signal)).rejects.toThrow('not found');
  });

  it('bounds connection, tool waits and incoming UTF-8 bytes', async () => {
    await manager.dispose();
    manager = new McpManager(store, { connectTimeoutMs: 200, callTimeoutMs: 50, maxMessageBytes: 4096 });
    let saved = fixture({ initialize: '' });
    expect((await manager.probe(saved.id)).error).toMatch(/did not answer initialize/);
    await library.remove(saved.id);
    saved = fixture({ call: '' });
    const [handle] = await manager.toolsFor([store.getResourceRow(saved.id)]);
    await expect(manager.call(handle, {}, new AbortController().signal)).rejects.toThrow(/did not answer tools\/call/);
    await manager.disconnect(saved.id); await library.remove(saved.id);
    saved = fixture({ initialize: "process.stdout.write('界'.repeat(2000));" });
    expect((await manager.probe(saved.id)).error).toMatch(/message larger/);
  });

  it('checks activation separately for two chats, including handles supplied by another chat', async () => {
    const saved = fixture();
    const first = store.createConversation().id, second = store.createConversation().id;
    store.setResourceActive(first, saved.id, true);
    const [handle] = await manager.toolsFor([store.getResourceRow(saved.id)], first);
    expect(await manager.toolsFor([store.getResourceRow(saved.id)], second)).toEqual([]);
    await expect(manager.call(handle, {}, new AbortController().signal, second)).rejects.toThrow(/turned off/);
    store.setResourceActive(second, saved.id, true);
    store.setResourceActive(first, saved.id, false); await manager.reconcile();
    expect(await manager.call(handle, {}, new AbortController().signal, second)).toBe('ok');
    expect(manager.status()[0].connected).toBe(true);
  });

  it('answers a server ping without confusing its ID with the pending initialize request', async () => {
    const saved = fixture({
      setup: 'let initializeId;',
      initialize: "initializeId = m.id; send({ jsonrpc: '2.0', id: m.id, method: 'ping' });",
      other: "if (m.id === initializeId && m.result) reply(initializeId, { protocolVersion: '2025-06-18', capabilities: { tools: {} } });",
    });
    expect(await manager.probe(saved.id)).toMatchObject({ connected: true, tools: ['echo'] });
  });

  it('rejects an oversized schema before offering it to the model', async () => {
    const saved = fixture({ list: "reply(m.id, { tools: [{ name: 'huge', inputSchema: { type: 'object', description: 'x'.repeat(21000) } }] });" });
    expect((await manager.probe(saved.id)).error).toMatch(/schema larger/);
    expect(await manager.toolsFor([store.getResourceRow(saved.id)])).toEqual([]);
  });

  it('refreshes the catalog between turns after tools/list_changed', async () => {
    const saved = fixture({
      setup: 'let changed = false;',
      list: "reply(m.id, { tools: [{ name: changed ? 'updated' : 'original', inputSchema: { type: 'object' } }] });",
      call: "changed = true; send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); reply(m.id, { content: [{ type: 'text', text: 'updated' }] });",
    });
    const [handle] = await manager.toolsFor([store.getResourceRow(saved.id)]);
    expect(handle.remoteName).toBe('original');
    await manager.call(handle, {}, new AbortController().signal);
    expect((await manager.toolsFor([store.getResourceRow(saved.id)])).map(tool => tool.remoteName)).toEqual(['updated']);
  });

  it('sends cancellation for an executing call while another chat keeps using the server', async () => {
    const marker = path.join(directory, 'call-started'), cancelled = path.join(directory, 'cancelled');
    const saved = fixture({
      call: `if (m.params.arguments.wait) writeFileSync(${JSON.stringify(marker)}, String(m.id)); else reply(m.id, { content: [{ type: 'text', text: 'ok' }] });`,
      other: `if (m.method === 'notifications/cancelled') writeFileSync(${JSON.stringify(cancelled)}, String(m.params.requestId));`,
    });
    const first = store.createConversation().id, second = store.createConversation().id;
    store.setResourceActive(first, saved.id, true); store.setResourceActive(second, saved.id, true);
    const [handle] = await manager.toolsFor([store.getResourceRow(saved.id)], first);
    const run = new AbortController();
    const call = manager.call(handle, { wait: true }, run.signal, first);
    const rejected = expect(call).rejects.toThrow('Stopped by you');
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    run.abort(new Error('Stopped by you'));
    await rejected;
    await vi.waitFor(() => expect(existsSync(cancelled)).toBe(true));
    expect(readFileSync(cancelled, 'utf8')).toBe(readFileSync(marker, 'utf8'));
    expect(await manager.call(handle, {}, new AbortController().signal, second)).toBe('ok');
  });

  it('stops waiting during startup without killing the connection needed by another chat', async () => {
    const marker = path.join(directory, 'initializing');
    const saved = fixture({ initialize: `writeFileSync(${JSON.stringify(marker)}, 'started'); setTimeout(() => reply(m.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} } }), 500);` });
    const first = store.createConversation().id, second = store.createConversation().id;
    store.setResourceActive(first, saved.id, true); store.setResourceActive(second, saved.id, true);
    const run = new AbortController();
    const loading = manager.toolsFor([store.getResourceRow(saved.id)], first, run.signal);
    const rejected = expect(loading).rejects.toThrow('Stopped while connecting');
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    run.abort(new Error('Stopped while connecting'));
    await rejected;
    const [handle] = await manager.toolsFor([store.getResourceRow(saved.id)], second);
    expect(await manager.call(handle, {}, new AbortController().signal, second)).toBe('ok');
    expect(getEventListeners(run.signal, 'abort')).toHaveLength(0);
  });
});
