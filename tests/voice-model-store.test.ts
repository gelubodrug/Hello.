import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { archivePath, VoiceModelStore } from '../src/main/voice/model-store';
import type { VoiceArtifact } from '../src/main/voice/manifest';

describe('consented Voice component downloads', () => {
  let root: string;
  const bytes = Buffer.from('small fixture, never a real model');
  const asset: VoiceArtifact = { name: 'fixture.bin', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: 'https://huggingface.co/publisher/fixture' };
  const signal = () => new AbortController().signal;
  beforeEach(async () => { root = await mkdtemp(join(await realpath(tmpdir()), 'hello-voice-store-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('commits a checked stream atomically and reuses it without another fetch', async () => {
    const fetcher = vi.fn(async () => new Response(bytes));
    const store = new VoiceModelStore(root, fetcher); const progress = vi.fn();
    const path = await store.download(asset, signal(), progress);
    expect(await readFile(path)).toEqual(bytes);
    expect(await store.download(asset, signal(), progress, false)).toBe(path);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenLastCalledWith(bytes.length, bytes.length);
    expect(await readdir(root)).toEqual([`${asset.sha256}-${asset.name}`]);
  });

  it('never turns a local restore into download consent', async () => {
    const fetcher = vi.fn(); const store = new VoiceModelStore(root, fetcher);
    await expect(store.download(asset, signal(), () => {}, false)).rejects.toThrow(/Settings/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['short', 'same size bad digest', 'oversize'])('keeps the prior file and removes temporary bytes on %s', async kind => {
    const body = kind === 'short' ? bytes.subarray(1) : kind === 'oversize' ? Buffer.concat([bytes, bytes]) : Buffer.alloc(bytes.length, 1);
    const store = new VoiceModelStore(root, vi.fn(async () => new Response(body)));
    await writeFile(store.path(asset), 'prior incomplete file');
    await expect(store.download(asset, signal(), () => {})).rejects.toThrow(/size|SHA-256/);
    expect(await readFile(store.path(asset), 'utf8')).toBe('prior incomplete file');
    expect((await readdir(root)).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('refuses a leaf symlink without changing its target', async () => {
    const fetcher = vi.fn(); const store = new VoiceModelStore(root, fetcher);
    const target = join(root, 'person.txt'); await writeFile(target, 'keep'); await symlink(target, store.path(asset));
    await expect(store.download(asset, signal(), () => {})).rejects.toThrow(/link/i);
    expect(await readFile(target, 'utf8')).toBe('keep'); expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses a symlinked parent directory', async () => {
    const alias = `${root}-alias`; await symlink(root, alias);
    try { await expect(new VoiceModelStore(alias).directory()).rejects.toThrow(/link/i); }
    finally { await rm(alias); }
  });

  it('cleans an interrupted streaming download', async () => {
    const controller = new AbortController();
    const store = new VoiceModelStore(root, vi.fn(async () => new Response(bytes)));
    await expect(store.download(asset, controller.signal, received => { if (received) controller.abort(); })).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it('does not follow a publisher redirect to loopback or an unknown host', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
    await expect(new VoiceModelStore(root, fetcher).download(asset, signal(), () => {})).rejects.toThrow(/unapproved/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects archive traversal, absolute and control-character paths', () => {
    for (const path of ['../outside', '/absolute', 'model/../../outside', 'model\\outside', 'bad\nname']) expect(archivePath(path)).toBe(false);
    expect(archivePath('model/espeak-ng-data/en')).toBe(true);
  });
});
