import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { VOICE_BACKOFF, WhisperSupervisor } from '../src/main/voice/supervisor';

function fixture(crash = false) {
  const children: Array<EventEmitter & { kill: ReturnType<typeof vi.fn> }> = [];
  const spawnFake = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) }); children.push(child);
    if (crash) queueMicrotask(() => child.emit('exit', 1));
    return child as unknown as ChildProcess;
  });
  const changed = vi.fn(); const waits: number[] = [];
  const supervisor = new WhisperSupervisor({ executable: '/private/hello/whisper', model: '/private/hello/model', cwd: '/private/hello',
    spawn: spawnFake as unknown as typeof spawn, port: async () => 40000 + children.length, changed,
    fetch: vi.fn(async () => Response.json({ status: 'ok' })),
    wait: async (ms, signal) => { signal.throwIfAborted(); waits.push(ms); },
  });
  return { supervisor, children, changed, waits, spawnFake };
}

describe('Hello-owned Whisper lifecycle', () => {
  it('starts once on a minted loopback port and becomes ready only after health', async () => {
    const f = fixture();
    const first = f.supervisor.start(); expect(f.supervisor.start()).toBe(first);
    expect(await first).toBe('http://127.0.0.1:40000');
    expect(f.spawnFake).toHaveBeenCalledTimes(1);
    expect(f.spawnFake.mock.calls[0]).toEqual(['/private/hello/whisper', ['--host', '127.0.0.1', '--port', '40000', '-m', '/private/hello/model', '-l', 'auto', '-t', '4'],
      { cwd: '/private/hello', env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' }]);
    expect(f.changed).toHaveBeenLastCalledWith('ready', expect.any(String));
    f.supervisor.dispose(); expect(f.children[0].kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('restarts a crashed owned child and shares the recovery with callers', async () => {
    const f = fixture(); await f.supervisor.start(); f.children[0].emit('exit', 1);
    expect(await f.supervisor.start()).toBe('http://127.0.0.1:40001');
    expect(f.waits).toEqual([1000]); expect(f.children).toHaveLength(2);
    f.supervisor.dispose();
  });

  it('gives up after three backoffs without an unbounded restart loop', async () => {
    const f = fixture(true);
    await expect(f.supervisor.start()).rejects.toThrow(/three retries/);
    expect(f.waits.filter(ms => ms !== 300)).toEqual([...VOICE_BACKOFF]);
    expect(f.children).toHaveLength(4);
    await expect(f.supervisor.start()).rejects.toThrow(/repeatedly/);
    expect(f.children).toHaveLength(4);
    expect(f.changed).toHaveBeenLastCalledWith('error', expect.any(String));
    f.supervisor.dispose();
  });

  it('shutdown before launch prevents a child or recovery', async () => {
    const f = fixture(); f.supervisor.dispose();
    await expect(f.supervisor.start()).rejects.toThrow(/stopped/);
    expect(f.spawnFake).not.toHaveBeenCalled();
  });
});
