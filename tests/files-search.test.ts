import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTENT_SEARCH_LIMITS, WorkspaceFiles } from '../src/main/files/service';

// Audit A3b: the search of a chat folder's contents. Temporary folders only;
// nothing here reads the person's files, and nothing scanned is kept.
let root: string;
let outside: string;
const files = () => new WorkspaceFiles(id => (id === 'chat' ? root : null));

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hello-search-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'hello-outside-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('searching the contents of a chat folder', () => {
  it('finds words that are only in a body, by line, with the match placed in its snippet', async () => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'notes.txt'), 'first line\nthe needle sits here\nlast');
    writeFileSync(join(root, 'needle-name.txt'), 'nothing to see');
    const result = await files().searchContents('chat', 'r1', 'needle');
    expect(result.requestId).toBe('r1');
    expect(result.matches).toEqual([{ path: 'src/notes.txt', line: 2, snippet: 'the needle sits here', start: 4, end: 10 }]);
    expect(result).toMatchObject({ limited: false, reasons: [], filesScanned: 2, skipped: 0 });
  });

  it('matches case only when asked', async () => {
    writeFileSync(join(root, 'a.md'), 'Hello World\nhello world');
    expect((await files().searchContents('chat', 'r', 'hello')).matches.map(match => match.line)).toEqual([1, 2]);
    expect((await files().searchContents('chat', 'r', 'hello', true)).matches.map(match => match.line)).toEqual([2]);
  });
  it('normalizes Romanian, dotted İ and Hangul and maps matches back to the original spelling', async () => {
    writeFileSync(join(root, 'unicode.txt'), '😀 s\u0326tiri\nİstanbul invoice\ni\u0307STANBUL\n가');
    const service = files();
    const first = (await service.searchContents('chat', 'r', 'ȘTIRI')).matches[0];
    expect(first).toMatchObject({ line: 1, start: 3, end: 9 });
    expect(first.snippet.slice(first.start, first.end)).toBe('s\u0326tiri');
    const cities = (await service.searchContents('chat', 'r', 'istanbul')).matches;
    expect(cities.map(hit => hit.snippet.slice(hit.start, hit.end))).toEqual(['İstanbul', 'i\u0307STANBUL']);
    expect((await service.searchContents('chat', 'r', 'invoice')).matches[0]).toMatchObject({ line: 2, start: 9, end: 16 });
    const hangul = (await service.searchContents('chat', 'r', '가')).matches[0];
    expect(hangul.snippet.slice(hangul.start, hangul.end)).toBe('가');
    expect((await service.searchContents('chat', 'r', 'știri', true)).matches).toHaveLength(1);
    expect((await service.searchContents('chat', 'r', 'ȘTIRI', true)).matches).toHaveLength(0);
    expect((await service.searchContents('chat', 'r', 'istanbul', true)).matches).toHaveLength(0);
  });

  it('keeps lines and the marked place right across CRLF, diacritics, emoji, line ends and long lines', async () => {
    const long = `${'x'.repeat(300)}😀needle${'y'.repeat(300)}`;
    writeFileSync(join(root, 'mixed.txt'), `întâi\r\nȘi acolo: țară\r\n😀 needle 😀\r\n${long}\r\nneedle`);
    const { matches } = await files().searchContents('chat', 'r', 'needle');
    expect(matches.map(match => match.line)).toEqual([3, 4, 5]);
    for (const match of matches) expect(match.snippet.slice(match.start, match.end)).toBe('needle');
    expect(matches[1].snippet.startsWith('…') && matches[1].snippet.endsWith('…')).toBe(true);
    expect(matches[1].snippet.length).toBeLessThan(170);
    expect((await files().searchContents('chat', 'r', 'ȚARĂ')).matches)
      .toEqual([{ path: 'mixed.txt', line: 2, snippet: 'Și acolo: țară', start: 10, end: 14 }]);
  });

  it('never cuts a character in two at the edges of a long line’s snippet', async () => {
    writeFileSync(join(root, 'start.txt'), `${'a'.repeat(99)}😀${'b'.repeat(59)}needle${'z'.repeat(400)}`);
    writeFileSync(join(root, 'end.txt'), `${'a'.repeat(160)}needle${'c'.repeat(93)}😀${'z'.repeat(300)}`);
    const { matches } = await files().searchContents('chat', 'r', 'needle');
    const start = matches.find(match => match.path === 'start.txt')!;
    const end = matches.find(match => match.path === 'end.txt')!;
    expect(start.snippet.startsWith('…😀')).toBe(true);
    expect(end.snippet.endsWith('😀…')).toBe(true);
    for (const match of [start, end]) {
      expect(match.snippet.slice(match.start, match.end)).toBe('needle');
      expect(match.snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });

  it('passes over links, binary, undecodable, oversized and dependency files, and counts them', async () => {
    writeFileSync(join(outside, 'secret.txt'), 'needle outside');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'linked.txt'));
    symlinkSync(outside, join(root, 'linked-folder'));
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]));
    writeFileSync(join(root, 'latin1.txt'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x20, 0xe9]));
    writeFileSync(join(root, 'big.txt'), `needle\n${'z'.repeat(CONTENT_SEARCH_LIMITS.fileBytes)}`);
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'dep.js'), 'needle');
    writeFileSync(join(root, 'kept.txt'), 'a needle');
    const result = await files().searchContents('chat', 'r', 'needle');
    expect(result.matches.map(match => match.path)).toEqual(['kept.txt']);
    expect(result.skipped).toBe(6);
    expect(result.limited).toBe(false);
  });

  it('stops at the result limit, and says that is why', async () => {
    writeFileSync(join(root, 'many.txt'), Array.from({ length: CONTENT_SEARCH_LIMITS.results + 5 }, (_, index) => `needle ${index}`).join('\n'));
    const result = await files().searchContents('chat', 'r', 'needle');
    expect(result.matches).toHaveLength(CONTENT_SEARCH_LIMITS.results);
    expect(result).toMatchObject({ limited: true, reasons: ['results'] });
  });

  it('a newer search, or a cancel, stops the one running for that chat', async () => {
    for (let index = 0; index < 50; index++) writeFileSync(join(root, `file-${index}.txt`), 'needle');
    const service = files();
    const first = service.searchContents('chat', 'old', 'needle');
    const second = service.searchContents('chat', 'new', 'needle');
    expect((await first).matches).toEqual([]);
    expect((await second).matches).toHaveLength(50);
    const third = service.searchContents('chat', 'stopped', 'needle');
    service.cancelSearch('chat');
    expect((await third).matches).toEqual([]);
  });

  it('needs the chat’s folder, and nothing else', async () => {
    await expect(new WorkspaceFiles(() => null).searchContents('chat', 'r', 'needle')).rejects.toThrow(/Choose a folder/);
  });
});
