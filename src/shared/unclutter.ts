/** Unclutter, as the window sees it: one tab's page, the switches, and OpenJev. */

export interface UnclutterSwitches { enabled: boolean; auto: boolean }

export interface UnclutterTabState {
  tabId: string;
  /** A web page Unclutter may clean: not a generated document, a previewed file or a local dev server. */
  eligible: boolean;
  /** The page type the page is on now, e.g. `article · /news/:detail`. */
  label?: string;
  origin?: string;
  /** Blocks hidden on the page right now. */
  hidden: number;
  /** What was learned about this page type, or null when it was never analysed. */
  profile: { enabled: boolean; rules: number; analyzedAt: number; categories: Record<string, number> } | null;
  /** An analysis of this tab under way: batches answered of all. */
  analyzing: { done: number; total: number } | null;
  error?: string | null;
}

export interface UnclutterOpenJev { state: 'ready' | 'starting' | 'stopped' | 'missing'; detail: string; ownHelper: boolean }

export interface UnclutterOverview { switches: UnclutterSwitches; openjev: UnclutterOpenJev; tab: UnclutterTabState }
