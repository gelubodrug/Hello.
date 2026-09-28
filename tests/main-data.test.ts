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

// Runbook and Tasks are switches too, but the other way round: they exist
// until the human takes one away, so only the departure is stored and every
// chat that already existed keeps both pages (user, 20.09).
describe('the shared pages of a chat', () => {
  it('starts with both, keeps what is switched off, and gives it back', () => {
    const chat = store.createConversation('Pages');
    expect(chat).toMatchObject({ runbook: true, tasks: true });
    expect(store.getConversation(chat.id)).toMatchObject({ runbook: true, tasks: true });

    expect(store.updateConversation(chat.id, { tasks: false })).toMatchObject({ runbook: true, tasks: false });
    expect(store.getConversation(chat.id).tasks).toBe(false);
    expect(store.listConversations().find(row => row.id === chat.id)?.tasks).toBe(false);
    // Another change does not disturb it.
    expect(store.updateConversation(chat.id, { title: 'Still off' }).tasks).toBe(false);

    expect(store.updateConversation(chat.id, { runbook: false, tasks: true }))
      .toMatchObject({ runbook: false, tasks: true });
    store.deleteConversation(chat.id);
    expect(store.createConversation('Fresh')).toMatchObject({ runbook: true, tasks: true });
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
    raw.exec(`ALTER TABLE browser_tabs DROP COLUMN control; ALTER TABLE browser_tabs DROP COLUMN source; DROP TABLE browser_downloads; ALTER TABLE messages DROP COLUMN model; PRAGMA user_version = 4;`);
    raw.close();
    store = createDataStore(directory, codec);
    expect(store.listBrowserTabs()).toMatchObject([{ id: 'kept', control: 'off' }]);
    store.saveBrowserTab({ id: 'kept', conversationId: chat.id, title: 'Kept', url: 'https://example.test',
      control: 'full', loading: false, progress: null, canGoBack: false, canGoForward: false });
    expect(store.listBrowserTabs()[0].control).toBe('full');
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
