import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DshStatus } from '../../shared/types';
import { listCheckpoints, restoreCheckpoint, saveCheckpoint } from './checkpoints';
import { DshHost, type HostReady, type SpawnHost } from './host';
import { DSH_VERSION, installedVersion, runtimeReady, selectedVersion, selectVersion, type DshLayout } from './layout';
import { newer, npmLatest } from '../updates';
import { inheritedEnv, packagesToAdd, parseProgress, pnpmActivity, pnpmFailure, runPnpm, type PnpmInvocation } from './pnpm';
import { ensureHelloProfile, ensureProfileWorkspace, HELLO_BUNDLE, profileChange, rememberProfile } from './profile';
import { installRuntime } from './runtime';
import { ModelProxy, type ModelConnection, type ProxyAddress } from './model-proxy';
import { BRIDGE_TOKEN_ENV } from './tool-bridge';
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
  /** Hello's active model connection, read fresh on each start and each proxied request. */
  model?: () => ModelConnection | undefined;
  /**
   * Electron's process metrics, for the host's memory and CPU budget
   * (dsh/budget.ts). Written as an inline import so this file's import block
   * stays as it is. Without it the host still runs under its heap ceiling.
   */
  metrics?: () => readonly import('./budget').ProcessMetric[];
  /** For tests: replaces the runtime install. */
  install?: (layout: DshLayout, pnpm: PnpmInvocation, options: Parameters<typeof installRuntime>[2]) => Promise<void>;
  /** For tests: what npm offers as the newest dsh. */
  latest?: () => Promise<string | undefined>;
}

/** The environment variable the host's llm-pi-ai route reads its (proxy) key from. */
export const MODEL_TOKEN_ENV = 'HELLO_DSH_MODEL_TOKEN';
export const HELLO_PROVIDER = 'hello';

/**
 * Hello's patch layer over the profile, rewritten on every start.
 *
 * A host inside an app has no terminal to print its address to and no browser
 * to open: both would put the login token somewhere it does not belong. With a
 * model connection, dsh's pi-ai route `hello` points at Hello's proxy and new
 * sessions start on Hello's model; dsh's own providers stay selectable.
 */
export function helloPatch(model?: { proxy: ProxyAddress; connection: ModelConnection }): string {
  const rows: unknown[] = [
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true, trustedHosts: [] } },
    // Never the appearance. dsh refuses a Settings change that an overlay
    // would override, so a preference set here could not be changed in dsh's
    // own Settings (user, 01.10). Hello's bundle starts it dark instead.
  ];
  if (model) {
    const { connection, proxy } = model;
    rows.push({
      id: 'llm-pi-ai',
      config: {
        providers: {
          [HELLO_PROVIDER]: {
            displayName: 'Hello.',
            apiKeyEnv: MODEL_TOKEN_ENV,
            api: 'openai-completions',
            baseURL: proxy.baseURL,
            models: [{
              id: connection.model,
              name: connection.model,
              ...(connection.contextWindow ? { contextWindow: connection.contextWindow } : {}),
              ...(connection.maxOutputTokens ? { maxTokens: connection.maxOutputTokens } : {}),
            }],
          },
        },
      },
    });
    rows.push({ id: 'agent-default-model', config: { provider: HELLO_PROVIDER, model: connection.model } });
  }
  return `# Written by Hello. on every start of the DSH surface; edits are overwritten.
# Use the profile's cordis.patch.yml for your own layer.
${stringify(rows)}`;
}

const LOG_LIMIT = 2 * 1024 * 1024;

