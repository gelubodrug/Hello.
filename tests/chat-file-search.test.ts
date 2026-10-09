import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeTool, toolDefinitions } from '../src/main/chat/tools';
import { helloToolGroups } from '../src/main/chat/tool-groups';
import { CONTENT_SEARCH_LIMITS } from '../src/main/files/service';
import type { DataStore } from '../src/main/data/store';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'hello-file-search-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function context(folder: string | null = root) {
  return { store: { getConversation: () => ({ folder }) } as unknown as DataStore,
    conversationId: 'chat', signal: new AbortController().signal, approve: vi.fn(async () => false) };
}

describe('automatic file search', () => {
  it('finds names and content without approval, skipping secrets, binary, dependencies and escaping links', async () => {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'node_modules'));
    await Promise.all([
      writeFile(join(root, 'src/needle.ts'), 'first\nneedle here\n'),
      writeFile(join(root, '.env'), 'needle'),
      writeFile(join(root, 'binary.bin'), Buffer.from([0, 110, 101, 101, 100, 108, 101])),
      writeFile(join(root, 'node_modules/hidden.ts'), 'needle'),
      symlink(tmpdir(), join(root, 'escape')),
    ]);
    const ctx = context();
    const contents = JSON.parse(await executeTool('file_search', { query: 'needle' }, ctx));
    expect(contents.matches).toEqual([expect.objectContaining({ path: 'src/needle.ts', line: 2, snippet: 'needle here' })]);
    expect(JSON.parse(await executeTool('file_search', { query: 'needle', mode: 'names' }, ctx)).matches)
      .toEqual([{ path: 'src/needle.ts', name: 'needle.ts', kind: 'file' }]);
    expect(ctx.approve).not.toHaveBeenCalled();
  });
  it('uses the Files content result bound and reports that it stopped', async () => {
    await writeFile(join(root, 'many.txt'), 'needle\n'.repeat(CONTENT_SEARCH_LIMITS.results + 10));
    const result = JSON.parse(await executeTool('file_search', { query: 'needle' }, context()));
    expect(result.matches).toHaveLength(CONTENT_SEARCH_LIMITS.results);
    expect(result.reasons).toContain('results');
  });
  it('requires a folder, validates input and stops with the turn', async () => {
    await expect(executeTool('file_search', { query: 'needle' }, context(null))).rejects.toThrow(/Attach/);
    await expect(executeTool('file_search', { query: 'x\ny' }, context())).rejects.toThrow(/one line/);
    const ctx = context();
    ctx.signal = AbortSignal.abort(new Error('Stopped'));
    await expect(executeTool('file_search', { query: 'needle' }, ctx)).rejects.toThrow(/Stopped/);
  });
  it('belongs to coding and is only offered with an attached folder', () => {
    expect(toolDefinitions(false, false).some(tool => tool.function.name === 'file_search')).toBe(false);
    const group = helloToolGroups(toolDefinitions(true, false), { chatMode: 'coder', notebooks: { runbook: false, tasks: false }, planning: false, mcp: [] })
      .find(group => group.id === 'coding');
    expect(group?.tools).toContain('file_search');
    expect(group?.core).toBe(true);
  });
});
