import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HtmlArtifacts, MAX_HTML_ARTIFACT_BYTES } from '../src/main/browser/html-artifacts';

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open) };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

let root: string;
let dataDir: string;
let artifacts: HtmlArtifacts;
const hash = (conversation: string) => createHash('sha256').update(conversation).digest('hex');
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hello-html-artifacts-'));
  dataDir = join(root, 'app-data');
  artifacts = new HtmlArtifacts(dataDir);
  vi.mocked(open).mockImplementation(actualFs.open);
});
afterEach(async () => {
  vi.mocked(open).mockReset();
  await rm(root, { recursive: true, force: true });
});

describe('app-owned conversation HTML artifacts', () => {
  it('persists UTF-8 HTML without a workspace and reopens it after store reconstruction', async () => {
    const html = '<!doctype html><title>Vremea</title><p>București — 17°C</p>';
    const output = await artifacts.create('chat-a', html);
    expect(output.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(output.folder).toBe(join(await actualFs.realpath(dataDir), 'artifacts', hash('chat-a'), output.id));
    expect(output.path).toBe(join(output.folder, 'index.html'));
    expect(await readFile(output.path, 'utf8')).toBe(html);
    expect(await new HtmlArtifacts(dataDir).get('chat-a', output.id)).toEqual(output);
    for (const folder of [dirname(dirname(output.folder)), dirname(output.folder), output.folder])
      expect((await lstat(folder)).mode & 0o777).toBe(0o700);
    expect((await lstat(output.path)).mode & 0o777).toBe(0o600);
  });

  it('isolates conversations and concurrent artifacts without overwriting previous output', async () => {
    const [first, second, other] = await Promise.all([
      artifacts.create('chat-a', '<p>first</p>'), artifacts.create('chat-a', '<p>second</p>'),
      artifacts.create('chat-b', '<p>other</p>'),
    ]);
    expect(first.id).not.toBe(second.id);
    await expect(artifacts.get('chat-b', first.id)).rejects.toThrow();
    await artifacts.removeConversation('chat-a');
    await expect(artifacts.get('chat-a', first.id)).rejects.toThrow();
    await expect(artifacts.get('chat-a', second.id)).rejects.toThrow();
    expect(await artifacts.get('chat-b', other.id)).toEqual(other);
    expect(await readFile(other.path, 'utf8')).toBe('<p>other</p>');
    await artifacts.removeConversation('chat-a');
    const recreated = await artifacts.create('chat-a', '<p>new</p>');
    expect(await artifacts.get('chat-a', recreated.id)).toEqual(recreated);
  });

  it('uses a fixed hashed owner directory even for path-like conversation IDs', async () => {
    const owner = '../../outside';
    const output = await artifacts.create(owner, '<p>contained</p>');
    expect(dirname(output.folder)).toBe(join(await actualFs.realpath(dataDir), 'artifacts', hash(owner)));
    for (const id of ['../index.html', '../../outside', '/tmp/output', output.id + '/..', output.id.toUpperCase()])
      await expect(artifacts.get(owner, id)).rejects.toThrow(/Invalid/);
    expect(await artifacts.get(owner, output.id)).toEqual(output);
  });

  it('validates the UTF-8 byte limit before creating files', async () => {
    for (const html of ['', ' \n\t', 'x'.repeat(MAX_HTML_ARTIFACT_BYTES + 1), 'é'.repeat(MAX_HTML_ARTIFACT_BYTES / 2 + 1)])
      await expect(artifacts.create('chat-a', html)).rejects.toThrow(/content|limit/i);
    await expect(lstat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
    const output = await artifacts.create('chat-a', 'é'.repeat(MAX_HTML_ARTIFACT_BYTES / 2));
    expect((await lstat(output.path)).size).toBe(MAX_HTML_ARTIFACT_BYTES);
  });

  it('cleans an unpublished artifact if cancellation arrives after opening the file', async () => {
    const controller = new AbortController();
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actualFs.open(...args);
      controller.abort(new Error('Stopped by user.'));
      return handle;
    });
    await expect(artifacts.create('chat-a', '<p>cancelled</p>', controller.signal)).rejects.toThrow('Stopped by user.');
    const owner = join(dataDir, 'artifacts', hash('chat-a'));
    expect(await readdir(owner)).toEqual([]);
    const next = await artifacts.create('chat-a', '<p>next</p>');
    expect(await artifacts.get('chat-a', next.id)).toEqual(next);
  });

  it('never publishes queued output after conversation deletion, including a write already in progress', async () => {
    let reached!: () => void;
    const opened = new Promise<void>(resolve => { reached = resolve; });
    let resume!: () => void;
    const held = new Promise<void>(resolve => { resume = resolve; });
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actualFs.open(...args);
      reached();
      await held;
      return handle;
    });
    const writing = artifacts.create('chat-a', '<p>must not publish</p>');
    const queued = artifacts.create('chat-a', '<p>nor this one</p>');
    const writingRejected = expect(writing).rejects.toThrow(/deleted/);
    const queuedRejected = expect(queued).rejects.toThrow(/deleted/);
    await opened;
    const deleting = artifacts.removeConversation('chat-a');
    resume();
    await Promise.all([writingRejected, queuedRejected, deleting]);
    await expect(lstat(join(dataDir, 'artifacts', hash('chat-a')))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans only its new artifact directory after a write failure', async () => {
    const first = await artifacts.create('chat-a', '<p>keep</p>');
    vi.mocked(open).mockRejectedValueOnce(new Error('Disk full.'));
    await expect(artifacts.create('chat-a', '<p>failed</p>')).rejects.toThrow('Disk full.');
    expect(await readdir(dirname(first.folder))).toEqual([first.id]);
    expect(await readFile(first.path, 'utf8')).toBe('<p>keep</p>');
  });

  it('rejects artifact-directory and index-file symlinks without touching their targets', async () => {
    const output = await artifacts.create('chat-a', '<p>original</p>');
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'index.html'), '<p>outside</p>');
    await rm(output.path);
    await symlink(join(outside, 'index.html'), output.path);
    await expect(artifacts.get('chat-a', output.id)).rejects.toThrow();
    await rm(output.folder, { recursive: true });
    await symlink(outside, output.folder);
    await expect(artifacts.get('chat-a', output.id)).rejects.toThrow();
    await artifacts.removeConversation('chat-a');
    expect(await readFile(join(outside, 'index.html'), 'utf8')).toBe('<p>outside</p>');
  });

  it('refuses replaced owner and storage-root directories for create, read and delete', async () => {
    const output = await artifacts.create('chat-a', '<p>keep</p>');
    const owner = dirname(output.folder);
    const saved = join(root, 'saved-owner');
    await rename(owner, saved);
    await symlink(saved, owner);
    await expect(artifacts.create('chat-a', '<p>escape</p>')).rejects.toThrow();
    await expect(artifacts.get('chat-a', output.id)).rejects.toThrow();
    await expect(artifacts.removeConversation('chat-a')).rejects.toThrow();
    expect(await readFile(join(saved, output.id, 'index.html'), 'utf8')).toBe('<p>keep</p>');
    await rm(owner);
    await rename(saved, owner);
    const storage = dirname(owner);
    await rename(storage, join(root, 'saved-storage'));
    await symlink(join(root, 'saved-storage'), storage);
    await expect(artifacts.create('chat-a', '<p>escape</p>')).rejects.toThrow();
    await expect(artifacts.get('chat-a', output.id)).rejects.toThrow();
    await expect(artifacts.removeConversation('chat-a')).rejects.toThrow();
  });

  it('rejects hardlinks, directories, empty files and outputs that have grown beyond the limit', async () => {
    const output = await artifacts.create('chat-a', '<p>valid</p>');
    const other = join(root, 'hardlink.html');
    await link(output.path, other);
    await expect(artifacts.get('chat-a', output.id)).rejects.toThrow();
    await rm(other);
    await truncate(output.path, 0);
    await expect(artifacts.get('chat-a', output.id)).rejects.toThrow();
    await truncate(output.path, MAX_HTML_ARTIFACT_BYTES + 1);
    await expect(artifacts.get('chat-a', output.id)).rejects.toThrow();
    await rm(output.path);
    await mkdir(output.path);
    await expect(artifacts.get('chat-a', output.id)).rejects.toThrow();
  });
});
