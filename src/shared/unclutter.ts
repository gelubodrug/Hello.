/** Unclutter, as the window sees it: one tab's page, the switches, and the model that classifies. */

/** Which model classifies a page's blocks: Perplexity's Decider on OpenRouter, or OpenJev on this Mac. */
export type UnclutterClassifierId = 'decider' | 'openjev';

/** The models Unclutter can ask, in the order the menu offers them; the first is the default. */
export const UNCLUTTER_CLASSIFIERS: ReadonlyArray<{ id: UnclutterClassifierId; name: string; where: string }> = [
  { id: 'decider', name: 'Decider V1.3', where: 'Perplexity on OpenRouter, free — the redacted blocks leave this Mac' },
  { id: 'openjev', name: 'OpenJev', where: 'On this Mac, about 27 GB — nothing leaves it' },
];
export const DEFAULT_CLASSIFIER: UnclutterClassifierId = 'decider';

export interface UnclutterSwitches { enabled: boolean; auto: boolean; classifier: UnclutterClassifierId }

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

/** The chosen model as it stands: ready, starting (OpenJev loading), stopped, or missing what it needs. */
export interface UnclutterClassifier { id: UnclutterClassifierId; name: string; state: 'ready' | 'starting' | 'stopped' | 'missing'; detail: string; ownHelper: boolean }

export interface UnclutterOverview { switches: UnclutterSwitches; classifier: UnclutterClassifier; tab: UnclutterTabState }
