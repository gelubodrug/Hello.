import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDataStore,
  type DataStore,
  type SecretCodec,
} from '../src/main/data/store';
import { updateTaskStatus } from '../src/main/chat/tasks';
import { snippetAround } from '../src/main/data/store';

// Test-only codec; production injects Electron safeStorage.
const codec: SecretCodec = {
  encrypt(value) {
    return Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0xa5));
  },
  decrypt(value) {
    return Buffer.from([...value].map((byte) => byte ^ 0xa5)).toString();
  },
};
let directory: string;
let store: DataStore;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hello-data-test-'));
  store = createDataStore(directory, codec);
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('new application persistence', () => {
  // User, 04.10 (the second design audit): cost lived only inside one chat's meter.
  it('adds up what replies cost and moved, by model and by chat, the costliest first', () => {
    const cheap = store.createConversation('Local work');
    const dear = store.createConversation('Cloud research');
    const reply = (id: string, conversationId: string, model: string, usage?: { input: number; output: number; cost?: number }) =>
      store.saveMessage({ id, conversationId, role: 'assistant', content: 'x', createdAt: 1, status: 'complete', model, ...(usage ? { usage } : {}) });
    reply('a', cheap.id, 'qwen-local', { input: 1000, output: 200 });
    reply('b', dear.id, 'anthropic/claude-sonnet-4.5', { input: 5000, output: 800, cost: 0.03 });
    reply('c', dear.id, 'anthropic/claude-sonnet-4.5', { input: 7000, output: 900, cost: 0.04 });
    reply('d', cheap.id, 'qwen-local');
    store.saveMessage({ id: 'u', conversationId: dear.id, role: 'user', content: 'q', createdAt: 1, status: 'complete' });
    const summary = store.usageSummary();
    expect(summary).toMatchObject({ replies: 3, input: 13_000, output: 1_900 });
    expect(summary.cost).toBeCloseTo(0.07);
    expect(summary.models.map(row => [row.model, row.replies])).toEqual([['anthropic/claude-sonnet-4.5', 2], ['qwen-local', 1]]);
    expect(summary.chats.map(row => row.title)).toEqual(['Cloud research', 'Local work']);
  });

  // User, 04.10: a reply's activity says how long it worked, across retries.
  it('keeps how long a reply worked, and keeps it through saves that do not say', () => {
    const conversation = store.createConversation('Work time');
    const reply = { id: 'r1', conversationId: conversation.id, role: 'assistant' as const, content: 'Done.', createdAt: 1, status: 'complete' as const };
    store.saveMessage({ ...reply, workedMs: 42_000 });
    expect(store.listMessages(conversation.id)[0].workedMs).toBe(42_000);
    store.saveMessage({ ...reply, status: 'streaming' });
    expect(store.listMessages(conversation.id)[0].workedMs).toBe(42_000);
  });

  it('creates, updates and cascades conversations/messages/notebooks/browser metadata', () => {
    const conversation = store.createConversation('Test');
    store.updateConversation(conversation.id, {
      title: 'Renamed',
      folder: directory,
    });
    store.saveMessage({
      id: 'm1',
      conversationId: conversation.id,
      role: 'user',
      content: 'hello',
      createdAt: 1,
      status: 'complete',
    });
    store.saveNotebook({
      conversationId: conversation.id,
      kind: 'tasks',
      title: 'Task',
      body: 'Do this.',
    });
    store.saveBrowserTab({
      id: 'tab1',
      conversationId: conversation.id,
      title: 'Page',
      url: 'https://example.test',
      control: 'full',
      loading: false,
      progress: null,
      canGoBack: true,
      canGoForward: false,
    });
    expect(store.listConversations()[0].title).toBe('Renamed');
    expect(store.listMessages(conversation.id)[0].content).toBe('hello');
    // The grant comes back with the page (user, 22.09).
    expect(store.listBrowserTabs()[0]).toMatchObject({ control: 'full', loading: false, progress: null, canGoBack: false });
    store.deleteConversation(conversation.id);
    expect(store.listConversations()).toEqual([]);
    expect(store.listBrowserTabs()).toEqual([]);
    expect(() => store.listMessages(conversation.id)).toThrow(/not found/);
  });
  it('preserves message order when timestamps collide and updates a message in place', () => {
    const id = store.createConversation().id;
    for (const name of ['z', 'a', 'b'])
      store.saveMessage({
        id: name,
        conversationId: id,
        role: 'assistant',
        content: name,
        createdAt: 1,
        status: 'complete',
      });
    store.saveMessage({
      id: 'a',
      conversationId: id,
      role: 'assistant',
      content: 'updated',
      createdAt: 1,
      status: 'complete',
    });
    expect(store.listMessages(id).map((message) => message.id)).toEqual([
      'z',
      'a',
      'b',
    ]);
    store.deleteMessagesAfter(id, 'a');
    expect(store.listMessages(id).map((message) => message.content)).toEqual([
      'z',
      'updated',
    ]);
  });
  it('persists structured thinking/tool parts and recovers an interrupted response', () => {
    const id = store.createConversation().id;
    store.saveMessage({
      id: 'response',
      conversationId: id,
      role: 'assistant',
      content: 'partial',
      parts: [
        { type: 'thinking', text: 'Checking' },
        {
          type: 'tool',
          id: 'tool',
          name: 'read',
          input: '{}',
          status: 'complete',
          output: 'ok',
        },
      ],
      createdAt: 1,
      status: 'streaming',
      usage: { input: 1, output: 2 },
    });
    store.close();
    store = createDataStore(directory, codec);
    const response = store.listMessages(id)[0];
    expect(response.status).toBe('error');
    expect(response.error).toMatch(/interrupted/);
    expect(response.parts?.[1]).toMatchObject({ type: 'tool', output: 'ok' });
    expect(response.usage).toEqual({ input: 1, output: 2 });
  });
  it('materializes separate empty exports, updates immediately and never writes to a repo', () => {
    const id = store.createConversation().id;
    store.updateConversation(id, { folder: '/not/an/existing/repository', runbook: true, tasks: true });
    const paths = store.notebookPaths(id);
    expect(paths.runbook.startsWith(directory + path.sep)).toBe(true);
    expect(readFileSync(paths.tasks, 'utf8')).toBe('');
    const entry = store.saveNotebook({
      conversationId: id,
      kind: 'tasks',
      title: 'First',
      body: '- [ ] Read the source',
    });
    expect(readFileSync(paths.tasks, 'utf8')).toContain(
      '- [ ] Read the source',
    );
    expect(readFileSync(paths.runbook, 'utf8')).toBe('');
    store.saveNotebook({ ...entry, body: '- [x] Read the source' });
    expect(readFileSync(paths.tasks, 'utf8')).toContain('- [x]');
    store.deleteNotebook(entry.id);
    expect(readFileSync(paths.tasks, 'utf8')).toBe('');
  });
  it('rejects notebook/message ownership changes', () => {
    const a = store.createConversation().id;
    const b = store.createConversation().id;
    const entry = store.saveNotebook({
      conversationId: a,
      kind: 'runbook',
      title: 'A',
      body: '',
    });
    expect(() => store.saveNotebook({ ...entry, conversationId: b })).toThrow(
      /another/,
    );
    store.saveMessage({
      id: 'm',
      conversationId: a,
      role: 'user',
      content: 'a',
      status: 'complete',
      createdAt: 1,
    });
    expect(() =>
      store.saveMessage({
        id: 'm',
        conversationId: b,
        role: 'user',
        content: 'b',
        status: 'complete',
        createdAt: 1,
      }),
    ).toThrow(/another/);
  });
  it('rejects a stale editor save after an external task completion', () => {
    const conversationId = store.createConversation().id;
    const original = store.saveNotebook({ conversationId, kind: 'tasks', title: 'Audit', body: '- [ ] Check entry points' });
    const completed = store.saveNotebook({ ...original,
      expectedUpdatedAt: original.updatedAt,
      body: updateTaskStatus(original.body, 1, '- [ ] Check entry points', 'done'),
    });

    expect(() => store.saveNotebook({ ...original, title: 'My unsaved title',
      expectedUpdatedAt: original.updatedAt,
    })).toThrow(/Notebook changed since/);
    expect(store.listNotebooks(conversationId, 'tasks')).toEqual([completed]);
    expect(completed.body).toBe('- [x] Check entry points');
  });
  it('gives saves distinct revisions even when the clock does not advance', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const conversationId = store.createConversation().id;
    const first = store.saveNotebook({ conversationId, kind: 'tasks', title: 'Plan', body: 'First' });
    const second = store.saveNotebook({ ...first, body: 'Second', expectedUpdatedAt: first.updatedAt });
    const third = store.saveNotebook({ ...second, body: 'Third', expectedUpdatedAt: second.updatedAt });
    expect([first.updatedAt, second.updatedAt, third.updatedAt]).toEqual([1_000, 1_001, 1_002]);
    expect(third.createdAt).toBe(first.createdAt);
    expect(() => store.saveNotebook({ ...first, expectedUpdatedAt: first.updatedAt })).toThrow(/Notebook changed since/);
  });
  it('notifies notebook subscribers without letting a broken listener invalidate commits', () => {
    const conversationId = store.createConversation().id;
    const broken = vi.fn(() => { throw new Error('Renderer unavailable'); });
    const changed = vi.fn();
    store.subscribeNotebooks(broken);
    const unsubscribe = store.subscribeNotebooks(changed);
    const entry = store.saveNotebook({ conversationId, kind: 'tasks', title: 'Plan', body: 'First' });
    const saved = store.saveNotebook({ ...entry, body: 'Second', expectedUpdatedAt: entry.updatedAt });
    expect(store.listNotebooks(conversationId, 'tasks')).toEqual([saved]);
    expect(changed.mock.calls).toEqual([
      [{ conversationId, kind: 'tasks' }], [{ conversationId, kind: 'tasks' }],
    ]);
    unsubscribe();
    expect(() => store.deleteNotebook(entry.id)).not.toThrow();
    expect(broken).toHaveBeenCalledTimes(3);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(store.listNotebooks(conversationId, 'tasks')).toEqual([]);
  });
  it('keeps committed saves and deletes successful when derived exports cannot be written', () => {
    const conversationId = store.createConversation().id;
    const entry = store.saveNotebook({ conversationId, kind: 'tasks', title: 'Plan', body: 'First' });
    const files = store.notebookPaths(conversationId);
    rmSync(files.tasks);
    mkdirSync(files.tasks); // A directory at the export filename produces a real I/O failure.
    const changed = vi.fn();
    store.subscribeNotebooks(changed);

    const saved = store.saveNotebook({ ...entry, body: 'Committed despite export failure', expectedUpdatedAt: entry.updatedAt });
    expect(store.listNotebooks(conversationId, 'tasks')).toEqual([saved]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(() => store.notebookPaths(conversationId)).toThrow();
    expect(() => store.deleteNotebook(entry.id)).not.toThrow();
    expect(store.listNotebooks(conversationId, 'tasks')).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenLastCalledWith({ conversationId, kind: 'tasks' });
  });
  it('encrypts secrets, scopes them to the endpoint and never returns them in settings', () => {
    const value = 'test-only-private-credential';
    const settings = store.saveSettings({
      endpointUrl: 'https://one.example/v1/',
      apiKey: value,
    });
    expect(settings.apiKeySet).toBe(true);
    expect(JSON.stringify(settings)).not.toContain(value);
    expect(store.getApiKey()).toBe(value);
    store.saveSettings({ endpointUrl: 'https://two.example/v1' });
    expect(store.getSettings().apiKeySet).toBe(false);
    expect(store.getApiKey()).toBe('');
    store.saveSettings({ endpointUrl: 'https://one.example/v1' });
    expect(store.getApiKey()).toBe(value);
    store.close();
    expect(
      readFileSync(path.join(directory, 'hello.sqlite')).includes(
        Buffer.from(value),
      ),
    ).toBe(false);
    store = createDataStore(directory, codec);
    store.saveSettings({ apiKey: '' });
    expect(store.getApiKey()).toBe('');
  });
  it('keeps several providers with their own keys, switches between them and forgets one with its key', () => {
    store.saveSettings({ endpointUrl: 'https://one.example/v1', model: 'one-model', apiKey: 'key-one' });
    store.rememberConnection('  Provider One  ');
    store.saveSettings({ endpointUrl: 'https://two.example/v1', model: 'two-model', apiKey: 'key-two' });
    store.rememberConnection('Provider Two');
    expect(store.getSettings().connections).toEqual([
      { name: 'Provider One', endpointUrl: 'https://one.example/v1', model: 'one-model', apiKeySet: true },
      { name: 'Provider Two', endpointUrl: 'https://two.example/v1', model: 'two-model', apiKeySet: true },
    ]);
    // Saving a model for the endpoint in use follows the entry that names it.
    store.saveSettings({ model: 'two-model-v2' });
    expect(store.getSettings().connections[1].model).toBe('two-model-v2');

    const back = store.useConnection('https://one.example/v1/');
    expect(back.endpointUrl).toBe('https://one.example/v1');
    expect(back.model).toBe('one-model');
    expect(back.apiKeySet).toBe(true);
    expect(store.getApiKey()).toBe('key-one');
    expect(() => store.forgetConnection('https://one.example/v1')).toThrow(/in use/);
    expect(() => store.rememberConnection('Provider Two')).toThrow(/already names/);

    store.useConnection('https://two.example/v1');
    const left = store.forgetConnection('https://one.example/v1');
    expect(left.connections.map(entry => entry.name)).toEqual(['Provider Two']);
    expect(store.getApiKey('https://one.example/v1')).toBe('');
    expect(store.getApiKey('https://two.example/v1')).toBe('key-two');
  });
  it('validates connection names, unknown endpoints and how many are kept', () => {
    expect(() => store.rememberConnection('   ')).toThrow(/name/i);
    expect(() => store.useConnection('https://missing.example/v1')).toThrow(/no longer saved/);
    expect(() => store.forgetConnection('https://missing.example/v1')).toThrow(/no longer saved/);
    for (let index = 0; index < 12; index += 1) {
      store.saveSettings({ endpointUrl: `https://host${index}.example/v1` });
      store.rememberConnection(`Provider ${index}`);
    }
    store.saveSettings({ endpointUrl: 'https://one-too-many.example/v1' });
    expect(() => store.rememberConnection('One too many')).toThrow(/at most 12/);
    // Renaming an endpoint already kept is not a new one.
    store.useConnection('https://host0.example/v1');
    expect(store.rememberConnection('Renamed').connections[0]).toMatchObject({ name: 'Renamed' });
    expect(store.getSettings().connections).toHaveLength(12);
  });
  it('fails closed if encryption fails and validates settings', () => {
    store.close();
    store = createDataStore(directory, {
      ...codec,
      encrypt() {
        throw new Error('Keychain unavailable');
      },
    });
    expect(() =>
      store.saveSettings({ apiKey: 'not-persisted', model: 'new' }),
    ).toThrow(/Keychain/);
    expect(store.getSettings().apiKeySet).toBe(false);
    expect(store.getSettings().model).toBe('');
    expect(() =>
      store.saveSettings({ endpointUrl: 'https://user:secret@example.test' }),
    ).toThrow(/credentials/);
    expect(() => store.saveSettings({ temperature: Number.NaN })).toThrow(
      /Temperature/,
    );
  });
});

