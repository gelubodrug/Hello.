import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDataStore, type DataStore } from '../src/main/data/store';
import { ResourceLibrary, parseFrontmatter, resourceDirectory } from '../src/main/extensions/library';
import { resultText, toolNameFor } from '../src/main/extensions/mcp';

let directory: string;
let source: string;
let store: DataStore;
let library: ResourceLibrary;
let conversationId: string;

function writeSkill(root: string, name: string, description: string, extra: Record<string, string> = {}): string {
  const folder = path.join(source, root);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\nversion: 1.0.0\n---\n\n# ${name}\n\nDo the thing.\n`);
  for (const [file, body] of Object.entries(extra)) {
    mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
    writeFileSync(path.join(folder, file), body);
  }
  return folder;
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hello-library-data-'));
  source = mkdtempSync(path.join(tmpdir(), 'hello-library-src-'));
  store = createDataStore(directory, {
    encrypt: text => Buffer.from(text.split('').reverse().join('')),
    decrypt: bytes => bytes.toString().split('').reverse().join(''),
  });
  library = new ResourceLibrary(store);
  conversationId = store.createConversation().id;
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

describe('front matter', () => {
  it('reads YAML folded descriptions instead of advertising the literal > marker', () => {
    expect(parseFrontmatter('---\nname: demo\ndescription: >-\n  Read documents\n  and cite evidence.\n---\n')).toEqual({ name: 'demo', description: 'Read documents and cite evidence.' });
  });
  it('reads the flat keys skills use and ignores the rest', () => {
    expect(parseFrontmatter('---\nname: a-skill\ndescription: "Does a thing"\n---\nbody')).toEqual({
      name: 'a-skill', description: 'Does a thing',
    });
    expect(parseFrontmatter('no front matter')).toEqual({});
  });
});

describe('importing skills', () => {
  it('copies the folder into Hello and records what it found', async () => {
    const folder = writeSkill('demo', 'demo-skill', 'Demonstrates importing.', { 'references/detail.md': '# detail\n' });
    const imported = await library.importPath('skill', folder);
    expect(imported.name).toBe('demo-skill');
    expect(imported.state).toBe('ready');
    expect(imported.entries).toContain('references/detail.md');
    // The copy is Hello's, so later edits to the source cannot change it.
    const copy = resourceDirectory(store.dataDir, { id: store.listResourceRows()[0].id, kind: 'skill' });
    expect(readFileSync(path.join(copy, 'SKILL.md'), 'utf8')).toContain('Do the thing.');
    writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: demo-skill\ndescription: changed\n---\nnew body');
    expect((await library.list())[0].state).toBe('ready');
    expect(readFileSync(path.join(copy, 'SKILL.md'), 'utf8')).toContain('Do the thing.');
  });

  it('re-imports on request and keeps the same identity', async () => {
    const folder = writeSkill('demo', 'demo-skill', 'First description.');
    const first = await library.importPath('skill', folder);
    writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: demo-skill\ndescription: Second description.\n---\nnew body');
    const second = await library.update(first.id);
    expect(second.id).toBe(first.id);
    expect(second.description).toBe('Second description.');
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('flags an approved copy that changed on disk', async () => {
    const folder = writeSkill('demo', 'demo-skill', 'Demonstrates importing.');
    const imported = await library.importPath('skill', folder);
    const copy = resourceDirectory(store.dataDir, { id: imported.id, kind: 'skill' });
    writeFileSync(path.join(copy, 'SKILL.md'), '---\nname: demo-skill\ndescription: tampered\n---\nrewritten');
    expect((await library.list())[0].state).toBe('modified');
    store.setResourceActive(conversationId, imported.id, true);
    const active = await library.activeFor(conversationId);
    expect(active.skills).toHaveLength(0);
    expect(active.blocked).toEqual([{ name: 'demo-skill', kind: 'skill', state: 'modified' }]);
  });

  it('refuses folders without a usable SKILL.md', async () => {
    const empty = path.join(source, 'empty');
    mkdirSync(empty, { recursive: true });
    await expect(library.importPath('skill', empty)).rejects.toThrow(/no SKILL\.md/i);
    writeFileSync(path.join(empty, 'SKILL.md'), '# no front matter\n');
    await expect(library.importPath('skill', empty)).rejects.toThrow(/description/i);
  });

  it('refuses symbolic links instead of following them', async () => {
    const folder = writeSkill('linky', 'linky', 'Has a link.');
    symlinkSync('/etc/passwd', path.join(folder, 'secret.md'));
    await expect(library.importPath('skill', folder)).rejects.toThrow(/symbolic link/i);
  });

  it('refuses a second folder claiming an installed name, and updates from the same source', async () => {
    const first = writeSkill('one', 'same-name', 'First.');
    const second = writeSkill('two', 'same-name', 'Second.');
    const installed = await library.importPath('skill', first);
    // A different folder must not take over the copy activated conversations use.
    await expect(library.importPath('skill', second)).rejects.toThrow(/already installed from/i);
    expect(store.listResourceRows()).toHaveLength(1);
    // Re-importing from its own source still updates in place.
    writeFileSync(path.join(first, 'SKILL.md'), '---\nname: same-name\ndescription: Updated.\n---\nbody');
    const updated = await library.importPath('skill', first);
    expect(updated.id).toBe(installed.id);
    expect(updated.description).toBe('Updated.');
  });
});

describe('importing plugins', () => {
  it('lists the Pi resources it contains and reports declared dependencies', async () => {
    const folder = path.join(source, 'plugin');
    mkdirSync(path.join(folder, 'extensions'), { recursive: true });
    mkdirSync(path.join(folder, 'skills', 'bundled'), { recursive: true });
    writeFileSync(path.join(folder, 'package.json'), JSON.stringify({
      name: 'demo-plugin', version: '2.0.0', description: 'Adds a tool.',
      dependencies: { 'left-pad': '^1.0.0' },
    }));
    writeFileSync(path.join(folder, 'extensions', 'tool.ts'), 'export default function () {}\n');
    writeFileSync(path.join(folder, 'skills', 'bundled', 'SKILL.md'), '---\nname: bundled\ndescription: Bundled skill.\n---\nsteps');
    const imported = await library.importPath('plugin', folder);
    expect(imported.name).toBe('demo-plugin');
    expect(imported.version).toBe('2.0.0');
    expect(imported.entries).toEqual(expect.arrayContaining(['extension: extensions/tool.ts', 'skill: skills/bundled']));
    expect(imported.warning).toMatch(/left-pad/);

    store.setResourceActive(conversationId, imported.id, true);
    const active = await library.activeFor(conversationId);
    expect(active.extensions[0].files[0]).toMatch(/extensions\/tool\.ts$/);
    expect(active.pluginSkills[0].directory).toMatch(/skills\/bundled$/);
    const index = await library.skillIndex(conversationId);
    expect(index).toEqual([{ name: 'bundled', description: 'Bundled skill.', files: ['SKILL.md'] }]);
  });

  it('refuses a folder with no Pi resources', async () => {
    const folder = path.join(source, 'plain');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: 'plain' }));
    await expect(library.importPath('plugin', folder)).rejects.toThrow(/No Pi resources/i);
  });
});

