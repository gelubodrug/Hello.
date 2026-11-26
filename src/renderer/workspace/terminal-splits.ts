/**
 * Terminals side by side in one tab (user, 26.11): a tab of terminals is a
 * binary tree whose leaves are terminal session ids. The tree is kept under
 * the id of the tab's own terminal, its lead; the other leaves are in no tab
 * strip of their own. Only the arrangement is saved: a terminal that did not
 * survive a restart is pruned, and a tree left with one leaf is no split.
 */
export type SplitDirection = 'row' | 'column';
export type SplitNode = string | { dir: SplitDirection; ratio: number; a: SplitNode; b: SplitNode };
export type TerminalSplits = Record<string, SplitNode>;

export const MIN_RATIO = 0.15;
export const clampRatio = (ratio: number) => Math.max(MIN_RATIO, Math.min(1 - MIN_RATIO, ratio));

export function leaves(node: SplitNode): string[] {
  return typeof node === 'string' ? [node] : [...leaves(node.a), ...leaves(node.b)];
}

/** `target` shares its place with `added`: beside it (row) or below it (column). */
export function splitLeaf(node: SplitNode, target: string, added: string, dir: SplitDirection): SplitNode {
  if (typeof node === 'string') return node === target ? { dir, ratio: 0.5, a: node, b: added } : node;
  return { ...node, a: splitLeaf(node.a, target, added, dir), b: splitLeaf(node.b, target, added, dir) };
}

/** The tree without these leaves; a split left with one side becomes that side. */
export function removeLeaves(node: SplitNode, ids: ReadonlySet<string>): SplitNode | null {
  if (typeof node === 'string') return ids.has(node) ? null : node;
  const a = removeLeaves(node.a, ids), b = removeLeaves(node.b, ids);
  return a === null ? b : b === null ? a : { ...node, a, b };
}

/** The split at `path` ('a'/'b' steps from the root) with a new ratio. */
export function setRatio(node: SplitNode, path: string, ratio: number): SplitNode {
  if (typeof node === 'string') return node;
  if (!path) return { ...node, ratio: clampRatio(ratio) };
  const [step, rest] = [path[0], path.slice(1)];
  return step === 'a' ? { ...node, a: setRatio(node.a, rest, ratio) } : { ...node, b: setRatio(node.b, rest, ratio) };
}

/** Which tab's tree holds this terminal: its lead's id, or none. */
export function leadOf(splits: TerminalSplits | undefined, id: string): string | undefined {
  for (const [lead, node] of Object.entries(splits ?? {})) if (leaves(node).includes(id)) return lead;
  return undefined;
}

/** The terminals shown inside another tab, never as a tab of their own. */
export function splitChildren(splits: TerminalSplits | undefined): Set<string> {
  const out = new Set<string>();
  for (const [lead, node] of Object.entries(splits ?? {})) for (const id of leaves(node)) if (id !== lead) out.add(id);
  return out;
}

/**
 * The trees as they stand among these live terminals: a dead leaf is gone, a
 * tree whose lead is gone is dropped (the lead is the tab; after a restart it
 * may be back under a new id, alone), a tree of one leaf is no split.
 */
export function liveSplits(splits: TerminalSplits | undefined, live: ReadonlySet<string>): TerminalSplits {
  const out: TerminalSplits = {};
  for (const [lead, node] of Object.entries(splits ?? {})) {
    if (!live.has(lead)) continue;
    const dead = new Set(leaves(node).filter(id => !live.has(id)));
    const kept = removeLeaves(node, dead);
    if (kept && typeof kept !== 'string') out[lead] = kept;
  }
  return out;
}

/**
 * These terminals closed. A leaf leaves its tree; a closed lead hands its tab
 * to the first terminal left in it (`renamed`), which the caller carries over
 * to where the tab is named (Tools' selection, the chat's tabs).
 */
export function closeInSplits(splits: TerminalSplits | undefined, ids: ReadonlySet<string>): { splits: TerminalSplits; renamed: Record<string, string> } {
  const out: TerminalSplits = {};
  const renamed: Record<string, string> = {};
  for (const [lead, node] of Object.entries(splits ?? {})) {
    const kept = removeLeaves(node, ids);
    if (!kept) continue;
    const next = ids.has(lead) ? leaves(kept)[0] : lead;
    if (next !== lead) renamed[lead] = next;
    if (typeof kept !== 'string') out[next] = kept;
  }
  return { splits: out, renamed };
}

function parseNode(raw: unknown, depth: number, seen: Set<string>): SplitNode | null {
  if (typeof raw === 'string') {
    if (!raw || seen.has(raw)) return null;
    seen.add(raw);
    return raw;
  }
  if (depth > 8 || !raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.dir !== 'row' && value.dir !== 'column') return null;
  const ratio = typeof value.ratio === 'number' && Number.isFinite(value.ratio) ? clampRatio(value.ratio) : 0.5;
  const a = parseNode(value.a, depth + 1, seen), b = parseNode(value.b, depth + 1, seen);
  return a && b ? { dir: value.dir, ratio, a, b } : null;
}

/** Saved trees read back; a damaged one is dropped, never a reason to fail. */
export function parseSplits(raw: unknown): TerminalSplits {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: TerminalSplits = {};
  const seen = new Set<string>();
  for (const [lead, value] of Object.entries(raw as Record<string, unknown>)) {
    const node = parseNode(value, 0, seen);
    if (node && typeof node !== 'string' && leaves(node).includes(lead)) out[lead] = node;
  }
  return out;
}
