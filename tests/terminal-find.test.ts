import { describe, expect, it } from "vitest";
import type { IBuffer } from "@xterm/xterm";
import { findInBuffer } from "../src/renderer/terminal/find";

// S209 F5: find in a terminal's scrollback, as xterm's buffer holds it.
type Cell = { chars: string; width: number };
function row(content: string | Cell[], cols: number, isWrapped = false) {
  const cells: Cell[] = typeof content === "string" ? [...content].map(chars => ({ chars, width: 1 })) : [...content];
  while (cells.length < cols) cells.push({ chars: "", width: 1 });
  return {
    isWrapped,
    // Like xterm: a wide character's second cell adds nothing; an empty cell is a space.
    translateToString: (_trim?: boolean, start = 0, end = cols) =>
      cells.slice(start, end).map(cell => (cell.width === 0 ? "" : cell.chars || " ")).join(""),
    getCell: (x: number) => (cells[x] ? { getChars: () => cells[x].chars, getWidth: () => cells[x].width } : undefined),
  };
}
const buffer = (rows: Array<ReturnType<typeof row>>) => ({ length: rows.length, getLine: (y: number) => rows[y] }) as unknown as IBuffer;

describe("finding in a terminal's scrollback", () => {
  it("finds words whatever the case, every place, top to bottom", () => {
    const rows = [row("npm ERR! one", 12), row("all fine", 12), row("Err two err", 12)];
    expect(findInBuffer(buffer(rows), 12, "err")).toEqual([
      { row: 0, col: 4, length: 3 },
      { row: 2, col: 0, length: 3 },
      { row: 2, col: 8, length: 3 },
    ]);
    expect(findInBuffer(buffer(rows), 12, "missing")).toEqual([]);
    expect(findInBuffer(buffer(rows), 12, "   ")).toEqual([]);
  });

  it("finds text that wrapped onto the next row, as one line", () => {
    const rows = [row("abcde", 5), row("fgh", 5, true), row("defgh", 5)];
    expect(findInBuffer(buffer(rows), 5, "def")).toEqual([
      { row: 0, col: 3, length: 3 },
      { row: 2, col: 0, length: 3 },
    ]);
  });

  it("maps wide characters and emoji to the cells they are drawn in", () => {
    const wide = [{ chars: "中", width: 2 }, { chars: "", width: 0 }, { chars: "a", width: 1 }, { chars: "b", width: 1 }];
    expect(findInBuffer(buffer([row(wide, 6)]), 6, "ab")).toEqual([{ row: 0, col: 2, length: 2 }]);
    // The wide character covers two cells, so the match does too.
    expect(findInBuffer(buffer([row(wide, 6)]), 6, "中a")).toEqual([{ row: 0, col: 0, length: 3 }]);
    const emoji = [{ chars: "😀", width: 2 }, { chars: "", width: 0 }, { chars: "x", width: 1 }];
    expect(findInBuffer(buffer([row(emoji, 4)]), 4, "x")).toEqual([{ row: 0, col: 2, length: 1 }]);
    expect(findInBuffer(buffer([row(emoji, 4)]), 4, "😀x")).toEqual([{ row: 0, col: 0, length: 3 }]);
  });
});
