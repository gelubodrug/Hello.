import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { minimatch } from 'minimatch';
import type { LibraryResource, McpServerInput, ResourceKind, ResourceState } from '../../shared/types';
import type { DataStore, ResourceRow } from '../data/store';
import { bundleExtension, isBundleFile, type ExtensionBundle } from './bundle';

// Hello owns an approved COPY of every imported skill and plugin. Editing the
// original folder afterwards cannot change what an activated conversation
// loads, and editing Hello's copy is detected instead of used. Nothing here
// executes imported code, resolves a package manager or reaches the network.

const MAX_FILES = 400;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 8;

/** How much of a folder Hello reads, copies and fingerprints. */
export interface CollectLimits { files: number; totalBytes: number; fileBytes: number; depth: number }
const IMPORT_LIMITS: CollectLimits = { files: MAX_FILES, totalBytes: MAX_TOTAL_BYTES, fileBytes: MAX_FILE_BYTES, depth: MAX_DEPTH };
/**
 * A Pi package installed from the market with pnpm (user, 29.09: "pnpm ca la
 * DSH"): its own files, not its dependencies, which the lockfile pins. The
 * popular ones run to a thousand files and tens of megabytes.
 */
export const INSTALLED_LIMITS: CollectLimits = { files: 5000, totalBytes: 100 * 1024 * 1024, fileBytes: 50 * 1024 * 1024, depth: 16 };
const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
/** Extension entry points Pi can load with -e. */
const CODE_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs']);
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.DS_Store']);

export interface LibraryPaths {
  /** Approved copy, inside Hello's own data directory. */
  directory: string;
}

export interface ActiveResources {
  skills: Array<{ row: ResourceRow; directory: string; entry: string }>;
  extensions: Array<{ row: ResourceRow; files: string[] }>;
  pluginSkills: Array<{ row: ResourceRow; directory: string }>;
  prompts: string[];
  mcp: ResourceRow[];
  blocked: Array<{ name: string; kind: ResourceKind; state: ResourceState }>;
  /** Skill name → approved folder, resolved once per run. */
  skillDirectories: Array<{ name: string; directory: string }>;
  /** `id:fingerprint` for each activated resource. */
  identity: string[];
}

export interface SkillConfig { entry: string; files: string[]; }
export interface PluginConfig {
  extensions: string[]; skills: string[]; prompts: string[]; files: string[]; dependencies: string[];
  /** Extensions that import npm packages, bundled at import; `extensions` lists the bundle instead of the entry. */
  bundles?: Array<{ entry: string; file: string; packages: string[] }>;
  /**
   * Installed by pnpm, with its dependencies beside it: the library folder is
   * the install, and the paths above are relative to the package inside it.
   */
  installed?: { manager: 'pnpm'; package: string; root: string };
}

/** Where a plugin's paths start: its folder, or the installed package inside it. */
export function pluginRoot(directory: string, config: PluginConfig): string {
  return config.installed ? join(directory, ...config.installed.root.split('/')) : directory;
}
/**
 * A server Hello starts on this Mac (stdio: command, args, cwd), or one it
 * reaches over streamable HTTP (url). `envNames` names the values kept in the
 * encrypted store: the process's environment, or the HTTP server's headers.
 */
export interface McpConfig { command: string; args: string[]; cwd: string | null; envNames: string[]; transport?: 'stdio' | 'http'; url?: string; }

/**
 * Where an HTTP MCP server may be: https anywhere, plain http only on this Mac
 * — the request carries the tool's arguments and any token. Throws the reason.
 */
export function mcpServerUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter the server URL, like https://mcp.example.com/mcp.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('An MCP server URL must use https, or http on this Mac (localhost).');
  if (url.username || url.password) throw new Error('Put credentials in a header, not in the URL.');
  if (url.href.length > 2048) throw new Error('The server URL is too long.');
  return url.href;
}

export function libraryRoot(dataDir: string): string {
  return join(dataDir, 'library');
}
export function resourceDirectory(dataDir: string, row: Pick<ResourceRow, 'id' | 'kind'>): string {
  return join(libraryRoot(dataDir), `${row.kind}s`, row.id);
}

export function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

/** Use the same YAML syntax as Pi, including folded/multiline descriptions. */
export function parseFrontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ''));
  if (!match) return {};
  const value: unknown = parseYaml(match[1], { maxAliasCount: 20 });
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Skill front matter must be a YAML mapping.');
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, text]) => [key, text.trim().slice(0, 2000)]));
}

