/**
 * Pure layout logic for the terminal pane: which edge it is docked to, how big
 * it may be there, where a drag of its own edge puts it, and what survives a
 * reload.
 *
 * The pane's default home is a drawer at the foot of the conversation, like
 * an editor terminal. It can still be dragged into a full-height side column,
 * and which of the two positions the user chose is remembered.
 *
 * Geometry is a renderer-only layout preference, so it persists in
 * `localStorage` rather than through the system-preferences channel — the same
 * reasoning as the browser split ratio (src/renderer/app/browser-split.ts).
 */

/** Which edge the pane is attached to. */
export type TerminalDock = 'right' | 'bottom';

export const TERMINAL_DOCK = {
  defaultDock: 'bottom',

  /** Column width, used while docked to the right. */
  minWidth: 280,
  maxWidth: 1200,
  defaultWidth: 460,
  /** The conversation never shrinks below this to make room for the column. */
  minConversationWidth: 320,

  /** Drawer height, used while docked at the foot of the chat column. */
  minHeight: 120,
  maxHeight: 720,
  defaultHeight: 260,
  defaultHeightRatio: 1 / 3,
  /** The conversation never shrinks below this to make room for the drawer. */
  minConversationHeight: 200,

  widthStorageKey: 'terminal-pane-width',
  cliWorkerWidthStorageKey: 'cli-worker-pane-width',
  dockStorageKey: 'terminal-pane-dock',
  cliWorkerDockStorageKey: 'cli-worker-pane-dock',
  /* The two keys that predate the column keep their names: a rename would
     forget the height and open state every existing user already has. */
  heightStorageKey: 'terminal-drawer-height',
  cliWorkerHeightStorageKey: 'cli-worker-drawer-height',
  openStorageKey: 'terminal-drawer-open',
} as const;

/**
 * How much of the shell's height, measured from its foot, reads as "the user
 * dropped this at the bottom" while dragging the pane's header.
 */
const BOTTOM_DOCK_BAND = 0.25;

/** Pointer travel below which a header drag was really a click. */
export const DOCK_DRAG_THRESHOLD_PX = 4;

export function clampTerminalPaneWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return TERMINAL_DOCK.defaultWidth;
  }

  return Math.min(TERMINAL_DOCK.maxWidth, Math.max(TERMINAL_DOCK.minWidth, Math.round(width)));
}

export function clampTerminalDrawerHeight(height: number): number {
  if (!Number.isFinite(height)) {
    return TERMINAL_DOCK.defaultHeight;
  }

  return Math.min(TERMINAL_DOCK.maxHeight, Math.max(TERMINAL_DOCK.minHeight, Math.round(height)));
}

/** Initial drawer size for a concrete chat region: one third, within safe bounds. */
export function defaultTerminalDrawerHeight(availableHeight: number): number {
  return clampTerminalDrawerHeight(availableHeight * TERMINAL_DOCK.defaultHeightRatio);
}

/**
 * Column width for a pointer at `clientX` while dragging the left edge, with
 * the conversation beside it kept usable. The column is the last item in the
 * shell row, so its right edge is the container's.
 */
export function terminalPaneWidthFromPointer(
  clientX: number,
  container: Pick<DOMRect, 'left' | 'width'>,
): number {
  const ceiling = Math.max(
    TERMINAL_DOCK.minWidth,
    container.width - TERMINAL_DOCK.minConversationWidth,
  );

  return Math.min(ceiling, clampTerminalPaneWidth(container.left + container.width - clientX));
}

/**
 * Drawer height for a pointer at `clientY` while dragging the top edge, with
 * the conversation above it kept usable.
 */
export function terminalDrawerHeightFromPointer(
  clientY: number,
  container: Pick<DOMRect, 'top' | 'height'>,
): number {
  const ceiling = Math.max(
    TERMINAL_DOCK.minHeight,
    container.height - TERMINAL_DOCK.minConversationHeight,
  );

  return Math.min(ceiling, clampTerminalDrawerHeight(container.top + container.height - clientY));
}

/**
 * Where a header drag ending at `clientY` puts the pane. Only the vertical
 * position decides it: the gesture the user is making is "put this along the
 * bottom", and a rule stated in one axis is one they can predict from the
 * first attempt.
 */
export function terminalDockFromPointer(
  clientY: number,
  container: Pick<DOMRect, 'top' | 'height'>,
): TerminalDock {
  if (!(container.height > 0)) {
    return TERMINAL_DOCK.defaultDock;
  }

  const band = container.top + container.height * (1 - BOTTOM_DOCK_BAND);
  return clientY >= band ? 'bottom' : 'right';
}

