import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDataStore, type DataStore } from '../src/main/data/store';
import { ResourceLibrary, resourceDirectory } from '../src/main/extensions/library';
import { SkillCatalog, SKILLS_SH, downloadSkill, scoreSkill } from '../src/main/extensions/skill-catalog';
import type { MarketHttp } from '../src/main/market/net';
import { executeToolOutput, toolDefinitions } from '../src/main/chat/tools';
import { helloSystemPrompt } from '../src/main/chat/pi-instructions';
import type { AppSettings, DiscoveredSkill } from '../src/shared/types';

// Nothing here reaches the network: skills.sh and GitHub are a map of URLs.
let directory: string;
let store: DataStore;
let library: ResourceLibrary;
let discovered: DiscoveredSkill[];
let conversationId: string;

function writeSkill(name: string, description: string, root = path.join(directory, 'agents')): string {
  const folder = path.join(root, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps for ${name}.\n`);
  return folder;
}

function fakeHttp(json: Record<string, unknown>, files: Record<string, string> = {}) {
  const calls: string[] = [];
  const http: MarketHttp = {
    getJson: vi.fn(async (url: string, _signal: AbortSignal, policy?: { allowedOrigin?: string }) => {
      calls.push(url);
      if (policy?.allowedOrigin && new URL(url).origin !== policy.allowedOrigin) throw new Error('wrong origin');
      if (!(url in json)) throw new Error(`HTTP 404 ${url}`);
      const value = json[url];
      if (value instanceof Error) throw value;
      return { value, finalUrl: url };
    }),
    getBytes: vi.fn(async (url: string, _signal: AbortSignal, policy: { allowedOrigin?: string }) => {
      calls.push(url);
      if (policy.allowedOrigin && new URL(url).origin !== policy.allowedOrigin) throw new Error('wrong origin');
      if (!(url in files)) throw new Error(`HTTP 404 ${url}`);
      return { body: Buffer.from(files[url]), contentType: 'text/plain', finalUrl: url };
    }),
  };
  return { http, calls };
}

function catalog(http: MarketHttp = fakeHttp({}).http) {
  return new SkillCatalog({ store, library, discover: async () => discovered, http, stagingDir: path.join(directory, 'staging') });
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hello-skill-catalog-'));
  store = createDataStore(path.join(directory, 'data'), { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  library = new ResourceLibrary(store);
  discovered = [];
  conversationId = store.createConversation().id;
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('the skills on this Mac', () => {
  it('lists Hello’s library first, then other agents’ skills, one per name', async () => {
    const approved = await library.importPath('skill', writeSkill('pdf', 'Fill and read PDF forms.', path.join(directory, 'mine')));
    discovered = [
      { id: 'a', name: 'PDF', description: 'Another copy.', source: 'Claude Code', path: writeSkill('pdf', 'Another copy.') },
      { id: 'b', name: 'frontend-design', description: 'Distinctive web interfaces.', source: 'Anthropic plugins', path: writeSkill('frontend-design', 'Distinctive web interfaces.') },
    ];
    const local = await catalog().local();
    expect(local.map(entry => [entry.id, entry.origin])).toEqual([[`library:${approved.id}`, 'library'], [`local:${discovered[1].path}`, 'local']]);
    expect(local[1]).toMatchObject({ name: 'frontend-design', source: 'Anthropic plugins' });
  });

  it('scores a task’s words against names before descriptions', () => {
    expect(scoreSkill({ name: 'pdf-forms', description: 'x' }, 'fill a pdf')).toBe(3);
    expect(scoreSkill({ name: 'docs', description: 'Makes a PDF report' }, 'pdf')).toBe(1);
    expect(scoreSkill({ name: 'frontend-design', description: '' }, 'front')).toBe(2);
    expect(scoreSkill({ name: 'anything', description: 'x' }, 'the skill for')).toBe(0);
  });

  it('finds the best local fit, and skills.sh’s only when asked', async () => {
    discovered = [
      { id: 'a', name: 'xlsx', description: 'Spreadsheets with formulas.', source: 'Claude Code', path: writeSkill('xlsx', 'Spreadsheets with formulas.') },
      { id: 'b', name: 'pptx', description: 'Slide decks.', source: 'Claude Code', path: writeSkill('pptx', 'Slide decks.') },
    ];
    const search = `${SKILLS_SH}/api/search?q=slide+deck`;
    const { http, calls } = fakeHttp({ [search]: { skills: [
      { source: 'anthropics/skills', skillId: 'pptx', name: 'pptx', installs: 5000 },
      { source: 'acme/decks', skillId: 'deck-builder', name: 'deck-builder', installs: 12 },
      { source: '../../etc', skillId: 'passwd', name: 'bad' },
    ] } });
    const found = await catalog(http).search('slide deck');
    expect(found.local.map(entry => entry.name)).toEqual(['pptx']);
    expect(found.online).toEqual([]);
    expect(calls).toEqual([]);
    const online = await catalog(http).search('slide deck', { online: true });
    // pptx is already on this Mac; a malformed repository is dropped.
    expect(online.online).toEqual([{ id: 'skills.sh:acme/decks/deck-builder', name: 'deck-builder', description: '', source: 'skills.sh · acme/decks', origin: 'online', installs: 12 }]);
  });

  it('keeps the local results when skills.sh cannot be reached', async () => {
    discovered = [{ id: 'a', name: 'xlsx', description: 'Spreadsheets.', source: 'Codex', path: writeSkill('xlsx', 'Spreadsheets.') }];
    const found = await catalog(fakeHttp({ [`${SKILLS_SH}/api/search?q=xlsx`]: new Error('timeout') }).http).search('xlsx', { online: true });
    expect(found.local.map(entry => entry.name)).toEqual(['xlsx']);
    expect(found.onlineError).toBe('timeout');
  });
});

describe('using a found skill', () => {
  it('turns on a library skill for the chat', async () => {
    const approved = await library.importPath('skill', writeSkill('pdf', 'PDF forms.', path.join(directory, 'mine')));
    const used = await catalog().use(`library:${approved.id}`, conversationId);
    expect(used).toEqual({ name: 'pdf', resourceId: approved.id, imported: false, source: 'Hello library' });
    expect(store.activeResourceIds(conversationId)).toEqual([approved.id]);
  });

  it('copies another agent’s skill into the library once, and turns it on', async () => {
    const folder = writeSkill('frontend-design', 'Interfaces.');
    discovered = [{ id: 'b', name: 'frontend-design', description: 'Interfaces.', source: 'Anthropic plugins', path: folder }];
    const first = await catalog().use(`local:${folder}`, conversationId);
    expect(first).toMatchObject({ name: 'frontend-design', imported: true, source: 'Anthropic plugins' });
    expect(store.activeResourceIds(conversationId)).toEqual([first.resourceId]);
    // The library copy now answers for that name; nothing is imported twice.
    const other = store.createConversation().id;
    discovered = [{ id: 'c', name: 'frontend-design', description: 'Interfaces.', source: 'Codex', path: writeSkill('frontend-design', 'Interfaces.', path.join(directory, 'codex')) }];
    const second = await catalog().use(`local:${discovered[0].path}`, other);
    expect(second).toMatchObject({ resourceId: first.resourceId, imported: false });
    expect(store.listResourceRows()).toHaveLength(1);
  });

  it('refuses a local skill that is no longer where it was found', async () => {
    await expect(catalog().use(`local:${path.join(directory, 'gone')}`, conversationId)).rejects.toThrow(/no longer where it was found/);
  });

  const DECKS_TREE = 'https://api.github.com/repos/acme/decks/git/trees/HEAD?recursive=1';
  const raw = (repo: string, file: string) => `https://raw.githubusercontent.com/${repo}/HEAD/${file}`;
  const listed = (repo: string, skillId: string) => ({ [`${SKILLS_SH}/api/search?q=${skillId}`]: { skills: [{ source: repo, skillId, name: skillId, installs: 3 }] } });
  function decks(extra: Record<string, unknown> = {}) {
    return fakeHttp({ ...listed('acme/decks', 'deck-builder'), [DECKS_TREE]: { tree: [
      { path: 'README.md', type: 'blob', size: 10 },
      { path: 'skills/deck-builder/SKILL.md', type: 'blob', size: 80 },
      { path: 'skills/deck-builder/references/layouts.md', type: 'blob', size: 20 },
      { path: 'skills/other/SKILL.md', type: 'blob', size: 80 },
      { path: 'skills/deck-builder/.git/config', type: 'blob', size: 5 },
    ] }, ...extra }, {
      [raw('acme/decks', 'skills/deck-builder/SKILL.md')]: '---\nname: deck-builder\ndescription: Builds decks.\n---\nSteps.\n',
      [raw('acme/decks', 'skills/deck-builder/references/layouts.md')]: 'Layouts.\n',
    });
  }

  it('downloads a skills.sh skill from its repository folder, and says where it came from', async () => {
    mkdirSync(path.join(directory, 'staging', 'left-by-a-crash'), { recursive: true });
    const { http } = decks();
    const used = await catalog(http).use('skills.sh:acme/decks/deck-builder', conversationId);
    expect(used).toMatchObject({ name: 'deck-builder', imported: true, source: 'skills.sh · acme/decks' });
    const row = store.getResourceRow(used.resourceId);
    expect(row.source).toBe('skills.sh:acme/decks/deck-builder');
    const copy = resourceDirectory(store.dataDir, row);
    expect(readFileSync(path.join(copy, 'references', 'layouts.md'), 'utf8')).toBe('Layouts.\n');
    expect(existsSync(path.join(copy, 'README.md'))).toBe(false);
    expect(readdirSync(path.join(directory, 'staging'))).toEqual([]);
    expect(store.activeResourceIds(conversationId)).toEqual([used.resourceId]);
    // Asked again, the library copy is used.
    expect(await catalog(http).use('skills.sh:acme/decks/deck-builder', conversationId)).toMatchObject({ resourceId: used.resourceId, imported: false });
  });

  it('installs only what skills.sh lists, asking it again for an id it did not just hand out', async () => {
    const { http, calls } = decks();
    const skills = catalog(http);
    await expect(skills.use('skills.sh:attacker/payload/deck-builder', conversationId)).rejects.toThrow(/skills\.sh does not list that skill/);
    expect(calls.some(url => url.includes('attacker'))).toBe(false);
    // Handed out by a search: no second question.
    await skills.online('deck-builder', new AbortController().signal);
    calls.length = 0;
    await skills.use('skills.sh:acme/decks/deck-builder', conversationId);
    expect(calls.filter(url => url.startsWith(SKILLS_SH))).toEqual([]);
  });

  it('refuses ids with a dot segment, or of no known kind', async () => {
    for (const id of ['skills.sh:acme/decks/..', 'skills.sh:../x/y', 'skills.sh:acme/.git/x', 'skills.sh:acme/decks/.hidden'])
      await expect(catalog().use(id, conversationId)).rejects.toThrow(/not a skills\.sh skill id/);
    await expect(catalog().use('https://example.com/skill', conversationId)).rejects.toThrow(/Unknown skill id/);
  });

  it('finds a skill whose folder is not named after it, by its SKILL.md', async () => {
    const tree = 'https://api.github.com/repos/vercel-labs/agent-skills/git/trees/HEAD?recursive=1';
    const { http } = fakeHttp({ ...listed('vercel-labs/agent-skills', 'vercel-react-best-practices'), [tree]: { tree: [
      { path: 'skills/deploy/SKILL.md', type: 'blob' },
      { path: 'skills/react-best-practices/SKILL.md', type: 'blob' },
      { path: 'skills/react-best-practices/rules/hooks.md', type: 'blob' },
    ] } }, {
      [raw('vercel-labs/agent-skills', 'skills/deploy/SKILL.md')]: '---\nname: deploy\ndescription: Deploys.\n---\n',
      [raw('vercel-labs/agent-skills', 'skills/react-best-practices/SKILL.md')]: '---\nname: vercel-react-best-practices\ndescription: React rules.\n---\nRules.\n',
      [raw('vercel-labs/agent-skills', 'skills/react-best-practices/rules/hooks.md')]: 'Hooks.\n',
    });
    const used = await catalog(http).use('skills.sh:vercel-labs/agent-skills/vercel-react-best-practices', conversationId);
    expect(readFileSync(path.join(resourceDirectory(store.dataDir, store.getResourceRow(used.resourceId)), 'rules', 'hooks.md'), 'utf8')).toBe('Hooks.\n');
  });

  it('lists only the skill’s folder when the whole repository is too large, and never imports a partial skill', async () => {
    const destination = path.join(directory, 'out', 'helper');
    const subtree = 'https://api.github.com/repos/acme/tools/git/trees/HEAD:skills/helper?recursive=1';
    const { http } = fakeHttp({ 'https://api.github.com/repos/acme/tools/git/trees/HEAD?recursive=1': new Error('market request failed: response'), [subtree]: { tree: [
      { path: 'SKILL.md', type: 'blob' }, { path: 'references', type: 'tree' }, { path: 'references/a.md', type: 'blob' },
    ] } }, {
      [raw('acme/tools', 'skills/helper/SKILL.md')]: '---\nname: helper\ndescription: Helps.\n---\n',
      [raw('acme/tools', 'skills/helper/references/a.md')]: 'A.\n',
    });
    await downloadSkill(http, 'acme/tools', 'helper', destination, new AbortController().signal);
    expect(readdirSync(destination).sort()).toEqual(['SKILL.md', 'references']);
    // GitHub refusing every listing (its hourly limit, say) is an error, not a SKILL.md alone.
    await expect(downloadSkill(fakeHttp({}, { [raw('acme/tools', 'skills/other/SKILL.md')]: 'x' }).http, 'acme/tools', 'other', path.join(directory, 'out', 'other'), new AbortController().signal))
      .rejects.toThrow(/GitHub did not list acme\/tools/);
    expect(existsSync(path.join(directory, 'out', 'other'))).toBe(false);
    // Listed, but no SKILL.md of that name.
    await expect(downloadSkill(decks().http, 'acme/decks', 'missing', path.join(directory, 'out', 'missing'), new AbortController().signal))
      .rejects.toThrow(/No SKILL\.md for missing was found in acme\/decks/);
  });

  it('stops at once when the reply is stopped', async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(catalog(decks().http).use('skills.sh:acme/decks/deck-builder', conversationId, stop.signal)).rejects.toThrow();
    expect(store.listResourceRows()).toEqual([]);
  });

  it('imports once when two chats ask for the same skill at the same moment', async () => {
    const skills = catalog(decks().http);
    const other = store.createConversation().id;
    const [a, b] = await Promise.all([skills.use('skills.sh:acme/decks/deck-builder', conversationId), skills.use('skills.sh:acme/decks/deck-builder', other)]);
    expect(b.resourceId).toBe(a.resourceId);
    expect(store.activeResourceIds(conversationId)).toEqual([a.resourceId]);
    expect(store.activeResourceIds(other)).toEqual([a.resourceId]);
    expect(readdirSync(path.join(directory, 'data', 'library', 'skills'))).toEqual([a.resourceId]);
  });

  it('answers with a same-name skill already on in the chat, importing nothing', async () => {
    const plugin = path.join(directory, 'plugin');
    writeSkill('frontend-design', 'The plugin’s own.', path.join(plugin, 'skills'));
    writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'design-kit', version: '1.0.0' }));
    const kit = await library.importPath('plugin', plugin);
    store.setResourceActive(conversationId, kit.id, true);
    const folder = writeSkill('frontend-design', 'Another copy.');
    discovered = [{ id: 'x', name: 'frontend-design', description: 'Another copy.', source: 'Claude Code', path: folder }];
    const used = await catalog().use(`local:${folder}`, conversationId);
    expect(used).toEqual({ name: 'frontend-design', resourceId: kit.id, imported: false, source: 'already on in this chat (design-kit)' });
    expect(store.listResourceRows().map(row => row.kind)).toEqual(['plugin']);
    expect(store.activeResourceIds(conversationId)).toEqual([kit.id]);
  });

  it('refuses a library skill whose approved copy changed', async () => {
    const approved = await library.importPath('skill', writeSkill('pdf', 'PDF forms.', path.join(directory, 'mine')));
    writeFileSync(path.join(resourceDirectory(store.dataDir, store.getResourceRow(approved.id)), 'SKILL.md'), '---\nname: pdf\ndescription: Changed.\n---\n');
    await expect(catalog().use(`library:${approved.id}`, conversationId)).rejects.toThrow(/changed since it was approved/);
    expect(store.activeResourceIds(conversationId)).toEqual([]);
  });

  it('re-imports a skills.sh skill from skills.sh', async () => {
    const { http } = decks();
    const skills = catalog(http);
    library.remote = source => skills.remote(source);
    const used = await skills.use('skills.sh:acme/decks/deck-builder', conversationId);
    (http.getBytes as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => ({
      body: Buffer.from(url.endsWith('SKILL.md') ? '---\nname: deck-builder\ndescription: Builds decks, v2.\n---\nSteps.\n' : 'Layouts v2.\n'), contentType: 'text/plain', finalUrl: url,
    }));
    const updated = await library.update(used.resourceId);
    expect(updated).toMatchObject({ description: 'Builds decks, v2.', source: 'skills.sh:acme/decks/deck-builder' });
    expect(store.getResourceRow(used.resourceId).source).toBe('skills.sh:acme/decks/deck-builder');
    expect(readdirSync(path.join(directory, 'staging'))).toEqual([]);
  });

  it('does not offer a found skill the library would refuse', async () => {
    discovered = [{ id: 'a', name: 'bare', description: '', source: 'Claude Code', path: writeSkill('bare', 'x') }];
    expect(await catalog().local()).toEqual([]);
  });
});