// Plan is a switch in the composer, off until the human asks for it: absent
// from the settings table means off, so every chat that exists is already off.
describe('the Plan switch of a chat', () => {
  it('is off for a new chat, survives being turned on, and goes with the chat', () => {
    const chat = store.createConversation('Planned');
    expect(chat.planning).toBe(false);
    expect(store.getConversation(chat.id).planning).toBe(false);

    expect(store.updateConversation(chat.id, { planning: true }).planning).toBe(true);
    expect(store.getConversation(chat.id).planning).toBe(true);
    expect(store.listConversations().find(row => row.id === chat.id)?.planning).toBe(true);
    // A title change is not a planning change.
    expect(store.updateConversation(chat.id, { title: 'Still planned' }).planning).toBe(true);

    expect(store.updateConversation(chat.id, { planning: false }).planning).toBe(false);
    store.updateConversation(chat.id, { planning: true });
    store.deleteConversation(chat.id);
    expect(store.createConversation('Fresh').planning).toBe(false);
  });
});

// Each chat keeps the model it last used (user, 04.10: "nothing fancy").
describe('the model a chat runs on', () => {
  it('is none for a new chat, kept as picked or as a turn ran on it, and cleared on request', () => {
    const chat = store.createConversation('Mine');
    expect(chat.model).toBeUndefined();
    const picked = store.updateConversation(chat.id, { model: { endpointUrl: 'https://one.example/v1/', id: '  one-model ' } });
    expect(picked.model).toEqual({ endpointUrl: 'https://one.example/v1', id: 'one-model' });
    expect(store.getConversation(chat.id).model).toEqual({ endpointUrl: 'https://one.example/v1', id: 'one-model' });
    expect(store.listConversations().find(row => row.id === chat.id)?.model?.id).toBe('one-model');
    // A title change is not a model change.
    expect(store.updateConversation(chat.id, { title: 'Still mine' }).model?.id).toBe('one-model');

    // What a turn ran on is kept without moving the chat in the list.
    const before = store.getConversation(chat.id).updatedAt;
    store.rememberChatModel(chat.id, { endpointUrl: 'http://127.0.0.1:8000/v1', id: 'local-model' });
    expect(store.getConversation(chat.id)).toMatchObject({ updatedAt: before, model: { endpointUrl: 'http://127.0.0.1:8000/v1', id: 'local-model' } });

    expect(store.updateConversation(chat.id, { model: null }).model).toBeUndefined();
    expect(store.getConversation(chat.id).model).toBeUndefined();
    expect(() => store.updateConversation(chat.id, { model: { endpointUrl: 'not an address', id: 'm' } })).toThrow(/valid HTTP/);
    expect(() => store.updateConversation(chat.id, { model: { endpointUrl: 'https://one.example/v1', id: '  ' } })).toThrow(/Choose a model/);
  });

  it('goes with the chat, and with the connection it ran on', () => {
    store.saveSettings({ endpointUrl: 'https://one.example/v1', model: 'one-model', apiKey: 'key-one' });
    store.rememberConnection('Provider One');
    store.saveSettings({ endpointUrl: 'https://two.example/v1', model: 'two-model', apiKey: 'key-two' });
    const onOne = store.createConversation('On one');
    const onTwo = store.createConversation('On two');
    store.updateConversation(onOne.id, { model: { endpointUrl: 'https://one.example/v1', id: 'one-model' } });
    store.updateConversation(onTwo.id, { model: { endpointUrl: 'https://two.example/v1', id: 'two-model' } });

    // Its key went with the connection: the chat follows the selection again.
    store.forgetConnection('https://one.example/v1');
    expect(store.getConversation(onOne.id).model).toBeUndefined();
    expect(store.getConversation(onTwo.id).model?.id).toBe('two-model');

    store.deleteConversation(onTwo.id);
    const raw = new Database(store.databasePath, { readonly: true });
    try {
      expect(raw.prepare("SELECT COUNT(*) AS count FROM settings WHERE key LIKE 'chat-model:%'").get()).toEqual({ count: 0 });
    } finally {
      raw.close();
    }
  });
});

