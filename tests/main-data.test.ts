import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDataStore,
  type DataStore,
  type SecretCodec,
} from '../src/main/data/store';
import { updateTaskStatus } from '../src/main/chat/tasks';

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
      canGoBack: true,
      canGoForward: false,
    });
    expect(store.listConversations()[0].title).toBe('Renamed');
    expect(store.listMessages(conversation.id)[0].content).toBe('hello');
    expect(store.listBrowserTabs()[0].control).toBe('off');
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
    store.updateConversation(id, { folder: '/not/an/existing/repository' });
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
