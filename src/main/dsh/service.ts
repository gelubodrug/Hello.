import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { atomicWriteFileSync } from '../atomic-write';
import { join } from 'node:path';
import type { DshStatus } from '../../shared/types';
import { DshHost, type HostReady, type SpawnHost } from './host';
import { installedVersion, runtimeReady, selectedVersion, selectVersion, type DshLayout } from './layout';
import { newer, npmLatest } from '../updates';
import { inheritedEnv, packagesToAdd, parseProgress, pnpmActivity, type PnpmInvocation } from './pnpm';
import { removeLegacyTheme } from './profile';
import { installRuntime } from './runtime';
import { stringify } from 'yaml';

/** What the service needs from the surface: a place to show a started host. */
export interface SurfaceConnector {
  connect(ready: HostReady): Promise<void>;
  disconnect(): void;
}

export interface DshServiceOptions {
  layout: DshLayout;
  hostEntry: string;
  spawn: SpawnHost;
  surface: SurfaceConnector;
  pnpm: PnpmInvocation;
  emit(status: DshStatus): void;
  now?: () => number;
  /**
   * Electron's process metrics, for the host's memory and CPU budget
   * (dsh/budget.ts). Without it the host still runs under its heap ceiling.
   */
  metrics?: () => readonly import('./budget').ProcessMetric[];
  /** For tests: replaces the runtime install. */
  install?: (layout: DshLayout, pnpm: PnpmInvocation, options: Parameters<typeof installRuntime>[2]) => Promise<void>;
  /** For tests: what npm offers as the newest dsh. */
  latest?: () => Promise<string | undefined>;
}

const LOG_LIMIT = 2 * 1024 * 1024;

/**
 * The DSH surface's lifecycle in main: install, start, stop, update.
 *
 * One host at a time, started only when the person asks (opening the surface
 * or pressing Start), stopped with the app. A host that dies on its own is
 * reported, not restarted: a plugin that crashes it would crash it again.
 */
export class DshService {
  private current: DshStatus;
  private installing?: Promise<DshStatus>;
  private transition?: Promise<DshStatus>;
  private host: DshHost;
  private disposed = false;
  /** Cancels a running install when the app quits. */
  private work = new AbortController();
  /** The newest dsh npm offered at the last look. */
  private offered?: string;

  constructor(private readonly options: DshServiceOptions) {
    const { layout } = options;
    this.current = {
      state: runtimeReady(layout) ? 'stopped' : 'absent',
      version: selectedVersion(layout),
      ...(installedVersion(layout) ? { installedVersion: installedVersion(layout) } : {}),
      profileDir: layout.profile,
      logFile: this.logFile,
    };
    this.host = this.createHost();
  }

  private get logFile(): string {
    return join(this.options.layout.logs, 'host.log');
  }

  private createHost(): DshHost {
    const { layout } = this.options;
    const host = new DshHost({
      entry: this.options.hostEntry,
      layout,
      spawn: this.options.spawn,
      env: inheritedEnv(),
      patchFile: join(layout.root, 'hello.patch.yml'),
      pnpmScript: this.options.pnpm.args[0],
      log: line => this.log(line),
      ...(this.options.metrics ? { metrics: this.options.metrics } : {}),
    });
    host.onExit(exit => {
      if (exit.expected || this.disposed) return;
      this.options.surface.disconnect();
      this.set({ state: 'failed', message: exit.message ?? `The DSH host stopped unexpectedly (code ${exit.code}).`, startedAt: undefined });
    });
    return host;
  }

  status(): DshStatus { return { ...this.current }; }

  private set(patch: Partial<DshStatus>): DshStatus {
    const next: DshStatus = { ...this.current, ...patch };
    for (const key of Object.keys(patch) as Array<keyof DshStatus>) if (patch[key] === undefined) delete next[key];
    this.current = next;
    if (!this.disposed) this.options.emit(this.status());
    return this.status();
  }

  private log(line: string): void {
    try {
      mkdirSync(this.options.layout.logs, { recursive: true, mode: 0o700 });
      const file = this.logFile;
      if (existsSync(file) && statSync(file).size > LOG_LIMIT) renameSync(file, `${file}.1`);
      appendFileSync(file, `${new Date(this.options.now?.() ?? Date.now()).toISOString()} ${line}\n`);
    } catch { /* a log that cannot be written must not stop the surface */ }
  }