describe('the model’s side', () => {
  const base = { store: { getConversation: () => ({ id: 'c', folder: null }) } as unknown as DataStore, conversationId: 'c', signal: new AbortController().signal, approve: async () => false };

  it('offers skills_find and skill_load by id when the catalog is there', () => {
    const names = toolDefinitions(false, false, { skills: [], mcp: [], skillsCatalog: true }).map(tool => tool.function.name);
    expect(names).toEqual(expect.arrayContaining(['skills_find', 'skill_load']));
    expect(toolDefinitions(false, false, { skills: [], mcp: [] }).map(tool => tool.function.name)).not.toContain('skills_find');
  });

  it('returns ids to load, and loads one by id', async () => {
    const find = vi.fn(async () => ({
      local: [{ id: 'local:/x/pdf', name: 'pdf', description: 'PDF forms.', source: 'Claude Code' }],
      online: [{ id: 'skills.sh:anthropics/skills/pptx', name: 'pptx', source: 'skills.sh · anthropics/skills', installs: 9 }],
    }));
    const use = vi.fn(async () => ({ name: 'pdf', imported: true, source: 'Claude Code' }));
    const read = vi.fn(async () => 'Steps for pdf.');
    const skills = { find, use, read };
    const found = (await executeToolOutput('skills_find', { need: 'fill a pdf form' }, { ...base, skills })) as unknown as string;
    expect(find).toHaveBeenCalledWith('fill a pdf form', true, base.signal);
    expect(JSON.stringify(found)).toContain('local:/x/pdf');
    expect(JSON.stringify(found)).toContain('skills.sh:anthropics/skills/pptx');
    const loaded = JSON.stringify(await executeToolOutput('skill_load', { id: 'local:/x/pdf' }, { ...base, skills }));
    expect(use).toHaveBeenCalledWith('c', 'local:/x/pdf', base.signal);
    expect(read).toHaveBeenCalledWith('c', 'pdf', undefined);
    expect(loaded).toContain('Steps for pdf.');
    expect(loaded).toContain('Copied into Hello’s library from Claude Code');
  });

  it('says so when nothing fits, naming a failed online search', async () => {
    const skills = { read: vi.fn(), find: vi.fn(async () => ({ local: [], online: [], onlineError: 'timeout' })) };
    const output = JSON.stringify(await executeToolOutput('skills_find', { need: 'quantum', online: true }, { ...base, skills }));
    expect(output).toContain('No skill matches');
    expect(output).toContain('timeout');
  });

  it('tells the model to look for a skill only when it can', () => {
    const settings = { systemPrompt: '' } as AppSettings;
    expect(helloSystemPrompt(settings, { skills: [], mcp: [], catalog: true })).toContain('Skills are prompt-context driven too');
    expect(helloSystemPrompt(settings, { skills: [], mcp: [] })).not.toContain('skills_find');
  });
});