describe('reading skill files', () => {
  const folders = (active: Awaited<ReturnType<ResourceLibrary['activeFor']>>) => active.skillDirectories;

  it('reads only skills active in that conversation, inside their folder', async () => {
    const folder = writeSkill('demo', 'demo-skill', 'Demonstrates importing.', { 'references/detail.md': '# detail\n' });
    const imported = await library.importPath('skill', folder);
    await expect(library.readSkillFile(folders(await library.activeFor(conversationId)), 'demo-skill'))
      .rejects.toThrow(/not an active skill/i);
    store.setResourceActive(conversationId, imported.id, true);
    const active = folders(await library.activeFor(conversationId));
    expect(await library.readSkillFile(active, 'demo-skill')).toContain('Do the thing.');
    expect(await library.readSkillFile(active, 'demo-skill', 'references/detail.md')).toContain('# detail');
    await expect(library.readSkillFile(active, 'demo-skill', '../../../etc/passwd'))
      .rejects.toThrow(/inside the .* skill/i);
    await expect(library.readSkillFile(active, 'demo-skill', '/etc/passwd'))
      .rejects.toThrow(/inside the skill folder/i);
    // Another conversation does not inherit the activation.
    const other = store.createConversation().id;
    await expect(library.readSkillFile(folders(await library.activeFor(other)), 'demo-skill'))
      .rejects.toThrow(/not an active skill/i);
  });

  it('refuses a symlinked directory planted inside the imported copy', async () => {
    const folder = writeSkill('demo', 'demo-skill', 'Demonstrates importing.');
    const imported = await library.importPath('skill', folder);
    store.setResourceActive(conversationId, imported.id, true);
    const copy = resourceDirectory(store.dataDir, { id: imported.id, kind: 'skill' });
    const secret = path.join(source, 'outside');
    mkdirSync(secret, { recursive: true });
    writeFileSync(path.join(secret, 'private.txt'), 'not yours');
    // A name the import walk skips, planted after the fact.
    symlinkSync(secret, path.join(copy, 'node_modules'));
    // First line of defence: the copy no longer verifies, so it never loads.
    const active = await library.activeFor(conversationId);
    expect(active.skills).toHaveLength(0);
    expect(active.blocked).toEqual([{ name: 'demo-skill', kind: 'skill', state: 'modified' }]);
    // Second line: even handed the folder directly, the read stays inside it.
    await expect(library.readSkillFile([{ name: 'demo-skill', directory: copy }], 'demo-skill', 'node_modules/private.txt'))
      .rejects.toThrow(/inside the demo-skill skill/i);
  });
});

