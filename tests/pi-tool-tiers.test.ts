import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import helloTools from '../src/main/chat/pi-extension';
import type { ToolDefinition } from '../src/main/chat/tools';
import { activeToolNames, groupsByIntent, helloToolGroups, matchGroups, pluginToolGroups, spreadsheetWork, toolsFindDescription, TOOLS_LOADED, type ToolCatalog } from '../src/main/chat/tool-groups';

// Tools are prompt-context driven (user, 29.09: "ai treabă în browser,
// descoperi tool-urile de browser"). A fake Pi and a fake bridge: no Pi
// process, no listener, no model.
const tool = (name: string, description = `${name} does one thing. And more.`): ToolDefinition => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties: {} } },
});
const HELLO = ['web_search', 'fetch_url', 'file_list', 'file_read', 'file_edit', 'file_write', 'bash',
  'browser_open', 'browser_read', 'browser_click', 'worker_list', 'worker_say', 'notebook_list', 'notebook_save', 'mcp_github_search'];
const PLUGIN_PATH = '/data/library/plugins/abc/index.hello-bundle.mjs';

function catalogFor(tools: ToolDefinition[]): ToolCatalog {
  return {
    groups: helloToolGroups(tools, {
      notebooks: { runbook: true, tasks: true }, planning: false,
      mcp: [{ name: 'mcp_github_search', serverName: 'github', remoteName: 'search' }],
    }),
    plugins: [{ path: PLUGIN_PATH, name: 'openviking' }],
  };
}