interface CollectedFile { relative: string; absolute: string; size: number; }

/** Depth-first listing that refuses symlinks, specials and oversized trees. */
async function collect(root: string, limits: CollectLimits = IMPORT_LIMITS): Promise<CollectedFile[]> {
  const files: CollectedFile[] = [];
  let total = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > limits.depth) throw new Error(`This folder nests deeper than Hello imports (${limits.depth} levels).`);
    const entries = await readdir(directory, { withFileTypes: true });
    // Byte-stable order: a locale-dependent sort would change the fingerprint
    // when the system language changes and flag every resource as modified.
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const absolute = join(directory, entry.name);
      const info = await lstat(absolute);
      // Checked BEFORE the skip lists: a link named `node_modules` inside an
      // approved copy would otherwise be invisible to both copy and fingerprint.
      if (info.isSymbolicLink())
        throw new Error(`Remove the symbolic link “${relative(root, absolute)}” before importing; Hello copies real files only.`);
      if (entry.name.startsWith('.') && entry.name !== '.pi') continue;
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      if (info.isDirectory()) { await walk(absolute, depth + 1); continue; }
      if (!info.isFile()) continue;
      if (info.size > limits.fileBytes)
        throw new Error(`“${relative(root, absolute)}” is larger than the ${megabytes(limits.fileBytes)} per-file import limit.`);
      total += info.size;
      if (files.length >= limits.files) throw new Error(`This package contains more than ${limits.files} files.`);
      if (total > limits.totalBytes) throw new Error(`This package is larger than the ${megabytes(limits.totalBytes)} import limit.`);
      files.push({ relative: relative(root, absolute).split(sep).join('/'), absolute, size: info.size });
    }
  };
  await walk(root, 0);
  return files;
}

async function fingerprintOf(files: CollectedFile[]): Promise<string> {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0))) {
    hash.update(file.relative);
    hash.update('\0');
    hash.update(createHash('sha256').update(await readFile(file.absolute)).digest());
  }
  return hash.digest('hex').slice(0, 32);
}

/** An installed package's fingerprint: its own files, and the lockfile that pins what it depends on. */
async function installedFingerprint(files: CollectedFile[], lockfile: Buffer): Promise<string> {
  return createHash('sha256').update(await fingerprintOf(files)).update('\0')
    .update(createHash('sha256').update(lockfile).digest()).digest('hex').slice(0, 32);
}

async function copyTree(files: CollectedFile[], destination: string): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = join(destination, file.relative);
    if (!target.startsWith(destination + sep)) throw new Error('Refusing to import a path outside the library folder.');
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(file.absolute, target);
  }
}

export interface ImportedResource {
  kind: ResourceKind;
  name: string;
  description: string;
  version: string;
  fingerprint: string;
  config: SkillConfig | PluginConfig;
  warning?: string;
  files: CollectedFile[];
  root: string;
}

/** A skill is SKILL.md plus its folder, or a single standalone .md skill file. */
export async function readSkill(target: string): Promise<ImportedResource> {
  const absolute = resolve(target);
  const info = await stat(absolute);
  let root: string;
  let entry: string;
  if (info.isFile()) {
    if (info.size > MAX_FILE_BYTES) throw new Error('This skill exceeds the 2 MB file limit.');
    if (extname(absolute).toLowerCase() !== '.md')
      throw new Error('Choose a SKILL.md file or the folder that contains it.');
    root = dirname(absolute);
    entry = basename(absolute);
    // A lone Markdown file is imported on its own; its folder may hold others.
    const text = await readFile(absolute, 'utf8');
    const meta = parseFrontmatter(text);
    if (!meta.name || !meta.description)
      throw new Error('This Markdown file has no skill front matter with a name and description.');
    const files: CollectedFile[] = [{ relative: 'SKILL.md', absolute, size: info.size }];
    return {
      kind: 'skill', name: meta.name, description: meta.description,
      version: meta.version ?? '', fingerprint: await fingerprintOf(files),
      config: { entry: 'SKILL.md', files: ['SKILL.md'] }, files, root,
    };
  }
  root = absolute;
  entry = 'SKILL.md';
  const files = await collect(root);
  const manifest = files.find(file => file.relative === 'SKILL.md');
  if (!manifest) throw new Error('This folder has no SKILL.md file.');
  const meta = parseFrontmatter(await readFile(manifest.absolute, 'utf8'));
  if (!meta.description)
    throw new Error('SKILL.md needs front matter with a description so the model knows when to use it.');
  return {
    kind: 'skill', name: meta.name || basename(root), description: meta.description,
    version: meta.version ?? '', fingerprint: await fingerprintOf(files),
    config: { entry, files: files.map(file => file.relative) }, files, root,
  };
}

