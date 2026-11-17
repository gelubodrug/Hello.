/**
 * Finds MCP servers and skills the user has already set up for other agent
 * tools, so adding one to Hello is a click instead of a retyped command line
 * or a folder hunt.
 *
 * Every source below is a file those tools write on this Mac. Nothing is
 * executed, nothing is modified, and no file outside this list is read. The
 * values found there are the user's own; environment values stay in the main
 * process and are handed to the library only when an entry is actually
 * imported — the renderer receives variable names, never their values.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import type { DiscoveredMcpServer, DiscoveredPlugin, DiscoveredSkill } from '../../shared/types';
import { mcpServerUrl, readPlugin, slug } from './library';

/** Whole file read into memory; a config far past this is not one of these tools'. */
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_SERVERS = 200;
/** Folders whose per-project configuration is read. */
const MAX_PROJECTS = 100;

export interface DiscoveredMcpEntry extends DiscoveredMcpServer {
  /** Never leaves the main process. */
  env: Record<string, string>;
}

interface Source {
  label: string;
  path: string;
  read: (text: string, source: Source) => DiscoveredMcpEntry[];
  /** Names the project a per-folder config belongs to. */
  scope?: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function entry(
  source: Source,
  name: string,
  raw: Record<string, unknown>,
  scope?: string,
): DiscoveredMcpEntry | null {
  if (!name || name.length > 200) return null;
  // Some tools write the whole command line as one array instead of command+args.
  const line = Array.isArray(raw.command)
    ? raw.command.filter((value): value is string => typeof value === 'string')
    : [];
  const command = line.length ? line[0] : typeof raw.command === 'string' ? raw.command.trim() : '';
  // Claude Code and VS Code write `url`, Gemini CLI `httpUrl`, Windsurf `serverUrl`.
  const url = [raw.httpUrl, raw.url, raw.serverUrl].find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim() ?? '';
  // Gemini CLI's `url` is its SSE transport; only `httpUrl` is streamable HTTP.
  const sse = raw.type === 'sse' || (source.label === 'Gemini CLI' && typeof raw.httpUrl !== 'string' && typeof raw.url === 'string');
  const args = [
    ...line.slice(1),
    ...(Array.isArray(raw.args)
      ? raw.args.filter((value): value is string => typeof value === 'string')
      : []),
  ].slice(0, 64);
  const cwd = typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : undefined;
  const env = object(raw.env)
    ? Object.fromEntries(
        Object.entries(raw.env)
          .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && typeof value === 'string')
          .map(([key, value]) => [key, String(value)]),
      )
    : {};
  const common = {
    id: `${source.path}#${scope ? `${scope}/` : ''}${name}`,
    name,
    source: scope ? `${source.label} · ${scope}` : source.label,
    configPath: source.path,
    envNames: Object.keys(env).sort(),
    env,
  };
  if (!command) {
    // A streamable HTTP server Hello reaches itself. What it cannot reach is
    // still listed, disabled with the reason: hiding a server the person sees
    // in their other tool would only make them wonder where it went.
    const headers = object(raw.headers)
      ? Object.fromEntries(Object.entries(raw.headers)
        .filter(([key, value]) => /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(key) && typeof value === 'string')
        .map(([key, value]) => [key, String(value)]))
      : {};
    const why = !url ? 'This entry has no command to run.' : remoteProblem(url, sse);
    return {
      ...common,
      ...(why ? {} : { envNames: Object.keys(headers).sort(), env: headers }),
      command: url,
      args: [],
      url,
      transport: why ? 'remote' : 'http',
      ...(why ? { unsupported: why } : {}),
    };
  }
  return { ...common, command, args, cwd, transport: 'stdio' };
}

/** Why an HTTP entry is out of reach, or nothing when Hello can connect to it. */
function remoteProblem(url: string, sse: boolean): string {
  if (sse) return 'This server uses the old SSE transport. Hello connects to streamable HTTP servers.';
  try { mcpServerUrl(url); return ''; } catch (error) { return error instanceof Error ? error.message : 'Hello cannot reach this server.'; }
}

