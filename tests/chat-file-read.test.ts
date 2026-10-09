import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FILE_READ_LIMITS, readFileRange } from '../src/main/chat/file-read';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'hello-range-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const read = (input: { startLine?: unknown; lineCount?: unknown } = {}) => readFileRange(join(root, 'file.txt'), input, new AbortController().signal);

describe('bounded UTF-8 file ranges', () => {
  it('keeps small unrequested reads unchanged and ranges are 1-based', async () => {
    await writeFile(join(root, 'file.txt'), 'one\r\ntwo\r\nthree');
    expect(await read()).toBe('one\r\ntwo\r\nthree');
    expect(JSON.parse(await read({ startLine: 2, lineCount: 1 }))).toMatchObject({ content: 'two\r\n', startLine: 2, endLine: 2, totalLines: 3 });
    expect(JSON.parse(await read({ startLine: 9 }))).toMatchObject({ content: '', returnedLines: 0, totalLines: 3 });
  });
  it('returns the head and total line count for a large file, then reads later lines', async () => {
    await writeFile(join(root, 'file.txt'), Array.from({ length: 6000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    expect(JSON.parse(await read())).toMatchObject({ totalLines: 6000, returnedLines: 2000, endLine: 2000, truncated: true });
    expect(JSON.parse(await read({ startLine: 5999, lineCount: 2 }))).toMatchObject({ content: 'line 5999\nline 6000\n', totalLines: 6000, returnedLines: 2 });
  });
  it('caps a huge line including JSON overhead without breaking Unicode', async () => {
    await writeFile(join(root, 'file.txt'), '🦉\\"'.repeat(40_000));
    const result = await read();
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(FILE_READ_LIMITS.bytes);
    const range = JSON.parse(result);
    expect(range.totalLines).toBe(1);
    expect(range.lineTruncated).toBe(true);
    expect(range.content).not.toContain('�');
  });
  it('rejects binary bytes outside the requested excerpt, symlinks and oversized files', async () => {
    await writeFile(join(root, 'file.txt'), 'first\n' + 'x'.repeat(200_000) + '\0');
    await expect(read({ lineCount: 1 })).rejects.toThrow(/Binary/);
    await rm(join(root, 'file.txt'));
    await writeFile(join(root, 'target'), 'text');
    await symlink(join(root, 'target'), join(root, 'file.txt'));
    await expect(read()).rejects.toThrow();
    await rm(join(root, 'file.txt'));
    const handle = await open(join(root, 'file.txt'), 'w');
    await handle.truncate(FILE_READ_LIMITS.fileBytes + 1); await handle.close();
    await expect(read()).rejects.toThrow(/50 MiB/);
  });
  it('rejects invalid ranges and honours Stop before opening', async () => {
    for (const input of [{ startLine: 0 }, { startLine: '1' }, { lineCount: 2001 }, { lineCount: -1 }])
      await expect(read(input)).rejects.toThrow(/integer/);
    await expect(readFileRange(join(root, 'missing'), {}, AbortSignal.abort(new Error('Stopped')))).rejects.toThrow('Stopped');
  });
});
