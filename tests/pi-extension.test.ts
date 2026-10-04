import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convertToLlm, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import helloTools, { schemaArguments } from '../src/main/chat/pi-extension';
import type { ToolDefinition } from '../src/main/chat/tools';
import { createPiToolBridge } from '../src/main/chat/pi-tool-bridge';
import type { ToolOutput } from '../src/main/chat/tool-output';

// The Pi child's side of the bridge, driven by a fake ExtensionAPI and a fake
// loopback: no Pi process, no listener, no model.
const tool = (name: string): ToolDefinition => ({
  type: 'function', function: { name, description: `${name} fixture`, parameters: { type: 'object', properties: {} } },
});
type Handler = (event: unknown) => Promise<unknown>;

let offered: ToolDefinition[];
let toolsFail: boolean;
let executed: unknown;
let pi: {
  api: ExtensionAPI;
  handlers: Map<string, Handler>;
  registered: Map<string, unknown>;
  active: string[];
};

beforeEach(() => {
  offered = [tool('web_search'), tool('notebook_paths')];
  toolsFail = false;
  executed = 'done';
  vi.stubEnv('HELLO_PI_BRIDGE_URL', 'http://127.0.0.1:4555/');
  vi.stubEnv('HELLO_PI_BRIDGE_TOKEN', 'b'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
    const route = new URL(String(input)).pathname;
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (route === '/tools') return toolsFail ? reply({ error: 'bridge gone' }, 500) : reply({ tools: offered });
    if (route === '/ready') return reply({ ready: true });
    if (route === '/context') return reply({ context: 'Attached folder (tools use relative paths): /work' });
    if (route === '/execute') return reply({ result: executed });
    return reply({ error: 'unexpected' }, 404);
  }));
  const handlers = new Map<string, Handler>();
  const registered = new Map<string, unknown>();
  pi = { handlers, registered, active: ['plugin_tool'], api: undefined as unknown as ExtensionAPI };
  pi.api = {
    on: (event: string, handler: Handler) => { handlers.set(event, handler); },
    registerTool: (definition: { name: string }) => { registered.set(definition.name, definition); },
    getActiveTools: () => [...pi.active],
    setActiveTools: (names: string[]) => { pi.active = [...names]; },
  } as unknown as ExtensionAPI;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function started() {
  await helloTools(pi.api);
  await pi.handlers.get('session_start')!({ type: 'session_start' });
  expect(pi.active).toEqual(['plugin_tool', 'web_search', 'notebook_paths']);
}

describe('Hello tools inside a running Pi reply', () => {
  it('brings a folder attached mid-reply to the next step, without dropping plugin tools', async () => {
    await started();
    // A steer attached a folder: the reply keeps running, no agent start follows.
    offered = [...offered, tool('file_read'), tool('command_run')];
    await pi.handlers.get('turn_end')!({ type: 'turn_end' });
    expect(pi.registered.has('command_run')).toBe(true);
    expect(pi.active).toEqual(['plugin_tool', 'web_search', 'notebook_paths', 'file_read', 'command_run']);
  });

  it('keeps the current tools when a refresh fails, rather than ending the reply', async () => {
    await started();
    toolsFail = true;
    await expect(pi.handlers.get('turn_end')!({ type: 'turn_end' })).resolves.toBeUndefined();
    expect(pi.active).toEqual(['plugin_tool', 'web_search', 'notebook_paths']);
  });

  it('tells the model that tools enabled after this step was fixed arrive with the next step', async () => {
    await started();
    const context = pi.handlers.get('context')!;
    const text = async () => {
      const result = await context({ type: 'context', messages: [] }) as { messages: Array<{ content: string }> };
      return result.messages.at(-1)!.content;
    };
    expect(await text()).not.toMatch(/just enabled/);
    offered = [...offered, tool('command_run')];
    expect(await text()).toMatch(/just enabled and can be called from your next step, not in this one: command_run\./);
    // Activated now, so the step after this one really has it.
    expect(pi.active).toContain('command_run');
    expect(await text()).not.toMatch(/just enabled/);
  });
});

