import type { MenuAction } from "../shared/types";

/**
 * Which chat a menu key lands on (S209): ⌘1–9 the chat at that place in the
 * list, ⌘⇧] and ⌘⇧[ the next or previous one, round the end, ⌘J the next one
 * waiting for the person after the one open, round the end. Null: none.
 */
export function chatForMenu(
  action: Exclude<MenuAction, "new-chat" | "toggle-sidebar">,
  order: readonly string[],
  activeId: string | null,
  waiting: ReadonlySet<string>,
): string | null {
  const count = order.length;
  if (!count) return null;
  const at = activeId ? order.indexOf(activeId) : -1;
  if (action === "next-chat") return order[(at + 1) % count];
  if (action === "previous-chat") return order[at < 0 ? count - 1 : (at - 1 + count) % count];
  if (action === "attention-chat") {
    // The open chat comes last: it is the one already being looked at.
    for (let step = 1; step <= count; step += 1) {
      const id = order[(at + step) % count];
      if (waiting.has(id)) return id;
    }
    return null;
  }
  return order[Number(action.slice("chat-".length)) - 1] ?? null;
}
