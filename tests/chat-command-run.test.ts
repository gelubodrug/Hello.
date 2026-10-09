import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_OUTPUT, CommandOutput, commandTimeout, runApprovedCommand } from '../src/main/chat/command-run';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
let child: EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough };
let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'hello-command-'));
  child = Object.assign(new EventEmitter(), { pid: 987654321, stdout: new PassThrough(), stderr: new PassThrough() });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  vi.spyOn(process, 'kill').mockReturnValue(true);
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await rm(dataDir, { recursive: true, force: true }); });
const start = (timeoutSeconds = 30, signal = new AbortController().signal, saveLog = false) =>
  runApprovedCommand('fake command', dataDir, signal, { timeoutSeconds, dataDir, saveLog, redactValues: ['fixture-redact-this'] });

describe('bounded command output and per-call deadlines', () => {
  it('validates timeout seconds without launching anything', () => {
    expect(commandTimeout(undefined)).toBe(30);
    expect(commandTimeout(600)).toBe(600);
    for (const value of [0, -1, 601, 1.5, '30', NaN]) expect(() => commandTimeout(value)).toThrow(/1 to 600/);
  });
  it('retains a 16 KiB head and rolling 48 KiB tail, counts the middle and preserves split UTF-8 in small output', () => {
    const ring = new CommandOutput();
    ring.append(Buffer.from('A'.repeat(COMMAND_OUTPUT.head)));
    ring.append(Buffer.from('M'.repeat(200_000)));
    ring.append(Buffer.from('Z'.repeat(COMMAND_OUTPUT.tail)));
    expect(ring.omittedBytes).toBe(200_000);
    expect(ring.text()).toBe('A'.repeat(COMMAND_OUTPUT.head) + '\n[200000 bytes omitted]\n' + 'Z'.repeat(COMMAND_OUTPUT.tail));
    const unicode = new CommandOutput();
    const bytes = Buffer.from('hello 🦉');
    unicode.append(bytes.subarray(0, 8)); unicode.append(bytes.subarray(8));
    expect(unicode.text()).toBe('hello 🦉');
  });
  it('keeps running after noisy output, including stderr at the end', async () => {
    const pending = start();
    child.stdout.write('a'.repeat(200_000));
    child.stderr.write('the final diagnostic');
    expect(process.kill).not.toHaveBeenCalled();
    child.emit('close', 1, null);
    const result = JSON.parse(await pending);
    expect(result.output.endsWith('the final diagnostic')).toBe(true);
    expect(result.omittedBytes).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
  });
  it('uses the selected timeout and terminates descendants even when the parent closes first', async () => {
    vi.useFakeTimers();
    const pending = start(60);
    vi.advanceTimersByTime(30_000);
    expect(process.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    child.emit('close', null, 'SIGTERM');
    expect(JSON.parse(await pending).error).toContain('60 seconds');
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
  });
  it('Stop rejects and kills the owned process group', async () => {
    const controller = new AbortController();
    const pending = start(30, controller.signal);
    const rejected = expect(pending).rejects.toThrow('Stopped');
    controller.abort(new Error('Stopped'));
    child.emit('close', null, 'SIGTERM');
    await rejected;
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
  });
  it('saves a private optional log and redacts known values across stream chunks', async () => {
    const pending = start(30, new AbortController().signal, true);
    child.stdout.write('fixture-redact-'); child.stdout.write('this');
    child.emit('close', 0, null);
    const result = JSON.parse(await pending);
    expect(result.output).toBe('[redacted]');
    expect(await readFile(result.logPath, 'utf8')).toBe('[redacted]');
    expect((await stat(result.logPath)).mode & 0o777).toBe(0o600);
    expect(result.logTruncated).toBe(false);
  });
});
