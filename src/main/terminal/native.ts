/**
 * Loading node-pty, and saying why when it will not load.
 *
 * Native compatibility is checked lazily, on explicit launch. The new app
 * owns its dependency rebuild; a failed binary load never prevents boot.
 *
 * Two things can still go wrong on a real machine, and neither may take the
 * app down at boot: the addon can refuse to load, and — far more likely —
 * `spawn-helper` can be non-executable. node-pty's npm tarball ships that
 * helper with mode 0644, and every `posix_spawnp` through it then fails with
 * a message that says nothing about a permission bit. The probe fixes the bit
 * where it can and reports a reason where it cannot; the drawer shows the
 * reason instead of an empty box.
 */

import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The slice of node-pty's `IPty` this app uses. */
export interface PtyProcess {
  readonly pid: number;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface SpawnPtyOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type SpawnPty = (
  file: string,
  args: string[],
  options: SpawnPtyOptions,
) => PtyProcess;

export type NodePtyProbe =
  { ok: true; spawn: SpawnPty } | { ok: false; reason: string };

interface NodePtyModule {
  spawn: SpawnPty;
}

/** Same search order node-pty's own loader uses, so the helper found is its helper. */
const NATIVE_DIRS = [
  "build/Release",
  "build/Debug",
  `prebuilds/${process.platform}-${process.arch}`,
];

/**
 * Where node-pty will look for `spawn-helper`, or null when the package is
 * laid out in a way this does not recognize. Inside a packaged app the entry
 * resolves through the archive, and the unpacked copy is the one that runs.
 */
export function spawnHelperPath(packageRoot: string): string | null {
  for (const dir of NATIVE_DIRS) {
    const candidate = join(packageRoot, dir, "spawn-helper").replace(
      "app.asar",
      "app.asar.unpacked",
    );
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Makes the helper executable when it is not, and reports what stopped it.
 * Returns null on success — including on Windows, which has no such helper.
 */
export function ensureSpawnHelperExecutable(
  helperPath: string | null,
): string | null {
  if (process.platform === "win32") {
    return null;
  }

  if (helperPath === null) {
    return "node-pty is installed without a spawn-helper for this platform";
  }

  try {
    accessSync(helperPath, constants.X_OK);
    return null;
  } catch {
    // Not executable yet: node-pty's tarball ships it 0644.
  }

  try {
    chmodSync(helperPath, statSync(helperPath).mode | 0o111);
    accessSync(helperPath, constants.X_OK);
    return null;
  } catch (error) {
    return `${helperPath} is not executable and could not be made executable (${
      error instanceof Error ? error.message : String(error)
    })`;
  }
}

const REMEDY =
  "Reinstall dependencies and rebuild node-pty for this Electron runtime.";

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const abi =
    /NODE_MODULE_VERSION (\d+)\.[\s\S]*?NODE_MODULE_VERSION (\d+)/.exec(
      message,
    );

  return abi === null
    ? message.replace(/\s+/g, " ").trim()
    : `the build in node_modules is NODE_MODULE_VERSION ${abi[1]} and this runtime wants ${abi[2]}`;
}

/**
 * Loads node-pty once and hands back its `spawn`, or the reason it cannot.
 *
 * `resolve` is injected so a test can describe a broken install without one.
 */
export function probeNodePty(
  resolve: (specifier: string) => string = createRequire(import.meta.url)
    .resolve,
  load: (specifier: string) => unknown = createRequire(import.meta.url),
): NodePtyProbe {
  let module: NodePtyModule;
  let entry: string;

  try {
    entry = resolve("node-pty");
    module = load("node-pty") as NodePtyModule;
  } catch (error) {
    return {
      ok: false,
      reason: `node-pty will not load — ${describeFailure(error)}. ${REMEDY}`,
    };
  }

  if (typeof module.spawn !== "function") {
    return {
      ok: false,
      reason: "node-pty loaded but exposes no spawn(); the install is broken.",
    };
  }

  // The entry is `<root>/lib/index.js`; the native directories sit beside lib.
  const helperFailure = ensureSpawnHelperExecutable(
    spawnHelperPath(dirname(dirname(entry))),
  );
  if (helperFailure !== null) {
    return {
      ok: false,
      reason: `node-pty cannot start a shell — ${helperFailure}.`,
    };
  }

  return { ok: true, spawn: module.spawn.bind(module) };
}
