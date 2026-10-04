import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Script } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTab, Conversation, NotebookEntry, NotebookKind } from '../src/shared/types';
import type { DataStore } from '../src/main/data/store';
import type { BrowserHooks } from '../src/main/chat/tools';
import { createWorkerNotebookContext, type WorkerNotebookContext } from '../src/main/terminal/notebook-context';

const roots: string[] = [];
const contexts: WorkerNotebookContext[] = [];

afterEach(async () => {
  try {
    await Promise.all(contexts.splice(0).map(context => context.close()));
  } finally {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

interface BridgeReply {
  context?: string;
  tools?: Array<{ function: { name: string } }>;
  result?: string;
  error?: string;
}

async function fixture(options: { folder?: string | null; runbook?: boolean; tasks?: boolean; browser?: BrowserHooks; piExtension?: string } = {}) {
  const folder = options.folder;
  const root = mkdtempSync(join(tmpdir(), 'hello-cli-notebooks-test-'));
  roots.push(root);
  const cwd = folder ?? join(root, 'home');
  const chat: Conversation = {
    id: 'chat-a', title: 'Selected chat', folder: folder === null ? null : cwd,
    runbook: options.runbook !== false, tasks: options.tasks !== false,
    createdAt: 1, updatedAt: 1,
  };
  const makeEntry = (id: string, conversationId: string, kind: NotebookKind, body: string): NotebookEntry => ({
    id, conversationId, kind, title: id, body, createdAt: 1, updatedAt: 1, shared: true,
  });
  const entries = new Map([
    makeEntry('task-a', chat.id, 'tasks', '# Work\n- [ ] Audit entry points\n  - [ ] Check route ownership\n- [x] Existing done'),
    makeEntry('task-b', chat.id, 'tasks', '# Other\n- [ ] Review assets'),
    makeEntry('reference', chat.id, 'runbook', '- [ ] Reference is not an assigned task'),
    makeEntry('foreign-task', 'chat-b', 'tasks', '- [ ] Another conversation'),
  ].map(entry => [entry.id, entry]));
  const getConversation = vi.fn((id: string) => {
    if (id !== chat.id) throw new Error('Conversation not found.');
    return { ...chat };
  });
  const listNotebooks = vi.fn((conversationId: string, kind: NotebookKind) =>
    [...entries.values()].filter(entry => entry.conversationId === conversationId && entry.kind === kind)
      .map(entry => ({ ...entry })),
  );
  const saveNotebook = vi.fn((input: Parameters<DataStore['saveNotebook']>[0]) => {
    const before = input.id ? entries.get(input.id) : undefined;
    if (!before) throw new Error('Expected an existing entry.');
    const saved: NotebookEntry = {
      ...before, title: input.title, body: input.body, updatedAt: before.updatedAt + 1,
    };
    entries.set(saved.id, saved);
    return { ...saved };
  });
  // Only the store operations used by this bridge exist: no native SQLite,
  // browser, filesystem tool, PTY, model or provider process is constructed.
  const store = { getConversation, listNotebooks, saveNotebook } as unknown as DataStore;
  const context = await createWorkerNotebookContext({ store, conversationId: chat.id, cwd, userDataDir: root, browser: options.browser, piExtension: options.piExtension });
  contexts.push(context);
  const request = async (path: string, payload?: unknown, authenticated = true) => {
    const response = await fetch(context.env.HELLO_NOTEBOOK_BRIDGE_URL + path, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${context.env.HELLO_NOTEBOOK_BRIDGE_TOKEN}` } : {}),
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(3000),
    });
    return { status: response.status, body: await response.json() as BridgeReply };
  };
  const execute = async (name: string, args: Record<string, unknown>) => {
    const response = await request('/execute', { name, args, toolCallId: randomUUID() });
    return { ...response, value: response.body.result === undefined ? undefined : JSON.parse(response.body.result) };
  };
  return {
    root, cwd, chat, conversation: chat, entries, context, request, execute, saveNotebook,
    bridge: { context: async () => (await request('/context')).body.context ?? '{}' },
  };
}

describe('conversation-scoped CLI notebook connection', () => {
  it('exposes only list/status and denies unauthenticated requests and unrelated operations', async () => {
    const f = await fixture();
    expect((await f.request('/tools')).body.tools?.map(tool => tool.function.name).sort())
      .toEqual(['notebook_list', 'notebook_task_status']);
    expect((await f.request('/context', undefined, false)).status).toBe(403);
    for (const name of ['file_read', 'notebook_save', 'notebook_paths', 'shell']) {
      const response = await f.execute(name, { kind: 'tasks', path: '.', title: 'No', body: 'No' });
      expect(response.status).toBe(403);
    }
    expect(f.saveNotebook).not.toHaveBeenCalled();
  });

  it('reads live entries from this conversation and treats Runbook as read-only', async () => {
    const f = await fixture();
    const tasks = await f.execute('notebook_list', { kind: 'tasks' });
    expect(tasks.status).toBe(200);
    expect(tasks.value.map((entry: NotebookEntry) => entry.id)).toEqual(['task-a', 'task-b']);
    expect(tasks.value[0].tasks[0]).toEqual({
      line: 2, source: '- [ ] Audit entry points', text: 'Audit entry points', status: 'pending',
    });
    const runbook = await f.execute('notebook_list', { kind: 'runbook' });
    expect(runbook.value.map((entry: NotebookEntry) => entry.id)).toEqual(['reference']);
    const denied = await f.execute('notebook_task_status', {
      id: 'reference', line: 1, expectedLine: '- [ ] Reference is not an assigned task', status: 'done',
    });
    expect(denied.body.error).toMatch(/not found in this chat/i);
    expect(f.saveNotebook).not.toHaveBeenCalled();
    const before = f.entries.get('task-a')!;
    f.entries.set(before.id, { ...before, body: '- [ ] Added after CLI launch' });
    expect((await f.execute('notebook_list', { kind: 'tasks' })).value[0].body)
      .toBe('- [ ] Added after CLI launch');
  });

  it('does not list a Runbook chapter the human switched off; Tasks have no such switch', async () => {
    const f = await fixture();
    f.entries.set('reference', { ...f.entries.get('reference')!, shared: false });
    expect((await f.execute('notebook_list', { kind: 'runbook' })).value).toEqual([]);
    // Only a Runbook chapter has a switch (user, 29.09): Tasks are all there while the section is on.
    f.entries.set('task-b', { ...f.entries.get('task-b')!, shared: false });
    const tasks = await f.execute('notebook_list', { kind: 'tasks' });
    expect(tasks.value.map((entry: NotebookEntry) => entry.id)).toEqual(['task-a', 'task-b']);
    // The switch is the human's, not data for the worker.
    expect(tasks.value[0]).not.toHaveProperty('shared');
    const updated = await f.execute('notebook_task_status', { id: 'task-b', line: 2, expectedLine: '- [ ] Review assets', status: 'done' });
    expect(updated.status).toBe(200);
  });

  it('refuses a foreign entry and a mismatched line in another entry without touching either', async () => {
    const f = await fixture();
    const before = [...f.entries.values()].map(entry => ({ ...entry }));
    const foreign = await f.execute('notebook_task_status', {
      id: 'foreign-task', line: 1, expectedLine: '- [ ] Another conversation', status: 'done',
    });
    expect(foreign.body.error).toMatch(/not found in this chat/i);
    const wrongEntry = await f.execute('notebook_task_status', {
      id: 'task-b', line: 2, expectedLine: '- [ ] Audit entry points', status: 'done',
    });
    expect(wrongEntry.body.error).toMatch(/changed since you read/i);
    expect(f.saveNotebook).not.toHaveBeenCalled();
    expect([...f.entries.values()]).toEqual(before);
  });

  it('finds the task by its exact source when the line given is off, and says which line it was', async () => {
    const f = await fixture();
    const moved = await f.execute('notebook_task_status', { id: 'task-a', line: 1, expectedLine: '- [ ] Audit entry points', status: 'in_progress' });
    expect(moved.status).toBe(200);
    expect(moved.value.tasks[0].status).toBe('in_progress');
    expect(moved.value.note).toBe('Line 1 is not that task; line 2 is, and it was updated. Line numbers count every line of the entry from 1, headings and blank lines included.');
    const unnumbered = await f.execute('notebook_task_status', { id: 'task-a', expectedLine: '  - [ ] Check route ownership', status: 'done' });
    expect(unnumbered.body.error).toBeUndefined();
    expect(unnumbered.status).toBe(200);
    expect(unnumbered.value.note).toBeUndefined();
  });

  it('saves one exact task line to the store, rejects stale writes and preserves sibling tasks', async () => {
    const f = await fixture();
    const args = { id: 'task-a', line: 2, expectedLine: '- [ ] Audit entry points', status: 'in_progress' };
    const progress = await f.execute('notebook_task_status', args);
    expect(progress.status).toBe(200);
    expect(progress.value.tasks[0].status).toBe('in_progress');
    const stale = await f.execute('notebook_task_status', { ...args, status: 'done' });
    expect(stale.body.error).toMatch(/changed since you read/i);
    expect(f.saveNotebook).toHaveBeenCalledTimes(1);
    const done = await f.execute('notebook_task_status', {
      ...args, expectedLine: progress.value.tasks[0].source, status: 'done',
    });
    expect(done.status).toBe(200);
    expect(done.value.tasks[0].status).toBe('done');
    expect(f.entries.get('task-a')?.body)
      .toBe('# Work\n- [x] Audit entry points\n  - [ ] Check route ownership\n- [x] Existing done');
    expect(f.entries.get('task-b')?.body).toBe('# Other\n- [ ] Review assets');
    expect(f.saveNotebook).toHaveBeenCalledTimes(2);
  });

  it('returns both folder contexts and blocks writes after the chat folder changes', async () => {
    const f = await fixture();
    f.chat.folder = join(f.root, 'selected-later');
    const metadata = JSON.parse((await f.request('/context')).body.context!);
    expect(metadata).toMatchObject({
      conversationId: f.chat.id, launchFolder: f.cwd, selectedFolder: f.chat.folder, folderChanged: true,
    });
    expect((await f.execute('notebook_list', { kind: 'tasks' })).status).toBe(200);
    const denied = await f.execute('notebook_task_status', {
      id: 'task-a', line: 2, expectedLine: '- [ ] Audit entry points', status: 'done',
    });
    expect(denied.body.error).toMatch(/folder changed/i);
    expect(f.saveNotebook).not.toHaveBeenCalled();
  });

  it('allows an unset-folder chat launched in its home fallback to update its own Tasks', async () => {
    const f = await fixture({ folder: null });
    const metadata = JSON.parse((await f.request('/context')).body.context!);
    expect(metadata).toMatchObject({ launchFolder: f.cwd, selectedFolder: null, folderChanged: false });
    const changed = await f.execute('notebook_task_status', {
      id: 'task-a', line: 2, expectedLine: '- [ ] Audit entry points', status: 'blocked',
    });
    expect(changed.status).toBe(200);
    expect(changed.value.tasks[0].status).toBe('blocked');
    expect(f.saveNotebook).toHaveBeenCalledOnce();
  });

  it('writes a parseable passive helper without embedding the bridge credential', async () => {
    const f = await fixture();
    const helper = readFileSync(f.context.env.HELLO_NOTEBOOK_CLIENT, 'utf8');
    const instructions = readFileSync(f.context.instructionsPath, 'utf8');
    expect(() => new Script(helper, { filename: 'notebooks.cjs' })).not.toThrow();
    expect(helper).not.toContain(f.context.env.HELLO_NOTEBOOK_BRIDGE_TOKEN);
    expect(instructions).not.toContain(f.context.env.HELLO_NOTEBOOK_BRIDGE_TOKEN);
    expect(instructions).toContain('Wait for the human’s request');
    expect(instructions).toContain('does not assign or start work');
    expect(instructions).toContain('Do not guess tasks/todo.md');
    expect(instructions).toContain('Empty notebooks are valid');
    expect(instructions).toContain('"$HELLO_NOTEBOOK_RUNTIME" "$HELLO_NOTEBOOK_CLIENT"');
    if (process.platform !== 'win32') {
      expect(statSync(f.context.instructionsPath).mode & 0o777).toBe(0o600);
      expect(statSync(f.context.env.HELLO_NOTEBOOK_CLIENT).mode & 0o777).toBe(0o600);
    }
  });

  // A worker the chat prompts must be able to answer: the three channels are
  // written beside its instructions and named in them (user, 18.09).
  it('hands the worker its channels back to the chat, and tells it how to use them', async () => {
    const f = await fixture();
    const instructions = readFileSync(f.context.instructionsPath, 'utf8');
    for (const variable of ['HELLO_REPORT', 'HELLO_NOTE', 'HELLO_ASK'] as const) {
      expect(f.context.env[variable]).toBeDefined();
      expect(instructions).toContain(`sh "$${variable}"`);
      if (process.platform !== 'win32')
        expect(statSync(f.context.env[variable]).mode & 0o777).toBe(0o700);
    }
    expect(instructions).toContain('what you did, where, how it can be checked, and what is still to do');
    expect(instructions).toContain('--status blocked');
    expect(instructions).toContain('a conversation, not a task');
    // What a worker sends lands with whoever is listening for this pane.
    const heard: unknown[] = [];
    f.context.listen(report => { heard.push(report); });
    execFileSync('/bin/sh', [f.context.env.HELLO_REPORT], {
      env: { ...process.env, ...f.context.env }, input: 'built it', timeout: 10_000,
    });
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    expect(heard[0]).toMatchObject({ kind: 'report', status: 'done', text: 'built it' });
  });

  it('revokes access and removes session helper files on idempotent close', async () => {
    const f = await fixture();
    const directory = dirname(f.context.instructionsPath);
    expect((await f.request('/context')).status).toBe(200);
    await f.context.close();
    await f.context.close();
    expect(existsSync(directory)).toBe(false);
    await expect(f.request('/context')).rejects.toThrow();
  });
});

// What a worker is handed says nothing about the chat's title, and nothing
// about a shared page the human switched off (user, 20.09).
describe('what a CLI worker is told about this chat', () => {
  it('never carries the chat title, which is only what the human first typed', async () => {
    const f = await fixture();
    const context = JSON.parse(await f.bridge.context());
    expect(context.conversationId).toBe(f.conversation.id);
    expect(context).not.toHaveProperty('title');
    expect(JSON.stringify(context)).not.toContain(f.conversation.title);
    expect(f.context.instructions).not.toContain(f.conversation.title);
  });

  it('describes only the pages that are still there', async () => {
    const both = await fixture();
    expect(both.context.instructions).toContain('Shared Tasks and Runbook');
    expect(both.context.instructions).toContain('list tasks');

    const withoutTasks = await fixture({ tasks: false });
    expect(withoutTasks.context.instructions).toContain('Runbook');
    expect(withoutTasks.context.instructions).not.toMatch(/HELLO_NOTEBOOK_CLIENT" list tasks/);
    expect(withoutTasks.context.instructions).not.toContain('HELLO_TASK_STATUS');
    expect(withoutTasks.context.instructions).not.toContain('Read Tasks before');
    // The channels back to the chat are not a page and always stay.
    expect(withoutTasks.context.instructions).toContain('$HELLO_REPORT');

    const neither = await fixture({ runbook: false, tasks: false });
    expect(neither.context.instructions).not.toContain('Runbook');
    expect(neither.context.instructions).not.toMatch(/HELLO_NOTEBOOK_CLIENT" list/);
    expect(neither.context.instructions).not.toContain('Shared');
    expect(neither.context.instructions).toContain('$HELLO_REPORT');
  });
});

// Hello's browser, for a CLI (user, 30.09): it could not see it, and read the
// human's own Chrome through osascript instead. The chat's tools, this chat's
// tabs, each tab's Agent control — checked in main, as for the chat.
describe('Hello’s browser over the CLI connection', () => {
  const tab = (id: string, control: BrowserTab['control'], conversationId = 'chat-a'): BrowserTab => ({
    id, conversationId, title: `Page ${id}`, url: `https://example.test/${id}`, control, loading: false, progress: null, canGoBack: false, canGoForward: false,
  });
  // A 1x1 transparent PNG.
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const browserFake = () => {
    const clicks: string[] = [];
    const hooks: BrowserHooks = {
      getTabs: () => [tab('t-off', 'off'), tab('t-read', 'read'), tab('t-full', 'full'), tab('t-other', 'full', 'chat-b')],
      read: (_conversationId, id) => ({ title: `Page ${id}`, url: `https://example.test/${id}`, text: `Text of ${id}\nline two` }),
      navigate: () => undefined,
      click: (_conversationId, id) => { clicks.push(id); return 'Clicked.'; },
      type: () => undefined,
      scroll: () => undefined,
      screenshot: () => ({ frames: [{ mimeType: 'image/png', data: pixel, width: 1, height: 1 }], viewport: { width: 1, height: 1 } }),
    } as BrowserHooks;
    return { hooks, clicks };
  };
  const call = (f: Awaited<ReturnType<typeof fixture>>, name: string, args: Record<string, unknown>) =>
    f.request('/execute', { name, args, toolCallId: randomUUID() });

  it('offers the chat’s page tools and holds every call to the tab’s Agent control', async () => {
    const { hooks, clicks } = browserFake();
    const f = await fixture({ browser: hooks });
    const names = (await f.request('/tools')).body.tools?.map(tool => tool.function.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(['browser_tabs', 'browser_open', 'browser_read', 'browser_click', 'browser_screenshot', 'browser_show_html']));
    for (const absent of ['browser_pointer', 'browser_note', 'browser_download', 'shell', 'file_read']) expect(names).not.toContain(absent);
    // Only this chat's tabs.
    expect(JSON.parse((await call(f, 'browser_tabs', {})).body.result!).map((item: BrowserTab) => item.id)).toEqual(['t-off', 't-read', 't-full']);
    expect((await call(f, 'browser_read', { tabId: 't-other' })).body.error).toMatch(/not owned by this chat/);
    // Off reads nothing, Read reads but does not act, Full acts.
    expect((await call(f, 'browser_read', { tabId: 't-off' })).body.error).toMatch(/Agent control off/);
    expect((await call(f, 'browser_read', { tabId: 't-read' })).body.result).toContain('Text of t-read');
    expect((await call(f, 'browser_click', { tabId: 't-read', ref: 'e1' })).body.error).toMatch(/requires Full/);
    expect((await call(f, 'browser_click', { tabId: 't-full', ref: 'e1' })).status).toBe(200);
    expect(clicks).toEqual(['t-full']);
  });

  it('saves a screenshot where the CLI can open it, names the file, and hands a Pi the picture too', async () => {
    const f = await fixture({ browser: browserFake().hooks });
    const shot = await call(f, 'browser_screenshot', { tabId: 't-read' });
    const result = shot.body.result as unknown as { text: string; images: Array<{ data: string }> };
    expect(result.images.map(image => image.data)).toEqual([pixel]);
    const file = result.text.split('\n').find(line => line.endsWith('.png'))!;
    expect(dirname(dirname(file))).toBe(dirname(f.context.instructionsPath));
    expect(readFileSync(file).equals(Buffer.from(pixel, 'base64'))).toBe(true);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('is told as the only browser, and the client reaches it from a shell', async () => {
    const f = await fixture({ browser: browserFake().hooks });
    const instructions = readFileSync(f.context.instructionsPath, 'utf8');
    expect(instructions).toContain('## The browser in Hello');
    expect(instructions).toContain('do not script Chrome, Safari or any other app');
    // Another app's browser bridge is not this chat's browser (user, 30.09: another app's open_browser).
    expect(instructions).toContain('Browser tools of any other MCP server you may have');
    expect(instructions).toContain('browser read \'{"tabId":"TAB_ID"}\'');
    const run = (...args: string[]) => new Promise<{ stdout: string; stderr: string; code: number }>(resolve => {
      execFile(process.execPath, [f.context.env.HELLO_NOTEBOOK_CLIENT, ...args], {
        env: { PATH: process.env.PATH, HELLO_NOTEBOOK_BRIDGE_URL: f.context.env.HELLO_NOTEBOOK_BRIDGE_URL, HELLO_NOTEBOOK_BRIDGE_TOKEN: f.context.env.HELLO_NOTEBOOK_BRIDGE_TOKEN },
      }, (error, stdout, stderr) => resolve({ stdout, stderr, code: error ? Number((error as { code?: number }).code ?? 1) : 0 }));
    });
    const tabs = await run('browser', 'tabs');
    expect(tabs.code).toBe(0);
    expect(JSON.parse(tabs.stdout).map((item: BrowserTab) => item.id)).toEqual(['t-off', 't-read', 't-full']);
    // A page reads as text: a short header, then its words, never escaped JSON.
    const read = await run('browser', 'read', '{"tabId":"t-read"}');
    expect(read.stdout).toBe('title: Page t-read\nurl: https://example.test/t-read\n\nText of t-read\nline two\n');
    const denied = await run('browser', 'read', '{"tabId":"t-off"}');
    expect(denied.code).toBe(1);
    expect(denied.stderr).toMatch(/Agent control off/);
    const unknown = await run('browser', 'osascript');
    expect(unknown.stderr).toMatch(/^Usage: browser </);
    // A picture prints its saved path, never its pixels.
    const shot = await run('browser', 'screenshot', '{"tabId":"t-read"}');
    expect(shot.stdout).toMatch(/\.png\n$/);
    expect(shot.stdout).not.toContain(pixel);
  });

  it('passes on why a page refused, even when it was thrown as text', async () => {
    const { hooks } = browserFake();
    // How Electron hands over a page script's exception: its stack, as a string.
    hooks.click = () => { throw 'Error: No visible element shows "Apple iPad Air 11 M4". browser_read lists the visible controls with their words.\n    at find (<anonymous>:167:28)'; };
    const f = await fixture({ browser: hooks });
    const refused = await call(f, 'browser_click', { tabId: 't-full', label: 'Apple iPad Air 11 M4' });
    expect(refused.body.error).toBe('Error: No visible element shows "Apple iPad Air 11 M4". browser_read lists the visible controls with their words.\n    at find (<anonymous>:167:28)');
  });

  // The same connection as an MCP server, for Claude Code and Codex (user, 30.09).
  it('is an MCP server too: the same tools, the same refusals, pictures as images, and no secret in its files', async () => {
    const f = await fixture({ browser: browserFake().hooks });
    const mcp = f.context.mcp!;
    const config = readFileSync(mcp.config, 'utf8');
    expect(config).not.toContain(f.context.env.HELLO_NOTEBOOK_BRIDGE_TOKEN);
    expect(JSON.parse(config).mcpServers.hello).toEqual({
      type: 'stdio', command: process.execPath, args: [mcp.server],
      env: { ELECTRON_RUN_AS_NODE: '1', HELLO_NOTEBOOK_BRIDGE_URL: '${HELLO_NOTEBOOK_BRIDGE_URL}', HELLO_NOTEBOOK_BRIDGE_TOKEN: '${HELLO_NOTEBOOK_BRIDGE_TOKEN}' },
    });
    expect(readFileSync(mcp.server, 'utf8')).not.toContain(f.context.env.HELLO_NOTEBOOK_BRIDGE_TOKEN);
    if (process.platform !== 'win32') for (const file of [mcp.server, mcp.config]) expect(statSync(file).mode & 0o777).toBe(0o600);

    // Spoken to as a CLI speaks to it: JSON-RPC, a line each, on its stdin.
    const child = spawn(process.execPath, [mcp.server], {
      env: { PATH: process.env.PATH, HELLO_NOTEBOOK_BRIDGE_URL: f.context.env.HELLO_NOTEBOOK_BRIDGE_URL, HELLO_NOTEBOOK_BRIDGE_TOKEN: f.context.env.HELLO_NOTEBOOK_BRIDGE_TOKEN },
    });
    const waiting = new Map<number, (message: { result?: any; error?: any }) => void>();
    let buffer = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        waiting.get(message.id)?.(message);
      }
    });
    let next = 1;
    const ask = (method: string, params?: unknown) => new Promise<{ result?: any; error?: any }>(resolve => {
      const id = next++;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    try {
      const started = await ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      expect(started.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hello' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const listed = (await ask('tools/list')).result.tools as Array<{ name: string; inputSchema: { type: string } }>;
      expect(listed.map(tool => tool.name)).toEqual(expect.arrayContaining(['notebook_list', 'browser_read', 'browser_mark', 'browser_screenshot']));
      expect(listed.find(tool => tool.name === 'browser_read')?.inputSchema.type).toBe('object');
      const tabs = (await ask('tools/call', { name: 'browser_tabs', arguments: {} })).result;
      expect(JSON.parse(tabs.content[0].text).map((tab: BrowserTab) => tab.id)).toEqual(['t-off', 't-read', 't-full']);
      // Off refuses, as for the chat: the tool's answer, not a broken server.
      const refused = (await ask('tools/call', { name: 'browser_read', arguments: { tabId: 't-off' } })).result;
      expect(refused).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringMatching(/Agent control off/) }] });
      const shot = (await ask('tools/call', { name: 'browser_screenshot', arguments: { tabId: 't-read' } })).result;
      expect(shot.content[1]).toEqual({ type: 'image', data: pixel, mimeType: 'image/png' });
      expect((await ask('resources/list')).error).toMatchObject({ code: -32601 });
    } finally {
      child.stdin.end();
    }
  });

  it('offers a Pi CLI Hello’s extension on this connection, in the CLI role', async () => {
    const f = await fixture({ browser: browserFake().hooks, piExtension: '/app/out/main/pi-extension.js' });
    expect(f.context.piExtension).toEqual({ path: '/app/out/main/pi-extension.js', env: {
      HELLO_PI_BRIDGE_URL: f.context.env.HELLO_NOTEBOOK_BRIDGE_URL,
      HELLO_PI_BRIDGE_TOKEN: f.context.env.HELLO_NOTEBOOK_BRIDGE_TOKEN,
      HELLO_PI_EXTENSION_ROLE: 'cli',
    } });
    expect(readFileSync(f.context.instructionsPath, 'utf8')).toContain('a Pi opened from Hello has them');
  });

  it('without a browser, stays the notebook connection it was', async () => {
    const f = await fixture();
    expect((await f.request('/tools')).body.tools?.map(tool => tool.function.name).sort()).toEqual(['notebook_list', 'notebook_task_status']);
    expect(readFileSync(f.context.instructionsPath, 'utf8')).not.toContain('The browser in Hello');
  });
});
