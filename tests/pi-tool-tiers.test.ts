import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import helloTools from '../src/main/chat/pi-extension';
import type { ToolDefinition } from '../src/main/chat/tools';
import { activeToolNames, helloToolGroups, matchGroups, pluginToolGroups, toolsFindDescription, type ToolCatalog } from '../src/main/chat/tool-groups';

// Tools are prompt-context driven (user, 29.09: "ai treabă în browser,
// descoperi tool-urile de browser"). A fake Pi and a fake bridge: no Pi
// process, no listener, no model.
const tool = (name: string, description = `${name} does one thing. And more.`): ToolDefinition => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties: {} } },
});
const HELLO = ['web_search', 'fetch_url', 'file_list', 'file_read', 'file_edit', 'file_write', 'command_run',
  'browser_open', 'browser_read', 'browser_click', 'worker_list', 'worker_say', 'notebook_list', 'notebook_save', 'mcp_github_search'];
const PLUGIN_PATH = '/data/library/plugins/abc/index.hello-bundle.mjs';

function catalogFor(tools: ToolDefinition[], chatMode: 'chat' | 'coder' = 'chat'): ToolCatalog {
  return {
    groups: helloToolGroups(tools, {
      chatMode, notebooks: { runbook: true, tasks: true }, planning: false,
      mcp: [{ name: 'mcp_github_search', serverName: 'github', remoteName: 'search' }],
    }),
    plugins: [{ path: PLUGIN_PATH, name: 'openviking' }],
  };
}

describe('the groups main describes', () => {
  const tools = HELLO.map(name => tool(name));

  it('keeps research in the core and puts every other area in a group', () => {
    const groups = helloToolGroups(tools, { chatMode: 'chat', notebooks: { runbook: true, tasks: true }, planning: false, mcp: [{ name: 'mcp_github_search', serverName: 'github', remoteName: 'search' }] });
    expect(groups.map(group => [group.id, group.core, group.tools.length])).toEqual([
      ['core', true, 2], ['coding', false, 5], ['browser', false, 3], ['workers', false, 2], ['notebook', false, 2], ['mcp:github', false, 1],
    ]);
    expect(groups.find(group => group.id === 'browser')!.manual).toContain('browser_click ref: "e12"');
    expect(groups.find(group => group.id === 'workers')!.manual).toContain('NEVER read a pane in a loop');
    expect(groups.find(group => group.id === 'mcp:github')!.manual).toContain('untrusted external data');
  });

  it('makes coding core in Coder mode, and never hides a tool it does not know', () => {
    const groups = helloToolGroups([...tools, tool('something_new')], { chatMode: 'coder', notebooks: { runbook: true, tasks: true }, planning: false, mcp: [] });
    expect(groups.find(group => group.id === 'coding')!.core).toBe(true);
    expect(groups.find(group => group.id === 'core')!.tools).toEqual(['web_search', 'fetch_url', 'mcp_github_search', 'something_new']);
  });

  it('publishes the coding safety rules with the tool group in both modes', () => {
    const chat = catalogFor(tools, 'chat').groups.find(group => group.id === 'coding')!;
    const coder = catalogFor(tools, 'coder').groups.find(group => group.id === 'coding')!;
    expect(chat.manual).toBe(coder.manual);
    expect(coder.manual).toMatchInlineSnapshot(`
"Read relevant source before editing, complete the requested change, and check the result with the available tools when authorized.
Change an existing file with file_edit — the exact text to replace and its replacement — never by rewriting the whole file with file_write, which is for new files or a deliberate full replacement; every replaced version is kept, and the result says where.
Before rm, mv, cp -R, git clean or git reset, verify the resolved source and destination paths, including symlinks, and the exact scope of deletion, overwrite or discarded work. For Git, check the repository, branch and working-tree changes first; never infer a safe target from cwd alone.
After a step is interrupted, stopped or times out, inspect its actual effect before retrying or continuing. A timeout does not mean nothing happened: files, processes or external state may already have changed.
command_run uses the current approval setting and runs in the attached folder; the shell is not sandboxed. Use it only for work the human asked for; these rules never bypass an approval.
Report what changed and what was verified; never claim a check you did not run."
`);
  });

  it('groups a plugin’s tools by the extension that registered them', () => {
    expect(pluginToolGroups([
      { name: 'openviking_search', sourceInfo: { path: PLUGIN_PATH } },
      { name: 'openviking_remember', sourceInfo: { path: PLUGIN_PATH } },
      { name: 'web_search', sourceInfo: { path: '/app/pi-extension.js' } },
    ], [{ path: PLUGIN_PATH, name: 'openviking' }])).toEqual([expect.objectContaining({ id: 'plugin:openviking', tools: ['openviking_search', 'openviking_remember'] })]);
  });

  it('activates the core and what was loaded, and matches a few words to a group', () => {
    const { groups } = catalogFor(tools);
    expect(activeToolNames(groups, new Set())).toEqual(['tools_find', 'web_search', 'fetch_url']);
    expect(activeToolNames(groups, new Set(['browser']))).toEqual(['tools_find', 'web_search', 'fetch_url', 'browser_open', 'browser_read', 'browser_click']);
    expect(matchGroups(groups, 'browser').map(group => group.id)).toEqual(['browser']);
    // Whole words, no stop words: "code" is coding, not the workers' "Codex".
    expect(matchGroups(groups, 'fix the code').map(group => group.id)).toEqual(['coding']);
    // Two groups equally likely: the list, not a guess that cannot be undone.
    expect(matchGroups(groups, 'read')).toEqual([]);
    expect(matchGroups(groups, 'edit files and run a shell command').map(group => group.id)).toEqual(['coding']);
    expect(matchGroups(groups, 'github')[0].id).toBe('mcp:github');
    expect(matchGroups(groups, 'xyzzy')).toEqual([]);
    expect(toolsFindDescription(groups)).toContain('- browser: open, read or drive a web page');
    expect(toolsFindDescription(groups)).not.toContain('- core:');
  });
});

