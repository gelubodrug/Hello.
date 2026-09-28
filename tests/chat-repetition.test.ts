import { describe, expect, it } from 'vitest';
import { MIN_CHUNK, MIN_TIMES, repeatsItself } from '../src/main/chat/repetition';
import { LOOP_CUT_NOTE, trimLoop } from '../src/main/chat/repetition';

// A reply that keeps saying the same three paragraphs is over; the harness
// ends it rather than let it spend the output budget (user, 22.09).
describe('a reply repeating itself', () => {
  const paragraph = 'Sau, mai simplu, să încerc să folosesc browser_pointer pentru a face click pe "Download invoice" cu coordonate mai precise. Sau, să încerc să navighez direct la URL-ul PDF al facturii. De obicei, facturile Stripe sunt la /pdf.\n\n';

  it('is caught once the same long stretch has come back three times', () => {
    expect(paragraph.length).toBeGreaterThanOrEqual(MIN_CHUNK);
    expect(repeatsItself(paragraph)).toBe(false);
    expect(repeatsItself(paragraph.repeat(2))).toBe(false);
    expect(repeatsItself(paragraph.repeat(MIN_TIMES))).toBe(true);
    expect(repeatsItself(`Mă gândesc ce să fac.\n\n${paragraph.repeat(4)}`)).toBe(true);
  });

  it('leaves ordinary prose alone, including a list of similar short lines', () => {
    const list = Array.from({ length: 40 }, (_, index) => `- [ ] Step ${index}: check the file\n`).join('');
    expect(repeatsItself(list)).toBe(false);
    const prose = Array.from({ length: 30 }, (_, index) => `Paragraph ${index} says something of its own about the invoice and the folder it should go in. `).join('');
    expect(repeatsItself(prose)).toBe(false);
    expect(repeatsItself('')).toBe(false);
    expect(repeatsItself(' '.repeat(2_000))).toBe(false);
  });
});

// Where the loop is cut, one turn of it stays and a note says why the reply jumps.
describe('the cut', () => {
  it('keeps what came before the loop and one turn of it, then the note', () => {
    const turn = 'Need maybe use browser_open to known URL? But "use existing sessions" and OpenAI page not currently tab. ';
    const text = 'I opened the billing page. ' + turn.repeat(12);
    const cut = trimLoop(text);
    expect(cut.startsWith('I opened the billing page. ' + turn.trimEnd())).toBe(true);
    expect(cut.endsWith(LOOP_CUT_NOTE)).toBe(true);
    expect(cut.length).toBeLessThan(text.length / 3);
    expect(trimLoop('short')).toBe('short');
  });
});