  /** Installs the runtime this app runs. Concurrent calls share one install. */
  install(versionToInstall?: string): Promise<DshStatus> {
    if (this.installing) return this.installing;
    if (this.current.state === 'running' || this.current.state === 'starting') return Promise.resolve(this.status());
    const run = async () => {
      const startedAt = this.options.now?.() ?? Date.now();
      this.set({ state: 'installing', message: undefined, progress: { resolved: 0, downloaded: 0, added: 0, startedAt, at: startedAt } });
      // Everything pnpm says keeps the panel alive: the counters, what it is
      // doing now, and when it last said anything (user, 01.10: "pune ceva
      // viu aici, că nu știi nimic ce face").
      const progressed = (patch: Partial<NonNullable<DshStatus['progress']>>) => this.set({
        progress: { resolved: 0, downloaded: 0, added: 0, ...this.current.progress, ...patch, at: this.options.now?.() ?? Date.now() },
      });
      try {
        const version = versionToInstall ?? await (this.options.latest ?? (() => npmLatest('@deepseek-ai/dsh')))();
        if (!version) throw new Error('Could not resolve the latest DSH release from npm. Try again when connected.');
        this.log(`Installing dsh ${version}.`);
        await (this.options.install ?? installRuntime)(this.options.layout, this.options.pnpm, {
          version,
          signal: this.work.signal,
          onProgress: progress => progressed({ resolved: progress.resolved, downloaded: progress.downloaded, added: progress.added, ...(progress.done ? { done: true } : {}) }),
          onLine: line => {
            this.log(`pnpm: ${line}`);
            if (parseProgress(line)) return;
            const total = packagesToAdd(line);
            const activity = pnpmActivity(line);
            progressed({ ...(total !== undefined ? { total } : {}), ...(activity ? { activity } : {}) });
          },
        });
        selectVersion(this.options.layout, version);
        this.log(`dsh ${version} installed.`);
        return this.set({ state: 'stopped', version, latest: newer(this.offered, version), updateError: undefined, progress: undefined, installedVersion: installedVersion(this.options.layout) ?? version, message: undefined });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(message);
        return this.set({ state: runtimeReady(this.options.layout) ? 'stopped' : 'absent', progress: undefined, message });
      } finally {
        this.installing = undefined;
      }
    };
    return this.installing = run();
  }

  /** Asks npm for the newest dsh; the status offers it when it is newer than the one running. */
  async checkLatest(): Promise<DshStatus> {
    this.offered = await (this.options.latest ?? (() => npmLatest('@deepseek-ai/dsh')))();
    return this.set({ latest: newer(this.offered, this.current.version) });
  }

  /** Resolve the current npm release on each requested update. */
  async update(): Promise<DshStatus> {
    if (this.installing || this.transition) throw new Error('DSH is busy. Try again when it has finished.');
    await this.checkLatest();
    const version = this.offered;
    if (!version) return this.set({ updateError: 'Could not resolve the latest DSH release from npm.' });
    if (!newer(version, this.current.version) && runtimeReady(this.options.layout)) return this.status();
    const wasRunning = this.host.running;
    if (wasRunning) await this.stop();
    const installed = await this.install(version);
    if (installed.message) return this.set({ updateError: installed.message });
    return wasRunning ? this.start() : installed;
  }

  /** A plugin boot failure the surface reported: shown until the next start. */
  reportBootFailure(entries: string[]): void {
    if (!entries.length) return;
    this.log(`The DSH page could not activate: ${entries.join(', ')}`);
    this.set({ bootFailure: entries, message: `The DSH page could not start: ${entries.join(', ')}. Check the host log for details.` });
  }

  /** Starts the host; installs first when there is no runtime yet. */
  start(): Promise<DshStatus> {
    if (this.transition) return this.transition;
    if (this.current.state === 'running') return Promise.resolve(this.status());
    const run = async (): Promise<DshStatus> => {
      if (!runtimeReady(this.options.layout)) {
        const installed = await this.install();
        if (installed.state !== 'stopped' || installed.message) return installed;
      }
      const { layout } = this.options;
      this.set({ state: 'starting', message: undefined, bootFailure: undefined });
      try {
        mkdirSync(layout.home, { recursive: true, mode: 0o700 });
        removeLegacyTheme(layout);
        // Only launch configuration: keep the authentication URL out of logs
        // and prevent DSH from opening an external browser.
        atomicWriteFileSync(join(layout.root, 'hello.patch.yml'), stringify([
          { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true, trustedHosts: [] } },
        ]));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(message);
        return this.set({ state: 'failed', message });
      }
      this.log(`Starting the DSH host (profile ${layout.profile}).`);
      try {
        const ready = await this.host.start();
        await this.options.surface.connect(ready);
        return this.set({ state: 'running', startedAt: this.options.now?.() ?? Date.now(), message: undefined });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`Start failed: ${message}`);
        await this.host.stop().catch(() => {});
        this.options.surface.disconnect();
        return this.set({ state: 'failed', message, startedAt: undefined });
      }
    };
    return this.transition = run().finally(() => { this.transition = undefined; });
  }

  stop(): Promise<DshStatus> {
    if (this.transition) return this.transition.then(() => this.stop());
    if (!this.host.running) return Promise.resolve(this.current.state === 'failed' ? this.status() : this.set({ state: runtimeReady(this.options.layout) ? 'stopped' : 'absent', startedAt: undefined }));
    const run = async () => {
      this.set({ state: 'stopping' });
      this.log('Stopping the DSH host.');
      await this.host.stop();
      this.options.surface.disconnect();
      return this.set({ state: 'stopped', startedAt: undefined, message: undefined });
    };
    return this.transition = run().finally(() => { this.transition = undefined; });
  }

  async restart(): Promise<DshStatus> {
    await this.stop();
    return this.start();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.work.abort(new Error('Hello. is closing.'));
    await this.host.stop().catch(() => {});
  }
}
