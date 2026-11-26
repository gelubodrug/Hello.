import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cutPiTurn, markPiTurn } from '../src/main/chat/pi-turn-marks';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function session(): { dir: string; file: string; add: (id: string, text: string) => void; read: () => string } {
  const dir = mkdtempSync(join(tmpdir(), 'hello-marks-'));
  dirs.push(dir);
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id: 'header' })}\n`);
  return { dir, file, add: (id, text) => appendFileSync(file, `${JSON.stringify({ id, type: 'message', text })}\n`), read: () => readFileSync(file, 'utf8') };
}

// User, 26.11: a message taken back is cut off Pi's session, not edited out of it.
describe('where a turn began in Pi’s session', () => {
  it('cuts back to the mark, however long the entry before it, and forgets the marks past it', async () => {
    const pi = session();
    // A tool result far longer than one read: the entry before the mark is found all the same.
    pi.add('a', 'x'.repeat(200_000));
    const before = pi.read();
    await markPiTurn(pi.dir, 'm1');
    pi.add('b', 'said by mistake');
    await markPiTurn(pi.dir, 'm2');
    pi.add('c', 'and again');
    // Taking back the earlier of two marked messages drops the later mark with it.
    expect(await cutPiTurn(pi.dir, 'm1')).toBe(true);
    expect(pi.read()).toBe(before);
    expect(await cutPiTurn(pi.dir, 'm2')).toBe(false);
    expect(await cutPiTurn(pi.dir, 'm1')).toBe(false);
    expect(pi.read()).toBe(before);
  });

  it('touches nothing without a mark it can trust', async () => {
    const pi = session();
    pi.add('a', 'first');
    expect(await cutPiTurn(pi.dir, 'never-marked')).toBe(false);
    await markPiTurn(pi.dir, 'm1');
    pi.add('b', 'second');
    // The file was replaced by one of the same length or more: the entry that ended at the mark is another.
    writeFileSync(pi.file, pi.read().replace('"id":"a"', '"id":"z"'));
    const replaced = pi.read();
    expect(await cutPiTurn(pi.dir, 'm1')).toBe(false);
    expect(pi.read()).toBe(replaced);
    // A file shorter than the mark is not cut either.
    writeFileSync(pi.file, '{"type":"session","id":"h"}\n');
    expect(await cutPiTurn(pi.dir, 'm1')).toBe(false);
    // And with no session file at all, marking and cutting are both quiet.
    rmSync(pi.file);
    await expect(markPiTurn(pi.dir, 'm3')).resolves.toBeUndefined();
    expect(await cutPiTurn(pi.dir, 'm3')).toBe(false);
  });
});