function fromMcpServers(text: string, source: Source): DiscoveredMcpEntry[] {
  const parsed: unknown = JSON.parse(text);
  if (!object(parsed)) return [];
  const found: DiscoveredMcpEntry[] = [];
  const collect = (value: unknown, scope?: string) => {
    if (!object(value)) return;
    for (const [name, raw] of Object.entries(value)) {
      if (!object(raw)) continue;
      const item = entry(source, name, raw, scope);
      if (item) found.push(item);
    }
  };
  collect(parsed.mcpServers, source.scope);
  // VS Code writes the same records under `servers`, opencode and Crush under `mcp`.
  collect(parsed.servers, source.scope);
  collect(parsed.mcp, source.scope);
  // Claude Code also keeps servers the user added inside one project folder.
  if (object(parsed.projects))
    for (const [folder, project] of Object.entries(parsed.projects))
      if (object(project)) collect(project.mcpServers, folder);
  return found;
}

function fromToml(text: string, source: Source): DiscoveredMcpEntry[] {
  const parsed = parseToml(text) as Record<string, unknown>;
  // Codex writes [mcp_servers.name]; Kimi nests them under [mcp.servers.name].
  const servers = object(parsed.mcp_servers)
    ? parsed.mcp_servers
    : object(parsed.mcp) && object(parsed.mcp.servers)
      ? parsed.mcp.servers
      : null;
  if (!servers) return [];
  return Object.entries(servers)
    .map(([name, raw]) => (object(raw) ? entry(source, name, raw) : null))
    .filter((item): item is DiscoveredMcpEntry => Boolean(item));
}

function fromYaml(text: string, source: Source): DiscoveredMcpEntry[] {
  const parsed: unknown = parseYaml(text);
  if (!object(parsed)) return [];
  const servers = parsed.mcpServers;
  // Continue lists servers instead of keying them by name.
  const records = Array.isArray(servers)
    ? servers.filter(object).map(item => [String(item.name ?? ''), item] as const)
    : object(servers)
      ? Object.entries(servers).filter((pair): pair is [string, Record<string, unknown>] => object(pair[1]))
      : [];
  return records
    .map(([name, raw]) => entry(source, name, raw))
    .filter((item): item is DiscoveredMcpEntry => Boolean(item));
}

function fromZedSettings(text: string, source: Source): DiscoveredMcpEntry[] {
  // Zed nests the command, and its settings file allows comments.
  const parsed: unknown = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
  if (!object(parsed) || !object(parsed.context_servers)) return [];
  return Object.entries(parsed.context_servers)
    .map(([name, raw]) => {
      if (!object(raw)) return null;
      const command = object(raw.command) ? raw.command : raw;
      return entry(source, name, {
        command: command.path ?? command.command,
        args: command.args,
        env: command.env,
      });
    })
    .filter((item): item is DiscoveredMcpEntry => Boolean(item));
}

/**
 * Per-folder configuration. These tools also keep servers next to a project,
 * so a folder the user actually works in is where the rest of them live.
 */
function projectSourcesFor(project: string): Source[] {
  return [
    { label: 'Claude Code', path: join(project, '.mcp.json'), read: fromMcpServers, scope: project },
    { label: 'VS Code', path: join(project, '.vscode', 'mcp.json'), read: fromMcpServers, scope: project },
    { label: 'Cursor', path: join(project, '.cursor', 'mcp.json'), read: fromMcpServers, scope: project },
  ];
}

/** Folders Claude Code has recorded, which is the list of places the user works. */
async function claudeProjects(home: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse((await readFile(join(home, '.claude.json'))).toString('utf8'));
    if (!object(parsed) || !object(parsed.projects)) return [];
    return Object.keys(parsed.projects).filter(path => path.startsWith('/'));
  } catch {
    return [];
  }
}

function sourcesFor(home: string): Source[] {
  return [
    { label: 'Claude Code', path: join(home, '.claude.json'), read: fromMcpServers },
    {
      label: 'Claude Desktop',
      path: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      read: fromMcpServers,
    },
    { label: 'Codex CLI', path: join(home, '.codex', 'config.toml'), read: fromToml },
    { label: 'Kimi CLI', path: join(home, '.kimi', 'config.toml'), read: fromToml },
    { label: 'Gemini CLI', path: join(home, '.gemini', 'settings.json'), read: fromMcpServers },
    { label: 'Qwen Code', path: join(home, '.qwen', 'settings.json'), read: fromMcpServers },
    { label: 'Copilot CLI', path: join(home, '.copilot', 'mcp-config.json'), read: fromMcpServers },
    { label: 'opencode', path: join(home, '.config', 'opencode', 'opencode.json'), read: fromMcpServers },
    { label: 'Crush', path: join(home, '.config', 'crush', 'crush.json'), read: fromMcpServers },
    { label: 'Continue', path: join(home, '.continue', 'config.yaml'), read: fromYaml },
    { label: 'Cursor', path: join(home, '.cursor', 'mcp.json'), read: fromMcpServers },
    { label: 'Windsurf', path: join(home, '.codeium', 'windsurf', 'mcp_config.json'), read: fromMcpServers },
    {
      label: 'VS Code',
      path: join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
      read: fromMcpServers,
    },
    { label: 'Zed', path: join(home, '.config', 'zed', 'settings.json'), read: fromZedSettings },
  ];
}

