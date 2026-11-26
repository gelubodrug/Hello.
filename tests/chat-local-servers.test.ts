import { describe, expect, it, vi } from 'vitest';
import { ModelListingAuthError, PORT_LIMIT, detectLocalServers, parseListening, serverLabel } from '../src/main/chat/local-servers';

// Exactly the shape `lsof -nP -iTCP -sTCP:LISTEN +c 0 -F pcn` printed on the
// Mac this was written on: llama-server on 8081, Ollama on 11434, and the
// listeners that are not model servers.
const LSOF = [
  'p662', 'crapportd', 'f14', 'n*:64461',
  'p718', 'cControlCenter', 'f11', 'n*:5000',
  'p1941', 'cpostgres', 'f7', 'n[::1]:5432', 'f8', 'n127.0.0.1:5432',
  'p3658', 'collama', 'f5', 'n127.0.0.1:11434',
  'p89254', 'cllama-server', 'f3', 'n127.0.0.1:8081',
  'p4453', 'cnode', 'f15', 'n127.0.0.1:51670',
  'p4454', 'cnode', 'f16', 'n192.168.1.20:7777',
  'p999', 'cElectron', 'f20', 'n127.0.0.1:61000',
  '',
].join('\n');

describe('finding model servers on this Mac', () => {
  it('reads who listens on loopback, leaving out this app, databases and macOS', () => {
    expect(parseListening(LSOF, 999)).toEqual([
      { pid: 3658, command: 'ollama', port: 11434 },
      { pid: 89254, command: 'llama-server', port: 8081 },
      { pid: 4453, command: 'node', port: 51670 },
    ]);
  });

  it('names a server after what it is', () => {
    expect(serverLabel('llama-server')).toEqual({ label: 'llama.cpp', known: true });
    expect(serverLabel('ollama')).toEqual({ label: 'Ollama', known: true });
    expect(serverLabel('LM Studio')).toEqual({ label: 'LM Studio', known: true });
    expect(serverLabel('node')).toEqual({ label: 'node', known: false });
  });

  it('keeps what answers with a model list, known servers first, and skips what does not', async () => {
    const list = vi.fn(async (endpointUrl: string) => {
      if (endpointUrl.includes(':8081/')) return [{ id: '/Users/q/Models/Nex-N2.5-mini-Q8_0.gguf', contextWindow: 262144 }];
      if (endpointUrl.includes(':11434/')) return [{ id: 'gemma4:12b' }];
      if (endpointUrl.includes(':3000/')) return [{ id: 'proxy-model' }];
      if (endpointUrl.includes(':4000/')) return [];
      throw new Error('Model listing returned HTTP 404');
    });
    const servers = await detectLocalServers({
      ports: async () => [
        { pid: 1, command: 'node', port: 3000 },
        { pid: 2, command: 'ollama', port: 11434 },
        { pid: 3, command: 'node', port: 51670 },
        { pid: 4, command: 'llama-server', port: 8081 },
        { pid: 5, command: 'python3.12', port: 4000 },
      ],
      list,
    });
    expect(servers.map(server => server.name)).toEqual(['llama.cpp · 8081', 'Ollama · 11434', 'node · 3000']);
    expect(servers[0]).toEqual({ name: 'llama.cpp · 8081', endpointUrl: 'http://localhost:8081/v1',
      models: [{ id: '/Users/q/Models/Nex-N2.5-mini-Q8_0.gguf', contextWindow: 262144 }] });
  });

  it('asks no more than its limit of ports', async () => {
    const list = vi.fn(async () => { throw new Error('no'); });
    const ports = Array.from({ length: PORT_LIMIT + 10 }, (_, index) => ({ pid: index, command: 'node', port: 20_000 + index }));
    await detectLocalServers({ ports: async () => ports, list });
    expect(list).toHaveBeenCalledTimes(PORT_LIMIT);
  });
});

describe('which ports are asked', () => {
  it('asks model servers by name first, then the usual ports, then chosen ones, and never a system-picked port of an unknown process', async () => {
    const { candidates } = await import('../src/main/chat/local-servers');
    const ranked = candidates([
      { pid: 1, command: 'node', port: 51670 },
      { pid: 2, command: 'node', port: 3000 },
      { pid: 3, command: 'python3.12', port: 8080 },
      { pid: 4, command: 'llama-server', port: 58123 },
      { pid: 5, command: 'ollama', port: 11434 },
      { pid: 6, command: 'Electron', port: 1234 },
    ]);
    expect(ranked.map(entry => `${entry.command}:${entry.port}`)).toEqual([
      'ollama:11434', 'llama-server:58123', 'Electron:1234', 'python3.12:8080', 'node:3000',
    ]);
  });

  it('never leaves a named model server unasked, however many helpers listen before it', async () => {
    const { candidates } = await import('../src/main/chat/local-servers');
    const helpers = Array.from({ length: 270 }, (_, index) => ({ pid: index, command: 'node', port: 10_000 + index }));
    const ranked = candidates([...helpers, { pid: 9999, command: 'llama-server', port: 8081 }]);
    expect(ranked).toHaveLength(PORT_LIMIT);
    expect(ranked[0]).toEqual({ pid: 9999, command: 'llama-server', port: 8081 });
  });

  // oMLX started with an API key answered 401 on :8000 and Settings said
  // nothing listened there (user, 26.11): a key-refusing model server is shown,
  // named for what it is, and asks for its key.
  it('keeps a server that refuses its model list for want of a key', async () => {
    expect(serverLabel('omlx-server')).toEqual({ label: 'oMLX', known: true });
    const servers = await detectLocalServers({
      ports: async () => [
        { pid: 1, command: 'omlx-server', port: 8000 },
        { pid: 2, command: 'node', port: 3000 },
      ],
      list: async (endpointUrl: string) => {
        if (endpointUrl.includes(':8000/')) throw new ModelListingAuthError('Model listing returned HTTP 401', 401);
        throw new Error('Model listing returned HTTP 401: login');
      },
    });
    expect(servers).toEqual([{ name: 'oMLX · 8000', endpointUrl: 'http://localhost:8000/v1', models: [], needsKey: true }]);
  });
});
