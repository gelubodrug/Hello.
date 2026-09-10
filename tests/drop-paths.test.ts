import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDropPaths } from '../src/main/files/drop-paths';
import { droppedPaths, hasFileDrop, HELLO_FILES_MIME, quoteTerminalPaths, setInternalFileDrop } from '../src/renderer/drop';
import { api } from '../src/renderer/api';

vi.mock('../src/renderer/api', () => ({ api: { system: { pathsForFiles: vi.fn() }, files: { resolvePaths: vi.fn() } } }));

describe('scoped Files-pane paths', () => {
  let root: string;
  let folder: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hello-drop-paths-'));
    folder = join(root, 'workspace');
    await mkdir(join(folder, 'subfolder'), { recursive: true });
    root = await realpath(root);
    folder = await realpath(folder);
    await writeFile(join(folder, 'a file.txt'), 'Hello');
    await writeFile(join(root, 'outside.txt'), 'Outside');
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('resolves existing files and directories under the conversation folder and deduplicates them', async () => {
    expect(await resolveDropPaths(folder, ['a file.txt', 'subfolder', 'a file.txt'])).toEqual([
      join(folder, 'a file.txt'), join(folder, 'subfolder'),
    ]);
  });

  it('rejects missing scope, traversal, absolute paths and links escaping the folder', async () => {
    await expect(resolveDropPaths(null, ['a file.txt'])).rejects.toThrow(/Choose a folder/);
    await expect(resolveDropPaths(folder, ['../outside.txt'])).rejects.toThrow(/outside/);
    await expect(resolveDropPaths(folder, [join(folder, 'a file.txt')])).rejects.toThrow(/Invalid/);
    await symlink(join(root, 'outside.txt'), join(folder, 'escape'));
    await expect(resolveDropPaths(folder, ['escape'])).rejects.toThrow(/outside/);
  });

  it('allows canonical links remaining inside the scope', async () => {
    await symlink(join(folder, 'a file.txt'), join(folder, 'alias'));
    expect(await resolveDropPaths(folder, ['alias'])).toEqual([join(folder, 'a file.txt')]);
  });

  it('rejects unbounded payloads, terminal controls and missing files', async () => {
    for (const input of [[], new Array(17).fill('a file.txt'), [null], ['a\nb.txt'], ['x\u001by'], ['https://example.com/a']]) {
      await expect(resolveDropPaths(folder, input)).rejects.toThrow();
    }
    await expect(resolveDropPaths(folder, ['missing.txt'])).rejects.toThrow();
  });
});

function transfer(payload: Record<string, string> = {}, files: File[] = []): DataTransfer {
  return {
    types: [...Object.keys(payload), ...(files.length ? ['Files'] : [])], files,
    getData: (type: string) => payload[type] || '',
    setData: (type: string, data: string) => { payload[type] = data; },
    effectAllowed: 'none',
  } as unknown as DataTransfer;
}

describe('file drop transfer and terminal input', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('recognizes file drags while leaving plain text and web links untouched', () => {
    expect(hasFileDrop(transfer({}, [{} as File]))).toBe(true);
    expect(hasFileDrop(transfer({ [HELLO_FILES_MIME]: '{}' }))).toBe(true);
    expect(hasFileDrop(transfer({ 'text/plain': 'hello', 'text/uri-list': 'https://example.com/' }))).toBe(false);
  });

  it('uses Electron native file identities rather than names or legacy File.path', async () => {
    const file = { name: 'name-only.txt', path: '/fake/legacy.txt' } as unknown as File;
    vi.mocked(api.system.pathsForFiles).mockReturnValue(['/Users/q/actual file.txt']);
    expect(await droppedPaths(transfer({}, [file]))).toEqual(['/Users/q/actual file.txt']);
    expect(api.system.pathsForFiles).toHaveBeenCalledWith([file]);
  });

  it('resolves internal paths through the original conversation and never accepts a supplied root', async () => {
    const data = transfer();
    setInternalFileDrop(data, 'chat-a', ['subfolder/file.txt']);
    expect(data.effectAllowed).toBe('copy');
    vi.mocked(api.files.resolvePaths).mockResolvedValue(['/workspace/subfolder/file.txt']);
    expect(await droppedPaths(data)).toEqual(['/workspace/subfolder/file.txt']);
    expect(api.files.resolvePaths).toHaveBeenCalledWith('chat-a', ['subfolder/file.txt']);
  });

  it('fails closed for malformed or overlong drop payloads', async () => {
    for (const data of ['{', '{}', JSON.stringify({ conversationId: 'a', paths: ['file\nname'] }), 'x'.repeat(140_000)]) {
      await expect(droppedPaths(transfer({ [HELLO_FILES_MIME]: data }))).rejects.toThrow();
    }
    expect(api.files.resolvePaths).not.toHaveBeenCalled();
  });

  it('quotes spaces, quotes and command substitutions without appending Enter', () => {
    const result = quoteTerminalPaths(['/tmp/a b', "/tmp/o'clock", '/tmp/$(touch evil);`whoami`']);
    expect(result).toBe("'/tmp/a b' '/tmp/o'\"'\"'clock' '/tmp/$(touch evil);`whoami`' ");
    expect(result).not.toMatch(/[\r\n\u001b]/);
    expect(() => quoteTerminalPaths(['/tmp/line\nnext'])).toThrow();
    expect(() => quoteTerminalPaths(['/tmp/escape\u001b[200~'])).toThrow();
  });
});