describe('live browser metadata is not a new user turn', () => {
  type Messages = Parameters<typeof convertToLlm>[0];
  const history = () => [
    { role: 'user', content: 'Read the two current tabs.', timestamp: 1 },
    { role: 'assistant', content: [
      { type: 'toolCall', id: 'read-a', name: 'browser_read', arguments: { tabId: 'a' } },
      { type: 'toolCall', id: 'read-b', name: 'browser_read', arguments: { tabId: 'b' } },
    ], timestamp: 2 },
    { role: 'toolResult', toolCallId: 'read-a', toolName: 'browser_read',
      content: [{ type: 'text', text: 'First page.' }], isError: false, timestamp: 3 },
    { role: 'toolResult', toolCallId: 'read-b', toolName: 'browser_read',
      content: [{ type: 'text', text: 'Second page.' }], isError: false, timestamp: 4 },
  ];
  const snapshot = (messages: unknown[]) => pi.handlers.get('context')!({
    type: 'context', messages,
  }) as Promise<{ messages: Messages }>;

  it('leaves both tool results last after Pi converts custom metadata to a user message', async () => {
    await started();
    const original = history();
    const result = await snapshot(original);
    const wire = convertToLlm(result.messages);
    expect(wire.map(message => message.role)).toEqual([
      'user', 'user', 'assistant', 'toolResult', 'toolResult',
    ]);
    expect(wire.slice(-2)).toEqual(original.slice(-2));
    expect(result.messages.slice(1)).toEqual(original);
    expect(original).toHaveLength(4);
  });

  it('replaces its ephemeral snapshot before the newest human steer without editing history', async () => {
    await started();
    const original = history();
    const first = await snapshot(original);
    const steer = { role: 'user', content: 'Continue with the second page.', timestamp: 5 };
    const next = await snapshot([...first.messages, steer]);
    const metadata = next.messages.filter(message => message.role === 'custom');
    expect(metadata).toHaveLength(1);
    expect(next.messages.slice(0, original.length)).toEqual(original);
    expect(next.messages.at(-2)).toBe(metadata[0]);
    expect(next.messages.at(-1)).toEqual(steer);
  });

  it('keeps an assistant and its tool results together after compaction removed the user turn', async () => {
    await started();
    const remaining = history().slice(1);
    const result = await snapshot(remaining);
    expect(convertToLlm(result.messages).map(message => message.role)).toEqual([
      'user', 'assistant', 'toolResult', 'toolResult',
    ]);
    expect(result.messages.slice(1)).toEqual(remaining);
  });
});

type Registered = { execute(id: string, params: unknown, signal?: AbortSignal): Promise<{ content: unknown[] }> };
const png = Buffer.from('picture bytes').toString('base64');

describe('tool results with pictures', () => {
  it('keeps a plain string result a single text block', async () => {
    await started();
    const result = await (pi.registered.get('web_search') as Registered).execute('call-1', {});
    expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('maps pictures to Pi image content after the text', async () => {
    await started();
    executed = { text: 'Screenshot 640x400, 1 frame', images: [{ mimeType: 'image/png', data: png }] };
    const result = await (pi.registered.get('web_search') as Registered).execute('call-2', {});
    expect(result.content).toEqual([
      { type: 'text', text: 'Screenshot 640x400, 1 frame' },
      { type: 'image', data: png, mimeType: 'image/png' },
    ]);
  });

  it.each([
    { text: 'x', images: [] },
    { text: 'x', images: [{ mimeType: 'image/svg+xml', data: png }] },
    { text: 'x', images: [{ mimeType: 'image/png', data: '/tmp/shot.png' }] },
    { text: 'x', images: Array.from({ length: 5 }, () => ({ mimeType: 'image/png', data: png })) },
    { images: [{ mimeType: 'image/png', data: png }] },
  ])('refuses a result the bridge may not carry: %j', async (bad) => {
    await started();
    executed = bad;
    await expect((pi.registered.get('web_search') as Registered).execute('call-3', {})).rejects.toThrow(/invalid result/);
  });

  it('carries pictures end to end, from main through the real loopback bridge to Pi content', async () => {
    vi.unstubAllGlobals();
    let output: ToolOutput = 'plain';
    const bridge = await createPiToolBridge({
      getTools: () => [tool('browser_screenshot'), tool('web_search')],
      execute: async () => output,
    });
    try {
      vi.stubEnv('HELLO_PI_BRIDGE_URL', bridge.env.HELLO_PI_BRIDGE_URL);
      vi.stubEnv('HELLO_PI_BRIDGE_TOKEN', bridge.env.HELLO_PI_BRIDGE_TOKEN);
      await helloTools(pi.api);
      await pi.handlers.get('session_start')!({ type: 'session_start' });
      const run = (name: string, id: string) => (pi.registered.get(name) as Registered).execute(id, {});
      expect((await run('web_search', 'e2e-1')).content).toEqual([{ type: 'text', text: 'plain' }]);
      output = { text: 'Screenshot 2x2, 2 frames', images: [
        { mimeType: 'image/png', data: png }, { mimeType: 'image/jpeg', data: png },
      ] };
      expect((await run('browser_screenshot', 'e2e-2')).content).toEqual([
        { type: 'text', text: 'Screenshot 2x2, 2 frames' },
        { type: 'image', data: png, mimeType: 'image/png' },
        { type: 'image', data: png, mimeType: 'image/jpeg' },
      ]);
      // Main refuses to send what it may not carry, before it reaches the child.
      output = { text: 'x', images: [{ mimeType: 'image/png', data: 'a'.repeat(2 * 1024 * 1024 + 4) }] };
      await expect(run('browser_screenshot', 'e2e-3')).rejects.toThrow(/invalid result/);
    } finally {
      await bridge.close();
    }
  });
});

describe('the chat’s folder', () => {
  it('becomes the working directory of the extensions loaded after Hello’s', async () => {
    const { mkdtempSync, realpathSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'hello-chat-folder-')));
    const before = process.cwd();
    try {
      vi.stubEnv('HELLO_CHAT_FOLDER', folder);
      await helloTools(pi.api);
      expect(process.cwd()).toBe(folder);
      // A folder that is gone, or a relative one, leaves the directory alone.
      process.chdir(before);
      vi.stubEnv('HELLO_CHAT_FOLDER', join(folder, 'missing'));
      await helloTools(pi.api);
      vi.stubEnv('HELLO_CHAT_FOLDER', 'relative/folder');
      await helloTools(pi.api);
      expect(process.cwd()).toBe(before);
    } finally {
      process.chdir(before);
    }
  });
});

