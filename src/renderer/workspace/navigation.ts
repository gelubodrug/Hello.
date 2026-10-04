import type { WorkspacePrefs } from './Workspace';

type PaneLayout = Pick<WorkspacePrefs, 'toolsOpen' | 'chatOpen' | 'expanded' | 'toolsExpanded'>;

export function hasExpandedPane(ui: PaneLayout): boolean {
  // Solo Chat expands inside its original right-hand stage. Full-workspace
  // focus mode belongs to the two-pane Tools layout only.
  return ui.toolsOpen && ((ui.chatOpen && ui.expanded) || ui.toolsExpanded);
}

/**
 * Whether the chats sidebar shows: pinned, or on Auto when the window has room
 * for it beside the chat — more room when the chat has tools open — and never
 * beside a pane expanded to fill the window. The DSH surface is a place of its
 * own: the layout of the chat behind it decides nothing there, and leaving it
 * is a click in this sidebar (user, 01.10: with the chat's pane expanded the
 * surface took the whole window, under the window's buttons, with no way back).
 */
export function navigationShown(
  sidebar: 'auto' | 'shown' | 'hidden',
  ui: PaneLayout,
  width: number,
  dshOpen: boolean,
): boolean {
  if (!dshOpen && hasExpandedPane(ui)) return false;
  return sidebar === 'shown' || (sidebar === 'auto' && width >= (!dshOpen && ui.toolsOpen ? 1280 : 720));
}
