import { hostExecArgv, watchHostUsage, type ProcessMetric } from './budget';
import { DSH_PROFILE, DSH_TEMPLATE, type DshLayout } from './layout';

/**
 * One running dsh host process, seen from main.
 *
 * The process is spawned through an injected function — an Electron utility
 * process in the app, a plain child process in tests — and speaks the small
 * protocol host-entry.ts defines. Its output is logged, but only after every
 * token in it is replaced: the boot URL carries the one-time login token.
 */
export interface HostChild {
  readonly pid?: number;
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  onOutput(listener: (text: string) => void): void;
  kill(): void;
}

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
  execArgv: string[];
  serviceName: string;
}

export type SpawnHost = (entry: string, args: string[], options: SpawnOptions) => HostChild;

export interface HostReady {
  port: number;
  /** http://127.0.0.1:<port>/?token=… — for main's login exchange only. */
  url: string;
}

export interface HostExit {
  code: number;
  /** True for an exit main asked for. */
  expected: boolean;
  /** The host's own account of a failed boot, when it gave one. */
  message?: string;
}

export interface HostOptions {
  entry: string;
  layout: DshLayout;
  spawn: SpawnHost;
  /** The environment the host runs with, already stripped of Hello's secrets. */
  env: Record<string, string>;
  /** Hello's patch layer: no browser to open, no URL to print. */
  patchFile?: string;
  /** Hello's pnpm, for plugin operations the host runs itself. */
  pnpmScript?: string;
  log(line: string): void;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  /**
   * Electron's process metrics, for the budget watch (budget.ts). Without it
   * the host still runs under its heap ceiling; nothing is sampled.
   */
  metrics?(): readonly ProcessMetric[];
}

/** Replaces every login token in a line of host output. */
export function redactTokens(text: string): string {
  return text
    .replace(/([?&]token=)[^\s&#"']+/g, '$1[redacted]')
    .replace(/(\btoken["']?\s*[:=]\s*["']?)[A-Za-z0-9_-]{16,}/gi, '$1[redacted]');
}

const START_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 8_000;

function isMessage(value: unknown): value is { type: string } & Record<string, unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

export class DshHost {
  private child?: HostChild;
  private watch?: { stop(): void };
  private stopping?: Promise<void>;
  private exitListeners = new Set<(exit: HostExit) => void>();
  private fatal?: string;

  constructor(private readonly options: HostOptions) {}

  get running(): boolean {
    return this.child !== undefined;
  }

  onExit(listener: (exit: HostExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Starts the host and resolves once its web server listens. `extraEnv` is this start's own (a proxy token). */
  start(extraEnv: Record<string, string> = {}): Promise<HostReady> {
    if (this.child) return Promise.reject(new Error('The DSH host is already running.'));
    const { layout } = this.options;
    this.fatal = undefined;
    this.stopping = undefined;
    const env: Record<string, string> = {
      ...this.options.env,
      DSH_HOME: layout.home,
      DSH_TELEMETRY_DISABLED: '1',
      DO_NOT_TRACK: '1',
      ...(this.options.patchFile ? { HELLO_DSH_PATCH: this.options.patchFile } : {}),
      ...(this.options.pnpmScript ? { HELLO_DSH_PNPM: this.options.pnpmScript } : {}),
      ...extraEnv,
    };
    const child = this.options.spawn(this.options.entry, [layout.runtime, DSH_PROFILE, DSH_TEMPLATE], {
      cwd: layout.home,
      env,
      // A heap ceiling goes with the process itself, so a runaway plugin fails
      // inside the host instead of taking the app's memory with it (budget.ts).
      execArgv: hostExecArgv(),
      serviceName: 'Hello. DSH host',
    });
    this.child = child;
    const metrics = this.options.metrics;
    if (metrics) this.watch = watchHostUsage({
      pid: () => (this.child === child ? child.pid : undefined),
      metrics,
      log: line => this.options.log(line),
    });
    let pending = '';
    child.onOutput(text => {
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) this.options.log(redactTokens(line));
    });
    return new Promise<HostReady>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('The DSH host did not start in time.'));
        child.kill();
      }, this.options.startTimeoutMs ?? START_TIMEOUT_MS);
      timer.unref?.();
      child.onMessage(message => {
        if (!isMessage(message)) return;
        if (message.type === 'ready' && typeof message.port === 'number' && typeof message.url === 'string') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            port: message.port,
            url: message.url,
          });
        } else if (message.type === 'fatal') {
          this.fatal = redactTokens(typeof message.message === 'string' ? message.message : 'The DSH host failed to start.');
          if (typeof message.diagnostic === 'string') this.options.log(redactTokens(message.diagnostic));
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(this.fatal));
        }
      });
      child.onExit(code => {
        if (pending.trim()) this.options.log(redactTokens(pending));
        pending = '';
        const expected = this.stopping !== undefined;
        if (this.child === child) this.child = undefined;
        this.watch?.stop();
        this.watch = undefined;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(this.fatal ?? `The DSH host exited before it was ready (code ${code}).`));
        }
        for (const listener of [...this.exitListeners]) listener({ code, expected, ...(this.fatal ? { message: this.fatal } : {}) });
      });
    });
  }

  /** Asks the host to shut down cleanly, and ends it if it does not. */
  stop(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    return this.stopping ??= new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill(), this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS);
      timer.unref?.();
      child.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.postMessage({ type: 'shutdown' });
      } catch {
        child.kill();
      }
    });
  }
}
