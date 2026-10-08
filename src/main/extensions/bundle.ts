import { existsSync, readFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BuildFailure, Metafile } from 'esbuild';

// A Pi extension may import npm packages. Pi resolves them from a
// node_modules folder beside the extension, but Hello's approved copy never
// holds one: it copies the files a person can review, not a dependency tree.
// So an extension that imports packages is bundled once, at import, from the
// folder the person chose — its code and exactly the packages it reaches, in
// one file beside its entry — and that file is what Pi loads. Bundling only
// parses; no plugin code and no install script runs here.

/** Modules Pi hands every extension itself (the loader's aliases); never bundled. */
export const PI_PROVIDED_MODULES = [
  '@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-tui', '@earendil-works/pi-ai',
  '@mariozechner/pi-coding-agent', '@mariozechner/pi-agent-core', '@mariozechner/pi-tui', '@mariozechner/pi-ai',
  'typebox', '@sinclair/typebox',
];

const EXTERNAL = [
  ...PI_PROVIDED_MODULES.flatMap(name => [name, `${name}/*`]),
  ...builtinModules.flatMap(name => [name, `${name}/*`]),
  'node:*',
];

/** The approved copy's per-file limit applies to a bundle too. */
export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
export const BUNDLE_SUFFIX = '.hello-bundle.mjs';

// CommonJS packages inside an ES module still call require() for built-ins.
const BANNER = "import { createRequire as __helloCreateRequire } from 'node:module';\nconst require = __helloCreateRequire(import.meta.url);";

export interface ExtensionBundle {
  /** The extension entry, relative to the plugin folder. */
  entry: string;
  /** The bundle beside it, relative to the plugin folder: what Pi loads. */
  file: string;
  /** The npm packages the bundle holds. */
  packages: string[];
  code: string;
}

/**
 * The bundle's name, beside the entry so that anything the extension finds
 * through `import.meta.url` (its package.json, a prompt file) is where it was.
 */
export function bundleName(entry: string): string {
  const directory = dirname(entry);
  const file = `${basename(entry, extname(entry))}${BUNDLE_SUFFIX}`;
  return directory === '.' ? file : `${directory}/${file}`;
}

/** Folders the approved copy leaves out, as library.ts collects it. */
const SKIPPED = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.DS_Store']);

/** Whether a resolved input is code the approved copy will not hold. */
function outsideCopy(root: string, absolute: string): boolean {
  const inside = relative(root, absolute);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return true;
  return inside.split(sep).slice(0, -1).some(part => SKIPPED.has(part) || (part.startsWith('.') && part !== '.pi'));
}

/** The name in the nearest package.json above a file; else what its node_modules path says, else its folder. */
function packageOf(file: string): string {
  let directory = dirname(file);
  for (let depth = 0; depth < 64; depth++) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      try {
        const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name;
        if (typeof name === 'string' && name) return name;
      } catch { /* an unreadable manifest names nothing */ }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const parts = file.split(/[\\/]/);
  const at = parts.lastIndexOf('node_modules');
  if (at >= 0 && parts[at + 1]) return parts[at + 1].startsWith('@') && parts[at + 2] ? `${parts[at + 1]}/${parts[at + 2]}` : parts[at + 1];
  return basename(dirname(file));
}

/**
 * The packages an import graph reached outside what the approved copy holds:
 * node_modules, a hoisted or linked package elsewhere on disk, a skipped
 * folder. Any of them means the entry cannot load from the copy alone.
 */
export function packagesIn(metafile: Metafile, root: string): string[] {
  const names = new Set<string>();
  for (const input of Object.keys(metafile.inputs)) {
    const absolute = resolve(root, input);
    if (outsideCopy(root, absolute)) names.add(packageOf(absolute));
  }
  return [...names].sort();
}

/** The packages behind the specifiers esbuild could not resolve: `@scope/pkg/sub` is `@scope/pkg`. */
function missingPackages(failure: BuildFailure): string[] {
  return [...new Set(failure.errors
    .map(error => /^Could not resolve "([^"]+)"/.exec(error.text)?.[1])
    .filter((name): name is string => Boolean(name))
    .map(name => name.startsWith('.') || name.startsWith('/') ? name : name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/')))];
}

/**
 * Bundles one extension entry when it imports npm packages; null when it
 * imports none, and Pi can load the entry itself. A package that is not
 * installed in the folder is named, so the person knows what to install.
 */
export async function bundleExtension(root: string, entry: string): Promise<ExtensionBundle | null> {
  const { build } = await loadEsbuild();
  let result;
  try {
    result = await build({
      entryPoints: [join(root, ...entry.split('/'))],
      absWorkingDir: root,
      bundle: true,
      write: false,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external: EXTERNAL,
      metafile: true,
      logLevel: 'silent',
      banner: { js: BANNER },
    });
  } catch (error) {
    const failure = error as BuildFailure;
    const missing = Array.isArray(failure.errors) ? missingPackages(failure) : [];
    if (missing.length)
      throw new Error(`${entry} imports ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not installed in that folder. Install the plugin’s dependencies there (for example with npm install), then import it again.`);
    const first = Array.isArray(failure.errors) ? failure.errors[0] : undefined;
    throw new Error(`${entry} could not be prepared for Pi: ${first ? `${first.text}${first.location ? ` (${first.location.file}:${first.location.line})` : ''}` : (error instanceof Error ? error.message : String(error))}`);
  }
  const packages = packagesIn(result.metafile, root);
  if (!packages.length) return null;
  const code = result.outputFiles[0]?.text ?? '';
  if (Buffer.byteLength(code) > MAX_BUNDLE_BYTES)
    throw new Error(`${entry} with its npm packages (${packages.join(', ')}) is larger than the 2 MB a Hello extension may be.`);
  return { entry, file: bundleName(entry), packages, code };
}

/**
 * esbuild runs a native binary it finds beside its package. Inside a packaged
 * app that path points into app.asar, which spawn() cannot execute; the copy
 * electron-builder unpacks sits in app.asar.unpacked. esbuild reads
 * ESBUILD_BINARY_PATH once, when it loads, so it is set first and esbuild is
 * loaded on first use.
 */
let esbuild: Promise<typeof import('esbuild')> | undefined;
function loadEsbuild(): Promise<typeof import('esbuild')> {
  return esbuild ??= (async () => {
    if (!process.env.ESBUILD_BINARY_PATH) {
      try {
        const require = createRequire(import.meta.url);
        const binary = require.resolve(`@esbuild/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`);
        const packed = `${sep}app.asar${sep}`;
        const unpacked = binary.replace(packed, `${sep}app.asar.unpacked${sep}`);
        // Only when electron-builder really unpacked it (packaging.test.ts keeps
        // the pattern): a path that is not there would replace esbuild's own
        // "binary not found" with a spawn failure nobody can read.
        if (binary.includes(packed) && existsSync(unpacked)) process.env.ESBUILD_BINARY_PATH = unpacked;
      } catch {
        // No platform package to point at: esbuild reports that itself.
      }
    }
    return import('esbuild');
  })();
}

/** Whether a path inside a plugin is one of Hello's own bundles. */
export function isBundleFile(relative: string): boolean {
  return relative.split(sep).join('/').endsWith(BUNDLE_SUFFIX);
}