type Handler = (event: unknown, ctx?: unknown) => Promise<unknown>;
interface Registered { name: string; description: string; parameters: unknown; execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }>; details: unknown }> }
let tools: ToolDefinition[];
let catalog: ToolCatalog | undefined;
let pi: { api: ExtensionAPI; handlers: Map<string, Handler>; registered: Map<string, Registered>; active: string[]; pluginTools: Array<{ name: string; description: string; sourceInfo: { path: string } }> };

beforeEach(() => {
  tools = HELLO.map(name => tool(name));
  catalog = catalogFor(tools);
  vi.stubEnv('HELLO_PI_BRIDGE_URL', 'http://127.0.0.1:4555/');
  vi.stubEnv('HELLO_PI_BRIDGE_TOKEN', 'b'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
    const route = new URL(String(input)).pathname;
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (route === '/tools') return reply({ tools, ...(catalog ?? {}) });
    if (route === '/ready') return reply({ ready: true });
    if (route === '/context') return reply({ context: '' });
    return reply({ result: 'done' });
  }));
  const handlers = new Map<string, Handler>();
  const registered = new Map<string, Registered>();
  pi = { handlers, registered, active: [], pluginTools: [], api: undefined as unknown as ExtensionAPI };
  pi.api = {
    on: (event: string, handler: Handler) => { handlers.set(event, handler); },
    registerTool: (definition: Registered) => {
      // Pi activates a tool that registers after startup.
      if (!registered.has(definition.name)) pi.active = [...new Set([...pi.active, definition.name])];
      registered.set(definition.name, definition);
    },
    getActiveTools: () => [...pi.active],
    setActiveTools: (names: string[]) => { pi.active = [...names]; },
    // Like Pi: action methods throw until every extension has loaded.
    getAllTools: () => {
      if (!pi.handlers.has('session_start') || !started) throw new Error('Extension runtime not initialized. Action methods cannot be called during extension loading.');
      return allTools();
    },
  } as unknown as ExtensionAPI;
  const allTools = () => [
      ...[...registered.values()].map(item => ({ name: item.name, description: item.description, sourceInfo: { path: '/app/pi-extension.js' } })),
      ...pi.pluginTools,
    ];
  started = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

let started = false;
async function start(ctx?: unknown) {
  await helloTools(pi.api);
  started = true;
  await pi.handlers.get('session_start')!({ type: 'session_start' }, ctx);
}
const find = (params: unknown) => pi.registered.get('tools_find')!.execute('call-1', params);