describe('MCP servers in the library', () => {
  it('round-trips editor fields without splitting paths, losing cwd or returning secrets', async () => {
    const saved = library.addMcp({ name: 'roundtrip', command: '/Applications/My Tool/server', args: ['--path', '/Users/a/My Notes', '', '  literal  '], cwd: source, env: { TOKEN: 'hidden' } });
    const listed = (await library.list())[0];
    expect(listed.mcp).toEqual({ command: '/Applications/My Tool/server', args: ['--path', '/Users/a/My Notes', '', '  literal  '], cwd: source, envNames: ['TOKEN'] });
    expect(JSON.stringify(listed)).not.toContain('hidden');
    library.addMcp({ ...listed.mcp!, name: listed.name, env: {}, keepEnv: true }, saved.id);
    expect(store.resourceSecret(saved.id)).toEqual({ TOKEN: 'hidden' });
    library.addMcp({ ...listed.mcp!, name: listed.name, env: {}, keepEnv: false }, saved.id);
    expect(store.resourceSecret(saved.id)).toEqual({});
  });

  it('requires explicit editing rather than silently replacing an existing MCP configuration', () => {
    library.addMcp({ name: 'same', command: '/bin/echo', args: ['first'], env: {} });
    expect(() => library.addMcp({ name: 'same', command: '/bin/echo', args: ['second'], env: {} })).toThrow(/already exists/);
  });
  it('stores configuration in the row and values in the encrypted secret store', () => {
    const saved = library.addMcp({ name: 'Notes Server', command: '/bin/echo', args: ['--serve'], env: { API_TOKEN: 'secret-value' } });
    expect(saved.name).toBe('notes-server');
    expect(saved.entries).toEqual(['env: API_TOKEN']);
    const row = store.getResourceRow(saved.id);
    expect(row.config).not.toContain('secret-value');
    expect(store.resourceSecret(saved.id)).toEqual({ API_TOKEN: 'secret-value' });
    expect(store.allResourceSecrets()).toContain('secret-value');
    store.deleteResourceRow(saved.id);
    expect(store.resourceSecret(saved.id)).toEqual({});
  });

  it('rejects a command with line breaks', () => {
    expect(() => library.addMcp({ name: 'bad', command: 'echo\nrm -rf /', args: [], env: {} }))
      .toThrow(/line breaks/i);
  });
});

