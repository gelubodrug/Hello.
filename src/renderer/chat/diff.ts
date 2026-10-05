export interface DiffLine { kind: "same" | "del" | "add"; text: string }

/** At most this many lines a side are compared; beyond it the old and the new
 *  text are shown apart, whole, rather than compared (main allows 200k each). */
export const DIFF_LINE_CAP = 500;

const linesOf = (text: string) => (text === "" ? [] : text.split(/\r?\n/));

/**
 * The lines an edit takes out and puts in, in order, by their longest common
 * subsequence (audit B1). Null when either side is longer than the cap.
 */
export function diffLines(before: string, after: string, cap = DIFF_LINE_CAP): DiffLine[] | null {
  const a = linesOf(before);
  const b = linesOf(after);
  if (a.length > cap || b.length > cap) return null;
  const width = b.length + 1;
  // How long the common run is from a[i] and b[j] on; 500 fits a Uint16.
  const common = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      common[i * width + j] = a[i] === b[j]
        ? common[(i + 1) * width + j + 1] + 1
        : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { lines.push({ kind: "same", text: a[i] }); i += 1; j += 1; }
    else if (common[(i + 1) * width + j] >= common[i * width + j + 1]) { lines.push({ kind: "del", text: a[i] }); i += 1; }
    else { lines.push({ kind: "add", text: b[j] }); j += 1; }
  }
  while (i < a.length) lines.push({ kind: "del", text: a[i++] });
  while (j < b.length) lines.push({ kind: "add", text: b[j++] });
  return lines;
}
