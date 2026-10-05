import type { FileDocument } from '../../shared/files';

/** The most a selection adds to the chat at once (audit A3b): a longer one is refused, never cut. */
export const QUOTE_LIMIT = 20_000;

/** A selection in the file viewer: its words, its file, and its lines when they are exact. */
export interface FileSelection { text: string; path: string; lines?: { from: number; to: number } }

/** The live selection, when it lies wholly inside the viewer. */
function selectionIn(area: HTMLElement): Selection | null {
  const selection = area.ownerDocument.getSelection();
  return selection && !selection.isCollapsed && selection.rangeCount > 0
    && area.contains(selection.anchorNode) && area.contains(selection.focusNode) ? selection : null;
}

/** Something is selected in the viewer: cheap enough for every selection change. */
export const hasSelectionIn = (area: HTMLElement | null) => Boolean(area && selectionIn(area));

const LINE = '.code-line[data-line]';

/** Where a boundary of the selection falls in the source: its line, and how far into it. */
function point(area: HTMLElement, node: Node, offset: number, edge: 'start' | 'end'): { line: number; column: number } | null {
  const line = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(LINE);
  if (line && area.contains(line)) {
    const before = area.ownerDocument.createRange();
    before.setStart(line, 0);
    before.setEnd(node, offset);
    return { line: Number(line.dataset.line), column: before.toString().length };
  }
  // On the element that holds the lines, the boundary sits between two of them.
  const beside = node.childNodes[edge === 'start' ? offset : offset - 1];
  return beside instanceof HTMLElement && beside.matches(LINE) && area.contains(beside)
    ? { line: Number(beside.dataset.line), column: edge === 'start' ? 0 : Infinity } : null;
}

/**
 * What the viewer's selection adds to the chat (audit A3b). In Source the
 * words come from the file itself, between the lines and columns the selection
 * covers; anywhere else — a Markdown preview — they are the words as shown,
 * and no line is claimed.
 */
export function fileSelection(area: HTMLElement, file: FileDocument, source: boolean): FileSelection | null {
  const selection = selectionIn(area);
  if (!selection || file.content == null) return null;
  const range = selection.getRangeAt(0);
  const block = source ? area.querySelector(':scope > .code-block') : null;
  const start = block?.contains(range.startContainer) ? point(area, range.startContainer, range.startOffset, 'start') : null;
  const end = start && block?.contains(range.endContainer) ? point(area, range.endContainer, range.endOffset, 'end') : null;
  const lines = file.content.split('\n').map(line => line.replace(/\r$/, ''));
  if (start && end && start.line >= 1 && start.line <= end.line && end.line <= lines.length) {
    let from = start.line, to = end.line;
    let first = Math.min(start.column, lines[from - 1].length), last = Math.min(end.column, lines[to - 1].length);
    // From the very end of a line, or to the very start of one, does not claim that line.
    if (from < to && first === lines[from - 1].length) { from++; first = 0; }
    if (from < to && last === 0) { to--; last = lines[to - 1].length; }
    const text = from === to ? lines[from - 1].slice(first, last)
      : [lines[from - 1].slice(first), ...lines.slice(from, to - 1), lines[to - 1].slice(0, last)].join('\n');
    return text ? { text, path: file.path, lines: { from, to } } : null;
  }
  const text = selection.toString();
  return text ? { text, path: file.path } : null;
}

/** The words a selection adds to the draft: where they come from, then the words — code fenced, prose quoted. */
export function selectionQuote(selected: FileSelection, language: string): string {
  const tick = selected.path.includes('`') ? '``' : '`';
  const lines = selected.lines;
  const where = `From ${tick}${selected.path}${tick}${lines ? lines.from === lines.to ? ` (line ${lines.from})` : ` (lines ${lines.from}–${lines.to})` : ''}:`;
  if (!lines) return `${where}\n${selected.text.split('\n').map(line => `> ${line}`).join('\n')}`;
  const fence = '`'.repeat(Math.max(3, ...(selected.text.match(/`+/g) ?? []).map(run => run.length + 1)));
  return `${where}\n${fence}${language === 'text' ? '' : language}\n${selected.text}\n${fence}`;
}
