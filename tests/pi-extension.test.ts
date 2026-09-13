import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import helloTools from '../src/main/chat/pi-extension';
import type { ToolDefinition } from '../src/main/chat/tools';

// The Pi child's side of the bridge, driven by a fake ExtensionAPI and a fake
// loopback: no Pi process, no listener, no model.
const tool = (name: string): ToolDefinition => ({
  type: 'function', function: { name, description: `${name} fixture`, parameters: { type: 'object', properties: {} } },
});
type Handler = (event: unknown) => Promise<unknown>;

let offered: ToolDefinition[];
let toolsFail: boolean;
let pi: {
  api: ExtensionAPI;
  handlers: Map<string, Handler>;
  registered: Map<string, unknown>;
  active: string[];
};

beforeEach(() => {
  offered = [tool('web_search'), tool('notebook_paths')];
  toolsFail = false;
  vi.stubEnv('HELLO_PI_BRIDGE_URL', 'http://127.0.0.1:4555/');
  vi.stubEnv('HELLO_PI_BRIDGE_TOKEN', 'b'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
    const route = new URL(String(input)).pathname;
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (route === '/tools') return toolsFail ? reply({ error: 'bridge gone' }, 500) : reply({ tools: offered });
    if (route === '/ready') return reply({ ready: true });
    if (route === '/context') return reply({ context: 'Attached folder (tools use relative paths): /work' });
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