// Runbook and Tasks are switches like Plans: off in a new chat (user, 05.10),
// on only when switched on. A chat made while they started on keeps them.
describe('the shared pages of a chat', () => {
  it('starts with none, keeps what is switched on, and takes it away again', () => {
    const chat = store.createConversation('Pages');
    expect(chat).toMatchObject({ runbook: false, tasks: false });
    expect(store.getConversation(chat.id)).toMatchObject({ runbook: false, tasks: false });

    expect(store.updateConversation(chat.id, { tasks: true })).toMatchObject({ runbook: false, tasks: true });
    expect(store.getConversation(chat.id).tasks).toBe(true);
    expect(store.listConversations().find(row => row.id === chat.id)?.tasks).toBe(true);
    // Another change does not disturb it.
    expect(store.updateConversation(chat.id, { title: 'Still on' }).tasks).toBe(true);

    expect(store.updateConversation(chat.id, { runbook: true, tasks: false }))
      .toMatchObject({ runbook: true, tasks: false });
    store.deleteConversation(chat.id);
    expect(store.createConversation('Fresh')).toMatchObject({ runbook: false, tasks: false });
  });

  it('keeps both pages for a chat made while they started on, and what the person took away', () => {
    const kept = store.createConversation('Kept').id;
    const without = store.createConversation('Without tasks').id;
    store.close();
    // Roll the file back to how version 14 left these chats: no row meant on,
    // and only a page taken away was written, as off.
    const raw = new Database(store.databasePath);
    raw.exec(`DELETE FROM settings WHERE key LIKE 'chat-runbook:%' OR key LIKE 'chat-tasks:%';
      INSERT INTO settings(key, value) VALUES ('chat-tasks:${without}', 'off');
      PRAGMA user_version = 14;`);
    raw.close();
    store = createDataStore(directory, codec);
    expect(store.getConversation(kept)).toMatchObject({ runbook: true, tasks: true });
    expect(store.getConversation(without)).toMatchObject({ runbook: true, tasks: false });
    expect(store.createConversation('New')).toMatchObject({ runbook: false, tasks: false });
  });
});


