/**
 * Which keystrokes the terminal keeps, and which the app still gets.
 *
 * xterm claims nearly every key that reaches its textarea, including the ones
 * this window's own shortcuts are built on: with no handler in front of it,
 * focusing the terminal silently kills the app menu's keys (src/main/index.ts)
 * — ⌘B the sidebar, ⌘J the next waiting chat, ⌘1–9 a chat by its place,
 * ⌘⇧] and ⌘⇧[ the next and previous chat. The rules are stated here as a pure
 * decision so they can be read — and tested — without a terminal attached.
 */

export type TerminalKeyVerdict =
  /** xterm handles it: it becomes input for the shell. */
  | "terminal"
  /** The window's own shortcut; xterm must not consume it. */
  | "app"
  /** Copy the terminal's selection, which is not a DOM selection. */
  | "copy";

/** The subset of a keyboard event this decision looks at. */
export interface TerminalKeyEvent {
  type: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Window shortcuts that must survive a focused terminal, by their bare key. */
const APP_SHORTCUT_KEYS = new Set(["b", "j", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
/** ⌘⇧] and ⌘⇧[, whichever character the layout reports for them. */
const APP_SHIFTED_KEYS = new Set(["]", "[", "}", "{"]);

export function terminalKeyVerdict(
  event: TerminalKeyEvent,
  hasSelection: boolean,
): TerminalKeyVerdict {
  const accelerator = event.metaKey || event.ctrlKey;

  if (!accelerator || event.altKey) {
    return "terminal";
  }

  // Ctrl+B and Ctrl+J are ordinary control characters a shell expects (^B
  // moves back a character, ^J is a newline), so only the platform's
  // accelerator — ⌘ on macOS — is claimed by the window.
  if (event.metaKey && APP_SHORTCUT_KEYS.has(event.key.toLowerCase())) {
    return "app";
  }
  if (event.metaKey && event.shiftKey && APP_SHIFTED_KEYS.has(event.key)) {
    return "app";
  }

  // ⌘C is copy only when there is something to copy. Left as a blanket copy it
  // would be indistinguishable from Ctrl+C to anyone typing quickly, and
  // Ctrl+C — the interrupt — is the one keystroke a terminal cannot lose.
  if (event.metaKey && !event.ctrlKey && event.key.toLowerCase() === "c") {
    return hasSelection ? "copy" : "terminal";
  }

  return "terminal";
}
