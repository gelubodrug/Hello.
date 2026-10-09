type Point = { line?: number; offset: number };
export interface FileViewState { top: number; left: number; selection?: { anchor: Point; focus: Point } }

function point(area: HTMLElement, node: Node, offset: number): Point {
  const line = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('.code-line[data-line]');
  const container = line && area.contains(line) ? line : area;
  const range = area.ownerDocument.createRange();
  range.selectNodeContents(container); range.setEnd(node, offset);
  return { ...(line && container === line ? { line: Number(line.dataset.line) } : {}), offset: range.toString().length };
}
export function captureFileView(area: HTMLElement): FileViewState {
  const selection = area.ownerDocument.getSelection();
  const inside = selection && !selection.isCollapsed && selection.anchorNode && selection.focusNode &&
    area.contains(selection.anchorNode) && area.contains(selection.focusNode);
  return { top: area.scrollTop, left: area.scrollLeft, ...(inside ? { selection: {
    anchor: point(area, selection.anchorNode!, selection.anchorOffset), focus: point(area, selection.focusNode!, selection.focusOffset),
  } } : {}) };
}
function boundary(area: HTMLElement, point: Point): { node: Node; offset: number } {
  const container = point.line ? area.querySelector(`[data-line="${point.line}"]`) ?? area.querySelector('.code-line:last-child') ?? area : area;
  const walker = area.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let remaining = point.offset;
  let last: Node = container;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    last = node;
    if (remaining <= (node.textContent?.length ?? 0)) return { node, offset: remaining };
    remaining -= node.textContent?.length ?? 0;
  }
  return { node: last, offset: last.nodeType === Node.TEXT_NODE ? last.textContent?.length ?? 0 : last.childNodes.length };
}
export function restoreFileView(area: HTMLElement, state: FileViewState): void {
  if (state.selection) {
    const anchor = boundary(area, state.selection.anchor), focus = boundary(area, state.selection.focus);
    area.ownerDocument.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  }
  area.scrollTop = state.top; area.scrollLeft = state.left;
}