// The grant the human set on a page is kept between sessions (user, 22.09).
describe('a browser tab’s grant between sessions', () => {
  it('is saved with the tab, read back, and never anything but off, read or full', () => {
    const chat = store.createConversation('Tabs');
    const base = { conversationId: chat.id, title: 'Billing', url: 'https://platform.example/billing',
      loading: false, progress: null, canGoBack: false, canGoForward: false } as const;
    store.saveBrowserTab({ ...base, id: 'full', control: 'full' });
    store.saveBrowserTab({ ...base, id: 'read', control: 'read' });
    store.saveBrowserTab({ ...base, id: 'off', control: 'off' });
    store.saveBrowserTab({ ...base, id: 'odd', control: 'admin' as never });
    const byId = Object.fromEntries(store.listBrowserTabs().map(tab => [tab.id, tab.control]));
    expect(byId).toMatchObject({ full: 'full', read: 'read', off: 'off', odd: 'off' });
    // Changing it later changes what comes back.
    store.saveBrowserTab({ ...base, id: 'full', control: 'off' });
    expect(store.listBrowserTabs().find(tab => tab.id === 'full')?.control).toBe('off');
  });

  it('is added to a database the previous version wrote, with every old tab Off', () => {
    const chat = store.createConversation('Old');
    store.saveBrowserTab({ id: 'kept', conversationId: chat.id, title: 'Kept', url: 'https://example.test',
      control: 'read', loading: false, progress: null, canGoBack: false, canGoForward: false });
    store.close();
    // Roll the file back to how version 4 left it: no control column at all.
    const raw = new Database(store.databasePath);
    raw.exec(`ALTER TABLE browser_tabs DROP COLUMN control; ALTER TABLE browser_tabs DROP COLUMN source; DROP TABLE browser_downloads; DROP TABLE browser_domain_notes; ALTER TABLE messages DROP COLUMN model; PRAGMA user_version = 4;`);
    raw.close();
    store = createDataStore(directory, codec);
    expect(store.listBrowserTabs()).toMatchObject([{ id: 'kept', control: 'off' }]);
    store.saveBrowserTab({ id: 'kept', conversationId: chat.id, title: 'Kept', url: 'https://example.test',
      control: 'full', loading: false, progress: null, canGoBack: false, canGoForward: false });
    expect(store.listBrowserTabs()[0].control).toBe('full');
  });
});

