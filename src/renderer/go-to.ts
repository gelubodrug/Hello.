/** The groups "Go to…" shows, in this order (audit A2). */
export const GO_TO_GROUPS = ["Commands", "Chats", "Open tabs", "Matching messages"] as const;
export type GoToGroup = (typeof GO_TO_GROUPS)[number];

/** One place or action. Choosing it only navigates or runs it; typing never does. */
export interface GoToItem {
  id: string;
  group: GoToGroup;
  label: string;
  /** What tells two of the same name apart: the chat, the surface, the folder. */
  detail?: string;
  /** When it was last used or changed, for the order among equals. */
  recent?: number;
  run(): void;
}

/** 0 the whole label, 1 its start or a word's start, 2 anywhere in it; null no match. */
function score(label: string, query: string): number | null {
  const text = label.toLocaleLowerCase();
  if (text === query) return 0;
  if (text.startsWith(query) || text.split(/[\s/·._-]+/).some(word => word.startsWith(query))) return 1;
  return text.includes(query) ? 2 : null;
}

/**
 * The items for the words typed: grouped in a fixed order; within a group the
 * whole name first, then a start, then anywhere, then the most recent, then
 * as given. Matching messages are found by the search and kept as found.
 */
export function rankGoTo(items: readonly GoToItem[], query: string): GoToItem[] {
  const words = query.trim().toLocaleLowerCase();
  const ranked = items.flatMap((item, index) => {
    if (!words || item.group === "Matching messages") return [{ item, index, rank: 0 }];
    const rank = score(item.label, words) ?? (item.detail ? score(item.detail, words) : null);
    return rank === null ? [] : [{ item, index, rank: rank + (score(item.label, words) === null ? 3 : 0) }];
  });
  return ranked
    .sort((a, b) => GO_TO_GROUPS.indexOf(a.item.group) - GO_TO_GROUPS.indexOf(b.item.group)
      || a.rank - b.rank || (b.item.recent ?? 0) - (a.item.recent ?? 0) || a.index - b.index)
    .map(entry => entry.item);
}
