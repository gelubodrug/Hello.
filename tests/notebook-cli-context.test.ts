import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Script } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, NotebookEntry, NotebookKind } from '../src/shared/types';
import type { DataStore } from '../src/main/data/store';
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

async function fixture(folder?: string | null) {
  const root = mkdtempSync(join(tmpdir(), 'hello-cli-notebooks-test-'));
  roots.push(root);
  const cwd = folder ?? join(root, 'home');
  const chat: Conversation = {
    id: 'chat-a', title: 'Selected chat', folder: folder === null ? null : cwd,
    createdAt: 1, updatedAt: 1,
  };
  const makeEntry = (id: string, conversationId: string, kind: NotebookKind, body: string): NotebookEntry => ({
    id, conversationId, kind, title: id, body, createdAt: 1, updatedAt: 1,
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
  const context = await createWorkerNotebookContext({ store, conversationId: chat.id, cwd, userDataDir: root });
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
  return { root, cwd, chat, entries, context, request, execute, saveNotebook };
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
    const f = await fixture(null);
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