// What a chat learned about a site, kept for its next visit. The live page stays
// the truth; the note is a head start, it outlives the app run, and it belongs to
// the chat that wrote it — never to the application, and never to another chat.
describe('what a chat’s earlier visits learned about a site', () => {
  it('is kept per chat and site, replaced when corrected, cleared on request, and still there after a restart', () => {
    const chat = store.createConversation('Research').id;
    expect(store.getDomainNote(chat, 'docs.example')).toBeUndefined();
    store.saveDomainNote(chat, 'docs.example', 'Search is behind the menu, not the header.');
    store.saveDomainNote(chat, 'shop.example', 'Prices need the currency picker set first.');
    expect(store.getDomainNote(chat, 'docs.example')?.notes).toBe('Search is behind the menu, not the header.');
    expect(store.getDomainNote(chat, 'docs.example')?.updatedAt).toBeGreaterThan(0);
    // One note per site in a chat: writing again is how a wrong one is corrected.
    store.saveDomainNote(chat, 'docs.example', 'Search moved into the header.');
    expect(store.getDomainNote(chat, 'docs.example')?.notes).toBe('Search moved into the header.');
    // The app closing and opening again is not a reason to forget a site.
    store.close();
    store = createDataStore(directory, codec);
    expect(store.getDomainNote(chat, 'docs.example')?.notes).toBe('Search moved into the header.');
    expect(store.getDomainNote(chat, 'shop.example')?.notes).toBe('Prices need the currency picker set first.');
    store.deleteDomainNote(chat, 'docs.example');
    expect(store.getDomainNote(chat, 'docs.example')).toBeUndefined();
    expect(store.getDomainNote(chat, 'shop.example')?.notes).toBe('Prices need the currency picker set first.');
  });

  it('is not another chat’s to read, and goes when its own chat goes', () => {
    const mine = store.createConversation('Mine').id;
    const other = store.createConversation('Other').id;
    store.saveDomainNote(mine, 'intranet.example', 'The admin list is under /people, not /users.');
    // The same site, another chat: nothing, until that chat writes its own.
    expect(store.getDomainNote(other, 'intranet.example')).toBeUndefined();
    store.saveDomainNote(other, 'intranet.example', 'Reports need the year picker set first.');
    expect(store.getDomainNote(mine, 'intranet.example')?.notes).toBe('The admin list is under /people, not /users.');
    expect(store.getDomainNote(other, 'intranet.example')?.notes).toBe('Reports need the year picker set first.');
    // Deleting a chat takes its notes with it, and leaves the other chat's alone.
    store.deleteConversation(mine);
    expect(store.getDomainNote(mine, 'intranet.example')).toBeUndefined();
    expect(store.getDomainNote(other, 'intranet.example')?.notes).toBe('Reports need the year picker set first.');
    // A note cannot be written for a chat that does not exist.
    expect(() => store.saveDomainNote(mine, 'intranet.example', 'Anything.')).toThrow();
  });

  it('gives the note its chat on a database the previous version wrote, keeping no row that has none', () => {
    const chat = store.createConversation('Old').id;
    store.saveBrowserTab({ id: 'kept', conversationId: chat, title: 'Kept',
      url: 'https://example.test', control: 'read', loading: false, progress: null, canGoBack: false, canGoForward: false });
    store.close();
    // Roll the file back to how version 9 left it: one note per site, for the
    // whole application, with a row already written under that shape.
    const raw = new Database(store.databasePath);
    raw.exec(`DROP TABLE browser_domain_notes;
      CREATE TABLE browser_domain_notes (domain TEXT PRIMARY KEY, notes TEXT NOT NULL, updatedAt INTEGER NOT NULL);
      INSERT INTO browser_domain_notes(domain,notes,updatedAt) VALUES ('shared.example','Written when notes were the application''s.',1);
      PRAGMA user_version = 9;`);
    raw.close();
    store = createDataStore(directory, codec);
    // The tab is untouched, and the row that had no chat is gone rather than
    // handed to one: which chat wrote it is the one thing that cannot be guessed.
    expect(store.listBrowserTabs()).toMatchObject([{ id: 'kept', control: 'read' }]);
    expect(store.getDomainNote(chat, 'shared.example')).toBeUndefined();
    const check = new Database(store.databasePath, { readonly: true });
    expect(check.pragma('user_version', { simple: true }) as number).toBe(15);
    expect((check.prepare('SELECT COUNT(*) AS rows FROM browser_domain_notes').get() as { rows: number }).rows).toBe(0);
    check.close();
    // And the new shape works on that same file.
    store.saveDomainNote(chat, 'example.test', 'The login is on /account, not /login.');
    expect(store.getDomainNote(chat, 'example.test')?.notes).toBe('The login is on /account, not /login.');
  });
});