// A Pi CLI the person opened from Hello loads this extension too (user, 30.09):
// the connection's tools become its own, and nothing else of it changes.
describe('in a Pi CLI opened from Hello', () => {
  it('adds the connection’s tools and leaves the person’s Pi as it was', async () => {
    vi.stubEnv('HELLO_PI_EXTENSION_ROLE', 'cli');
    vi.stubEnv('HELLO_CHAT_FOLDER', process.env.TMPDIR || '/tmp');
    const folder = process.cwd();
    const stub = globalThis.fetch;
    await helloTools(pi.api);
    await pi.handlers.get('session_start')!({ type: 'session_start' });
    expect(pi.active).toEqual(['plugin_tool', 'web_search', 'notebook_paths']);
    // Its fetch keeps following redirects, its folder stays, its context gets no snapshot.
    expect(globalThis.fetch).toBe(stub);
    expect(process.cwd()).toBe(folder);
    expect(pi.handlers.has('context')).toBe(false);
    // The tools themselves call through the connection.
    executed = 'Clicked button "Decline all" at (320, 437).';
    const click = pi.registered.get('web_search') as { execute(id: string, params: object): Promise<{ content: Array<{ text: string }> }> };
    expect((await click.execute('call-1', {})).content[0].text).toBe('Clicked button "Decline all" at (320, 437).');
  });
});

// A model sent tab_id for tabId, and every browser call failed Pi's check
// (user, 30.09): arguments are named as the schema names them first.
describe('arguments as the schema names them', () => {
  const schema = { type: 'object', properties: { tabId: { type: 'string' }, deltaY: { type: 'number' }, url: { type: 'string' } } };
  it('renames a snake_case key the schema knows in camelCase, and parses arguments sent as a string', () => {
    expect(schemaArguments({ tab_id: 't1', delta_y: 600 }, schema)).toEqual({ tabId: 't1', deltaY: 600 });
    expect(schemaArguments('{"tab_id":"t1","url":"https://example.test"}', schema)).toEqual({ tabId: 't1', url: 'https://example.test' });
    // Both sent: the schema's own name wins, and the other is left for the schema to refuse.
    expect(schemaArguments({ tabId: 'a', tab_id: 'b' }, schema)).toEqual({ tabId: 'a', tab_id: 'b' });
    expect(schemaArguments({ other_key: 1 }, schema)).toEqual({ other_key: 1 });
    expect(schemaArguments('not json', schema)).toBe('not json');
  });

  it('is what every Hello tool hands Pi to run before its check', async () => {
    offered = [{ type: 'function', function: { name: 'browser_read', description: 'read', parameters: schema } }];
    await helloTools(pi.api);
    const tool = pi.registered.get('browser_read') as { prepareArguments(args: unknown): unknown };
    expect(tool.prepareArguments({ tab_id: 't1' })).toEqual({ tabId: 't1' });
  });
});

