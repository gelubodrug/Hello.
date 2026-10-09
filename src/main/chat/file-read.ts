import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export const FILE_READ_LIMITS = { fileBytes: 50 * 1024 * 1024, bytes: 128 * 1024, lines: 2000 } as const;
function positive(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  return value;
}

/** Scan to count/validate every line, retaining only the bounded requested range. */
export async function readFileRange(target: string, input: { startLine?: unknown; lineCount?: unknown }, signal: AbortSignal): Promise<string> {
  const startLine = positive(input.startLine, 'startLine') ?? 1;
  const lineCount = positive(input.lineCount, 'lineCount', FILE_READ_LIMITS.lines) ?? FILE_READ_LIMITS.lines;
  const ranged = input.startLine !== undefined || input.lineCount !== undefined;
  signal.throwIfAborted();
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Only regular files can be read.');
    if (info.size > FILE_READ_LIMITS.fileBytes) throw new Error('File exceeds the 50 MiB read limit.');
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const buffer = Buffer.alloc(64 * 1024);
    const selected: string[] = [];
    let bytesRead = 0, keptBytes = 0, line = 1;
    let endedWithNewline = true, byteClipped = false;
    const take = (text: string) => {
      let from = 0;
      while (from < text.length) {
        const newline = text.indexOf('\n', from);
        const end = newline < 0 ? text.length : newline + 1;
        if (line >= startLine && line - startLine < lineCount) {
          const piece = text.slice(from, end);
          const bytes = Buffer.from(piece);
          const room = FILE_READ_LIMITS.bytes - keptBytes;
          if (bytes.length <= room) { selected.push(piece); keptBytes += bytes.length; }
          else {
            // Streaming decode omits an incomplete final UTF-8 sequence.
            selected.push(new TextDecoder().decode(bytes.subarray(0, room), { stream: true }));
            keptBytes = FILE_READ_LIMITS.bytes; byteClipped = true;
          }
        }
        endedWithNewline = newline >= 0;
        if (newline >= 0) line++;
        from = end;
      }
    };
    for (;;) {
      signal.throwIfAborted();
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytesRead += read.bytesRead;
      if (bytesRead > FILE_READ_LIMITS.fileBytes) throw new Error('File grew beyond the 50 MiB read limit.');
      const bytes = buffer.subarray(0, read.bytesRead);
      if (bytes.includes(0)) throw new Error('Binary files are not supported.');
      try { take(decoder.decode(bytes, { stream: true })); }
      catch { throw new Error('Only UTF-8 text files can be read.'); }
    }
    try { take(decoder.decode()); } catch { throw new Error('Only UTF-8 text files can be read.'); }
    signal.throwIfAborted();
    const totalLines = bytesRead ? line - (endedWithNewline ? 1 : 0) : 0;
    let content = selected.join('');
    if (!ranged && !byteClipped && totalLines <= lineCount) return content;
    const result = () => {
      const returnedLines = content ? content.split('\n').length - (content.endsWith('\n') ? 1 : 0) : 0;
      const endLine = returnedLines ? startLine + returnedLines - 1 : null;
      return { content, startLine, endLine, returnedLines, totalLines,
        truncated: byteClipped || startLine > 1 || (endLine ?? 0) < totalLines,
        ...(byteClipped ? { lineTruncated: !content.endsWith('\n') } : {}),
        hint: `Use startLine (1-based) and lineCount (up to ${FILE_READ_LIMITS.lines}) to read another range.${byteClipped ? ' The excerpt reached the byte cap; a long line may be incomplete.' : ''}` };
    };
    let output = JSON.stringify(result());
    // The limit includes JSON escapes and metadata, not just raw source bytes.
    while (Buffer.byteLength(output) > FILE_READ_LIMITS.bytes && content.length) {
      content = content.slice(0, -Math.max(1, Math.ceil((Buffer.byteLength(output) - FILE_READ_LIMITS.bytes) / 2))).replace(/[\uD800-\uDBFF]$/, '');
      byteClipped = true;
      output = JSON.stringify(result());
    }
    return output;
  } finally { await handle.close(); }
}