/** Minimal storage surface so persistence is testable without a DOM. */
export interface DockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): DockStorage | null {
  // `localStorage` can throw on access in restricted contexts.
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadTerminalDock(storage: DockStorage | null = defaultStorage()): TerminalDock {
  try {
    const saved = storage?.getItem(TERMINAL_DOCK.dockStorageKey);
    return saved === 'bottom' || saved === 'right' ? saved : TERMINAL_DOCK.defaultDock;
  } catch {
    return TERMINAL_DOCK.defaultDock;
  }
}

export function saveTerminalDock(
  dock: TerminalDock,
  storage: DockStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(TERMINAL_DOCK.dockStorageKey, dock);
  } catch {
    // A full or unavailable storage loses only a layout preference.
  }
}

export function loadTerminalPaneWidth(storage: DockStorage | null = defaultStorage()): number {
  if (!storage) {
    return TERMINAL_DOCK.defaultWidth;
  }

  try {
    const raw = storage.getItem(TERMINAL_DOCK.widthStorageKey);
    return raw === null
      ? TERMINAL_DOCK.defaultWidth
      : clampTerminalPaneWidth(Number.parseFloat(raw));
  } catch {
    return TERMINAL_DOCK.defaultWidth;
  }
}

export function saveTerminalPaneWidth(
  width: number,
  storage: DockStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(TERMINAL_DOCK.widthStorageKey, String(clampTerminalPaneWidth(width)));
  } catch {
    // A full or unavailable storage loses only a layout preference.
  }
}

/** The coding CLI is a distinct side pane and keeps its own preferred width. */
export function loadCliWorkerPaneWidth(storage: DockStorage | null = defaultStorage()): number {
  if (!storage) {
    return TERMINAL_DOCK.defaultWidth;
  }

  try {
    const raw = storage.getItem(TERMINAL_DOCK.cliWorkerWidthStorageKey);
    return raw === null
      ? TERMINAL_DOCK.defaultWidth
      : clampTerminalPaneWidth(Number.parseFloat(raw));
  } catch {
    return TERMINAL_DOCK.defaultWidth;
  }
}

export function saveCliWorkerPaneWidth(
  width: number,
  storage: DockStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(TERMINAL_DOCK.cliWorkerWidthStorageKey, String(clampTerminalPaneWidth(width)));
  } catch {
    // A full or unavailable storage loses only a layout preference.
  }
}

export function loadCliWorkerDock(storage: DockStorage | null = defaultStorage()): TerminalDock {
  try {
    const saved = storage?.getItem(TERMINAL_DOCK.cliWorkerDockStorageKey);
    return saved === 'bottom' || saved === 'right' ? saved : TERMINAL_DOCK.defaultDock;
  } catch {
    return TERMINAL_DOCK.defaultDock;
  }
}

export function saveCliWorkerDock(
  dock: TerminalDock,
  storage: DockStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(TERMINAL_DOCK.cliWorkerDockStorageKey, dock);
  } catch {
    // A full or unavailable storage loses only a layout preference.
  }
}

export function loadCliWorkerDrawerHeight(storage: DockStorage | null = defaultStorage()): number {
  if (!storage) {
    return TERMINAL_DOCK.defaultHeight;
  }

  try {
    const raw = storage.getItem(TERMINAL_DOCK.cliWorkerHeightStorageKey);
    return raw === null
      ? TERMINAL_DOCK.defaultHeight
      : clampTerminalDrawerHeight(Number.parseFloat(raw));
  } catch {
    return TERMINAL_DOCK.defaultHeight;
  }
}

export function saveCliWorkerDrawerHeight(
  height: number,
  storage: DockStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(
      TERMINAL_DOCK.cliWorkerHeightStorageKey,
      String(clampTerminalDrawerHeight(height)),
    );
  } catch {
    // A full or unavailable storage loses only a layout preference.
  }
}

export function loadTerminalDrawerHeight(storage: DockStorage | null = defaultStorage()): number {
  if (!storage) {
    return TERMINAL_DOCK.defaultHeight;
  }

  try {
    const raw = storage.getItem(TERMINAL_DOCK.heightStorageKey);
    return raw === null
      ? TERMINAL_DOCK.defaultHeight
      : clampTerminalDrawerHeight(Number.parseFloat(raw));
  } catch {
    return TERMINAL_DOCK.defaultHeight;
  }
}

export function saveTerminalDrawerHeight(
  height: number,
  storage: DockStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(TERMINAL_DOCK.heightStorageKey, String(clampTerminalDrawerHeight(height)));
  } catch {
    // A full or unavailable storage loses only a layout preference.
  }
}

export function loadTerminalOpen(storage: DockStorage | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(TERMINAL_DOCK.openStorageKey) === 'true';
  } catch {
    return false;
  }
}

export function saveTerminalOpen(
  open: boolean,
  storage: DockStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(TERMINAL_DOCK.openStorageKey, open ? 'true' : 'false');
  } catch {
    // A full or unavailable storage loses only a layout preference.
  }
}