/**
 * Reads the known configuration files and returns what they describe. A file
 * that is missing, unreadable or malformed is skipped: discovery is a
 * convenience and must never be the reason Settings fails to open.
 */
export async function discoverMcpServers(
  home = homedir(),
  extraProjects: string[] = [],
): Promise<DiscoveredMcpEntry[]> {
  const found: DiscoveredMcpEntry[] = [];
  const seen = new Set<string>();
  const projects = [...new Set([...extraProjects.filter(path => path?.startsWith('/')), ...await claudeProjects(home)])]
    .slice(0, MAX_PROJECTS);
  for (const source of [...sourcesFor(home), ...projects.flatMap(projectSourcesFor)]) {
    let text: string;
    try {
      const bytes = await readFile(source.path);
      if (bytes.byteLength > MAX_CONFIG_BYTES) continue;
      text = bytes.toString('utf8');
    } catch {
      continue;
    }
    let entries: DiscoveredMcpEntry[];
    try {
      entries = source.read(text, source);
    } catch {
      continue;
    }
    for (const item of entries) {
      if (seen.has(item.id) || found.length >= MAX_SERVERS) continue;
      seen.add(item.id);
      found.push(item);
    }
  }
  return found;
}

/** Skill folders live directly under these; each holds one SKILL.md. */
function skillRootsFor(home: string): Array<{ label: string; path: string }> {
  return [
    { label: 'Claude Code', path: join(home, '.claude', 'skills') },
    { label: 'Agent skills', path: join(home, '.agents', 'skills') },
    { label: 'Codex CLI', path: join(home, '.codex', 'skills') },
    { label: 'Gemini CLI', path: join(home, '.gemini', 'skills') },
    { label: 'Qwen Code', path: join(home, '.qwen', 'skills') },
    { label: 'Cursor', path: join(home, '.cursor', 'skills') },
    { label: 'opencode', path: join(home, '.config', 'opencode', 'skills') },
    { label: 'Pi', path: join(home, '.pi', 'agent', 'skills') },
  ];
}

/** Name and description as declared, without reading the whole skill. */
async function skillHeader(file: string): Promise<{ name?: string; description?: string }> {
  const text = (await readFile(file)).subarray(0, 64 * 1024).toString('utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const front: unknown = parseYaml(match[1]);
  if (!object(front)) return {};
  return {
    name: typeof front.name === 'string' ? front.name.trim() : undefined,
    description: typeof front.description === 'string' ? front.description.trim() : undefined,
  };
}

/** Directory children, following symlinks: a symlinked skill folder still holds a skill. */
async function directoriesIn(root: string, limit = 200): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(root)).sort().slice(0, limit);
  } catch {
    return [];
  }
  const directories: string[] = [];
  for (const name of names) {
    try {
      if ((await stat(join(root, name))).isDirectory()) directories.push(name);
    } catch {
      // A broken symlink or unreadable entry is simply not a folder here.
    }
  }
  return directories;
}

async function skillsUnder(root: string, label: string): Promise<DiscoveredSkill[]> {
  const names = await directoriesIn(root);
  const found: DiscoveredSkill[] = [];
  for (const name of names) {
    const path = join(root, name);
    const file = join(path, 'SKILL.md');
    try {
      if (!(await stat(file)).isFile()) continue;
      const header = await skillHeader(file);
      found.push({
        id: path,
        name: header.name || name,
        description: header.description ?? '',
        source: label,
        path,
      });
    } catch {
      // A folder without a readable SKILL.md is simply not a skill.
    }
  }
  return found;
}

/**
 * Skills already installed for other tools, plus those a Claude Code plugin
 * brought along. Reading stops at the folder listing and each SKILL.md header.
 */
