import type { IBuffer, IBufferCell } from "@xterm/xterm";

/** Where found text sits: its first cell, and how many cells it covers,
 *  running on into the rows below — what `Terminal.select` takes. */
export interface TerminalMatch { row: number; col: number; length: number }

/** A row's part of a logical line. A row of one-cell characters maps each
 *  character to the column at its index; any other row keeps its cells. */
interface Segment { row: number; offset: number; length: number; cells?: Array<{ col: number; width: number }> }
interface LogicalLine { text: string; segments: Segment[] }

/** Rows joined across soft wraps, so text that wrapped is found whole. */
function logicalLines(buffer: IBuffer, cols: number): LogicalLine[] {
  const lines: LogicalLine[] = [];
  let cell: IBufferCell | undefined;
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    let target: LogicalLine;
    if (line.isWrapped && lines.length) target = lines[lines.length - 1];
    else lines.push(target = { text: "", segments: [] });
    const plain = line.translateToString(false, 0, cols);
    if (plain.length === cols && !/[\uD800-\uDFFF̀-ͯ]/.test(plain)) {
      target.segments.push({ row, offset: target.text.length, length: cols });
      target.text += plain;
      continue;
    }
    // Wide characters, emoji and combining marks: cell by cell. The second
    // half of a wide character has width 0 and no text of its own.
    const cells: Array<{ col: number; width: number }> = [];
    let text = "";
    for (let col = 0; col < cols; col += 1) {
      cell = line.getCell(col, cell);
      if (!cell) break;
      const width = cell.getWidth();
      if (width === 0) continue;
      const chars = cell.getChars() || " ";
      for (let unit = 0; unit < chars.length; unit += 1) cells.push({ col, width });
      text += chars;
    }
    target.segments.push({ row, offset: target.text.length, length: text.length, cells });
    target.text += text;
  }
  return lines;
}

function locate(line: LogicalLine, index: number): { row: number; col: number; width: number } | null {
  for (const segment of line.segments) {
    if (index < segment.offset || index >= segment.offset + segment.length) continue;
    const at = index - segment.offset;
    if (!segment.cells) return { row: segment.row, col: at, width: 1 };
    const cell = segment.cells[at];
    return cell ? { row: segment.row, col: cell.col, width: cell.width } : null;
  }
  return null;
}

/**
 * Every place the query occurs in the buffer, literally and whatever the case,
 * top to bottom (S209 F5). A line whose lower case changes its length is
 * searched as it is, so an index always names the cell it came from.
 */
export function findInBuffer(buffer: IBuffer, cols: number, query: string): TerminalMatch[] {
  const needle = query.toLocaleLowerCase();
  if (!needle.trim() || cols <= 0) return [];
  const matches: TerminalMatch[] = [];
  for (const line of logicalLines(buffer, cols)) {
    const lower = line.text.toLocaleLowerCase();
    const hay = lower.length === line.text.length ? lower : line.text;
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
      const first = locate(line, at);
      const last = locate(line, at + needle.length - 1);
      if (!first || !last) continue;
      matches.push({ row: first.row, col: first.col, length: (last.row - first.row) * cols + last.col + last.width - first.col });
    }
  }
  return matches;
}
