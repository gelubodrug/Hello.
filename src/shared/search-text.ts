const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** NFC and case folding shared by chat Find and Files Contents. Each output
 * unit maps to its original grapheme, so composition and İ never shift a hit.
 * Match case still composes Unicode, but preserves letters and dotted İ.
 */
export function foldForSearch(text: string, matchCase = false): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  for (const { segment, index } of segments.segment(text)) {
    const composed = segment.normalize('NFC');
    // Locale-independent: the same file searches identically on every Mac.
    const unit = matchCase ? composed : composed.toLowerCase().replace(/i̇/g, 'i');
    for (let i = 0; i < unit.length; i++) map.push(index);
    folded += unit;
  }
  return { folded, map };
}

/** End after the whole original unit, never halfway through a combining mark
 * or surrogate pair. Offsets are UTF-16, as DOM ranges and JS slices require.
 */
export function originalSearchRange(text: string, map: number[], at: number, length: number): { start: number; end: number } {
  let tail = at + length;
  while (tail < map.length && map[tail] === map[tail - 1]) tail++;
  return { start: map[at], end: tail < map.length ? map[tail] : text.length };
}
