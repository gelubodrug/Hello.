import type { AppSettings } from './types';

/** The smallest window a chat can run on: Pi's reserve and room to work. */
const MIN_WINDOW = 20480;

export interface ContextBudget {
  /** What the runtime is told the model holds: the window it publishes. */
  window: number;
  /** The answer's budget as declared to the provider, which is never the person's setting raised. */
  maxTokens: number;
  /** What must stay free, so a request is legal and a tool result still fits. */
  reserveTokens: number;
  /** What the conversation may fill before the runtime summarises it: `shouldCompact` is `tokens > usable`. */
  usable: number;
  /** How much of the transcript a summary keeps. */
  keepRecentTokens: number;
}

/** Pi's own defaults (its settings: `compaction.reserveTokens`, `compaction.keepRecentTokens`). */
export const PI_RESERVE_TOKENS = 16384;
export const PI_KEEP_RECENT_TOKENS = 20000;

/**
 * One arithmetic for the window, shared by the launch that configures the
 * runtime and the meter that draws it — and it is Pi's own, the one its CLI
 * runs on (user, 26.11: the context in the chat was "calculat aleatoriu… față
 * de pi nativ cli; aș vrea… să fie 1:1 cu cli-ul"). The window is the one the
 * model publishes, whole: nothing learned shrinks it. Pi summarises when
 * `tokens > window - reserveTokens`, with its default reserve of 16,384, and
 * keeps its default 20,000 recent tokens.
 *
 * Hello used to hold 45% of the window free and scale the window down after a
 * turn whose prompt ran over, so a 131,072 model summarised itself at 72k and
 * the bar read "100% of 72.1k". Pi already clamps a request's output to what
 * is left and recovers from an overflow by summarising, which is what the CLI
 * relies on.
 */
export function contextBudget(settings: Pick<AppSettings, 'contextWindow' | 'maxOutputTokens'>): ContextBudget {
  const window = Math.max(MIN_WINDOW, settings.contextWindow ?? 32768);
  // An output budget is a ceiling for one answer, not a floor held free for
  // every turn: a quarter of the window is the most an answer may hold back.
  // The setting itself is never rewritten. 8,192 = Pi's 4,096 provider-side
  // margin plus the 4,096 the profile needs.
  const maxTokens = Math.min(settings.maxOutputTokens ?? 4096, window - 8192, Math.max(4096, Math.floor(window / 4)));
  const reserveTokens = PI_RESERVE_TOKENS;
  const usable = window - reserveTokens;
  return { window, maxTokens, reserveTokens, usable,
    // Pi's 20,000 wherever the window has room for it. A window too small to
    // keep that much after a summary keeps a third of what is usable: a
    // summary that leaves the chat over the line summarises again at once.
    keepRecentTokens: Math.max(1, Math.min(PI_KEEP_RECENT_TOKENS, Math.floor(usable / 3))) };
}
