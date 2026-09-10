import {
  isPreviewToolKind,
  isValidPreviewTabAddition,
  previewTabsReducer,
  type PreviewTabsAction,
  type PreviewTabsState,
} from './preview-tabs';

export type SidebarPreference = 'auto' | 'shown' | 'hidden';

/** One specimen per tool/CLI choice; reopening selects its own mounted session. */
export function previewToolsReducer(
  state: PreviewTabsState,
  action: PreviewTabsAction,
): PreviewTabsState {
  if (action.type === 'add') {
    if (!isPreviewToolKind(action.kind) || !isValidPreviewTabAddition(action)) return state;
    const existing = state.tabs.find(
      (tab) =>
        tab.kind === action.kind && (action.kind !== 'worker' || tab.workerId === action.workerId),
    );
    if (existing) return previewTabsReducer(state, { type: 'select', id: existing.id });
  }
  return previewTabsReducer(state, action);
}

export function previewSidebarVisible(
  width: number,
  workMode: boolean,
  preference: SidebarPreference,
): boolean {
  return preference === 'shown' || (preference === 'auto' && width >= (workMode ? 1280 : 720));
}

export function clampPreviewSplit(ratio: number, width: number): number {
  if (width < 720) return 0.35;
  return Math.max(320 / width, Math.min(1 - 400 / width, Number.isFinite(ratio) ? ratio : 0.35));
}
