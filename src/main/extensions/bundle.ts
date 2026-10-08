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

/**
 * CommonJS packages inside an ES module still call require() — for built-ins,
 * and for the modules Pi provides.
 *
 * Pi aliases those specifiers for its loader, so an `import` of them resolves
 * wherever the extension sits. A `require()` of one does not: createRequire
 * looks for a node_modules beside the bundle, and the approved copy in Hello's
 * library has none — in a packaged app there is no node_modules on that path at
 * all. So the prologue imports exactly the Pi modules this bundle reached, as
 * ESM, and hands them to require() by name; everything else still goes to
 * Node's own require, with its resolve/cache kept.
 */
export function bundlePrologue(piProvided: readonly string[] = []): string {
  const lines = ["import { createRequire as __helloCreateRequire } from 'node:module';"];
  const names = piProvided.map((specifier, index) => [specifier, `__helloPi${index}`] as const);
  for (const [specifier, binding] of names) lines.push(`import * as ${binding} from '${specifier}';`);
  lines.push('const __helloNodeRequire = __helloCreateRequire(import.meta.url);');
  if (!names.length) return `${lines.join('\n')}\nconst require = __helloNodeRequire;`;
  lines.push(`const __helloPiProvided = new Map([${names.map(([specifier, binding]) => `['${specifier}', ${binding}]`).join(', ')}]);`);
  // Object.assign keeps require.resolve and require.cache on the function.
  lines.push('const require = Object.assign((__helloId) => __helloPiProvided.get(__helloId) ?? __helloNodeRequire(__helloId), __helloNodeRequire);');
  return lines.join('\n');
}

/** The Pi-provided modules a built bundle still imports, in the order esbuild recorded them. */
export function piProvidedIn(metafile: Metafile): string[] {
  const provided = new Set(PI_PROVIDED_MODULES);
  const found = new Set<string>();
  for (const output of Object.values(metafile.outputs))
    for (const imported of output.imports ?? [])
      if (imported.external && provided.has(imported.path)) found.add(imported.path);
  return [...found];
}

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

/**
 * What esbuild could not resolve, told apart: npm packages (`@scope/pkg/sub` is
 * `@scope/pkg`) the person can install, and paths inside the plugin that are
 * simply not there. The published OpenViking extension is the second kind — its
 * `shared/` folder is generated at build time and never shipped — and telling
 * someone to install the dependencies of a missing file of its own was a dead
 * end.
 */
export function unresolved(failure: BuildFailure): { packages: string[]; files: string[] } {
  const names = [...new Set(failure.errors
    .map(error => /^Could not resolve "([^"]+)"/.exec(error.text)?.[1])
    .filter((name): name is string => Boolean(name)))];
  return {
    packages: [...new Set(names.filter(name => !name.startsWith('.') && !name.startsWith('/'))
      .map(name => name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/')))],
    files: names.filter(name => name.startsWith('.') || name.startsWith('/')),
  };
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
    });
  } catch (error) {
    const failure = error as BuildFailure;
    const missing = Array.isArray(failure.errors) ? unresolved(failure) : { packages: [], files: [] };
    if (missing.files.length)
      throw new Error(`${entry} imports ${missing.files.join(', ')}, which ${missing.files.length === 1 ? 'is' : 'are'} not in that folder. Some extensions generate those files when they are built, and a published copy does not carry them: build the plugin in its own folder first, then import it again.`);
    if (missing.packages.length)
      throw new Error(`${entry} imports ${missing.packages.join(', ')}, which ${missing.packages.length === 1 ? 'is' : 'are'} not installed in that folder. Install the plugin’s dependencies there (for example with npm install), then import it again.`);
    const first = Array.isArray(failure.errors) ? failure.errors[0] : undefined;
    throw new Error(`${entry} could not be prepared for Pi: ${first ? `${first.text}${first.location ? ` (${first.location.file}:${first.location.line})` : ''}` : (error instanceof Error ? error.message : String(error))}`);
  }
  const packages = packagesIn(result.metafile, root);
  if (!packages.length) return null;
  // The prologue is written here, not as esbuild's banner, because it depends
  // on which Pi modules the finished bundle still imports.
  const code = `${bundlePrologue(piProvidedIn(result.metafile))}\n${result.outputFiles[0]?.text ?? ''}`;
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
