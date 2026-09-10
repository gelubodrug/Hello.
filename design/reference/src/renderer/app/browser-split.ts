import type { BrowserPaneBounds } from '../../shared/ipc-contract';

/**
 * Pure logic behind the T108 chat/browser split: ratio clamping, persistence,
 * pointer math, and the toggle keyboard shortcut. Kept free of React and IPC
 * so every rule is unit-testable in isolation (tests/unit/browser-split.test.tsx).
 *
 * The divider ratio is a renderer-only layout preference, so it persists in
 * `localStorage` rather than the system-preferences IPC channel: the preload
 * bridge validates `SystemPreferencesPatch` against a closed key set
 * (src/preload/index.ts), and a main-process round-trip buys nothing for a
 * value only this window's layout reads.
 */

export const BROWSER_SPLIT = {
  /** Smallest chat fraction of the split container. */
  minRatio: 0.25,
  /** Largest chat fraction — the browser pane keeps at least a fifth. */
  maxRatio: 0.8,
  defaultRatio: 0.6,
  storageKey: 'browser-split-ratio',
  openStorageKey: 'browser-pane-open',
} as const;

/** Chat fraction clamped to the split range; non-finite input falls back to the default. */
export function clampBrowserSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) {
    return BROWSER_SPLIT.defaultRatio;
  }

  return Math.min(BROWSER_SPLIT.maxRatio, Math.max(BROWSER_SPLIT.minRatio, ratio));
}

/** Chat fraction for a pointer at `clientX` over the split container. */
export function splitRatioFromPointer(
  clientX: number,
  container: Pick<DOMRect, 'left' | 'width'>,
): number {
  if (!(container.width > 0)) {
    return BROWSER_SPLIT.defaultRatio;
  }

  return clampBrowserSplitRatio((clientX - container.left) / container.width);
}

/** Minimal storage surface so persistence is testable without a DOM. */
export interface SplitRatioStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): SplitRatioStorage | null {
  // `localStorage` can throw on access in restricted contexts.
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadBrowserSplitRatio(
  storage: SplitRatioStorage | null = defaultStorage(),
): number {
  if (!storage) {
    return BROWSER_SPLIT.defaultRatio;
  }

  try {
    const raw = storage.getItem(BROWSER_SPLIT.storageKey);
    if (raw === null) {
      return BROWSER_SPLIT.defaultRatio;
    }

    return clampBrowserSplitRatio(Number.parseFloat(raw));
  } catch {
    return BROWSER_SPLIT.defaultRatio;
  }
}

export function saveBrowserSplitRatio(
  ratio: number,
  storage: SplitRatioStorage | null = defaultStorage(),
): void {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(BROWSER_SPLIT.storageKey, String(clampBrowserSplitRatio(ratio)));
  } catch {
    // A full or unavailable storage loses only a layout preference.
  }
}

export function loadBrowserOpenState(
  storage: SplitRatioStorage | null = defaultStorage(),
): boolean {
  if (!storage) {
    return false;
  }

  try {
    return storage.getItem(BROWSER_SPLIT.openStorageKey) === 'true';
  } catch {
    return false;
  }
}

export function saveBrowserOpenState(
  open: boolean,
  storage: SplitRatioStorage | null = defaultStorage(),
): void {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(BROWSER_SPLIT.openStorageKey, open ? 'true' : 'false');
  } catch {
    // A full or unavailable storage loses only a layout preference.
  }
}

/**
 * ⌘⇧B / Ctrl+Shift+B toggles the browser pane. ⌘B alone belongs to the
 * sidebar (src/renderer/layout/Sidebar.tsx), so Shift is required here.
 */
export function isBrowserToggleShortcut(
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'key'>,
): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 'b'
  );
}

/** Viewport rect of the reserved content region, rounded to whole CSS pixels. */
export function browserContentBounds(
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
): BrowserPaneBounds {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
}