// A chat's downloads are kept between sessions, like a browser's list; one
// still saving when the app closed was not saved (user, 24.09).
describe('a chat’s downloads between sessions', () => {
  it('are saved, listed, updated, deleted, gone with the chat, and marked failed when the app closed on them', () => {
    const chat = store.createConversation('Invoices');
    const base = { conversationId: chat.id, name: 'invoice.pdf', path: '/chat/invoice.pdf', url: 'https://billing.example/i/1/pdf',
      mimeType: 'application/pdf', startedAt: 10 } as const;
    store.saveBrowserDownload({ ...base, id: 'a', state: 'saved', bytes: 1234, total: 1234, finishedAt: 12, tabId: 'tab-1' });
    store.saveBrowserDownload({ ...base, id: 'b', name: 'big.zip', path: '/chat/big.zip', state: 'saving', bytes: 300, total: 9000, startedAt: 20 });
    expect(store.listBrowserDownloads()).toEqual([
      { ...base, id: 'a', state: 'saved', bytes: 1234, total: 1234, finishedAt: 12, tabId: 'tab-1' },
      { ...base, id: 'b', name: 'big.zip', path: '/chat/big.zip', state: 'saving', bytes: 300, total: 9000, startedAt: 20 },
    ]);
    store.saveBrowserDownload({ ...base, id: 'a', state: 'saved', bytes: 1234, total: 1234, finishedAt: 12, tabId: 'tab-1', reason: undefined });
    store.deleteBrowserDownload('a');
    expect(store.listBrowserDownloads().map(download => download.id)).toEqual(['b']);
    expect(() => store.saveBrowserDownload({ ...base, id: 'c', conversationId: 'nowhere', state: 'saved' })).toThrow();
    store.close();
    store = createDataStore(directory, codec);
    expect(store.listBrowserDownloads()).toMatchObject([{ id: 'b', state: 'failed', reason: 'interrupted when the application closed', finishedAt: expect.any(Number) }]);
    store.deleteConversation(chat.id);
    expect(store.listBrowserDownloads()).toEqual([]);
  });
});

// A restart is remembered on the chat, and goes with it (user, 24.09).
describe('a chat restarted', () => {
  it('remembers from when the model starts fresh, keeps every message, and forgets it with the chat', () => {
    const chat = store.createConversation('Invoices');
    store.saveMessage({ id: 'before', conversationId: chat.id, role: 'user', content: 'before', status: 'complete', createdAt: 1 });
    expect(store.getConversation(chat.id).freshFrom).toBeUndefined();
    expect(store.restartConversation(chat.id, 12_345)).toMatchObject({ id: chat.id, freshFrom: 12_345 });
    expect(store.listConversations().find(item => item.id === chat.id)?.freshFrom).toBe(12_345);
    expect(store.listMessages(chat.id).map(message => message.content)).toEqual(['before']);
    expect(store.restartConversation(chat.id, 20_000).freshFrom).toBe(20_000);
    expect(() => store.restartConversation('nowhere')).toThrow();
    store.deleteConversation(chat.id);
    const again = store.createConversation('Fresh');
    expect(again.freshFrom).toBeUndefined();
  });
});

