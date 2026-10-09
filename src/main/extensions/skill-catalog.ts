import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix, sep } from 'node:path';
import type { CatalogSearch, CatalogSkill, DiscoveredSkill, SkillUse } from '../../shared/types';
import type { DataStore } from '../data/store';
import type { MarketHttp } from '../market/net';
import { parseFrontmatter, type ResourceLibrary } from './library';

// Skills are prompt-context driven, like tools (user, 29.09): every skill
// this Mac has — Hello's library, what other agents installed (Claude Code,
// Anthropic's plugins, Codex, Pi…) — and, online, skills.sh's registry,
// which holds Anthropic's own skills too, searchable in one place. The model
// finds one for the task and loads it; Hello copies it into its library and
// turns it on for the chat. A skill is instructions, never code authority.

export type SkillEntry = CatalogSkill;
export type { SkillUse };

export const SKILLS_SH = 'https://skills.sh';
const GITHUB_API = 'https://api.github.com';
const GITHUB_RAW = 'https://raw.githubusercontent.com';
// No segment may be `.`, `..` or hidden: each one becomes a URL path and a folder name.
const SEGMENT = '(?!\\.)[A-Za-z0-9_.-]{1,100}';
const REPO = new RegExp(`^${SEGMENT}/${SEGMENT}$`);
const SKILL_ID = new RegExp(`^${SEGMENT}$`);
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const FETCH_AT_ONCE = 6;
/** How long an id skills.sh returned stays usable without asking skills.sh again. */
const OFFERED_MS = 60 * 60_000;
/** SKILL.md files read for their name when no folder is named after the skill. */
const MAX_NAME_PROBES = 40;

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'about', 'what', 'how', 'some', 'your', 'you', 'can', 'are', 'its', 'use', 'using', 'need', 'want', 'task', 'make', 'get', 'skill', 'skills']);
const wordsOf = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 1 && !STOP_WORDS.has(word));

/** How well a skill's name and description fit the words of a task. */
export function scoreSkill(entry: Pick<SkillEntry, 'name' | 'description'>, query: string): number {
  const words = wordsOf(query);
  if (!words.length) return 0;
  const name = new Set(wordsOf(entry.name.replace(/[-_]/g, ' ')));
  const description = new Set(wordsOf(entry.description));
  let score = 0;
  for (const word of words) {
    if (name.has(word)) score += 3;
    else if ([...name].some(part => part.startsWith(word) || word.startsWith(part))) score += 2;
    else if (description.has(word)) score += 1;
  }
  return score;
}

export interface SkillCatalogOptions {
  store: Pick<DataStore, 'listResourceRows' | 'getResourceRow' | 'saveResourceRow' | 'setResourceActive' | 'activeResourceIds'>;
  library: Pick<ResourceLibrary, 'importPath' | 'verify' | 'activeFor'>;
  /** Skills other agents on this Mac keep (discovery.ts). */
  discover(): Promise<DiscoveredSkill[]>;
  http: MarketHttp;
  /** Where an online skill is written before it is imported; emptied after. */
  stagingDir: string;
}

const STATE_WORDS = { modified: 'changed since it was approved', missing: 'its files were removed' } as const;

export class SkillCatalog {
  /** skills.sh ids handed out, and until when: `use` takes no other. */
  private readonly offered = new Map<string, number>();
  /** One use at a time: two chats asking for one skill must not import it twice. */
  private queue: Promise<unknown> = Promise.resolve();
  private swept?: Promise<void>;

  constructor(private readonly options: SkillCatalogOptions) {}

  /** Hello's library first, then every skill another agent on this Mac keeps. */
  async local(): Promise<SkillEntry[]> {
    const library: SkillEntry[] = this.options.store.listResourceRows().filter(row => row.kind === 'skill').map(row => ({
      id: `library:${row.id}`, name: row.name, description: row.description, source: 'Hello library', origin: 'library',
    }));
    const taken = new Set(library.map(entry => entry.name.toLowerCase()));
    const found = await this.options.discover().catch(() => [] as DiscoveredSkill[]);
    const local: SkillEntry[] = [];
    for (const skill of found) {
      const key = skill.name.toLowerCase();
      // The library refuses a skill without a description: not offered, then.
      if (taken.has(key) || !skill.description.trim()) continue;
      taken.add(key);
      local.push({ id: `local:${skill.path}`, name: skill.name, description: skill.description, source: skill.source, origin: 'local' });
    }
    return [...library, ...local];
  }