/**
 * The DSH surface's lifecycle in main: install, start, stop, restore.
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
  private proxy: ModelProxy;
  private disposed = false;
  /** Cancels a running install or profile install when the app quits. */
  private work = new AbortController();
  /** The running host's tool bridge; gone with the host. */
  private bridgeAddress?: { port: number; token: string; generation: number };
  /** The newest dsh npm offered at the last look. */
  private offered?: string;
  private generation = 0;

  constructor(private readonly options: DshServiceOptions) {
    const { layout } = options;
    this.current = {
      state: runtimeReady(layout) ? 'stopped' : 'absent',
      version: selectedVersion(layout),
      bundledVersion: DSH_VERSION,
      ...(installedVersion(layout) ? { installedVersion: installedVersion(layout) } : {}),
      profileDir: layout.profile,
      logFile: this.logFile,
      checkpoints: listCheckpoints(layout),
    };
    if (this.current.state === 'absent' && installedVersion(layout))
      this.current.message = `dsh ${installedVersion(layout)} is installed; this version of Hello. runs ${selectedVersion(layout)}. Install again to update it.`;
    this.host = this.createHost();
    this.proxy = new ModelProxy(() => this.options.model?.(), line => this.log(line));
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
      this.bridgeAddress = undefined;
      if (exit.expected || this.disposed) return;
      this.options.surface.disconnect();
      void this.proxy.stop().catch(() => {});
      this.set({ state: 'failed', message: exit.message ?? `The DSH host stopped unexpectedly (code ${exit.code}).`, startedAt: undefined });
    });
    return host;
  }

  status(): DshStatus {
    return { ...this.current, checkpoints: listCheckpoints(this.options.layout), useHelloModel: this.useHelloModel() };
  }

  /**
   * Where the running host's tool bridge answers, and for which start: a
   * later start is another host with other plugins, so a caller holding an
   * older generation lists again.
   */
  bridge(): { port: number; token: string; generation: number } | undefined {
    return this.current.state === 'running' ? this.bridgeAddress : undefined;
  }

  /** Whether the surface's sessions use Hello's connection (the default) or dsh's own providers. */
  useHelloModel(): boolean {
    try { return (JSON.parse(readFileSync(join(this.options.layout.root, 'hello.json'), 'utf8')) as { useHelloModel?: unknown }).useHelloModel !== false; }
    catch { return true; }
  }

  /** Takes effect on the next start: the patch layer is written then. */
  setUseHelloModel(value: boolean): DshStatus {
    mkdirSync(this.options.layout.root, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.options.layout.root, 'hello.json'), `${JSON.stringify({ useHelloModel: value }, null, 2)}\n`);
    return this.set({});
  }

  private set(patch: Partial<DshStatus>): DshStatus {
    const next: DshStatus = { ...this.current, ...patch, checkpoints: listCheckpoints(this.options.layout), useHelloModel: this.useHelloModel() };
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
  install(): Promise<DshStatus> {
    if (this.installing) return this.installing;
    if (this.current.state === 'running' || this.current.state === 'starting') return Promise.resolve(this.status());
    const run = async () => {
      const version = selectedVersion(this.options.layout);
      const startedAt = this.options.now?.() ?? Date.now();
      this.set({ state: 'installing', message: undefined, progress: { resolved: 0, downloaded: 0, added: 0, startedAt, at: startedAt } });
      this.log(`Installing dsh ${version}.`);
      // Everything pnpm says keeps the panel alive: the counters, what it is
      // doing now, and when it last said anything (user, 01.10: "pune ceva
      // viu aici, că nu știi nimic ce face").
      const progressed = (patch: Partial<NonNullable<DshStatus['progress']>>) => this.set({
        progress: { resolved: 0, downloaded: 0, added: 0, ...this.current.progress, ...patch, at: this.options.now?.() ?? Date.now() },
      });
      try {
        await (this.options.install ?? installRuntime)(this.options.layout, this.options.pnpm, {
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
        this.log(`dsh ${version} installed.`);
        return this.set({ state: 'stopped', progress: undefined, installedVersion: installedVersion(this.options.layout) ?? version, message: undefined });
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

  /**
   * Installs the newer dsh npm offers and runs it (user, 01.10: "update dacă
   * există versiune nouă"). The version Hello came with stays one click away.
   */
  update(): Promise<DshStatus> {
    const version = newer(this.offered, this.current.version);
    return version ? this.switchTo(version) : Promise.resolve(this.status());
  }

  /** Back to the dsh this Hello came with. */
  useBundled(): Promise<DshStatus> {
    return this.current.version === DSH_VERSION ? Promise.resolve(this.status()) : this.switchTo(DSH_VERSION);
  }

  private async switchTo(version: string): Promise<DshStatus> {
    if (this.installing || this.transition) throw new Error('DSH is busy. Try again when it has finished.');
    const { layout } = this.options;
    const previous = selectedVersion(layout);
    const wasRunning = this.host.running;
    if (wasRunning) await this.stop();
    this.log(`Switching dsh from ${previous} to ${version}.`);
    selectVersion(layout, version);
    this.set({ version, latest: newer(this.offered, version), updateError: undefined });
    const installed = await this.install();
    if (installed.state === 'stopped') return wasRunning ? this.start() : installed;
    // The choice goes back, so Install brings the version that ran before;
    // why the switch failed stays beside the version in the sidebar.
    selectVersion(layout, previous);
    return this.set({ version: previous, latest: newer(this.offered, previous), state: runtimeReady(layout, previous) ? 'stopped' : 'absent', updateError: installed.message ?? 'The update could not be installed.' });
  }

  /** A plugin boot failure the surface reported: shown until the next start. */
  reportBootFailure(entries: string[]): void {
    if (!entries.length) return;
    this.log(`The DSH page could not activate: ${entries.join(', ')}`);
    this.set({ bootFailure: entries, message: `The DSH page could not start ${entries.length === 1 ? 'this plugin' : 'these plugins'}: ${entries.join(', ')}. Uninstall ${entries.length === 1 ? 'it' : 'them'} from the Plugin Market (DSH), or restore an earlier profile.` });
  }

  /** Starts the host; installs first when there is no runtime yet. */
  start(options: { acceptProfileChange?: boolean } = {}): Promise<DshStatus> {
    if (this.transition) return this.transition;
    if (this.current.state === 'running') return Promise.resolve(this.status());
    const run = async (): Promise<DshStatus> => {
      if (!runtimeReady(this.options.layout)) {
        const installed = await this.install();
        if (installed.state !== 'stopped') return installed;
      }
      const { layout } = this.options;
      const change = profileChange(layout);
      if (change && !options.acceptProfileChange) {
        const words = [
          change.added.length ? `added ${change.added.join(', ')}` : '',
          change.removed.length ? `removed ${change.removed.join(', ')}` : '',
          change.changed.length ? `changed ${change.changed.join(', ')}` : '',
        ].filter(Boolean).join('; ');
        this.log(`The profile changed outside Hello: ${words}.`);
        return this.set({ state: 'stopped', profileChange: change, message: `The DSH profile changed outside Hello.: ${words}. A plugin may have done this. Start with it, or restore the profile Hello. last left.` });
      }
      if (change) {
        saveCheckpoint(layout, 'before', 'Changed outside Hello., accepted', this.options.now?.());
        this.log('The person accepted the profile change.');
      }
      this.set({ profileChange: undefined, bootFailure: undefined });
      mkdirSync(layout.home, { recursive: true, mode: 0o700 });
      const connection = this.useHelloModel() ? this.options.model?.() : undefined;
      const proxy = connection?.endpointUrl && connection.model ? await this.proxy.start() : undefined;
      writeFileSync(join(layout.root, 'hello.patch.yml'), helloPatch(proxy && connection ? { proxy, connection } : undefined));
      this.set({ state: 'starting', message: undefined });
      try {
        const profile = ensureHelloProfile(layout);
        if (profile.changed || !existsSync(join(layout.profile, 'node_modules', HELLO_BUNDLE))) {
          this.set({ message: 'Preparing the profile…' });
          // The manifest just changed: a frozen lockfile would refuse it (see installRuntime).
          const install = await runPnpm(this.options.pnpm, ['install', '--no-frozen-lockfile'], { cwd: layout.profile, signal: this.work.signal, onLine: line => this.log(`pnpm: ${line}`) });
          if (install.code !== 0) throw new Error(`The DSH profile could not be installed.\n${pnpmFailure(install.output)}`);
          this.set({ message: undefined });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(message);
        return this.set({ state: 'failed', message });
      }
      this.log(`Starting the DSH host (profile ${layout.profile}).`);
      try {
        const bridgeToken = randomBytes(32).toString('base64url');
        const ready = await this.host.start({
          ...(proxy ? { [MODEL_TOKEN_ENV]: proxy.token } : {}),
          [BRIDGE_TOKEN_ENV]: bridgeToken,
        });
        this.log(`DSH host ready on port ${ready.port}.`);
        this.generation += 1;
        this.bridgeAddress = ready.bridgePort ? { port: ready.bridgePort, token: bridgeToken, generation: this.generation } : undefined;
        await this.options.surface.connect(ready);
        saveCheckpoint(layout, 'healthy', 'Started without errors', this.options.now?.());
        rememberProfile(layout);
        return this.set({ state: 'running', startedAt: this.options.now?.() ?? Date.now(), message: undefined });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`Start failed: ${message}`);
        await this.host.stop().catch(() => {});
        await this.proxy.stop().catch(() => {});
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
      this.bridgeAddress = undefined;
      await this.host.stop();
      await this.proxy.stop();
      this.options.surface.disconnect();
      return this.set({ state: 'stopped', startedAt: undefined, message: undefined });
    };
    return this.transition = run().finally(() => { this.transition = undefined; });
  }

  async restart(): Promise<DshStatus> {
    await this.stop();
    return this.start();
  }

  /** Brings a restore point's profile back, reinstalls its packages and starts. */
  async restore(checkpointId: string): Promise<DshStatus> {
    await this.stop();
    const { layout } = this.options;
    saveCheckpoint(layout, 'before', 'Before restoring an earlier point', this.options.now?.());
    const point = restoreCheckpoint(layout, checkpointId);
    this.log(`Restored the profile from ${point.label} (${new Date(point.at).toISOString()}).`);
    this.set({ state: 'starting', message: 'Reinstalling the restored profile…' });
    ensureProfileWorkspace(layout);
    const run = await runPnpm(this.options.pnpm, ['install'], { cwd: layout.profile, signal: this.work.signal, onLine: line => this.log(`pnpm: ${line}`) });
    if (run.code !== 0) return this.set({ state: 'failed', message: `The restored profile could not be installed.\n${pnpmFailure(run.output)}` });
    rememberProfile(layout);
    this.set({ state: 'stopped', message: undefined, profileChange: undefined, bootFailure: undefined });
    return this.start();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.work.abort(new Error('Hello. is closing.'));
    await this.host.stop().catch(() => {});
    await this.proxy.stop().catch(() => {});
  }
}