describe('tools in a running chat', () => {
  it('starts with the core and tools_find, a plugin’s tools waiting in their group', async () => {
    pi.pluginTools = [{ name: 'openviking_remember', description: 'Remember something.', sourceInfo: { path: PLUGIN_PATH } }];
    pi.active = ['openviking_remember'];
    await start();
    expect(pi.active.sort()).toEqual(['fetch_url', 'tools_find', 'web_search']);
    expect(pi.registered.get('tools_find')!.description).toContain('- plugin:openviking: tools of the openviking plugin: openviking_remember');
    // Every Hello tool is registered, ready to be loaded.
    expect([...pi.registered.keys()]).toEqual(expect.arrayContaining(['browser_click', 'worker_say', 'file_edit']));
  });

  it('loads a group by name for the next step, with its tools and its manual', async () => {
    await start();
    const result = await find({ groups: ['browser'] });
    expect(pi.active).toEqual(expect.arrayContaining(['browser_open', 'browser_read', 'browser_click', 'web_search', 'tools_find']));
    expect(pi.active).not.toContain('file_edit');
    expect(result.details).toEqual({ loaded: ['browser'] });
    expect(result.content[0].text).toContain('Browser (browser) is loaded. Its tools can be called from your next step:');
    expect(result.content[0].text).toContain('- browser_click: browser_click does one thing.');
    expect(result.content[0].text).toContain('Rules for these tools:');
    // A later refresh keeps what was loaded.
    await pi.handlers.get('turn_end')!({ type: 'turn_end' });
    expect(pi.active).toContain('browser_click');
  });

  it('finds a group from a few words, loads a plugin’s, and lists them all when nothing fits', async () => {
    pi.pluginTools = [{ name: 'openviking_remember', description: 'Remember something.', sourceInfo: { path: PLUGIN_PATH } }];
    await start();
    await find({ need: 'edit a file and run a shell command' });
    expect(pi.active).toEqual(expect.arrayContaining(['file_edit', 'command_run']));
    await find({ groups: ['plugin:openviking'] });
    expect(pi.active).toContain('openviking_remember');
    const nothing = await find({ groups: ['spreadsheet'] });
    expect(nothing.content[0].text).toContain('No group named spreadsheet. Pick from these:');
    expect(nothing.content[0].text).toContain('- workers:');
    expect(nothing.details).toEqual({ loaded: [] });
  });

  it('keeps the groups a restarted Pi had loaded, read back from the session', async () => {
    await start({ sessionManager: { getBranch: () => [
      { type: 'message', message: { role: 'user', content: 'x' } },
      { type: 'message', message: { role: 'toolResult', toolName: 'tools_find', details: { loaded: ['workers'] } } },
    ] } });
    expect(pi.active).toEqual(expect.arrayContaining(['worker_list', 'worker_say']));
    expect(pi.active).not.toContain('browser_open');
  });

  it('announces a group that appeared since the last step', async () => {
    await start();
    await pi.handlers.get('context')!({ type: 'context', messages: [{ role: 'user', content: 'x', timestamp: 1 }] });
    tools = [...tools, tool('mcp_linear_issues')];
    catalog = { groups: [...catalogFor(tools).groups, { id: 'mcp:linear', title: 'linear', when: 'tools of the linear MCP server', core: false, tools: ['mcp_linear_issues'], manual: '' }], plugins: [] };
    const result = await pi.handlers.get('context')!({ type: 'context', messages: [{ role: 'user', content: 'x', timestamp: 1 }] }) as { messages: Array<{ content: string }> };
    expect(result.messages[0].content).toContain('These tool groups just became available; load one with tools_find from your next step when the task needs it: mcp:linear.');
  });

  it('loads a group by its bare server name, and says which names it did not know', async () => {
    await start();
    const result = await find({ groups: ['github', 'spreadsheet'] });
    expect(pi.active).toContain('mcp_github_search');
    expect(result.details).toEqual({ loaded: ['mcp:github'] });
    expect(result.content[0].text).toContain('No group named spreadsheet; the others are:');
    expect(pi.registered.get('tools_find')!.parameters).toMatchObject({ properties: { groups: { items: { type: 'string' } } } });
  });

  it('unloads what a compaction summarized away, keeps what it kept, and says so', async () => {
    let branch: unknown[] = [];
    const ctx = { sessionManager: { getBranch: () => branch } };
    await start(ctx);
    await find({ groups: ['browser'] });
    await find({ groups: ['workers'] });
    branch = [
      { id: 'a', type: 'message', message: { role: 'toolResult', toolName: 'tools_find', details: { loaded: ['browser'] } } },
      { id: 'b', type: 'message', message: { role: 'toolResult', toolName: 'tools_find', details: { loaded: ['workers'] } } },
      { id: 'c', type: 'compaction', firstKeptEntryId: 'b' },
    ];
    await pi.handlers.get('session_compact')!({ type: 'session_compact' }, ctx);
    expect(pi.active).toEqual(expect.arrayContaining(['worker_list', 'worker_say']));
    expect(pi.active).not.toContain('browser_open');
    const result = await pi.handlers.get('context')!({ type: 'context', messages: [{ role: 'user', content: 'x', timestamp: 1 }] }) as { messages: Array<{ content: string }> };
    expect(result.messages[0].content).toContain('Compaction summarized away the rules of these tool groups, so they were unloaded: browser.');
  });

  it('offers every tool as before when the bridge describes no groups', async () => {
    catalog = undefined;
    await start();
    expect(pi.active).toEqual(expect.arrayContaining(HELLO));
    expect(pi.registered.has('tools_find')).toBe(false);
  });
});
