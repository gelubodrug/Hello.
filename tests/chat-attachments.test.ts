import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PiRpcEvent, PiRpcProcessOptions, PiRpcPromptOptions } from '../src/main/chat/pi-rpc';

// These regression fixtures never launch a CLI or call a model endpoint.
const runtime = vi.hoisted(() => {
  class FakePi {
    isRunning = true;
    listeners = new Set<(event: PiRpcEvent) => void>();
    constructor(readonly options: PiRpcProcessOptions) { instances.push(this); }
    async start() {}
    async dispose() { this.isRunning = false; this.listeners.clear(); }
    subscribe(listener: (event: PiRpcEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    async respondToExtension() {}
    prompt = vi.fn(async (_text: string, _options?: PiRpcPromptOptions) => {
      if (failPrompt) { failPrompt = false; throw new Error('Fixture startup transport failure'); }
      return { type: 'response', command: 'prompt', success: true };
    });
    finish(text: string) {
      for (const listener of this.listeners) {
        listener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
        listener({ type: 'agent_settled' });
      }
    }
  }
  const instances: FakePi[] = [];
  let failPrompt = false;
  return { FakePi, instances, failNextPrompt() { failPrompt = true; }, reset() { instances.length = 0; failPrompt = false; } };
});
vi.mock('../src/main/chat/pi-rpc', () => ({ PiRpcProcess: runtime.FakePi }));
vi.mock('../src/main/chat/pi-tool-bridge', () => ({ createPiToolBridge: async () => ({
  ready: true, env: { HELLO_PI_BRIDGE_TOKEN: 'fixture-only' }, close: async () => {},
}) }));
vi.mock('../src/main/chat/pi-session', async importOriginal => {
  const original = await importOriginal<typeof import('../src/main/chat/pi-session')>();
  return { ...original, preparePiLaunch: async () => ({ command: 'fixture-only', args: [], cwd: '/unused-fixture' }) };
});
vi.mock('node:child_process', () => ({ spawn: () => { throw new Error('Real process execution is forbidden in this fixture.'); } }));

import { ATTACHMENT_LIMITS, ChatAttachments } from '../src/main/chat/attachments';
import { ChatService } from '../src/main/chat/service';
import { createDataStore, type DataStore } from '../src/main/data/store';

let directory: string;
let appData: string;
let files: ChatAttachments;
let store: DataStore | undefined;
let chat: ChatService | undefined;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
const conversationId = 'fixture-conversation';
function root(id = conversationId) { return join(appData, 'attachments', createHash('sha256').update(id).digest('hex')); }
function file(name: string, content: string | Buffer) { const path = join(directory, name); writeFileSync(path, content); return realpathSync(path); }
beforeEach(() => {
  runtime.reset();
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'hello-attachments-')));
  appData = join(directory, 'app-data'); mkdirSync(appData);
  files = new ChatAttachments(appData);
});
afterEach(async () => {
  await chat?.dispose(); chat = undefined;
  store?.close(); store = undefined;
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe('explicit chat attachment snapshots', () => {
  it('reads actual text/images, snapshots their bytes privately, and retains bindings across service restarts', async () => {
    const text = file('notes.md', '# Original notes\nUse these facts.');
    const image = file('screenshot.png', png);
    const result = await files.import(conversationId, [text, image]);
    expect(result.folder).toBeUndefined();
    expect(result.attachments.map(item => item.kind)).toEqual(['text', 'image']);
    expect(result.attachments[0]).not.toHaveProperty('path');
    writeFileSync(text, 'Changed source'); unlinkSync(image);
    const messageId = randomUUID();
    await files.bind(conversationId, messageId, result.attachments.map(item => item.id));
    const context = await new ChatAttachments(appData).forMessage(conversationId, messageId);
    expect(context.text).toContain('# Original notes');
    expect(context.text).not.toContain('Changed source');
    expect(context.text).toContain(image);
    expect(context.text).toContain(join(root(), result.attachments[1].id, 'content'));
    expect(context.text).toContain('originalPath');
    expect(context.text).toContain('snapshotPath');
    expect(context.text).toContain('untrusted source material');
    expect(context.images).toEqual([{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]);
    expect(statSync(root()).mode & 0o777).toBe(0o700);
    expect(statSync(join(root(), result.attachments[0].id, 'content')).mode & 0o777).toBe(0o600);
  });

  it('previews only this chat\u2019s own image snapshots, as a data URL and never a path', async () => {
    const image = file('capture.png', png);
    const [picture, notes] = (await files.import(conversationId, [image, file('notes.md', 'words')])).attachments;
    unlinkSync(image);
    expect(await files.preview(conversationId, picture.id)).toBe(`data:image/png;base64,${png.toString('base64')}`);
    await expect(files.preview(conversationId, notes.id)).rejects.toThrow('Only image attachments');
    await expect(files.preview('another-conversation', picture.id)).rejects.toThrow();
    await expect(files.preview(conversationId, image)).rejects.toThrow('valid attachments');
    await expect(files.preview(conversationId, '../../etc/passwd')).rejects.toThrow('valid attachments');
    writeFileSync(join(root(), picture.id, 'content'), Buffer.from('tampered'), { flag: 'r+' });
    await expect(files.preview(conversationId, picture.id)).rejects.toThrow();
  });

  // S209: a picture pasted from the clipboard, read by main, kept like a drop.
  it('keeps a pasted picture as a snapshot like a dropped one, under the same checks', async () => {
    const pasted = await files.importData(conversationId, [{ name: 'Pasted image 2026-10-05T12:00:00.000Z.png', bytes: png }]);
    expect(pasted.attachments).toEqual([expect.objectContaining({ kind: 'image', name: 'Pasted image 2026-10-05T12:00:00.000Z.png', size: png.length })]);
    const context = await files.context(conversationId, [pasted.attachments[0].id]);
    expect(context.images).toEqual([{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]);
    // It has no file of its own, and the model is told so rather than given a path.
    expect(context.text).toContain('(pasted from the clipboard)');
    await expect(files.importData(conversationId, [{ name: 'Pasted image.png', bytes: Buffer.from('not a picture') }])).rejects.toThrow('signature');
    await expect(files.importData(conversationId, [{ name: 'Pasted image.png', bytes: Buffer.alloc(5 * 1024 * 1024 + 1) }])).rejects.toThrow('too large');
    await expect(files.importData(conversationId, [])).rejects.toThrow('Paste 1–8');
  });

  it('returns only a canonical folder for a single directory and rejects mixed-folder drops', async () => {
    const folder = join(directory, 'project'); mkdirSync(folder);
    const alias = join(directory, 'project-alias'); symlinkSync(folder, alias);
    expect(await files.import(conversationId, [alias])).toEqual({ folder, attachments: [] });
    expect(existsSync(root())).toBe(false);
    await expect(files.import(conversationId, [folder, file('readme.md', 'text')])).rejects.toThrow('one folder by itself');
  });

  it('rejects unsupported PDFs, binary content, fake images and size/count overflows with actionable errors', async () => {
    await expect(files.import(conversationId, [file('report.pdf', '%PDF-1.4 fixture')])).rejects.toThrow('PDF attachments');
    await expect(files.import(conversationId, [file('archive.bin', Buffer.from([1, 0, 2]))])).rejects.toThrow('binary document');
    await expect(files.import(conversationId, [file('fake.png', 'plain text')])).rejects.toThrow('signature');
    await expect(files.import(conversationId, [file('huge.md', Buffer.alloc(ATTACHMENT_LIMITS.textFile + 1, 97))])).rejects.toThrow('128 KiB');
    await expect(files.import(conversationId, Array(9).fill('/tmp/example'))).rejects.toThrow('1–8');
    const largeTexts = Array.from({ length: 4 }, (_, index) => file(`${index}.txt`, Buffer.alloc(120 * 1024, 97)));
    await expect(files.import(conversationId, largeTexts)).rejects.toThrow('400 KiB');
    expect(existsSync(root())).toBe(false);
  });

  it('does not resolve attachment IDs from another chat, paths or duplicate IDs', async () => {
    const result = await files.import(conversationId, [file('private.txt', 'belongs here')]);
    const id = result.attachments[0].id;
    await expect(files.context('another-chat', [id])).rejects.toThrow();
    await expect(files.context(conversationId, ['../../private.txt'])).rejects.toThrow('valid attachments');
    await expect(files.context(conversationId, [id, id])).rejects.toThrow('twice');
  });

  it('rejects app-owned directories replaced by symlinks and content replaced by hardlinks', async () => {
    const source = file('private.txt', 'source bytes');
    const result = await files.import(conversationId, [source]);
    const content = join(root(), result.attachments[0].id, 'content');
    unlinkSync(content); linkSync(source, content);
    await expect(files.context(conversationId, [result.attachments[0].id])).rejects.toThrow('regular file');
    rmSync(root(), { recursive: true });
    const elsewhere = join(directory, 'unrelated'); mkdirSync(elsewhere);
    symlinkSync(elsewhere, root());
    await expect(files.import(conversationId, [source])).rejects.toThrow('not safe');
    await expect(files.removeConversation(conversationId)).rejects.toThrow('not safe');
    expect(existsSync(elsewhere)).toBe(true);
  });

  it('cancels pending imports and deletes only the chosen conversation snapshots', async () => {
    const source = file('input.txt', 'contents');
    const other = await files.import('other', [source]);
    const pending = files.import(conversationId, [source]);
    const rejected = expect(pending).rejects.toThrow('deleted');
    await files.removeConversation(conversationId);
    await rejected;
    expect(existsSync(root())).toBe(false);
    expect((await files.context('other', [other.attachments[0].id])).text).toContain('contents');
    const controller = new AbortController(); controller.abort(new Error('Fixture cancelled'));
    await expect(files.import(conversationId, [source], controller.signal)).rejects.toThrow('Fixture cancelled');
  });
});

function service() {
  store = createDataStore(appData, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  store.saveSettings({ endpointUrl: 'https://fixture.invalid/v1', model: 'fixture-model' });
  const id = store.createConversation().id;
  chat = new ChatService({ store, emit() {}, fetch: async () => { throw new Error('Real networking is forbidden in this fixture.'); } });
  return { chat, store, id };
}
async function prompted(index = 0) {
  await vi.waitFor(() => expect(runtime.instances[index]?.prompt).toHaveBeenCalledOnce());
  return runtime.instances[index];
}

describe('chat send/retry attachment delivery', () => {
  it('sends an image-only message to Pi as an image payload while keeping SQLite bubbles small', async () => {
    const { chat, store, id } = service();
    const imported = await chat.attach(id, [file('visual.png', png), file('facts.md', 'the actual file contents')]);
    const running = chat.send(id, '', imported.attachments.map(item => item.id));
    const pi = await prompted();
    const [prompt, options] = pi.prompt.mock.calls[0];
    expect(prompt).toContain('the actual file contents');
    expect(options?.images).toEqual([{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]);
    const user = store.listMessages(id).find(message => message.role === 'user')!;
    expect(user.content).toContain('visual.png');
    expect(user.content).not.toContain('the actual file contents');
    expect(JSON.stringify(user)).not.toContain(png.toString('base64'));
    expect(store.getConversation(id).folder).toBeNull();
    pi.finish('I can read the files.'); await running;
  });

  it('re-delivers original images and text after transport failure and a ChatService restart', async () => {
    const fixture = service();
    const result = await fixture.chat.attach(fixture.id, [file('visual.png', png), file('facts.txt', 'persisted attachment text')]);
    runtime.failNextPrompt();
    await fixture.chat.send(fixture.id, 'Examine these', result.attachments.map(item => item.id));
    expect(fixture.store.listMessages(fixture.id).at(-1)?.status).toBe('error');
    await fixture.chat.dispose();
    chat = new ChatService({ store: fixture.store, emit() {} });
    const retrying = chat.retry(fixture.id);
    const pi = await prompted(1);
    expect(pi.prompt.mock.calls[0][0]).toContain('persisted attachment text');
    expect(pi.prompt.mock.calls[0][1]?.images?.[0].data).toBe(png.toString('base64'));
    pi.finish('Recovered.'); await retrying;
    expect(fixture.store.listMessages(fixture.id).filter(message => message.role === 'user')).toHaveLength(1);
  });

  it('does not start two responses while attachment preparation yields', async () => {
    const { chat, store, id } = service();
    const result = await chat.attach(id, [file('facts.txt', 'contents')]);
    const selected = result.attachments.map(item => item.id);
    const first = chat.send(id, 'First', selected);
    const second = chat.send(id, 'Second', selected);
    const secondRejected = expect(second).rejects.toThrow(/active response|stopped before sending/);
    const pi = await prompted();
    await secondRejected;
    expect(store.listMessages(id).filter(message => message.role === 'user')).toHaveLength(1);
    expect(runtime.instances).toHaveLength(1);
    pi.finish('Complete.'); await first;
  });

  it('stops a send during preparation and removes snapshots on conversation deletion', async () => {
    const { chat, store, id } = service();
    const result = await chat.attach(id, [file('facts.txt', 'contents')]);
    const pending = chat.send(id, 'Do this', result.attachments.map(item => item.id));
    const rejected = expect(pending).rejects.toThrow('stopped before sending');
    await chat.stop(id); await rejected;
    expect(store.listMessages(id)).toEqual([]);
    expect(runtime.instances).toHaveLength(0);
    await chat.deleteSession(id);
    expect(existsSync(root(id))).toBe(false);
    await expect(chat.attach(id, [file('again.txt', 'no')])).rejects.toThrow('being deleted');
  });
});
