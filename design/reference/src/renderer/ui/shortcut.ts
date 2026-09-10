/**
 * Keyboard-shortcut labels, written once for every platform.
 *
 * The labels used to be literals — `'⌘B'`, `'Close terminal ⌘J'` — which are
 * simply wrong off macOS: the handlers accept Ctrl there, so the label promised
 * a key that does nothing. A wrong chip is worse than no chip, so the binding
 * and its label are derived from the same place.
 *
 * This yields a string rather than an element because the app's `Tooltip` and
 * menu rows take `label` strings; a component would need every one of those to
 * accept nodes, which is a larger change than the problem warrants.
 */

/** A modifier named by role, plus the literal key it is pressed with. */
export type ShortcutKey = 'mod' | 'shift' | 'alt' | (string & {});

function detectMac(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const platform =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    navigator.userAgent ??
    '';
  return /mac/i.test(platform);
}

/**
 * True when the accelerator this app binds is Command rather than Control.
 * Exported so a handler and its label can never disagree about which it is.
 */
export const isMacPlatform = detectMac;

const MAC_GLYPHS: Record<string, string> = { mod: '⌘', shift: '⇧', alt: '⌥' };
const OTHER_NAMES: Record<string, string> = { mod: 'Ctrl', shift: 'Shift', alt: 'Alt' };

/**
 * `shortcutLabel(['mod', 'shift', 'B'])` → `⌘⇧B` on macOS, `Ctrl+Shift+B`
 * elsewhere. macOS sets its glyphs adjacent by convention; every other platform
 * joins with `+`.
 */
export function shortcutLabel(keys: ShortcutKey[], mac = detectMac()): string {
  const table = mac ? MAC_GLYPHS : OTHER_NAMES;
  const parts = keys.map((key) => table[key] ?? key.toUpperCase());
  return mac ? parts.join('') : parts.join('+');
}

/** A label with its shortcut trailing, for tooltips on icon-only controls. */
export function withShortcut(label: string, keys: ShortcutKey[], mac = detectMac()): string {
  return `${label} ${shortcutLabel(keys, mac)}`;
}