describe('the groups main describes', () => {
  const tools = HELLO.map(name => tool(name));

  it('keeps research, the shell and the chat’s files in view, and puts every other area in a group', () => {
    const groups = helloToolGroups(tools, { notebooks: { runbook: true, tasks: true }, planning: false, mcp: [{ name: 'mcp_github_search', serverName: 'github', remoteName: 'search' }] });
    expect(groups.map(group => [group.id, group.core, group.tools.length])).toEqual([
      ['core', true, 3], ['coding', true, 4], ['browser', false, 3], ['workers', false, 2], ['notebook', false, 2], ['mcp:github', false, 1],
    ]);
    expect(groups.find(group => group.id === 'browser')!.manual).toContain('browser_click ref: "e12"');
    expect(groups.find(group => group.id === 'workers')!.manual).toContain('NEVER read a pane in a loop');
    expect(groups.find(group => group.id === 'mcp:github')!.manual).toContain('untrusted external data');
  });

  it('has the file tools in view in every chat — there is no mode — and never hides a tool it does not know', () => {
    const groups = helloToolGroups([...tools, tool('something_new')], { notebooks: { runbook: true, tasks: true }, planning: false, mcp: [] });
    expect(groups.find(group => group.id === 'coding')!.core).toBe(true);
    expect(groups.find(group => group.id === 'core')!.tools).toEqual(['web_search', 'fetch_url', 'bash', 'mcp_github_search', 'something_new']);
  });

  it('publishes the coding safety rules with the tool group', () => {
    const coder = catalogFor(tools).groups.find(group => group.id === 'coding')!;
    expect(coder.manual).toMatchInlineSnapshot(`
"Read relevant source before editing, complete the requested change, and check the result with the available tools when authorized.
Change an existing file with file_edit — the exact text to replace and its replacement — never by rewriting the whole file with file_write, which is for new files or a deliberate full replacement; every replaced version is kept, and the result says where.
Before rm, mv, cp -R, git clean or git reset, verify the resolved source and destination paths, including symlinks, and the exact scope of deletion, overwrite or discarded work. For Git, check the repository, branch and working-tree changes first; never infer a safe target from cwd alone.
After a step is interrupted, stopped or times out, inspect its actual effect before retrying or continuing. A timeout does not mean nothing happened: files, processes or external state may already have changed.
bash uses the current approval setting and runs in the attached folder; the shell is not sandboxed. Use it only for work the human asked for; these rules never bypass an approval.
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
    // The shell and the chat's files are there from the first step, in every chat (user, 17.11: one way of working).
    const core = ['tools_find', 'web_search', 'fetch_url', 'bash', 'file_list', 'file_read', 'file_edit', 'file_write'];
    expect(activeToolNames(groups, new Set())).toEqual(core);
    expect(activeToolNames(groups, new Set(['browser']))).toEqual([...core, 'browser_open', 'browser_read', 'browser_click']);
    expect(matchGroups(groups, 'browser').map(group => group.id)).toEqual(['browser']);
    // The shell and the files are in view, so no words load them — and "code" is still not the workers' "Codex".
    expect(matchGroups(groups, 'fix the code')).toEqual([]);
    for (const said of [{ group: 'coding' }, { groups: ['files'] }, { tool: 'file_edit' }, { name: 'bash' }])
      expect([said, groupsByIntent(groups, said).already.map(group => group.id).length, groupsByIntent(groups, said).chosen]).toEqual([said, 1, []]);
    // Two groups equally likely: the list, not a guess that cannot be undone.
    expect(matchGroups(groups, 'read')).toEqual([]);
    expect(matchGroups(groups, 'github')[0].id).toBe('mcp:github');
    expect(matchGroups(groups, 'xyzzy')).toEqual([]);
    expect(toolsFindDescription(groups)).toContain('- browser: open, read or drive a web page');
    expect(toolsFindDescription(groups)).not.toContain('- core:');
  });

  // "browser" is a clear intent: answer with the browser tools, never with a
  // failed round spent learning a field's name (user, 09.10).
  it('reads a call by intent: a name, a tool, a word of its family, in any field', () => {
    const { groups } = catalogFor(tools);
    const ids = (input: Record<string, unknown>) => groupsByIntent(groups, input).chosen.map(group => group.id);
    expect(ids({ group: 'browser' })).toEqual(['browser']);
    expect(ids({ groups: 'Browser' })).toEqual(['browser']);
    expect(ids({ tool: 'TOOL_BROWSER_OPEN' })).toEqual(['browser']);
    expect(ids({ name: 'browser_screenshot' })).toEqual(['browser']);
    expect(ids({ area: 'web' })).toEqual(['browser']);
    expect(ids({ query: 'mcp__hello__worker_say' })).toEqual(['workers']);
    expect(ids({ groups: ['tabs', 'notebook'] })).toEqual(['browser', 'notebook']);
    expect(ids({ need: 'open google in a page' })).toEqual(['browser']);
    expect(ids({ server: 'github' })).toEqual(['mcp:github']);
    // A word two groups could claim decides nothing; a single unknown word is said to be none.
    expect(groupsByIntent(groups, { group: 'read' })).toEqual({ chosen: [], unknown: ['read'], already: [] });
    expect(ids({ groups: 'core' })).toEqual([]);
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
    expect(pi.active.sort()).toEqual(['bash', 'fetch_url', 'file_edit', 'file_list', 'file_read', 'file_write', 'tools_find', 'web_search']);
    expect(pi.registered.get('tools_find')!.description).toContain('- plugin:openviking: tools of the openviking plugin: openviking_remember');
    // Every Hello tool is registered, ready to be loaded.
    expect([...pi.registered.keys()]).toEqual(expect.arrayContaining(['browser_click', 'worker_say', 'file_edit']));
  });

  it('loads a group by name for the next step, with its tools and its manual', async () => {
    await start();
    const result = await find({ groups: ['browser'] });
    expect(pi.active).toEqual(expect.arrayContaining(['browser_open', 'browser_read', 'browser_click', 'web_search', 'tools_find']));
    expect(pi.active).not.toContain('worker_say');
    expect(result.details).toEqual({ loaded: ['browser'] });
    expect(result.content[0].text).toContain('Browser (browser) is loaded. Its tools can be called from your next step:');
    expect(result.content[0].text).toContain('- browser_click: browser_click does one thing.');
    expect(result.content[0].text).toContain('Rules for these tools:');
    // A later refresh keeps what was loaded.
    await pi.handlers.get('turn_end')!({ type: 'turn_end' });
    expect(pi.active).toContain('browser_click');
  });

  it('loads the browser by itself when a search or a page is stopped by bot protection, and says so in the failure', async () => {
    const blocked = 'DuckDuckGo blocked this search with bot protection; repeating it will not help. Run it in Hello’s browser.';
    const bridge = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => new URL(String(input)).pathname === '/execute'
      ? new Response(JSON.stringify({ error: JSON.parse(String(init?.body)).name === 'web_search' ? blocked : 'The page is outside this chat’s folder.' }), { status: 500 })
      : bridge(input, init));
    await start();
    expect(pi.active).not.toContain('browser_open');
    // Any other failure is passed on as it is, and loads nothing.
    await expect(pi.registered.get('file_read')!.execute('call-0', { path: '../x' })).rejects.toThrow(/^The page is outside this chat’s folder\.$/);
    expect(pi.active).not.toContain('browser_open');
    const failed = await pi.registered.get('web_search')!.execute('call-1', { query: 'x' }).then(() => undefined, (error: Error) => error.message);
    expect(failed).toContain(blocked);
    expect(failed).toContain('Browser (browser) is loaded. Its tools can be called from your next step:');
    expect(failed).toContain('Rules for these tools:');
    expect(pi.active).toEqual(expect.arrayContaining(['browser_open', 'browser_read', 'browser_click']));
    // Blocked again: the browser is there already, and its rules are not said twice.
    const again = await pi.registered.get('web_search')!.execute('call-2', { query: 'y' }).then(() => undefined, (error: Error) => error.message);
    expect(again).toContain(blocked);
    expect(again).not.toContain('is loaded');
    // A request for what is in view says so, instead of listing the other groups.
    const inView = await find({ groups: ['coding'] });
    expect(inView.content[0].text).toMatch(/already in view in every chat.*file_edit/);
    expect(inView.details).toEqual({ loaded: [] });
  });

  it('finds a group from a few words, loads a plugin’s, and lists them all when nothing fits', async () => {
    pi.pluginTools = [{ name: 'openviking_remember', description: 'Remember something.', sourceInfo: { path: PLUGIN_PATH } }];
    await start();
    await find({ need: 'edit a file and run a shell command' });
    expect(pi.active).toEqual(expect.arrayContaining(['file_edit', 'bash']));
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
    expect(pi.registered.get('tools_find')!.parameters).toMatchObject({ properties: { groups: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] } } });
  });

  it('loads the group a call means even under the wrong field, instead of failing validation', async () => {
    await start();
    // No closed object: Pi has no extra field to reject before the call reaches Hello.
    expect(pi.registered.get('tools_find')!.parameters).not.toHaveProperty('additionalProperties');
    const result = await find({ group: 'browser' });
    expect(result.details).toEqual({ loaded: ['browser'] });
    expect(pi.active).toContain('browser_open');
    expect((await find({ tool: 'TOOL_WORKER_SAY' })).details).toEqual({ loaded: ['workers'] });
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

  it('loads what main says a reply needs before its first step, with the manual, once', async () => {
    tools = [...tools, tool('sheet_list'), tool('sheet_read')];
    catalog = { ...catalogFor(tools), preload: ['sheets'] };
    let branch: unknown[] = [];
    const ctx = { sessionManager: { getBranch: () => branch } };
    await start(ctx);
    expect(pi.active).not.toContain('sheet_list');
    const begun = await pi.handlers.get('before_agent_start')!({ type: 'before_agent_start', prompt: 'x' }) as { message: { customType: string; display: boolean; details: unknown; content: string } };
    // The shell and the file tools sheets works with are in view already: only its own manual is in the note.
    expect(begun.message).toMatchObject({ customType: TOOLS_LOADED, display: false, details: { loaded: ['sheets'] } });
    expect(begun.message.content).toMatch(/^Hello loaded these tools before your first step.*not a request from the human/);
    expect(begun.message.content).toContain('Sheets (sheets) is loaded. Its tools can be called from this step on:\n- sheet_list: sheet_list does one thing.');
    expect(begun.message.content).toContain('never a total you computed yourself');
    expect(begun.message.content).not.toContain('(coding) is loaded.');
    expect(pi.active).toEqual(expect.arrayContaining(['sheet_list', 'sheet_read', 'file_read', 'bash', 'tools_find']));
    // The next reply of the same chat says nothing again: the rules are in the transcript.
    expect(await pi.handlers.get('before_agent_start')!({ type: 'before_agent_start', prompt: 'y' })).toBeUndefined();
    // Pi puts the note after the request; the model reads the rules first and the human's words last, on every step alike.
    const shown = await pi.handlers.get('context')!({ type: 'context', messages: [
      { role: 'user', content: 'older', timestamp: 1 }, { role: 'assistant', content: [], timestamp: 2 },
      { role: 'user', content: 'pivot please', timestamp: 3 },
      { role: 'custom', customType: TOOLS_LOADED, content: 'rules', display: false, timestamp: 4 },
      { role: 'assistant', content: [], timestamp: 5 },
    ] }) as { messages: Array<{ role: string; content: unknown; customType?: string }> };
    expect(shown.messages.map(message => message.customType ?? message.role)).toEqual(['user', 'assistant', TOOLS_LOADED, 'user', 'assistant']);
    expect(shown.messages[2].content).toBe('rules');
    expect(shown.messages[3].content).toBe('pivot please');
    // A restarted Pi reads the note back like a tools_find result; a compaction that summarized it away unloads the group, and the next reply loads it again.
    branch = [{ id: 'a', type: 'custom_message', customType: TOOLS_LOADED, content: 'rules', details: { loaded: ['sheets', 'coding'] } }];
    await pi.handlers.get('session_compact')!({ type: 'session_compact' }, ctx);
    expect(pi.active).toContain('sheet_list');
    branch = [...branch, { id: 'b', type: 'message', message: { role: 'user', content: 'z' } }, { id: 'c', type: 'compaction', firstKeptEntryId: 'b' }];
    await pi.handlers.get('session_compact')!({ type: 'session_compact' }, ctx);
    expect(pi.active).not.toContain('sheet_list');
    expect(await pi.handlers.get('before_agent_start')!({ type: 'before_agent_start', prompt: 'again' })).toMatchObject({ message: { details: { loaded: ['sheets'] } } });
    // Nothing asked for, nothing loaded.
    catalog = { ...catalogFor(tools), preload: [] };
    await pi.handlers.get('session_compact')!({ type: 'session_compact' }, { sessionManager: { getBranch: () => [] } });
    expect(await pi.handlers.get('before_agent_start')!({ type: 'before_agent_start', prompt: 'hello' })).toBeUndefined();
    expect(pi.active).not.toContain('sheet_list');
  });

  it('reads spreadsheet work from what a request names, and from nothing vaguer', () => {
    for (const text of ['Deschide Profi Phone List 22.05.2023.xlsx și fă un pivot', 'curăță export.csv', 'date.TSV', 'raport.xlsm are macro-uri', 'fă-mi un excel cu bugetul',
      'make a spreadsheet of the budget', 'în workbook-ul acesta', 'vreau un tabel pivot pe județe', 'o foaie de calcul nouă', 'Attached: vanzari.xlsx'])
      expect([text, spreadsheetWork(text)]).toEqual([text, true]);
    for (const text of ['fă-mi un tabel cu prețurile', 'excellent work', 'scrie un raport Word', 'ce e un pivot în baschet?', 'parse data.csv.gz in python', 'the sheet music', 'styles.css și index.html'])
      expect([text, spreadsheetWork(text)]).toEqual([text, false]);
  });

  it('offers every tool as before when the bridge describes no groups', async () => {
    catalog = undefined;
    await start();
    expect(pi.active).toEqual(expect.arrayContaining(HELLO));
    expect(pi.registered.has('tools_find')).toBe(false);
  });
});

// One way of working (user, 17.11): the browser is not carried by every chat,
// so Hello reads from the request when the work is there — and loads it when a
// search or a page is stopped by bot protection, which is when a model that had
// to go and find it answered from memory instead.
describe('the browser, loaded by Hello when the work is there', () => {
  it('reads browser work from an address, a site, or the thing by its name', async () => {
    const { browserWork, stoppedByBots } = await import('../src/main/chat/tool-groups');
    for (const text of ['deschide https://example.org/docs', 'ce scrie pe emag.ro despre asta', 'intră pe www.anaf.ro', 'uită-te în tabul deschis', 'citește site-ul lor',
      'open the link and summarise it', 'fă-mi o pagină html cu graficul', 'check news.ycombinator.com', 'folosește browserul'])
      expect([text, browserWork(text)]).toEqual([text, true]);
    for (const text of ['fă un tabel cu vânzările', 'citește notes.md și logo.ai', 'trimite la ana@firma.ro', 'ce zici de planul ăsta?', 'rulează scripts/build.io.sh', 'comprimă plan.pdf', 'src/app.dev.ts are o eroare'])
      expect([text, browserWork(text)]).toEqual([text, false]);
    expect(stoppedByBots('web_search', 'DuckDuckGo blocked this search with bot protection; repeating it will not help.')).toBe(true);
    expect(stoppedByBots('fetch_url', 'No readable page was returned (empty, JavaScript-only or bot protection).')).toBe(true);
    expect(stoppedByBots('fetch_url', 'fetch_url requires an absolute public HTTP(S) URL without credentials.')).toBe(false);
    expect(stoppedByBots('bash', 'bot protection')).toBe(false);
  });
});