// Reset: the chat empty as new, its tools kept (user, 24.09: "Reset chat să-l
// încarce fresh fără nici un context vechi" — without losing the tabs).
describe('a chat reset', () => {
  it('deletes messages, queue, restart mark and — with notes — Runbook and Tasks; keeps tabs, downloads, switches, folder and title', () => {
    const chat = store.createConversation('Invoices');
    store.updateConversation(chat.id, { chatMode: 'coder', planning: true, runbook: false });
    const notes = vi.fn();
    store.subscribeNotebooks(notes);
    store.saveMessage({ id: 'm1', conversationId: chat.id, role: 'user', content: 'download them', status: 'complete', createdAt: 1 });
    store.queueMessage(chat.id, 'and then X', 'next');
    store.saveNotebook({ conversationId: chat.id, kind: 'tasks', title: 'Plan', body: '- [ ] Neon' });
    store.saveNotebook({ conversationId: chat.id, kind: 'runbook', title: 'Logins', body: 'Use SSO' });
    store.saveBrowserTab({ id: 'tab', conversationId: chat.id, title: 'Billing', url: 'https://console.neon.tech/billing',
      control: 'full', loading: false, progress: null, canGoBack: false, canGoForward: false });
    store.saveBrowserDownload({ id: 'd', conversationId: chat.id, name: 'inv.pdf', state: 'saved', startedAt: 1 });
    store.restartConversation(chat.id, 5);
    // Without notes first: the notebooks stay.
    const kept = store.resetConversation(chat.id, { notes: false });
    expect(kept).toMatchObject({ id: chat.id, title: 'Invoices', chatMode: 'coder', planning: true, runbook: false });
    expect(kept.freshFrom).toBeUndefined();
    expect(store.listMessages(chat.id)).toEqual([]);
    expect(store.listQueued(chat.id)).toEqual([]);
    expect(store.listNotebooks(chat.id, 'tasks')).toHaveLength(1);
    notes.mockClear();
    store.resetConversation(chat.id, { notes: true });
    expect(store.listNotebooks(chat.id, 'tasks')).toEqual([]);
    expect(store.listNotebooks(chat.id, 'runbook')).toEqual([]);
    expect(notes).toHaveBeenCalledWith({ conversationId: chat.id, kind: 'runbook' });
    expect(notes).toHaveBeenCalledWith({ conversationId: chat.id, kind: 'tasks' });
    // The tools stay.
    expect(store.listBrowserTabs().map(tab => tab.id)).toEqual(['tab']);
    expect(store.listBrowserDownloads().map(download => download.id)).toEqual(['d']);
    expect(() => store.resetConversation('nowhere', { notes: true })).toThrow();
  });
});

// Search in what was said (user, 28.09 plan: "Full-text search în mesaje").
describe('searching messages', () => {
  it('finds the words in any chat, newest first, three per chat at most, with the words around them', () => {
    const a = store.createConversation('Invoices');
    const b = store.createConversation('Travel');
    const say = (conversationId: string, id: string, content: string, createdAt: number, role: 'user' | 'assistant' = 'assistant') =>
      store.saveMessage({ id, conversationId, role, content, status: 'complete', createdAt });
    for (let index = 0; index < 5; index += 1) say(a.id, `a${index}`, `Neon invoice number ${index} was saved to Downloads.`, 10 + index);
    say(b.id, 'b1', 'The flight from Genova leaves at 7; no invoice needed.', 100, 'user');
    say(b.id, 'b2', 'Nothing to see here.', 101);
    const found = store.searchMessages('INVOICE');
    expect(found.map(match => match.messageId)).toEqual(['b1', 'a4', 'a3', 'a2']);
    expect(found[0]).toMatchObject({ conversationId: b.id, role: 'user', snippet: 'The flight from Genova leaves at 7; no invoice needed.' });
    expect(store.searchMessages('i')).toEqual([]);
    // LIKE's own characters are words here, not wildcards.
    say(b.id, 'b3', 'Progress is 100% done_now.', 102);
    expect(store.searchMessages('0% done_').map(match => match.messageId)).toEqual(['b3']);
    expect(store.searchMessages('%').length).toBe(0);
    expect(store.searchMessages('_n').map(match => match.messageId)).toEqual(['b3']);
  });

  it('cuts the snippet around the first match, on one line', () => {
    const long = `${'lorem '.repeat(30)}the Billing tab\nis on the left ${'ipsum '.repeat(30)}`;
    const snippet = snippetAround(long, 'billing');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain('the Billing tab is on the left');
    expect(snippetAround('short text', 'absent')).toBe('short text');
  });
});

