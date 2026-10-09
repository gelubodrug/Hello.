import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { shellEnvironment } from '../shell-env';

export const COMMAND_OUTPUT = { head: 16 * 1024, tail: 48 * 1024, log: 8 * 1024 * 1024 } as const;
export function commandTimeout(value: unknown): number {
  if (value === undefined) return 30;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 600)
    throw new Error('timeoutSeconds must be an integer from 1 to 600.');
  return value;
}

/** A single chronological stdout/stderr stream with bounded retained bytes. */
export class CommandOutput {
  private head: Buffer = Buffer.alloc(0);
  private tail: Buffer = Buffer.alloc(0);
  total = 0;
  append(chunk: Buffer): void {
    this.total += chunk.length;
    const take = Math.min(COMMAND_OUTPUT.head - this.head.length, chunk.length);
    if (take) this.head = Buffer.concat([this.head, chunk.subarray(0, take)]);
    const rest = chunk.subarray(take);
    if (rest.length) this.tail = Buffer.from(rest.length >= COMMAND_OUTPUT.tail ? rest.subarray(-COMMAND_OUTPUT.tail)
      : Buffer.concat([this.tail, rest]).subarray(-COMMAND_OUTPUT.tail));
  }
  get omittedBytes(): number { return this.total - this.head.length - this.tail.length; }
  text(): string {
    if (!this.omittedBytes) return Buffer.concat([this.head, this.tail]).toString('utf8');
    return `${this.head.toString('utf8')}\n[${this.omittedBytes} bytes omitted]\n${this.tail.toString('utf8')}`;
  }
}

/** Explicit approval grants a shell, not a cwd-only sandbox. */
export function runApprovedCommand(command: string, cwd: string, signal: AbortSignal, options: {
  timeoutSeconds: number; dataDir: string; saveLog: boolean; redactValues?: string[];
}): Promise<string> {
  const timeoutSeconds = commandTimeout(options.timeoutSeconds);
  const env = shellEnvironment();
  const secrets = [...(options.redactValues ?? []), ...Object.entries(env)
    .filter(([name]) => /(?:TOKEN|KEY|PASSWORD|SECRET|AUTH|PROXY)/i.test(name)).map(([, value]) => value ?? '')]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  const redact = (text: string) => secrets.reduce((value, secret) => value.split(secret).join('[redacted]'), text);
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = new CommandOutput();
    const log: Buffer[] = [];
    let logBytes = 0;
    let reason = '';
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (kind: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, kind); } catch { /* Already gone. */ } } };
    const kill = () => {
      killGroup('SIGTERM');
      forceTimer ??= setTimeout(() => killGroup('SIGKILL'), 1000);
    };
    const abort = () => { reason = 'Command stopped.'; kill(); };
    const timeout = setTimeout(() => { reason = `Command timed out after ${timeoutSeconds} seconds.`; kill(); }, timeoutSeconds * 1000);
    const cleanup = () => { clearTimeout(timeout); if (forceTimer) clearTimeout(forceTimer); signal.removeEventListener('abort', abort); };
    signal.addEventListener('abort', abort, { once: true });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => {
      output.append(chunk);
      if (options.saveLog && logBytes < COMMAND_OUTPUT.log) {
        const kept = Buffer.from(chunk.subarray(0, COMMAND_OUTPUT.log - logBytes));
        log.push(kept); logBytes += kept.length;
      }
    });
    child.once('error', error => { cleanup(); reject(new Error(redact(error.message))); });
    child.once('close', (exitCode, exitSignal) => {
      // A parent can close its streams before its descendants exit.
      if (reason) killGroup('SIGKILL');
      cleanup();
      if (signal.aborted) { reject(signal.reason); return; }
      void (async () => {
        const result: Record<string, unknown> = { exitCode, signal: exitSignal, output: redact(output.text()), omittedBytes: output.omittedBytes,
          ...(reason ? { error: reason } : {}) };
        if (options.saveLog) {
          try {
            const directory = join(options.dataDir, 'command-output');
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const info = await lstat(directory);
            if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe log directory.');
            const file = join(directory, `${randomUUID()}.log`);
            const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
            try { await handle.writeFile(redact(Buffer.concat(log).toString('utf8'))); }
            finally { await handle.close(); }
            result.logPath = file;
            result.logTruncated = output.total > logBytes;
            if (result.logTruncated) result.logLimitBytes = COMMAND_OUTPUT.log;
          } catch { result.logError = 'Could not save the command log.'; }
        }
        resolve(JSON.stringify(result));
      })().catch(reject);
    });
  });
}
