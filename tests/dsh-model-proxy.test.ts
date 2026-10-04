import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ModelProxy, upstreamUrl, withModel, type ModelConnection } from '../src/main/dsh/model-proxy';
import { helloPatch, MODEL_TOKEN_ENV } from '../src/main/dsh/service';

const servers: Server[] = [];
const proxies: ModelProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map(proxy => proxy.stop()));
  await Promise.all(servers.splice(0).map(server => new Promise(done => { server.closeAllConnections(); server.close(done); })));
});

/** A model server that records what reached it and streams two SSE events back. */
async function upstream() {
  const seen: Array<{ url: string; headers: IncomingHttpHeaders; body: string }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      seen.push({ url: request.url ?? '', headers: request.headers, body });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"Bun"}}]}\n\n');
      setTimeout(() => { response.write('data: [DONE]\n\n'); response.end(); }, 10);
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  return { seen, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

function proxyFor(connection: () => ModelConnection | undefined) {
  const proxy = new ModelProxy(connection);
  proxies.push(proxy);
  return proxy;
}

describe('upstreamUrl', () => {
  it('maps the proxy’s /v1 onto the connection’s own base', () => {
    expect(upstreamUrl('https://api.example.com/v1', '/v1/chat/completions')).toBe('https://api.example.com/v1/chat/completions');
    expect(upstreamUrl('http://127.0.0.1:11434/v1/', '/v1/models?x=1')).toBe('http://127.0.0.1:11434/v1/models?x=1');
    expect(upstreamUrl('https://api.example.com/v1', '/admin')).toBeUndefined();
    expect(upstreamUrl('file:///etc', '/v1/x')).toBeUndefined();
  });
});

describe('ModelProxy', () => {
  it('swaps its token for the real key and streams the answer back', async () => {
    const model = await upstream();
    const proxy = proxyFor(() => ({ endpointUrl: model.base, model: 'qwen', apiKey: 'sk-real-key' }));
    const address = await proxy.start();
    expect(address.baseURL).toBe(`http://127.0.0.1:${address.port}/v1`);
    const response = await fetch(`${address.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${address.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen', stream: true }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const text = await response.text();
    expect(text).toContain('"content":"Bun"');
    expect(text).toContain('[DONE]');
    expect(model.seen[0]).toMatchObject({ url: '/v1/chat/completions', body: '{"model":"qwen","stream":true}' });
    expect(model.seen[0].headers.authorization).toBe('Bearer sk-real-key');
  });

  // User, 01.10: dsh still asked for the model Hello had when it started, and
  // the server Hello had moved to answered "model … not found".
  it('sends the model Hello uses now, whatever model dsh was told at its start', async () => {
    const model = await upstream();
    let current: ModelConnection = { endpointUrl: model.base, model: 'dots-studio/dots-3-note-preview:free', apiKey: '' };
    const proxy = proxyFor(() => current);
    const address = await proxy.start();
    const ask = () => fetch(`${address.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${address.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'dots-studio/dots-3-note-preview:free', stream: true }),
    }).then(response => response.text());
    await ask();
    current = { ...current, model: 'Qwen3-Coder-Next-6bit' };
    await ask();
    expect(model.seen.map(seen => JSON.parse(seen.body).model)).toEqual(['dots-studio/dots-3-note-preview:free', 'Qwen3-Coder-Next-6bit']);
    expect(JSON.parse(model.seen[1].body)).toEqual({ model: 'Qwen3-Coder-Next-6bit', stream: true });
  });

  it('passes a body that names no model, or is not JSON, as it came', () => {
    for (const body of ['not json', '[1,2]', '{"input":"x"}', '{"model":42}'])
      expect(withModel(Buffer.from(body), 'm').toString()).toBe(body);
  });

  it('refuses a request without its token, and never forwards it', async () => {
    const model = await upstream();
    const proxy = proxyFor(() => ({ endpointUrl: model.base, model: 'qwen', apiKey: 'sk-real-key' }));
    const address = await proxy.start();
    for (const authorization of [undefined, 'Bearer wrong', `Bearer ${address.token}x`]) {
      const response = await fetch(`${address.baseURL}/models`, { headers: authorization ? { authorization } : {} });
      expect(response.status).toBe(401);
    }
    expect(model.seen).toHaveLength(0);
  });

  it('sends no Authorization upstream for a connection without a key', async () => {
    const model = await upstream();
    const proxy = proxyFor(() => ({ endpointUrl: model.base, model: 'local', apiKey: '' }));
    const address = await proxy.start();
    await (await fetch(`${address.baseURL}/models`, { headers: { authorization: `Bearer ${address.token}` } })).text();
    expect(model.seen[0].headers.authorization).toBeUndefined();
  });

  it('says so when Hello has no connection, and refuses other paths and methods', async () => {
    let connection: ModelConnection | undefined;
    const proxy = proxyFor(() => connection);
    const address = await proxy.start();
    const auth = { authorization: `Bearer ${address.token}` };
    expect((await fetch(`${address.baseURL}/models`, { headers: auth })).status).toBe(503);
    connection = { endpointUrl: 'http://127.0.0.1:9/v1', model: 'x', apiKey: '' };
    expect((await fetch(`http://127.0.0.1:${address.port}/admin`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${address.baseURL}/models`, { method: 'DELETE', headers: auth })).status).toBe(405);
  });

  it('answers 502 when the model server is gone', async () => {
    const proxy = proxyFor(() => ({ endpointUrl: 'http://127.0.0.1:9/v1', model: 'x', apiKey: 'sk-secret' }));
    const address = await proxy.start();
    const response = await fetch(`${address.baseURL}/models`, { headers: { authorization: `Bearer ${address.token}` } });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('sk-secret');
  });

  it('mints a new token on each start', async () => {
    const proxy = proxyFor(() => undefined);
    const first = await proxy.start();
    await proxy.stop();
    const second = await proxy.start();
    expect(second.token).not.toBe(first.token);
  });
});

describe('helloPatch', () => {
  it('without a connection, only quiets the web runtime', () => {
    const rows = parse(helloPatch()) as Array<{ id: string; config: Record<string, unknown> }>;
    expect(rows).toEqual([
      { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true, trustedHosts: [] } },
    ]);
  });

  it('with one, routes dsh’s pi-ai provider through the proxy and defaults new sessions to Hello’s model', () => {
    const rows = parse(helloPatch({
      proxy: { port: 5000, token: 't', baseURL: 'http://127.0.0.1:5000/v1' },
      connection: { endpointUrl: 'https://api.example.com/v1', model: 'org/model:v1', apiKey: 'sk-never-written', contextWindow: 128000, maxOutputTokens: 8192 },
    })) as Array<{ id: string; config: any }>;
    const route = rows.find(row => row.id === 'llm-pi-ai')!.config.providers.hello;
    expect(route).toMatchObject({ apiKeyEnv: MODEL_TOKEN_ENV, api: 'openai-completions', baseURL: 'http://127.0.0.1:5000/v1', models: [{ id: 'org/model:v1', contextWindow: 128000, maxTokens: 8192 }] });
    expect(rows.find(row => row.id === 'agent-default-model')!.config).toEqual({ provider: 'hello', model: 'org/model:v1' });
    expect(JSON.stringify(rows)).not.toContain('sk-never-written');
    expect(JSON.stringify(rows)).not.toContain('api.example.com');
  });
});

// User, 01.10: dsh's own Settings › Appearance could not leave dark — Hello's
// overlay set it, and dsh refuses a change an overlay would override.
describe('the surface’s appearance', () => {
  it('starts as Hello’s window does, from Hello’s bundle, beneath the person’s own layer', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
    const pinned = /<html[^>]*data-theme="(light|dark)"/.exec(html)?.[1] ?? 'system';
    const bundle = parse(readFileSync(new URL('../assets/dsh/hello-dsh/cordis.patch.yml', import.meta.url), 'utf8')) as Array<{ id?: string; config?: { preference?: string } }>;
    expect(bundle.find(row => row.id === 'ui-theme')?.config?.preference).toBe(pinned);
  });

  it('is never set by Hello’s overlay, so dsh’s Settings can change it', () => {
    const overlay = helloPatch({
      proxy: { port: 5000, token: 't', baseURL: 'http://127.0.0.1:5000/v1' },
      connection: { endpointUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k' },
    });
    expect((parse(overlay) as Array<{ id: string }>).map(row => row.id)).not.toContain('ui-theme');
  });
});
