import { link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_INSTRUCTION_BYTES, projectInstructionPrompt, readProjectInstructions } from '../src/main/chat/project-instructions';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'hello-project-instructions-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('the folder’s root instructions', () => {
  it('prefers root AGENTS, falls back to root CLAUDE only when absent, and reads nothing without a folder', async () => {
    await writeFile(join(root, 'CLAUDE.md'), 'Use the root fallback.');
    expect(await readProjectInstructions(root)).toMatchObject({ source: 'CLAUDE.md', text: 'Use the root fallback.' });
    await writeFile(join(root, 'AGENTS.md'), 'Use root AGENTS.');
    expect(await readProjectInstructions(root)).toMatchObject({ source: 'AGENTS.md', text: 'Use root AGENTS.' });
    expect(await readProjectInstructions(null)).toBeUndefined();
  });
  it('does not walk up to a parent or down into nested folders', async () => {
    await mkdir(join(root, 'project/nested'), { recursive: true });
    await writeFile(join(root, 'AGENTS.md'), 'Parent instructions.');
    await writeFile(join(root, 'project/nested/CLAUDE.md'), 'Nested instructions.');
    expect(await readProjectInstructions(join(root, 'project'))).toBeUndefined();
  });
  it('caps UTF-8 bytes without a replacement character and labels the excerpt', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'a' + '🦉'.repeat(PROJECT_INSTRUCTION_BYTES));
    const found = await readProjectInstructions(root);
    expect(Buffer.byteLength(found!.text)).toBeLessThanOrEqual(PROJECT_INSTRUCTION_BYTES);
    expect(found?.text).not.toContain('�');
    expect(found?.truncated).toBe(true);
    expect(projectInstructionPrompt(found)).toContain('Only the first 32 KiB were loaded');
  });
  it('refuses links, hard links, binary and invalid UTF-8 instructions', async () => {
    const file = join(root, 'AGENTS.md');
    await writeFile(join(root, 'target'), 'Instructions behind a link.');
    await symlink(join(root, 'target'), file);
    expect(await readProjectInstructions(root)).toBeUndefined();
    await rm(file); await link(join(root, 'target'), file);
    expect(await readProjectInstructions(root)).toBeUndefined();
    await rm(file); await writeFile(file, Buffer.from([0, 65]));
    expect(await readProjectInstructions(root)).toBeUndefined();
    await writeFile(file, Buffer.from([0xff]));
    expect(await readProjectInstructions(root)).toBeUndefined();
  });
});