describe('activation is per conversation', () => {
  it('is independent between chats and disappears with the resource', async () => {
    const folder = writeSkill('demo', 'demo-skill', 'Demonstrates importing.');
    const imported = await library.importPath('skill', folder);
    const other = store.createConversation().id;
    store.setResourceActive(conversationId, imported.id, true);
    expect(store.activeResourceIds(conversationId)).toEqual([imported.id]);
    expect(store.activeResourceIds(other)).toEqual([]);
    expect(store.conversationsUsing(imported.id)).toEqual([conversationId]);
    store.setResourceActive(conversationId, imported.id, false);
    expect(store.activeResourceIds(conversationId)).toEqual([]);
    store.setResourceActive(conversationId, imported.id, true);
    await library.remove(imported.id);
    expect(store.activeResourceIds(conversationId)).toEqual([]);
    expect(store.listResourceRows()).toHaveLength(0);
  });
});

describe('Pi package resource selection', () => {
  it('honors explicit directories, glob exclusions, prompts and declared skill names', async () => {
    const folder = path.join(source, 'package');
    for (const dir of ['custom', 'templates', 'skills/folder-name', 'extensions']) mkdirSync(path.join(folder, dir), { recursive: true });
    writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: 'package', pi: { extensions: ['./custom/*.ts', '!custom/skip.ts'], skills: ['./skills'], prompts: ['./templates'] } }));
    for (const file of ['custom/main.ts', 'custom/skip.ts', 'extensions/should-not-run.ts']) writeFileSync(path.join(folder, file), 'export default () => {};');
    writeFileSync(path.join(folder, 'templates/review.md'), 'Review $1 carefully.');
    writeFileSync(path.join(folder, 'skills/folder-name/SKILL.md'), '---\nname: declared-name\ndescription: Read this skill.\n---\nSpecific instruction.');
    const imported = await library.importPath('plugin', folder);
    expect(imported.entries).toEqual(['extension: custom/main.ts', 'skill: skills/folder-name', 'prompt: templates/review.md']);
    store.setResourceActive(conversationId, imported.id, true);
    const active = await library.activeFor(conversationId);
    expect(active.prompts[0]).toMatch(/templates\/review.md$/);
    expect((await library.skillIndex(conversationId, active))[0].name).toBe('declared-name');
    expect(await library.readSkillFile(active.skillDirectories, 'declared-name')).toContain('Specific instruction');
  });

  it('loads directory entry points without running their helper modules as extensions', async () => {
    const folder = path.join(source, 'package');
    mkdirSync(path.join(folder, 'extensions', 'feature'), { recursive: true });
    writeFileSync(path.join(folder, 'package.json'), '{"name":"entry-points","pi":{"extensions":["./extensions"]}}');
    writeFileSync(path.join(folder, 'extensions/feature/index.ts'), 'export default () => {};');
    writeFileSync(path.join(folder, 'extensions/feature/helper.ts'), 'export const helper = 1;');
    expect((await library.importPath('plugin', folder)).entries).toEqual(['extension: extensions/feature/index.ts']);
  });

  it('does not replace an existing imported copy when a renamed skill conflicts', async () => {
    const first = await library.importPath('skill', writeSkill('first', 'one', 'First.'));
    await library.importPath('skill', writeSkill('second', 'two', 'Second.'));
    writeSkill('first', 'two', 'Renamed into a conflict.');
    await expect(library.update(first.id)).rejects.toThrow(/already imported/);
    expect((await library.list()).find(row => row.id === first.id)?.state).toBe('ready');
  });
});

describe('MCP naming and results', () => {
  it('maps server and tool names into Hello tool names', () => {
    expect(toolNameFor('Notes Server', 'search-notes')).toBe('mcp_notes_server_search_notes');
    expect(toolNameFor('9lives', '🙂')).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(toolNameFor('x'.repeat(200), 'y'.repeat(200)).length).toBeLessThanOrEqual(100);
  });

  it('flattens MCP content and marks server-reported errors', () => {
    expect(resultText({ content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] })).toBe('hello\nworld');
    expect(resultText({ content: [{ type: 'image', mimeType: 'image/png' }] })).toContain('image/png');
    expect(resultText({ isError: true, content: [{ type: 'text', text: 'boom' }] })).toMatch(/^The MCP server reported an error:/);
    expect(resultText({ content: [] })).toContain('empty result');
    expect(resultText({ content: [{ type: 'text', text: 'x'.repeat(80_000) }] })).toContain('[truncated by Hello');
  });
});
