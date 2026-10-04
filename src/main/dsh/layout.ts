import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the DSH surface lives on disk, and the one dsh version this app runs.
 *
 * dsh is not bundled: the runtime is installed into the app's own data folder
 * the first time the person opens the surface, from exact versions only (the
 * npm `latest` tags of several dsh packages lag behind). `DSH_HOME` is ours
 * too, so nothing in `~/.dsh` — another harness's credentials, sessions or
 * profiles — is read or written.
 */
export const DSH_VERSION = '0.1.7-rc.2';
/** Not `desktop`: that profile name switches on DeepSeek's desktop telemetry rows. */
export const DSH_PROFILE = 'hello';
/** The profile template the first start copies its bundle list from. */
export const DSH_TEMPLATE = 'web';

/**
 * Install scripts the runtime may run. pnpm 11 refuses an install whose
 * dependencies ask for scripts it was not told about, so every one is named:
 * the three that make native code usable run, the two that only print do not.
 */
export const DSH_ALLOWED_BUILDS: Readonly<Record<string, boolean>> = Object.freeze({
  'node-pty': true,
  '@deepseek-ai/dsh-subprocess-local': true,
  koffi: true,
  protobufjs: false,
  '@google/genai': false,
});

export interface DshLayout {
  /** `<data>/dsh`: everything the surface owns. */
  root: string;
  /** The dsh installation: `@deepseek-ai/dsh` and its bundles, hoisted. */
  runtime: string;
  /** `DSH_HOME` for the host process. */
  home: string;
  /** The profile the host boots: its package.json, patch layer and plugins. */
  profile: string;
  logs: string;
  checkpoints: string;
  /** Files that ship with Hello: the require-builtin shim and Hello's own dsh bundle. */
  resources: string;
  /** package.json of the installed dsh, the anchor dsh resolves its bundles from. */
  installAnchor: string;
}

export function dshLayout(dataDir: string, resources: string): DshLayout {
  const root = join(dataDir, 'dsh');
  const runtime = join(root, 'runtime');
  const home = join(root, 'home');
  return {
    root,
    runtime,
    home,
    profile: join(home, 'profiles', DSH_PROFILE),
    logs: join(root, 'logs'),
    checkpoints: join(root, 'checkpoints'),
    resources,
    installAnchor: join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  };
}

/** The dsh version installed in the runtime, or undefined when there is none. */
export function installedVersion(layout: DshLayout): string | undefined {
  if (!existsSync(layout.installAnchor)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(layout.installAnchor, 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The dsh version this app runs: the one it came with, unless the person
 * updated to a newer one from the sidebar (user, 01.10) — kept in
 * `<data>/dsh/version.json` until they go back.
 */
export function selectedVersion(layout: DshLayout): string {
  try {
    const version = (JSON.parse(readFileSync(join(layout.root, 'version.json'), 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version) ? version : DSH_VERSION;
  } catch {
    return DSH_VERSION;
  }
}

/** Runs `version` from the next install on; the version this app came with forgets the choice. */
export function selectVersion(layout: DshLayout, version: string): void {
  const file = join(layout.root, 'version.json');
  if (version === DSH_VERSION) { rmSync(file, { force: true }); return; }
  mkdirSync(layout.root, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify({ version }, null, 2)}\n`);
}

/** The runtime is usable only when it holds exactly the version this app runs. */
export function runtimeReady(layout: DshLayout, version = selectedVersion(layout)): boolean {
  return installedVersion(layout) === version
    && existsSync(join(layout.runtime, 'node_modules', 'node-addon-require-builtin', 'package.json'));
}
