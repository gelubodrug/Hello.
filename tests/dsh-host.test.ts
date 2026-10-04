import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DshHost, redactTokens, type HostExit } from '../src/main/dsh/host';
import { dshLayout } from '../src/main/dsh/layout';
import { forkSpawn } from '../src/main/dsh/spawn';

const fixture = resolve(__dirname, 'fixtures/fake-dsh-host.mjs');
const folders: string[] = [];
const hosts: DshHost[] = [];

function host(mode: string, extra: { startTimeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hello-dsh-host-'));
  folders.push(root);
  const lines: string[] = [];
  const created = new DshHost({
    entry: fixture,
    layout: dshLayout(root, join(root, 'resources')),
    spawn: (entry, args, options) => forkSpawn(entry, args, { ...options, env: { ...options.env, FAKE_DSH_MODE: mode, PATH: process.env.PATH ?? '' }, cwd: root }),
    env: { HELLO_SECRET: 'leaked-if-seen' },
    patchFile: join(root, 'hello.patch.yml'),
    log: line => lines.push(line),
    stopTimeoutMs: 2_000,
    ...extra,
  });
  hosts.push(created);
  return { host: created, lines, root };
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(item => item.stop().catch(() => {})));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('redactTokens', () => {
  it('replaces login tokens in URLs and key=value text', () => {
    expect(redactTokens('dsh web: http://127.0.0.1:1/?token=abcDEF123-_x&x=1')).toBe('dsh web: http://127.0.0.1:1/?token=[redacted]&x=1');
    expect(redactTokens('token: "abcdefghijklmnopqrstuvwxyz0123"')).toBe('token: "[redacted]"');
    expect(redactTokens('nothing secret here')).toBe('nothing secret here');
  });
});

describe('DshHost', () => {
  it('starts the entry with internals exposed and telemetry off, and resolves on ready', async () => {
    const { host: created, lines } = host('ready');
    const ready = await created.start();
    expect(ready).toEqual({ port: 4567, url: 'http://127.0.0.1:4567/?token=SECRET-TOKEN-1234567890' });
    expect(created.running).toBe(true);
    await new Promise(done => setTimeout(done, 50));
    const log = lines.join('\n');
    expect(log).toContain('telemetry=1 dnt=1');
    expect(log).toContain('internals=true');
    expect(log).toContain('hello.patch.yml');
    expect(log).not.toContain('SECRET-TOKEN');
    expect(log).toContain('?token=[redacted]');
  });

  it('passes only the environment it was given', async () => {
    const { host: created, lines } = host('ready');
    await created.start();
    await new Promise(done => setTimeout(done, 50));
    // The fixture echoes HELLO_SECRET; the host passes the env it was built with.
    expect(lines.join('\n')).toContain('secret=leaked-if-seen');
  });

  it('rejects with the host’s own words when the boot fails, without the token', async () => {
    const { host: created } = host('fatal');
    const exits: HostExit[] = [];
    created.onExit(exit => exits.push(exit));
    await expect(created.start()).rejects.toThrow('boot failed: ?token=[redacted]');
    await new Promise(done => setTimeout(done, 100));
    expect(exits[0]).toMatchObject({ expected: false, message: 'boot failed: ?token=[redacted]' });
    expect(created.running).toBe(false);
  });

  it('rejects when the process exits before it is ready', async () => {
    const { host: created } = host('exit');
    await expect(created.start()).rejects.toThrow('exited before it was ready (code 3)');
  });

  it('gives up on a host that never answers', async () => {
    const { host: created } = host('silent', { startTimeoutMs: 300 });
    await expect(created.start()).rejects.toThrow('did not start in time');
    await new Promise(done => setTimeout(done, 100));
    expect(created.running).toBe(false);
  });

  it('stops on request, and reports the exit as expected', async () => {
    const { host: created } = host('ready');
    const exits: HostExit[] = [];
    created.onExit(exit => exits.push(exit));
    await created.start();
    await created.stop();
    expect(created.running).toBe(false);
    expect(exits).toHaveLength(1);
    expect(exits[0].expected).toBe(true);
  });

  it('refuses a second start while one runs', async () => {
    const { host: created } = host('ready');
    await created.start();
    await expect(created.start()).rejects.toThrow('already running');
  });
});