  /** skills.sh's registry, which also lists Anthropic's skills; names and installs, best first. */
  async online(query: string, signal: AbortSignal, limit = 8): Promise<SkillEntry[]> {
    const url = new URL('/api/search', SKILLS_SH);
    url.searchParams.set('q', query.slice(0, 200));
    const { value } = await this.options.http.getJson(url.href, signal, { allowedOrigin: SKILLS_SH });
    const skills = value && typeof value === 'object' && Array.isArray((value as { skills?: unknown }).skills) ? (value as { skills: unknown[] }).skills : [];
    const entries: SkillEntry[] = [];
    const now = Date.now();
    for (const [id, until] of this.offered) if (until < now) this.offered.delete(id);
    for (const raw of skills) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as { source?: unknown; skillId?: unknown; name?: unknown; installs?: unknown };
      if (typeof item.source !== 'string' || !REPO.test(item.source) || typeof item.skillId !== 'string' || !SKILL_ID.test(item.skillId)) continue;
      const name = typeof item.name === 'string' && item.name.length <= 120 ? item.name : item.skillId;
      const id = `skills.sh:${item.source}/${item.skillId}`;
      this.offered.set(id, now + OFFERED_MS);
      entries.push({
        id, name, description: '',
        source: `skills.sh · ${item.source}`, origin: 'online',
        ...(typeof item.installs === 'number' && Number.isFinite(item.installs) ? { installs: item.installs } : {}),
      });
      if (entries.length >= limit) break;
    }
    while (this.offered.size > 2000) this.offered.delete(this.offered.keys().next().value as string);
    return entries;
  }

  /** Skills for the words of a task: the best local ones, then online when asked. */
  async search(query: string, options: { online?: boolean; signal?: AbortSignal } = {}): Promise<CatalogSearch> {
    const signal = options.signal ?? new AbortController().signal;
    const all = await this.local();
    const words = wordsOf(query);
    const local = words.length
      ? all.map(entry => ({ entry, score: scoreSkill(entry, query) })).filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || (a.entry.origin === 'library' ? -1 : 1)).slice(0, 12).map(item => item.entry)
      : all.slice(0, 40);
    if (!options.online || !words.length) return { local, online: [] };
    try {
      const present = new Set(all.map(entry => entry.name.toLowerCase()));
      const online = (await this.online(query, signal)).filter(entry => !present.has(entry.name.toLowerCase()));
      return { local, online };
    } catch (error) {
      return { local, online: [], onlineError: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Puts a skill in the library if it is not there, and turns it on for this
   * chat. A skill of the same name already in the library is the one used: a
   * found copy never replaces what the person approved.
   */
  use(id: string, conversationId: string, signal: AbortSignal = new AbortController().signal): Promise<SkillUse> {
    const run = this.queue.then(() => this.useNow(id, conversationId, signal));
    this.queue = run.catch(() => {});
    return run;
  }

  private async useNow(id: string, conversationId: string, signal: AbortSignal): Promise<SkillUse> {
    signal.throwIfAborted();
    const rows = () => this.options.store.listResourceRows().filter(row => row.kind === 'skill');
    // Two active skills of one name stop every turn of the chat: the one
    // already on (a plugin's, say) answers instead, and nothing is imported.
    const alreadyOn = async (name: string): Promise<SkillUse | undefined> => {
      const active = await this.options.library.activeFor(conversationId);
      const at = active.skillDirectories.findIndex(skill => skill.name.toLowerCase() === name.toLowerCase());
      if (at < 0) return undefined;
      const owner = at < active.skills.length ? active.skills[at].row : active.pluginSkills[at - active.skills.length].row;
      return { name: active.skillDirectories[at].name, resourceId: owner.id, imported: false, source: `already on in this chat (${owner.name})` };
    };
    const activate = async (resourceId: string, imported: boolean, source: string): Promise<SkillUse> => {
      const row = this.options.store.getResourceRow(resourceId);
      // A copy that no longer matches what was approved would block the chat.
      const state = await this.options.library.verify(row);
      if (state !== 'ready') throw new Error(`“${row.name}” is in Hello’s library but ${STATE_WORDS[state as keyof typeof STATE_WORDS] ?? 'needs attention'}. Update or remove it in Settings › Extensions.`);
      if (this.options.store.activeResourceIds(conversationId).includes(resourceId)) return { name: row.name, resourceId, imported, source };
      const on = await alreadyOn(row.name);
      if (on) return on;
      this.options.store.setResourceActive(conversationId, resourceId, true);
      return { name: row.name, resourceId, imported, source };
    };
    if (id.startsWith('library:')) {
      const row = this.options.store.getResourceRow(id.slice('library:'.length));
      if (row.kind !== 'skill') throw new Error('That is not a skill.');
      return activate(row.id, false, 'Hello library');
    }
    if (id.startsWith('local:')) {
      const path = id.slice('local:'.length);
      // Asked of discovery itself, not of local(): that hides a skill whose
      // name the library took after the id was handed out.
      const found = (await this.options.discover().catch(() => [] as DiscoveredSkill[])).find(skill => skill.path === path);
      if (!found) throw new Error('That skill is no longer where it was found. Search again.');
      const existing = rows().find(row => row.name.toLowerCase() === found.name.toLowerCase());
      if (existing) return activate(existing.id, false, 'Hello library');
      const on = await alreadyOn(found.name);
      if (on) return on;
      const imported = await this.options.library.importPath('skill', path);
      return activate(imported.id, true, found.source);
    }
    if (id.startsWith('skills.sh:')) {
      const { repo, skillId } = parseRemote(id);
      const existing = rows().find(row => row.source === id || row.name.toLowerCase() === skillId.toLowerCase());
      if (existing) return activate(existing.id, false, 'Hello library');
      const on = await alreadyOn(skillId);
      if (on) return on;
      // Only what skills.sh lists: an id made up in a page the model read is
      // not a way to install any repository on GitHub.
      if (!((this.offered.get(id) ?? 0) > Date.now()) && !(await this.online(skillId, signal, 50)).some(entry => entry.id === id))
        throw new Error('skills.sh does not list that skill. Use an id skills_find returned.');
      const staged = await this.stage(id, signal);
      try {
        const imported = await this.options.library.importPath('skill', staged.path);
        // Say where it came from, not the temporary folder it was read from.
        const row = this.options.store.getResourceRow(imported.id);
        this.options.store.saveResourceRow({ ...row, source: id });
        return await activate(imported.id, true, `skills.sh · ${repo}`);
      } finally {
        await staged.dispose();
      }
    }
    throw new Error('Unknown skill id. Use an id skills_find returned.');
  }

  /**
   * A skills.sh skill written to a staging folder of its own, for an import
   * or a re-import (library.ts asks through `remote`). Null for any other source.
   */
  remote(source: string, signal: AbortSignal = new AbortController().signal): Promise<{ path: string; dispose(): Promise<void> }> | null {
    return source.startsWith('skills.sh:') ? this.stage(source, signal) : null;
  }

  private async stage(id: string, signal: AbortSignal): Promise<{ path: string; dispose(): Promise<void> }> {
    const { repo, skillId } = parseRemote(id);
    // Whatever a crash left behind, once, before the first download.
    await (this.swept ??= rm(this.options.stagingDir, { recursive: true, force: true }).catch(() => {}));
    const staging = join(this.options.stagingDir, randomUUID());
    const destination = join(staging, skillId);
    if (dirname(destination) !== staging) throw new Error('That is not a skills.sh skill id.');
    const dispose = () => rm(staging, { recursive: true, force: true });
    try {
      await downloadSkill(this.options.http, repo, skillId, destination, signal);
      return { path: destination, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  }
}

function parseRemote(id: string): { repo: string; skillId: string } {
  const rest = id.slice('skills.sh:'.length);
  const at = rest.lastIndexOf('/');
  const repo = rest.slice(0, at);
  const skillId = rest.slice(at + 1);
  if (at < 0 || !REPO.test(repo) || !SKILL_ID.test(skillId)) throw new Error('That is not a skills.sh skill id.');
  return { repo, skillId };
}

interface TreeEntry { path: string; type: string; size?: number }

const blobsOf = (value: unknown): TreeEntry[] => {
  const tree = value && typeof value === 'object' && Array.isArray((value as { tree?: unknown }).tree) ? (value as { tree: TreeEntry[] }).tree : [];
  return tree.filter(entry => entry && entry.type === 'blob' && typeof entry.path === 'string');
};

const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Writes one skill's folder from its GitHub repository, file by file from
 * raw.githubusercontent.com. The folder is the one holding this skill's
 * SKILL.md: named after the skill, else the one whose SKILL.md carries its
 * name. A repository too large to list whole is looked into at the usual
 * places. Text and files only; nothing is run.
 */
export async function downloadSkill(http: MarketHttp, repo: string, skillId: string, destination: string, signal: AbortSignal): Promise<string> {
  let files: TreeEntry[] = [];
  let prefix: string | undefined;
  let listing: string | undefined;
  try {
    const { value } = await http.getJson(`${GITHUB_API}/repos/${repo}/git/trees/HEAD?recursive=1`, signal, { allowedOrigin: GITHUB_API });
    const blobs = blobsOf(value);
    const manifests = blobs.map(entry => entry.path).filter(path => path === 'SKILL.md' || path.endsWith('/SKILL.md'));
    const named = manifests.filter(path => path.endsWith(`/${skillId}/SKILL.md`) || (path === 'SKILL.md' && basename(repo) === skillId))
      .sort((a, b) => a.length - b.length)[0];
    const manifest = named ?? await manifestNamed(http, repo, skillId, manifests, signal);
    if (manifest) {
      prefix = posix.dirname(manifest);
      files = blobs.filter(entry => prefix === '.' || entry.path.startsWith(`${prefix}/`));
    }
  } catch (error) {
    if (signal.aborted) throw error;
    listing = reason(error);
  }
  if (!prefix && listing) {
    // Too large to list whole (or refused): the skill's own folder, listed alone.
    for (const guess of [`skills/${skillId}`, skillId, `.claude/skills/${skillId}`]) {
      try {
        const { value } = await http.getJson(`${GITHUB_API}/repos/${repo}/git/trees/HEAD:${guess.split('/').map(encodeURIComponent).join('/')}?recursive=1`, signal, { allowedOrigin: GITHUB_API });
        const inside = blobsOf(value);
        if (!inside.some(entry => entry.path === 'SKILL.md')) continue;
        prefix = guess;
        files = inside.map(entry => ({ ...entry, path: `${guess}/${entry.path}` }));
        break;
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
    if (!prefix) throw new Error(`GitHub did not list ${repo} (${listing}); it answers 60 requests an hour without an account. Try again later.`);
  }
  if (!prefix) throw new Error(`No SKILL.md for ${skillId} was found in ${repo}.`);
  if (files.length > MAX_FILES) throw new Error(`The ${skillId} skill has more than ${MAX_FILES} files.`);
  if (files.reduce((sum, entry) => sum + (entry.size ?? 0), 0) > MAX_TOTAL_BYTES) throw new Error(`The ${skillId} skill is larger than 5 MB.`);
  const wanted = files.flatMap(entry => {
    const relative = prefix === '.' ? entry.path : entry.path.slice(prefix!.length + 1);
    const parts = relative.split('/');
    if (!relative || parts.some(part => !part || part === '..' || part.startsWith('.git'))) return [];
    const target = join(destination, ...parts);
    return target.startsWith(destination + sep) ? [{ path: entry.path, target }] : [];
  });
  // A few at a time: Anthropic's own skills run to dozens of files.
  let total = 0;
  for (let at = 0; at < wanted.length; at += FETCH_AT_ONCE) {
    const batch = wanted.slice(at, at + FETCH_AT_ONCE);
    const bodies = await Promise.all(batch.map(entry => fetchFile(http, repo, entry.path, signal)));
    total += bodies.reduce((sum, body) => sum + body.length, 0);
    if (total > MAX_TOTAL_BYTES) throw new Error(`The ${skillId} skill is larger than 5 MB.`);
    for (const [index, entry] of batch.entries()) {
      await mkdir(dirname(entry.target), { recursive: true });
      await writeFile(entry.target, bodies[index]);
    }
  }
  return destination;
}

/**
 * The SKILL.md whose front matter names the skill: skills.sh ids are skill
 * names, and a folder need not be called that (vercel-react-best-practices
 * lives in react-best-practices). Folders that share a word with the name
 * are read first; at most MAX_NAME_PROBES files.
 */
async function manifestNamed(http: MarketHttp, repo: string, skillId: string, manifests: string[], signal: AbortSignal): Promise<string | undefined> {
  const words = skillId.toLowerCase().split(/[-_.]+/).filter(Boolean);
  const shared = (path: string) => { const folder = basename(posix.dirname(path)).toLowerCase(); return words.filter(word => folder.includes(word)).length; };
  const candidates = [...manifests].sort((a, b) => shared(b) - shared(a) || a.length - b.length).slice(0, MAX_NAME_PROBES);
  for (let at = 0; at < candidates.length; at += FETCH_AT_ONCE) {
    const batch = candidates.slice(at, at + FETCH_AT_ONCE);
    const names = await Promise.all(batch.map(path => fetchFile(http, repo, path, signal)
      .then(body => parseFrontmatter(body.toString('utf8')).name ?? '')
      .catch(error => { if (signal.aborted) throw error; return ''; })));
    const index = names.findIndex(name => name.trim() === skillId);
    if (index >= 0) return batch[index];
  }
  return undefined;
}

async function fetchFile(http: MarketHttp, repo: string, path: string, signal: AbortSignal): Promise<Buffer> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const { body } = await http.getBytes(`${GITHUB_RAW}/${repo}/HEAD/${encoded}`, signal, { allowedOrigin: GITHUB_RAW, maxBytes: MAX_FILE_BYTES, contentType: /.*/ });
  return body;
}
