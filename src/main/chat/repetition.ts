/**
 * Whether a reply has started saying the same thing over and over.
 *
 * A small model that cannot find its next move sometimes stops moving and
 * keeps talking: the same three paragraphs, again and again, until the output
 * budget is gone (user, 22.09: "ce face modelul ăsta???" over a screen of one
 * paragraph repeated six times). No one benefits from the rest of that reply,
 * so the harness ends it and says why, the way it ends a reply the provider
 * cut off.
 *
 * The test is deliberately dumb and deliberately strict: a stretch of text at
 * least MIN_CHUNK characters long that appears, verbatim, at least MIN_TIMES
 * times in the tail of the reply. Ordinary prose does not do that; a list of
 * similar lines does not reach the length; a looping model does it at once.
 */
export const MIN_CHUNK = 160;
export const MIN_TIMES = 3;
/** Only the end of the reply is looked at: a loop is what it is doing NOW. */
const WINDOW = 6_000;

export function repeatsItself(text: string, chunk = MIN_CHUNK, times = MIN_TIMES): boolean {
  const tail = text.length > WINDOW ? text.slice(-WINDOW) : text;
  if (tail.length < chunk * times) return false;
  // The chunk is taken from the very end: if the reply is looping, its last
  // characters are the loop, and the same characters occur further up.
  const needle = tail.slice(-chunk);
  if (!needle.trim()) return false;
  let found = 0;
  let from = 0;
  while (found < times) {
    const at = tail.indexOf(needle, from);
    if (at < 0) break;
    found += 1;
    from = at + 1;
  }
  return found >= times;
}

/** What Hello writes where it cut a loop, so the person knows why the reply jumps. */
export const LOOP_CUT_NOTE = '\n\n[Hello cut a loop here and asked the model to go on.]';

/**
 * The text up to where it began going round: what came before the loop, one
 * turn of the loop, and a note. The rest was the same words again.
 */
export function trimLoop(text: string, chunk = MIN_CHUNK): string {
  const needle = text.slice(-chunk);
  const first = text.indexOf(needle);
  if (!needle.trim() || first < 0 || first + chunk >= text.length) return text;
  const second = text.indexOf(needle, first + 1);
  const cycle = second > first ? second - first : chunk;
  return text.slice(0, first + cycle).trimEnd() + LOOP_CUT_NOTE;
}
