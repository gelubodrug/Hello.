import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export async function voicePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
export const VOICE_BACKOFF = [1000, 3000, 10_000] as const;
export class WhisperSupervisor {
  private child?: ChildProcess;
  private lifetime = new AbortController();
  private job?: Promise<string>;
  private recovery?: Promise<string>;
  private endpoint?: string;
  private failures = 0;
  private gaveUp = false;
  constructor(private readonly options: {
    executable: string; model: string; cwd: string;
    changed: (state: 'starting' | 'ready' | 'error', detail: string) => void;
    spawn?: typeof spawn; port?: () => Promise<number>; fetch?: typeof fetch;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  }) {}
  get url(): string | undefined { return this.endpoint; }
  start(retry = false): Promise<string> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('Voice has stopped.'));
    if (retry) { this.failures = 0; this.gaveUp = false; }
    if (this.endpoint) return Promise.resolve(this.endpoint);
    if (this.recovery) return this.recovery;
    if (this.job) return this.job;
    if (this.gaveUp) return Promise.reject(new Error('Whisper stopped repeatedly. Try again in Settings › Voice.'));
    this.job = this.launch().finally(() => { this.job = undefined; });
    return this.job;
  }
  private async launch(): Promise<string> {
    const signal = this.lifetime.signal;
    for (;;) {
      signal.throwIfAborted();
      this.options.changed('starting', this.failures ? `Restarting Whisper (${this.failures}/3)…` : 'Starting Whisper…');
      try {
        const port = await (this.options.port ?? voicePort)(); signal.throwIfAborted();
        const child = (this.options.spawn ?? spawn)(this.options.executable, ['--host', '127.0.0.1', '--port', String(port), '-m', this.options.model, '-l', 'auto', '-t', '4'], {
          cwd: this.options.cwd, env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore',
        });
        this.child = child; let ended = false;
        child.once('error', () => { ended = true; });
        child.once('exit', () => {
          ended = true;
          if (this.child !== child) return;
          this.child = undefined;
          const wasReady = !!this.endpoint; this.endpoint = undefined;
          if (wasReady && !signal.aborted) {
            this.options.changed('starting', 'Whisper stopped; restarting…');
            this.recovery = this.recover().finally(() => { this.recovery = undefined; });
            void this.recovery.catch(() => {});
          }
        });
        const endpoint = `http://127.0.0.1:${port}`;
        const until = Date.now() + 120_000;
        while (!ended && Date.now() < until) {
          signal.throwIfAborted();
          try {
            const response = await (this.options.fetch ?? fetch)(`${endpoint}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]), redirect: 'error' });
            if (response.ok && (await response.text()).includes('"ok"') && !ended) {
              this.endpoint = endpoint; this.options.changed('ready', 'Whisper is running locally.'); return endpoint;
            }
          } catch { /* model still loading */ }
          await this.wait(300);
        }
        throw new Error('Whisper did not become ready.');
      } catch (error) {
        this.child?.kill('SIGKILL'); this.child = undefined; this.endpoint = undefined;
        if (signal.aborted) throw error;
        await this.backoff();
      }
    }
  }
  private async backoff(): Promise<void> {
    const ms = VOICE_BACKOFF[this.failures++];
    if (ms === undefined) {
      this.gaveUp = true; const error = new Error('Whisper could not stay running after three retries. Try again in Settings › Voice.');
      this.options.changed('error', error.message); throw error;
    }
    await this.wait(ms);
  }
  private wait(ms: number): Promise<void> {
    return this.options.wait ? this.options.wait(ms, this.lifetime.signal) : delay(ms, undefined, { signal: this.lifetime.signal });
  }
  private async recover(): Promise<string> {
    await this.backoff();
    return this.launch();
  }
  dispose(): void { this.lifetime.abort(); this.endpoint = undefined; this.child?.kill('SIGKILL'); this.child = undefined; }
}
