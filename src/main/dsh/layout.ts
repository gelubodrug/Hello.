import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../atomic-write';
import { join } from 'node:path';

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
  /** Files that ship with Hello: the require-builtin shim. */
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

/** Installed versions, including a previously selected sidebar update, stay usable offline.
 * A fresh install resolves npm latest; there is no bundled rc pin or downgrade path. */
export function selectedVersion(layout: DshLayout): string {
  return installedVersion(layout) ?? 'latest';
}

/** Record a successful update for older Hello versions sharing this data folder. */
export function selectVersion(layout: DshLayout, version: string): void {
  mkdirSync(layout.root, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(join(layout.root, 'version.json'), `${JSON.stringify({ version }, null, 2)}\n`);
}

export function runtimeReady(layout: DshLayout, version = installedVersion(layout)): boolean {
  return !!version && installedVersion(layout) === version
    && existsSync(join(layout.runtime, 'node_modules', 'node-addon-require-builtin', 'package.json'));
}
