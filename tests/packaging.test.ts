import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';

/**
 * What `pnpm package:mac` has to be true for. Running electron-builder is not
 * part of the test suite, so these are the parts of the contract a file can
 * answer: the dependency tree a build would ship is the one the lockfile was
 * verified with, every folder extraResources copies exists, and every path the
 * app resolves as a real file on disk is named by an asarUnpack pattern.
 *
 * The last packaging attempt failed on a stale node_modules (electron-builder
 * hunted a @mariozechner/clipboard that the Pi upgrade had removed), so the
 * lockfile-agreement case here is the one that would have caught it.
 */
const root = path.join(__dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  build: {
    files: string[];
    asarUnpack: string[];
    extraResources: Array<{ from: string; to: string }>;
    mac: { extendInfo?: Record<string, string> };
  };
};
const lockfile = readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8');

/** The root importer's `name: { specifier, version }` entries, as pnpm wrote them. */
function lockfileSpecifiers(): Record<string, string> {
  const importers = lockfile.slice(lockfile.indexOf('\nimporters:'), lockfile.indexOf('\npackages:'));
  const specifiers: Record<string, string> = {};
  for (const [, name, specifier] of importers.matchAll(/\n {6}'?([^'\n:]+)'?:\n {8}specifier: (.+)\n {8}version:/g))
    specifiers[name] = specifier.trim();
  return specifiers;
}

describe('what a packaged build depends on', () => {
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };

  // A range lets a packaged app hold a version nobody verified; everything here
  // is pinned, so the tree electron-builder walks is the tree the lockfile names.
  it('pins every dependency to an exact version', () => {
    const ranged = Object.entries(declared).filter(([, version]) => !/^\d+\.\d+\.\d+$/.test(version));
    expect(ranged).toEqual([]);
  });

  it('agrees with the lockfile, name for name', () => {
    const locked = lockfileSpecifiers();
    expect(Object.keys(locked).sort()).toEqual(Object.keys(declared).sort());
    for (const [name, specifier] of Object.entries(locked)) expect(specifier).toBe(declared[name]);
  });
});

describe('what electron-builder is told to ship', () => {
  it('ships the build output and the manifest', () => {
    expect(manifest.build.files).toContain('out/**/*');
    expect(manifest.build.files).toContain('package.json');
  });

  it('copies extraResources folders that exist', () => {
    for (const resource of manifest.build.extraResources) expect(existsSync(path.join(root, resource.from)), resource.from).toBe(true);
  });

  // Reads through app.asar reach an unpacked file transparently, but spawn()
  // and dlopen() need the real path, and a package manager or an agent that
  // writes beside its own files needs a real folder. Each of these is resolved
  // at runtime by main; none may be left inside the archive alone.
  it('unpacks every path the app needs as a real file', () => {
    const needed: Array<[string, string]> = [
      ['better-sqlite3 binding', 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'],
      ['node-pty spawn-helper (terminal/native.ts)', 'node_modules/node-pty/build/Release/spawn-helper'],
      ['Pi rpc entry (chat/pi-session.ts)', 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/rpc-entry.js'],
      ['Pi cli entry (terminal/cli-workers.ts)', 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'],
      ['Hello’s Pi extension (chat/pi-session.ts)', 'out/main/pi-extension.js'],
      ['bundled pnpm (dsh/pnpm.ts)', 'node_modules/pnpm/bin/pnpm.cjs'],
      ['esbuild (extensions/bundle.ts)', 'node_modules/esbuild/lib/main.js'],
      ['esbuild binary (ESBUILD_BINARY_PATH)', 'node_modules/@esbuild/darwin-arm64/bin/esbuild'],
    ];
    for (const [what, file] of needed)
      expect(manifest.build.asarUnpack.some(pattern => minimatch(file, pattern)), `${what}: ${file}`).toBe(true);
  });

  it('keeps the microphone usage description a packaged build needs', () => {
    expect(manifest.build.mac.extendInfo?.NSMicrophoneUsageDescription).toMatch(/\S/);
  });
});