// One notebook, three sections, a switch per chapter (user, 29.09).
describe('the notebook’s sections and chapter switches', () => {
  it('moves the plan out of Tasks on a database the previous version wrote, and turns every chapter on', () => {
    const chat = store.createConversation('Old').id;
    store.close();
    // Roll the file back to how version 10 left it: two kinds, no switch.
    const raw = new Database(store.databasePath);
    raw.exec(`DROP TABLE notebooks;
      CREATE TABLE notebooks (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('runbook','tasks')),
        title TEXT NOT NULL, body TEXT NOT NULL,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE INDEX notebooks_conversation ON notebooks(conversationId, kind, createdAt);
      INSERT INTO notebooks VALUES ('plan-1','${chat}','tasks','Plan','- [ ] **In progress** — Wire it',1,5);
      INSERT INTO notebooks VALUES ('tasks-1','${chat}','tasks','Sprint','- [ ] Ship',2,6);
      INSERT INTO notebooks VALUES ('runbook-1','${chat}','runbook','Setup','Use pnpm.',3,7);
      PRAGMA user_version = 10;`);
    raw.close();
    store = createDataStore(directory, codec);
    expect(store.listNotebooks(chat, 'plan')).toMatchObject([{ id: 'plan-1', title: 'Plan', updatedAt: 5, shared: true }]);
    expect(store.listNotebooks(chat, 'tasks').map(row => row.id)).toEqual(['tasks-1']);
    expect(store.listNotebooks(chat, 'runbook')).toMatchObject([{ id: 'runbook-1', shared: true }]);
  });

  it('switches a chapter without touching its words or revision, and a save never moves the switch', () => {
    const chat = store.createConversation('Chat').id;
    const saved = store.saveNotebook({ conversationId: chat, kind: 'runbook', title: 'Setup', body: 'Use pnpm.' });
    expect(saved.shared).toBe(true);
    const off = store.shareNotebook(saved.id, false);
    expect(off).toMatchObject({ id: saved.id, shared: false, updatedAt: saved.updatedAt, body: 'Use pnpm.' });
    // A draft opened before the switch still saves against the same revision.
    const edited = store.saveNotebook({ id: saved.id, conversationId: chat, kind: 'runbook', title: 'Setup', body: 'Use pnpm 10.', expectedUpdatedAt: saved.updatedAt });
    expect(edited.shared).toBe(false);
    expect(store.listNotebooks(chat, 'runbook')[0]).toMatchObject({ body: 'Use pnpm 10.', shared: false });
    expect(() => store.shareNotebook('missing', true)).toThrow('Notebook entry not found.');
  });

  it('empties a section’s export while it is off, and forgets every export with the chat', () => {
    const chat = store.createConversation('Chat').id;
    store.saveNotebook({ conversationId: chat, kind: 'tasks', title: 'Sprint', body: '- [ ] Ship' });
    store.updateConversation(chat, { planning: true });
    store.saveNotebook({ conversationId: chat, kind: 'plan', title: 'Plan', body: '- [ ] Step' });
    const paths = store.notebookPaths(chat);
    store.updateConversation(chat, { tasks: false });
    expect(readFileSync(paths.tasks, 'utf8')).toBe('');
    store.updateConversation(chat, { tasks: true });
    expect(readFileSync(paths.tasks, 'utf8')).toBe('# Sprint\n\n- [ ] Ship\n');
    const heard: string[] = [];
    store.subscribeNotebooks(change => heard.push(change.kind));
    store.resetConversation(chat, { notes: true });
    expect(heard.sort()).toEqual(['plan', 'runbook', 'tasks']);
    store.saveNotebook({ conversationId: chat, kind: 'plan', title: 'Plan', body: '- [ ] Again' });
    store.deleteConversation(chat);
    for (const file of Object.values(paths)) expect(() => readFileSync(file)).toThrow();
  });

  it('exports for workers only the chapters that are on, the plan included', () => {
    const chat = store.createConversation('Chat').id;
    store.updateConversation(chat, { runbook: true });
    store.saveNotebook({ conversationId: chat, kind: 'runbook', title: 'Shared', body: 'Visible.' });
    store.updateConversation(chat, { planning: true });
    const hidden = store.saveNotebook({ conversationId: chat, kind: 'runbook', title: 'Private', body: 'Not for workers.' });
    store.saveNotebook({ conversationId: chat, kind: 'plan', title: 'Plan', body: '- [ ] Step' });
    store.shareNotebook(hidden.id, false);
    const paths = store.notebookPaths(chat);
    expect(readFileSync(paths.runbook, 'utf8')).toBe('# Shared\n\nVisible.\n');
    expect(readFileSync(paths.plan, 'utf8')).toBe('# Plan\n\n- [ ] Step\n');
  });
});

describe('the model for subagents, in Settings', () => {
  it('is kept for its connection, cleared with an empty value, and dropped when the connection changes', () => {
    store.saveSettings({ endpointUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-27b' });
    expect(store.saveSettings({ subagentModel: ' google/gemini-3-flash:free ' }).subagentModel).toBe('google/gemini-3-flash:free');
    expect(store.saveSettings({ model: 'another/model' }).subagentModel).toBe('google/gemini-3-flash:free');
    expect(store.saveSettings({ subagentModel: '' }).subagentModel).toBeUndefined();
    store.saveSettings({ subagentModel: 'google/gemini-3-flash:free' });
    expect(store.saveSettings({ endpointUrl: 'http://127.0.0.1:18090/v1' }).subagentModel).toBeUndefined();
  });
});

// The marks an agent left stay with their tab, page by page (user, 30.09).
describe('marks kept with a tab', () => {
  it('come back with the tab, each page its own — and the first version, one page, is read too', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hello-marks-'));
    try {
      const codec = { encrypt: (text: string) => Buffer.from(text), decrypt: (bytes: Buffer) => bytes.toString() };
      let marksStore = createDataStore(dir, codec);
      const chat = marksStore.createConversation('Marks');
      const pages = [
        { url: 'https://www.ebay.com/sch/i.html?_nkw=ipad', marks: [{ n: 1, note: 'Cheapest: $499.95', x: 40, y: 1300, width: 320, height: 90, path: '#item1' }] },
        { url: 'https://www.ebay.com/itm/1', marks: [{ n: 1, note: 'Seller rating', x: 10, y: 400, width: 100, height: 20 }] },
      ];
      marksStore.saveBrowserTab({ id: 'ebay', conversationId: chat.id, title: 'eBay', url: pages[1].url, control: 'off', loading: false, progress: null, canGoBack: false, canGoForward: false, marks: pages });
      marksStore.close();
      // One page, as the first version of the column wrote it.
      const raw = new Database(path.join(dir, 'hello.sqlite'));
      raw.prepare("INSERT INTO browser_tabs(id,conversationId,title,url,control,marks) VALUES ('old',?,'Old','https://example.test/','off',?)")
        .run(chat.id, JSON.stringify({ url: 'https://example.test/', marks: [{ n: 1, note: 'here', x: 1, y: 2, width: 3, height: 4 }] }));
      raw.close();
      marksStore = createDataStore(dir, codec);
      const tabs = marksStore.listBrowserTabs();
      expect(tabs.find(tab => tab.id === 'ebay')?.marks).toEqual(pages);
      expect(tabs.find(tab => tab.id === 'old')?.marks).toEqual([{ url: 'https://example.test/', marks: [{ n: 1, note: 'here', x: 1, y: 2, width: 3, height: 4 }] }]);
      marksStore.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

