import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { DSH_ALLOWED_BUILDS, DSH_VERSION, runtimeReady, selectedVersion, type DshLayout } from './layout';
import { parseProgress, pnpmFailure, runPnpm, type InstallProgress, type PnpmInvocation } from './pnpm';

/**
 * The dsh installation, as pnpm is asked to build it.
 *
 * One exact dependency: `@deepseek-ai/dsh` carries dsh-base, dsh-web-app and
 * the rest of the installation. The layout is hoisted, as dsh's own profiles
 * are, and one package is replaced: `node-addon-require-builtin` reads Node's
 * internal module loader through a native addon that recognises only exact
 * Electron builds (44.0.0, not this app's 44.x), so Hello's shim answers the
 * same calls through `--expose-internals`, which the host is started with.
 */
export function runtimeManifest(version = DSH_VERSION): Record<string, unknown> {
  return {
    name: 'hello-dsh-runtime',
    private: true,
    description: 'The DeepSeek Harness installation the Hello. DSH surface runs. Managed by Hello.; edits are overwritten.',
    dependencies: { '@deepseek-ai/dsh': version },
  };
}

export function runtimeWorkspace(layout: DshLayout): string {
  return stringify({
    packages: ['.'],
    nodeLinker: 'hoisted',
    managePackageManagerVersions: false,
    overrides: {
      'node-addon-require-builtin': `file:${join(layout.resources, 'shims', 'node-addon-require-builtin')}`,
    },
    allowBuilds: { ...DSH_ALLOWED_BUILDS },
  });
}

export function writeRuntimeFiles(layout: DshLayout, version = selectedVersion(layout)): void {
  mkdirSync(layout.runtime, { recursive: true, mode: 0o700 });
  writeFileSync(join(layout.runtime, 'package.json'), `${JSON.stringify(runtimeManifest(version), null, 2)}\n`);
  writeFileSync(join(layout.runtime, 'pnpm-workspace.yaml'), runtimeWorkspace(layout));
}

/**
 * Installs (or repairs) the runtime. Resolves when the version this app runs
 * is on disk; rejects with pnpm's own last words otherwise.
 */
export async function installRuntime(layout: DshLayout, pnpm: PnpmInvocation, options: {
  signal?: AbortSignal;
  onProgress?: (progress: InstallProgress) => void;
  onLine?: (line: string) => void;
} = {}): Promise<void> {
  const version = selectedVersion(layout);
  writeRuntimeFiles(layout, version);
  // pnpm runs as in CI, where an install keeps the lockfile frozen; switching
  // dsh's version changes the manifest that lockfile was made for, and a
  // frozen install refused it at once (user, 01.10: "apeși, clipește, se
  // termină imediat"). The manifest is Hello's own, so the lockfile follows it.
  const run = await runPnpm(pnpm, ['install', '--no-frozen-lockfile'], {
    cwd: layout.runtime,
    signal: options.signal,
    onLine(line) {
      const progress = parseProgress(line);
      if (progress) options.onProgress?.(progress);
      options.onLine?.(line);
    },
  });
  if (run.code !== 0) throw new Error(`Installing the DSH runtime failed.\n${pnpmFailure(run.output)}`);
  if (!runtimeReady(layout, version)) throw new Error(`pnpm finished, but dsh ${version} is not in the runtime folder.`);
}
