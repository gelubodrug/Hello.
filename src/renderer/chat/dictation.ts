/**
 * The words of a voice turn while it is being spoken (user, 09.10), kept the
 * way whisper_streaming keeps them (Macháček et al., 2023, LocalAgreement-2).
 *
 * Every pass writes out the whole turn so far, and Whisper does not say the
 * same thing twice: the newest words, heard with the least context after them,
 * change from pass to pass, and a pass can drop or reword a phrase it wrote a
 * moment ago. Shown as they come, the words flicker and phrases vanish. So the
 * words two passes in a row agree on are locked and never change again; only
 * the open words after them — the last second or two — may still be revised.
 * The pass after the last word adds what follows the locked words and stops.
 */

/** A word as compared: case, and punctuation at its ends, do not make two passes disagree. */
const fold = (word: string) => word.toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const same = (a: string, b: string) => fold(a) === fold(b);
const wordsOf = (text: string) => text.trim().split(/\s+/).filter(Boolean);

/** How many of the last locked words find the place a pass that rewords the start resumes at. */
const ANCHOR = 3;

export class Dictation {
  private locked: string[] = [];
  private open: string[] = [];

  /** What the turn says now: the locked words, then the open ones. */
  get text(): string { return [...this.locked, ...this.open].join(' '); }
  /** The words no later pass can take back. */
  get settled(): string { return this.locked.join(' '); }

  /**
   * A pass over the turn so far. The words it and the pass before it agree on,
   * after the locked ones, are locked too; the rest stay open. A pass that
   * cannot be lined up with the locked words is ignored rather than allowed to
   * take any of them back.
   */
  pass(heard: string): string {
    const words = wordsOf(heard);
    const from = this.resume(words);
    if (from < 0) return this.text;
    const fresh = words.slice(from);
    let agreed = 0;
    while (agreed < fresh.length && agreed < this.open.length && same(fresh[agreed], this.open[agreed])) agreed++;
    this.locked.push(...fresh.slice(0, agreed));
    this.open = fresh.slice(agreed);
    return this.text;
  }

  /**
   * The pass after the last word: what it heard after the locked words is the
   * end of the turn. It cannot reword or drop a locked word either — that is
   * what was agreed — so a final pass that lost the start of the turn loses
   * nothing. One that cannot be lined up leaves the turn as it stood.
   */
  finish(heard: string): string {
    const words = wordsOf(heard);
    const from = this.resume(words);
    if (from >= 0) { this.locked.push(...words.slice(from)); this.open = []; }
    else { this.locked.push(...this.open); this.open = []; }
    return this.text;
  }

  /**
   * Where a pass goes on after the locked words: right after them when it
   * begins with them, else after the last few of them, wherever it says them
   * nearest the place expected; -1 when it does not say them at all.
   */
  private resume(words: string[]): number {
    const locked = this.locked;
    let prefix = 0;
    while (prefix < locked.length && prefix < words.length && same(locked[prefix], words[prefix])) prefix++;
    if (prefix === locked.length) return prefix;
    const anchor = locked.slice(-ANCHOR);
    const expected = locked.length - anchor.length;
    let best = -1;
    for (let at = 0; at + anchor.length <= words.length; at++) {
      if (!anchor.every((word, index) => same(word, words[at + index]))) continue;
      if (best < 0 || Math.abs(at - expected) < Math.abs(best - expected)) best = at;
    }
    return best < 0 ? -1 : best + anchor.length;
  }
}