export async function discoverSkills(
  home = homedir(),
  extraProjects: string[] = [],
  extraRoots: Array<{ label: string; path: string }> = [],
): Promise<DiscoveredSkill[]> {
  const roots = [...skillRootsFor(home), ...extraRoots];
  // A project folder keeps its own skills beside its own MCP configuration.
  const projects = [...new Set([...extraProjects.filter(path => path?.startsWith('/')), ...await claudeProjects(home)])]
    .slice(0, MAX_PROJECTS);
  for (const project of projects)
    roots.push({ label: `Project · ${basename(project)}`, path: join(project, '.claude', 'skills') });
  // A plugin's own skills folder is a skill root like any other. A marketplace
  // clone keeps its plugins under plugins/ and external_plugins/; the clone's
  // own children are checked too, for layouts that skip that level.
  const marketplaces = join(home, '.claude', 'plugins', 'marketplaces');
  const seenPluginRoots = new Set<string>();
  for (const marketplace of await directoriesIn(marketplaces, 50)) {
    const clone = join(marketplaces, marketplace);
    for (const group of ['plugins', 'external_plugins', '.']) {
      const directory = group === '.' ? clone : join(clone, group);
      for (const plugin of await directoriesIn(directory, 200)) {
        const path = join(directory, plugin, 'skills');
        if (seenPluginRoots.has(path)) continue;
        seenPluginRoots.add(path);
        roots.push({ label: `Plugin · ${plugin}`, path });
      }
    }
  }
  const found: DiscoveredSkill[] = [];
  const seen = new Set<string>();
  for (const root of roots)
    for (const skill of await skillsUnder(root.path, root.label)) {
      if (seen.has(skill.id) || found.length >= MAX_SERVERS) continue;
      seen.add(skill.id);
      found.push(skill);
    }
  return found;
}

/** The reason the importer gave, short enough for a row. */
async function importRefusal(path: string): Promise<string | undefined> {
  try { await readPlugin(path); return undefined; } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return reason.slice(0, 300) || 'Hello cannot import this folder.';
  }
}

/**
 * Extensions installed for Pi itself, in its global extensions folder — where
 * an installer such as OpenViking's puts one, with its dependencies. Pi's own
 * rule: a .ts/.js file, or a folder holding index.ts/index.js or a
 * package.json with a "pi" section. Reading stops at that package.json. The
 * name is the one the library will give it, so an added one is not offered
 * again.
 *
 * Pi's rule is wider than Hello's import: a symlink in the folder, a tree past
 * the import limits, a "pi" section naming files that are not there. Each
 * candidate is offered to the importer — which reads and executes nothing — so
 * a row Hello would refuse says why instead of failing on the Add button
 * (an extension listed under "Found on this Mac" that the import then refused).
 */
export async function discoverPiExtensions(home = homedir(), agentDir = join(home, '.pi', 'agent')): Promise<DiscoveredPlugin[]> {
  const root = join(agentDir, 'extensions');
  const found: DiscoveredPlugin[] = [];
  let names: string[];
  try { names = (await readdir(root)).sort().slice(0, MAX_SERVERS); } catch { return []; }
  for (const name of names) {
    const path = join(root, name);
    let info;
    try { info = await stat(path); } catch { continue; }
    if (info.isFile()) {
      if (!/\.(?:ts|mts|js|mjs)$/.test(name) || /\.hello-bundle\.mjs$/.test(name)) continue;
      const unsupported = await importRefusal(path);
      found.push({ id: path, name: slug(name.replace(/\.[^.]+$/, '')), description: '', source: 'Pi', path, ...(unsupported ? { unsupported } : {}) });
      continue;
    }
    if (!info.isDirectory()) continue;
    let manifest: Record<string, unknown> = {};
    try {
      const file = join(path, 'package.json');
      if ((await stat(file)).size <= MAX_CONFIG_BYTES) manifest = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    } catch { /* no manifest: the index decides */ }
    const hasIndex = await Promise.all(['index.ts', 'index.js'].map(file => stat(join(path, file)).then(entry => entry.isFile(), () => false)));
    if (!hasIndex.some(Boolean) && (typeof manifest.pi !== 'object' || manifest.pi === null)) continue;
    const unsupported = await importRefusal(path);
    found.push({
      id: path,
      name: slug(typeof manifest.name === 'string' && manifest.name ? manifest.name : name),
      description: typeof manifest.description === 'string' ? manifest.description.slice(0, 500) : '',
      source: 'Pi',
      path,
      ...(unsupported ? { unsupported } : {}),
    });
  }
  return found;
}

/** The renderer's view: everything except the environment values. */
export function withoutSecrets(entries: DiscoveredMcpEntry[]): DiscoveredMcpServer[] {
  return entries.map(({ env: _env, ...rest }) => rest);
}