/** A plugin is a Pi package folder: declared `pi` resources or the conventional layout. */
export async function readPlugin(target: string, limits: CollectLimits = IMPORT_LIMITS): Promise<ImportedResource> {
  const root = resolve(target);
  const link = await lstat(root);
  // A single .ts/.js file is an extension on its own, the way Pi loads one
  // from its extensions folder.
  if (link.isFile() && CODE_EXTENSIONS.has(extname(root))) return readSingleExtension(root, link.size);
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error('Choose the plugin folder that contains package.json, or a single extension file.');
  const files = await collect(root, limits);
  let manifest: Record<string, unknown> = {};
  const packageFile = files.find(file => file.relative === 'package.json');
  if (packageFile) {
    try { manifest = JSON.parse(await readFile(packageFile.absolute, 'utf8')) as Record<string, unknown>; }
    catch { throw new Error('package.json in this folder is not valid JSON.'); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('package.json must be an object.');
  }
  const pi = (manifest.pi && typeof manifest.pi === 'object' && !Array.isArray(manifest.pi)
    ? manifest.pi : {}) as Record<string, unknown>;
  // An explicit Pi manifest is authoritative. Conventional folders are only
  // used in its absence; exclusions must not be re-added by auto-discovery.
  const select = (key: string, accepts: (file: string) => boolean): string[] => {
    const specs: unknown = manifest.pi === undefined ? [key] : (pi[key] ?? []);
    if (!Array.isArray(specs) || specs.some(value => typeof value !== 'string')) throw new Error(`pi.${key} must be a list of paths.`);
    const selected = new Set<string>();
    for (const spec of specs as string[]) {
      const exclude = spec.startsWith('!');
      const pattern = (exclude ? spec.slice(1) : spec).replace(/^\.\//, '').replace(/\/$/, '');
      if (!pattern || isAbsolute(pattern) || pattern.split('/').includes('..') || pattern.includes('\\'))
        throw new Error(`pi.${key} must reference files inside the plugin.`);
      const directoryMatch = (file: string): boolean => {
        if (!file.startsWith(`${pattern}/`)) return false;
        if (key !== 'extensions') return true;
        const rootIndex = files.find(f => f.relative === `${pattern}/index.ts`) ?? files.find(f => f.relative === `${pattern}/index.js`);
        if (rootIndex) return file === rootIndex.relative;
        const tail = file.slice(pattern.length + 1);
        if (!tail.includes('/')) return true;
        const [folder, entry, rest] = tail.split('/');
        if (rest !== undefined) return false;
        const index = files.find(f => f.relative === `${pattern}/${folder}/index.ts`) ?? files.find(f => f.relative === `${pattern}/${folder}/index.js`);
        return Boolean(index && file === index.relative && entry);
      };
      const matches = files.filter(file => accepts(file.relative) &&
        (file.relative === pattern || directoryMatch(file.relative) || minimatch(file.relative, pattern, { dot: true })));
      if (!exclude && !matches.length && manifest.pi !== undefined) throw new Error(`pi.${key} entry “${spec}” matches no supported files.`);
      for (const file of matches) exclude ? selected.delete(file.relative) : selected.add(file.relative);
    }
    return [...selected];
  };
  if (files.some(file => isBundleFile(file.relative)))
    throw new Error('This folder holds a Hello bundle (*.hello-bundle.mjs). Import the plugin’s own folder, not a copy from Hello’s library.');
  let extensions = select('extensions', file => CODE_EXTENSIONS.has(extname(file)));
  // Pi's own rule for a directory of extensions: one holding index.ts or
  // index.js is an extension. The way such an extension is published, without
  // a "pi" section, it is exactly that directory.
  const skills = select('skills', file => basename(file) === 'SKILL.md').map(file => dirname(file));
  const prompts = select('prompts', file => extname(file) === '.md');
  if (manifest.pi === undefined && !extensions.length && !skills.length && !prompts.length) {
    const index = files.find(file => file.relative === 'index.ts') ?? files.find(file => file.relative === 'index.js');
    if (index) extensions = [index.relative];
  }
  const unique = (list: string[]) => [...new Set(list)].sort();
  const resources = { extensions: unique(extensions), skills: unique(skills), prompts: unique(prompts) };
  if (!resources.extensions.length && !resources.skills.length && !resources.prompts.length)
    throw new Error('No Pi resources found. A plugin needs an extensions/, skills/ or prompts/ folder, an index.ts, or a "pi" section in package.json.');
  const dependencies = Object.keys((manifest.dependencies as Record<string, string> | undefined) ?? {});
  const name = slug(String(manifest.name ?? '') || basename(root));
  const description = String(manifest.description ?? '').slice(0, 2000) ||
    `Pi package with ${resources.extensions.length} extension(s), ${resources.skills.length} skill(s).`;
  return {
    kind: 'plugin', name, description, version: String(manifest.version ?? ''),
    fingerprint: await fingerprintOf(files),
    config: { ...resources, files: files.map(file => file.relative), dependencies },
    files, root,
  };
}

async function readSingleExtension(file: string, size: number): Promise<ImportedResource> {
  if (size > MAX_FILE_BYTES) throw new Error('This extension is larger than the 2 MB per-file import limit.');
  if (isBundleFile(basename(file))) throw new Error('This is a Hello bundle (*.hello-bundle.mjs). Import the extension’s own file.');
  const collected = { relative: basename(file), absolute: file, size };
  const name = slug(basename(file, extname(file)));
  return {
    kind: 'plugin', name, description: `Pi extension ${basename(file)}.`, version: '',
    fingerprint: await fingerprintOf([collected]),
    config: { extensions: [collected.relative], skills: [], prompts: [], files: [collected.relative], dependencies: [] },
    files: [collected], root: dirname(file),
  };
}

/** Bundles the plugin's extensions that import npm packages; throws, naming what is missing, before anything is copied. */
async function bundlesFor(imported: ImportedResource): Promise<ExtensionBundle[]> {
  const bundles: ExtensionBundle[] = [];
  for (const entry of (imported.config as PluginConfig).extensions) {
    const bundle = await bundleExtension(imported.root, entry);
    if (!bundle) continue;
    const clash = bundles.find(other => other.file === bundle.file);
    if (clash) throw new Error(`${clash.entry} and ${entry} would both be bundled as ${bundle.file}. Rename one of them.`);
    bundles.push(bundle);
  }
  return bundles;
}

function detailFor(row: ResourceRow): string {
  const config = parseConfig(row);
  if (row.kind === 'skill') return `${(config as SkillConfig).files.length} file(s)`;
  if (row.kind === 'plugin') {
    const plugin = config as PluginConfig;
    return [
      plugin.extensions.length ? `${plugin.extensions.length} extension(s)` : '',
      plugin.skills.length ? `${plugin.skills.length} skill(s)` : '',
      plugin.prompts.length ? `${plugin.prompts.length} prompt(s)` : '',
    ].filter(Boolean).join(' · ') || 'no resources';
  }
  const mcp = config as McpConfig;
  if (mcp.transport === 'http' && mcp.url) return `http · ${mcp.url.replace(/^https?:\/\//, '')}`.slice(0, 120);
  // The full command line lives in the details; the row stays readable.
  const command = basename(mcp.command) || mcp.command;
  const first = mcp.args[0] ? ` ${basename(mcp.args[0])}` : '';
  const rest = mcp.args.length > 1 ? ` +${mcp.args.length - 1}` : '';
  return `stdio · ${command}${first}${rest}`.slice(0, 120);
}

function entriesFor(row: ResourceRow): string[] {
  const config = parseConfig(row);
  if (row.kind === 'skill') return (config as SkillConfig).files.slice(0, 50);
  if (row.kind === 'plugin') {
    const plugin = config as PluginConfig;
    const bundled = new Map((plugin.bundles ?? []).map(bundle => [bundle.file, bundle]));
    return [
      ...plugin.extensions.map(file => {
        const bundle = bundled.get(file);
        return bundle ? `extension: ${bundle.entry}, bundled with ${bundle.packages.join(', ')}` : `extension: ${file}`;
      }),
      ...plugin.skills.map(file => `skill: ${file}`),
      ...plugin.prompts.map(file => `prompt: ${file}`),
    ].slice(0, 50);
  }
  const mcp = config as McpConfig;
  return mcp.envNames.map(name => `${mcp.transport === 'http' ? 'header' : 'env'}: ${name}`);
}

export function parseConfig(row: ResourceRow): SkillConfig | PluginConfig | McpConfig {
  try { return JSON.parse(row.config) as SkillConfig | PluginConfig | McpConfig; }
  catch { return row.kind === 'mcp' ? { command: '', args: [], cwd: null, envNames: [] } : { entry: 'SKILL.md', files: [] }; }
}

export class ResourceLibrary {
  /**
   * Sources that are not a folder on this Mac (a skills.sh id): written to a
   * staging folder for the re-import, then removed (skill-catalog.ts).
   */
  remote?: (source: string) => Promise<{ path: string; dispose(): Promise<void> }> | null;
  /** Updates a package installed with pnpm (the Pi market): it is fetched again, not re-read from a folder. */
  packages?: { update(row: ResourceRow): Promise<LibraryResource> };

  constructor(private readonly store: DataStore) {}

  private directory(row: Pick<ResourceRow, 'id' | 'kind'>): string {
    return resourceDirectory(this.store.dataDir, row);
  }

  /** Approved copy on disk, recomputed. `modified` never loads. */
  async verify(row: ResourceRow): Promise<ResourceState> {
    if (row.kind === 'mcp') return 'ready';
    const directory = this.directory(row);
    try {
      const config = row.kind === 'plugin' ? parseConfig(row) as PluginConfig : undefined;
      if (config?.installed) {
        const files = await collect(pluginRoot(directory, config), INSTALLED_LIMITS);
        if (!files.length) return 'missing';
        const lockfile = await readFile(join(directory, 'pnpm-lock.yaml'));
        return (await installedFingerprint(files, lockfile)) === row.fingerprint ? 'ready' : 'modified';
      }
      const files = await collect(directory);
      if (!files.length) return 'missing';
      return (await fingerprintOf(files)) === row.fingerprint ? 'ready' : 'modified';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      return 'modified';
    }
  }

  async describe(row: ResourceRow): Promise<LibraryResource> {
    return {
      id: row.id, kind: row.kind, name: row.name, description: row.description,
      source: row.source, version: row.version, fingerprint: row.fingerprint.slice(0, 12),
      state: await this.verify(row), detail: detailFor(row), entries: entriesFor(row),
      createdAt: row.createdAt, updatedAt: row.updatedAt,
      ...(row.kind === 'mcp' ? { mcp: parseConfig(row) as McpConfig } : {}),
    };
  }

  async list(): Promise<LibraryResource[]> {
    return Promise.all(this.store.listResourceRows().map(row => this.describe(row)));
  }

  /** Import (or update) a skill/plugin from a path the human picked. */
  async importPath(kind: 'skill' | 'plugin', target: string, existingId?: string): Promise<LibraryResource> {
    const imported = kind === 'skill' ? await readSkill(target) : await readPlugin(target);
    if (!imported.name) throw new Error('This resource has no usable name.');
    const previous = existingId ? this.store.getResourceRow(existingId) : this.store.findResourceRow(kind, imported.name);
    if (previous && previous.kind !== kind) throw new Error('A different kind of extension already uses this name.');
    // A second folder claiming an installed name would take over the approved
    // copy every activated conversation already uses. That decision is the
    // human's: re-import from the same source, or remove the old one first.
    if (previous && !existingId && resolve(previous.source) !== resolve(target))
      throw new Error(`“${imported.name}” is already installed from ${previous.source}. Remove it first, or use its re-import button to update it from that source.`);
    const id = previous?.id ?? randomUUID();
    const nameClash = this.store.findResourceRow(kind, imported.name);
    if (nameClash && nameClash.id !== id) throw new Error(`Another ${kind} named “${imported.name}” is already imported.`);
    // Bundled first, in memory: a missing package stops the import before the
    // approved copy is touched.
    const bundles = kind === 'plugin' ? await bundlesFor(imported) : [];
    const directory = this.directory({ id, kind });
    // The new copy is built beside the old one and replaces it only once it
    // passes the same collection verification later recomputes, so a failed
    // re-import leaves the approved copy as it was.
    const incoming = `${directory}.incoming-${randomUUID().slice(0, 8)}`;
    let fingerprint = imported.fingerprint;
    try {
      await copyTree(imported.files, incoming);
      for (const bundle of bundles) await writeFile(join(incoming, ...bundle.file.split('/')), bundle.code, { mode: 0o600 });
      const copied = await collect(incoming);
      // The approved copy is what verification recomputes: bundles included.
      if (bundles.length) fingerprint = await fingerprintOf(copied);
    } catch (error) {
      await rm(incoming, { recursive: true, force: true });
      throw error;
    }
    await rm(directory, { recursive: true, force: true });
    await rename(incoming, directory);
    let config = imported.config;
    if (bundles.length) {
      const plugin = imported.config as PluginConfig;
      const byEntry = new Map(bundles.map(bundle => [bundle.entry, bundle.file]));
      config = {
        ...plugin,
        extensions: plugin.extensions.map(entry => byEntry.get(entry) ?? entry),
        files: [...plugin.files, ...bundles.map(bundle => bundle.file)].sort(),
        bundles: bundles.map(({ entry, file, packages }) => ({ entry, file, packages })),
      };
    }
    const row = this.store.saveResourceRow({
      id, kind, name: imported.name, description: imported.description,
      source: resolve(target), version: imported.version, fingerprint,
      config: JSON.stringify(config),
    });
    const described = await this.describe(row);
    return imported.warning ? { ...described, warning: imported.warning } : described;
  }

  /**
   * Adopts a pnpm install as a plugin (the Pi market, user 29.09). The project
   * folder becomes the library folder whole — the package and the
   * dependencies pnpm put beside it — and the fingerprint covers the
   * package's own files and the lockfile that pins the rest. It replaces an
   * earlier install of the same row in one rename, once it is complete.
   * Nothing here runs the package or pnpm.
   */
  async installPackage(project: string, packageName: string, source: string, existingId?: string): Promise<LibraryResource> {
    const root = ['node_modules', ...packageName.split('/')].join('/');
    const packageDirectory = join(project, ...root.split('/'));
    if (!(await lstat(packageDirectory)).isDirectory()) throw new Error(`${packageName} is not installed in that folder.`);
    const imported = await readPlugin(packageDirectory, INSTALLED_LIMITS);
    const lockfile = await readFile(join(project, 'pnpm-lock.yaml'));
    const previous = existingId ? this.store.getResourceRow(existingId) : this.store.findResourceRow('plugin', imported.name);
    if (previous && previous.kind !== 'plugin') throw new Error('A different kind of extension already uses this name.');
    if (previous && !existingId && previous.source !== source)
      throw new Error(`“${imported.name}” is already in the library from ${previous.source}. Remove it first.`);
    const id = previous?.id ?? randomUUID();
    const nameClash = this.store.findResourceRow('plugin', imported.name);
    if (nameClash && nameClash.id !== id) throw new Error(`Another plugin named “${imported.name}” is already imported.`);
    const fingerprint = await installedFingerprint(imported.files, lockfile);
    const directory = this.directory({ id, kind: 'plugin' });
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    const retired = `${directory}.retired-${randomUUID().slice(0, 8)}`;
    const replacing = await stat(directory).then(() => true, () => false);
    if (replacing) await rename(directory, retired);
    try {
      await rename(project, directory);
    } catch (error) {
      if (replacing) await rename(retired, directory).catch(() => {});
      throw error;
    }
    if (replacing) await rm(retired, { recursive: true, force: true });
    const config: PluginConfig = { ...(imported.config as PluginConfig), installed: { manager: 'pnpm', package: packageName, root } };
    const row = this.store.saveResourceRow({
      id, kind: 'plugin', name: imported.name, description: imported.description,
      source, version: imported.version, fingerprint, config: JSON.stringify(config),
    });
    return this.describe(row);
  }

  /** Re-import from the original path, replacing the approved copy. */
  async update(id: string): Promise<LibraryResource> {
    const row = this.store.getResourceRow(id);
    if (row.kind === 'mcp') throw new Error('Edit an MCP server by saving it again.');
    if (row.kind === 'plugin' && (parseConfig(row) as PluginConfig).installed) {
      if (!this.packages) throw new Error('Update this package from the Pi market.');
      return this.packages.update(row);
    }
    const remote = this.remote?.(row.source);
    if (!remote) return this.importPath(row.kind, row.source, id);
    const staged = await remote;
    try {
      const updated = await this.importPath(row.kind, staged.path, id);
      this.store.saveResourceRow({ ...this.store.getResourceRow(id), source: row.source });
      return { ...updated, source: row.source };
    } finally {
      await staged.dispose();
    }
  }

  addMcp(input: McpServerInput, existingId?: string): LibraryResource {
    if (input.url?.trim()) return this.addHttpMcp(input, existingId);
    const name = slug(input.name);
    if (!name) throw new Error('Give this server a name.');
    const command = input.command.trim();
    if (!command || command.length > 4096) throw new Error('Enter the server command.');
    if (/[\n\r\0]/.test(command)) throw new Error('The command cannot contain line breaks.');
    const args = input.args.map(value => String(value));
    if (args.some(value => value.length > 4096 || /[\n\r\0]/.test(value)) || args.length > 64)
      throw new Error('Arguments must be single-line values, at most 64 of them.');
    const env = Object.fromEntries(Object.entries(input.env ?? {})
      .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key))
      .map(([key, value]) => [key, String(value).slice(0, 8192)]));
    const cwd = input.cwd ? resolve(input.cwd) : null;
    if (existingId && this.store.getResourceRow(existingId).kind !== 'mcp') throw new Error('That resource is not an MCP server.');
    if (!existingId && this.store.findResourceRow('mcp', name)) throw new Error('An MCP server with this name already exists. Use Edit to change it.');
    const id = existingId ?? randomUUID();
    // Editing without retyping the values must not delete them.
    const keepExisting = Boolean(input.keepEnv) && Boolean(existingId);
    const stored = keepExisting ? this.store.resourceSecret(id) : env;
    const config: McpConfig = { command, args, cwd, envNames: Object.keys(stored).sort() };
    const row = this.store.saveResourceRow({
      id, kind: 'mcp', name, description: `Local MCP server (stdio).`,
      source: command, version: '', fingerprint: '',
      config: JSON.stringify(config),
    });
    // Values live in the encrypted secret store, never in the resources table.
    if (!keepExisting) this.store.saveResourceSecret(id, env);
    return {
      id: row.id, kind: 'mcp', name: row.name, description: row.description, source: row.source,
      version: '', fingerprint: '', state: 'ready', detail: detailFor(row), entries: entriesFor(row),
      createdAt: row.createdAt, updatedAt: row.updatedAt,
      mcp: config,
    };
  }

  /** A server reached over streamable HTTP: its address in the row, its headers encrypted beside it. */
  private addHttpMcp(input: McpServerInput, existingId?: string): LibraryResource {
    const name = slug(input.name);
    if (!name) throw new Error('Give this server a name.');
    const url = mcpServerUrl(input.url ?? '');
    const headers = Object.fromEntries(Object.entries(input.env ?? {})
      .filter(([key]) => /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(key))
      .map(([key, value]) => [key, String(value).replace(/[\r\n\0]/g, '').slice(0, 8192)]));
    if (existingId && this.store.getResourceRow(existingId).kind !== 'mcp') throw new Error('That resource is not an MCP server.');
    if (!existingId && this.store.findResourceRow('mcp', name)) throw new Error('An MCP server with this name already exists. Use Edit to change it.');
    const id = existingId ?? randomUUID();
    const keepExisting = Boolean(input.keepEnv) && Boolean(existingId);
    const stored = keepExisting ? this.store.resourceSecret(id) : headers;
    const config: McpConfig = { command: '', args: [], cwd: null, envNames: Object.keys(stored).sort(), transport: 'http', url };
    const before = existingId ? parseConfig(this.store.getResourceRow(existingId)) as McpConfig : null;
    const row = this.store.saveResourceRow({
      id, kind: 'mcp', name, description: 'Remote MCP server (streamable HTTP).',
      source: url, version: '', fingerprint: '',
      config: JSON.stringify(config),
    });
    if (!keepExisting) this.store.saveResourceSecret(id, headers);
    // A sign-in belongs to the address it was made for.
    if (before?.url && before.url !== url) this.store.saveResourceAuth(id, null);
    return {
      id: row.id, kind: 'mcp', name: row.name, description: row.description, source: row.source,
      version: '', fingerprint: '', state: 'ready', detail: detailFor(row), entries: entriesFor(row),
      createdAt: row.createdAt, updatedAt: row.updatedAt,
      mcp: config,
    };
  }

  async remove(id: string): Promise<ResourceRow> {
    const row = this.store.deleteResourceRow(id);
    if (row.kind !== 'mcp') await rm(this.directory(row), { recursive: true, force: true });
    return row;
  }

  /** Verified, activated resources for one conversation, grouped for launch. */
  async activeFor(conversationId: string): Promise<ActiveResources> {
    const result: ActiveResources = {
      skills: [], extensions: [], pluginSkills: [], prompts: [], mcp: [], blocked: [],
      skillDirectories: [], identity: [],
    };
    for (const id of this.store.activeResourceIds(conversationId)) {
      let row: ResourceRow;
      try { row = this.store.getResourceRow(id); } catch { continue; }
      const state = await this.verify(row);
      if (state !== 'ready') { result.blocked.push({ name: row.name, kind: row.kind, state }); continue; }
      const directory = this.directory(row);
      // The fingerprint, not the path, is what changes on a re-import.
      result.identity.push(`${row.id}:${row.fingerprint}:${row.kind === 'mcp' ? row.config : ''}`);
      if (row.kind === 'skill') {
        const config = parseConfig(row) as SkillConfig;
        result.skills.push({ row, directory, entry: join(directory, config.entry) });
      } else if (row.kind === 'plugin') {
        const config = parseConfig(row) as PluginConfig;
        const root = pluginRoot(directory, config);
        result.prompts.push(...config.prompts.map(file => join(root, file)));
        if (config.extensions.length) result.extensions.push({ row, files: config.extensions.map(file => join(root, file)) });
        for (const skill of config.skills) result.pluginSkills.push({ row, directory: join(root, skill) });
      } else result.mcp.push(row);
    }
    result.skillDirectories = [
      ...result.skills.map(item => ({ name: item.row.name, directory: item.directory })),
      ...await Promise.all(result.pluginSkills.map(async item => {
        const meta = parseFrontmatter(await readFile(join(item.directory, 'SKILL.md'), 'utf8'));
        return { name: meta.name || basename(item.directory), directory: item.directory };
      })),
    ];
    const names = new Set<string>();
    for (const skill of result.skillDirectories) {
      if (names.has(skill.name)) throw new Error(`Two active resources provide the skill “${skill.name}”. Turn one off for this chat.`);
      names.add(skill.name);
    }
    return result;
  }

  /** Read from the activated folders verified for this run, enforcing real-path
   * containment at read time. This is not a filesystem snapshot or an OS
   * sandbox against concurrent edits by another local process. */
  async readSkillFile(
    candidates: ReadonlyArray<{ name: string; directory: string }>,
    skillName: string,
    relativePath = 'SKILL.md',
  ): Promise<string> {
    const skill = candidates.find(item => item.name === skillName) ??
      candidates.find(item => item.name.toLowerCase() === skillName.trim().toLowerCase());
    if (!skill)
      throw new Error(`“${skillName}” is not an active skill in this chat. Active: ${candidates.map(item => item.name).join(', ') || 'none'}.`);
    const clean = relativePath.trim() || 'SKILL.md';
    if (clean.includes('\0') || isAbsolute(clean))
      throw new Error('Use a path inside the skill folder, such as references/api.md.');
    // Real paths on both sides: a lexical prefix check would follow a symlinked
    // directory planted inside the approved copy straight out of it.
    const root = await realpath(skill.directory);
    const target = await realpath(resolve(root, clean)).catch(() => null);
    if (!target || (target !== root && !target.startsWith(root + sep)))
      throw new Error(`“${clean}” is not a file inside the ${skillName} skill.`);
    const info = await lstat(target).catch(() => null);
    if (!info?.isFile()) throw new Error(`“${clean}” is not a file in the ${skillName} skill.`);
    if (info.size > MAX_FILE_BYTES) throw new Error('That skill file is too large to load into the conversation.');
    const buffer = await readFile(target);
    if (buffer.includes(0)) throw new Error('That skill file is binary; only text files can be loaded.');
    return buffer.toString('utf8').slice(0, 200_000);
  }

  /** Names and descriptions of activated skills, for the tool description. */
  async skillIndex(conversationId: string, snapshot?: ActiveResources): Promise<Array<{ name: string; description: string; files: string[] }>> {
    const active = snapshot ?? await this.activeFor(conversationId);
    const rows = active.skills.map(item => ({
      name: item.row.name, description: item.row.description,
      files: (parseConfig(item.row) as SkillConfig).files.slice(0, 30),
    }));
    for (const item of active.pluginSkills) {
      const name = active.skillDirectories.find(skill => skill.directory === item.directory)!.name;
      if (rows.some(row => row.name === name)) continue;
      let description = `Skill bundled with the ${item.row.name} plugin.`;
      let files: string[] = [];
      try {
        const text = await readFile(join(item.directory, 'SKILL.md'), 'utf8');
        description = parseFrontmatter(text).description ?? description;
        files = (await collect(item.directory)).map(file => file.relative).slice(0, 30);
      } catch { /* A plugin skill with no readable SKILL.md is still listed. */ }
      rows.push({ name, description, files });
    }
    return rows;
  }
}
