import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import type { PiEngineStatus } from '../../shared/types';
import { pnpmFailure, runPnpm, type PnpmInvocation } from '../dsh/pnpm';
import { newer, npmLatest } from '../updates';
import { piRpcEntry } from './pi-session';

export const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const ENTRY = join('node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'rpc-entry.js');
/**
 * Install scripts in Pi's dependencies. pnpm 11 refuses an install whose
 * dependencies ask for scripts it was not told about; none of these is
 * needed to run Pi (esbuild finds its binary in its platform package).
 */
const PI_ALLOWED_BUILDS: Readonly<Record<string, boolean>> = Object.freeze({ esbuild: false, protobufjs: false, '@google/genai': false });

/** The version of the Pi whose rpc-entry this is, from its package.json. */
export function piVersionAt(entry: string): string | undefined {
  try {
    const version = (JSON.parse(readFileSync(join(dirname(entry), '..', '..', 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

interface PiEngineOptions {
  /** `<data>/pi`: an updated Pi lives in its `runtime` folder. */
  root: string;
  pnpm: PnpmInvocation;
  emit?(status: PiEngineStatus): void;
  /** For tests: the Pi this build came with. */
  bundledEntry?(): string;
  /** For tests: what npm offers as the newest Pi. */
  latest?(): Promise<string | undefined>;
  /** For tests: replaces pnpm's install into the staging folder. */
  install?(folder: string, version: string): Promise<void>;
}

/**
 * The Pi Hello's chats run on: the one this build came with, or a newer one
 * the person updated to from the sidebar (user, 01.10), installed with
 * Hello's pnpm into Hello's data folder. Going back removes the update and
 * the bundled Pi runs again. A chat moves to whichever runs at its next
 * message: the engine is part of its session's fingerprint.
 */
export class PiEngine {
  private state: PiEngineStatus['state'] = 'idle';
  private message?: string;
  private offered?: string;

  constructor(private readonly options: PiEngineOptions) {}

  private get runtime(): string { return join(this.options.root, 'runtime'); }

  private bundled(): { entry: string; version: string } {
    const entry = (this.options.bundledEntry ?? piRpcEntry)();
    return { entry, version: piVersionAt(entry) ?? '0.0.0' };
  }

  /** What runs: an update newer than the bundled Pi, else the bundled one. A Hello that brings a newer Pi of its own outgrows an older update. */
  current(): { entry: string; version: string; updated: boolean } {
    const bundled = this.bundled();
    const entry = join(this.runtime, ENTRY);
    const version = existsSync(entry) ? piVersionAt(entry) : undefined;
    return version && newer(version, bundled.version) ? { entry, version, updated: true } : { ...bundled, updated: false };
  }

  /** The rpc-entry a chat's Pi is started from. */
  entry(): string { return this.current().entry; }

  status(): PiEngineStatus {
    const { version } = this.current();
    const latest = newer(this.offered, version);
    return {
      version,
      bundled: this.bundled().version,
      ...(latest ? { latest } : {}),
      state: this.state,
      ...(this.message ? { message: this.message } : {}),
    };
  }

  /** A new state brings its own message, or none; a look at npm keeps both. */
  private changed(patch: { state?: PiEngineStatus['state']; message?: string } = {}): PiEngineStatus {
    if (patch.state) { this.state = patch.state; this.message = patch.message; }
    const status = this.status();
    this.options.emit?.(status);
    return status;
  }

  async checkLatest(): Promise<PiEngineStatus> {
    this.offered = await (this.options.latest ?? (() => npmLatest(PI_PACKAGE)))();
    return this.changed();
  }

  /** Installs the newer Pi npm offers beside the bundled one, and runs it from the next message on. */
  async update(): Promise<PiEngineStatus> {
    if (this.state === 'updating') return this.status();
    const version = newer(this.offered, this.current().version);
    if (!version) return this.status();
    this.changed({ state: 'updating' });
    const staging = join(this.options.root, `staging-${randomUUID()}`);
    try {
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await (this.options.install ?? ((folder, wanted) => this.pnpmInstall(folder, wanted)))(staging, version);
      if (piVersionAt(join(staging, ENTRY)) !== version) throw new Error(`pnpm finished, but Pi ${version} is not in the folder.`);
      await rm(this.runtime, { recursive: true, force: true });
      await rename(staging, this.runtime);
      return this.changed({ state: 'idle' });
    } catch (error) {
      return this.changed({ state: 'failed', message: error instanceof Error ? error.message : String(error) });
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Back to the Pi this Hello came with: the update is removed. */
  async useBundled(): Promise<PiEngineStatus> {
    if (this.state === 'updating') return this.status();
    await rm(this.runtime, { recursive: true, force: true });
    return this.changed({ state: 'idle' });
  }

  private async pnpmInstall(folder: string, version: string): Promise<void> {
    await writeFile(join(folder, 'package.json'), `${JSON.stringify({
      name: 'hello-pi-runtime',
      private: true,
      description: 'The Pi Hello. runs instead of the one it came with. Managed by Hello.; going back removes it.',
      dependencies: { [PI_PACKAGE]: version },
    }, null, 2)}\n`);
    await writeFile(join(folder, 'pnpm-workspace.yaml'), stringify({
      packages: ['.'],
      nodeLinker: 'hoisted',
      managePackageManagerVersions: false,
      allowBuilds: { ...PI_ALLOWED_BUILDS },
    }));
    const run = await runPnpm(this.options.pnpm, ['install'], { cwd: folder });
    if (run.code !== 0) throw new Error(`Installing Pi ${version} failed.\n${pnpmFailure(run.output)}`);
  }
}
