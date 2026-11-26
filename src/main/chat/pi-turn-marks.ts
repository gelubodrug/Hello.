import { open, readFile, rename, stat, truncate, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * Where Pi's session ended before each message the person sent, so that a
 * message taken back can be cut off the session instead of the session being
 * rebuilt (user, 26.11: "fă varianta de mijloc, taie doar coada").
 *
 * Pi's session file is append-only, one entry a line, written as each entry
 * happens. Its length just before a prompt is therefore the whole of what the
 * model knew then, and truncating to it brings exactly that back: the summary
 * of an earlier compaction, the tool results, the notes — and nothing of the
 * turn that followed. No entry is read for its meaning, so nothing here depends
 * on what Pi puts in one.
 *
 * A mark is trusted only while the entry that ended the session then still ends
 * at the same byte. Anything else — no mark, a file that was replaced or
 * rewritten — is not cut: the caller rebuilds the session from the chat.
 */
const SESSION = 'session.jsonl';
const MARKS = 'turn-marks.json';
/** Only the last message can be taken back, then the one before it: a few marks are plenty. */
const KEPT = 40;

interface Mark { offset: number; before: string }
type Marks = Record<string, Mark>;

/** The id of the entry whose line ends exactly at `end`, or null when no line ends there. */
async function entryEndingAt(file: string, end: number): Promise<string | null> {
  if (end < 2) return null;
  const handle = await open(file, 'r');
  try {
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, end - 1);
    if (last[0] !== 0x0a) return null;
    // Back from the newline to the one before it: the line may be long (a tool result).
    const chunks: Buffer[] = [];
    let position = end - 1;
    while (position > 0) {
      const size = Math.min(64 * 1024, position);
      const chunk = Buffer.alloc(size);
      await handle.read(chunk, 0, size, position - size);
      const newline = chunk.lastIndexOf(0x0a);
      if (newline >= 0) { chunks.unshift(chunk.subarray(newline + 1)); break; }
      chunks.unshift(chunk);
      position -= size;
    }
    const entry: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const id = entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function readMarks(dir: string): Promise<Marks> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, MARKS), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const marks: Marks = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const mark = value as Partial<Mark> | null;
      if (mark && Number.isSafeInteger(mark.offset) && typeof mark.before === 'string') marks[id] = { offset: mark.offset!, before: mark.before };
    }
    return marks;
  } catch {
    return {};
  }
}

async function writeMarks(dir: string, marks: Marks): Promise<void> {
  const kept = Object.fromEntries(Object.entries(marks).sort(([, a], [, b]) => a.offset - b.offset).slice(-KEPT));
  const temporary = join(dir, `${MARKS}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(kept), { mode: 0o600 });
  await rename(temporary, join(dir, MARKS));
}

/** Notes where the session ends now, for the message about to be sent to Pi. Never throws: a turn does not wait on a mark. */
export async function markPiTurn(dir: string, messageId: string): Promise<void> {
  try {
    const file = join(dir, SESSION);
    const offset = (await stat(file)).size;
    const before = await entryEndingAt(file, offset);
    if (!before) return;
    const marks = await readMarks(dir);
    // A session that got shorter was cut or replaced: marks past its end describe another file.
    for (const [id, mark] of Object.entries(marks)) if (mark.offset >= offset) delete marks[id];
    marks[messageId] = { offset, before };
    await writeMarks(dir, marks);
  } catch { /* no mark: taking this message back rebuilds the session instead */ }
}

/**
 * Cuts the session back to where it ended before that message. True when it
 * did; false when there is no mark that can still be trusted, and nothing was
 * touched. Only call it once the Pi process that owns the file is closed.
 */
export async function cutPiTurn(dir: string, messageId: string): Promise<boolean> {
  const file = join(dir, SESSION);
  const marks = await readMarks(dir);
  const mark = marks[messageId];
  if (!mark) return false;
  let size: number;
  try { size = (await stat(file)).size; } catch { return false; }
  if (mark.offset > size || await entryEndingAt(file, mark.offset) !== mark.before) return false;
  await truncate(file, mark.offset);
  for (const [id, other] of Object.entries(marks)) if (other.offset >= mark.offset) delete marks[id];
  await writeMarks(dir, marks).catch(() => { /* stale marks are refused by their own check */ });
  return true;
}
