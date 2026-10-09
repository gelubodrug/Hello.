import { describe, expect, it } from 'vitest';
import { Dictation } from '../src/renderer/chat/dictation';

// The words of a turn as it is spoken (user, 09.10: phrases vanished from the
// composer). LocalAgreement-2: what two passes agree on is locked for good.
describe('the words of a voice turn', () => {
  it('locks what two passes in a row agree on, and leaves only the newest words open', () => {
    const turn = new Dictation();
    expect(turn.pass('Caută care e')).toBe('Caută care e');
    expect(turn.settled).toBe('');
    expect(turn.pass('Caută care e cel mai')).toBe('Caută care e cel mai');
    expect(turn.settled).toBe('Caută care e');
    // The open words may still change: the last word of a pass is heard with no context after it.
    expect(turn.pass('Caută care e cel mai ieftin')).toBe('Caută care e cel mai ieftin');
    expect(turn.settled).toBe('Caută care e cel mai');
  });

  it('never takes back a locked word, whatever a later pass says', () => {
    const turn = new Dictation();
    turn.pass('Caută care e cel mai');
    turn.pass('Caută care e cel mai ieftin');
    // This pass lost the start of the turn: the locked words stand, and what it added after them is shown.
    expect(turn.pass('e cel mai ieftin MacBook')).toBe('Caută care e cel mai ieftin MacBook');
    // This one says nothing like them: it is ignored.
    expect(turn.pass('Thank you.')).toBe('Caută care e cel mai ieftin MacBook');
    expect(turn.settled).toBe('Caută care e cel mai ieftin');
  });

  it('lines up a pass that words the start differently by the last locked words', () => {
    const turn = new Dictation();
    turn.pass('Cauta care e cel mai ieftin');
    turn.pass('Cauta care e cel mai ieftin MacBook');
    // "Caută" now with its diacritic: the anchor is the last locked words, so the rest still lines up.
    expect(turn.pass('Caută care e cel mai ieftin MacBook Pro')).toBe('Cauta care e cel mai ieftin MacBook Pro');
    // Case and punctuation at a word's ends do not make two passes disagree.
    expect(turn.pass('cauta care e cel mai ieftin macbook, Pro 128')).toBe('Cauta care e cel mai ieftin MacBook Pro 128');
  });

  it('ends with the last pass after the locked words, and keeps the open ones when it cannot be placed', () => {
    const turn = new Dictation();
    turn.pass('Open the');
    turn.pass('Open the page');
    expect(turn.finish('Open the page with the cheapest MacBook.')).toBe('Open the page with the cheapest MacBook.');
    const lost = new Dictation();
    lost.pass('Open the page');
    lost.pass('Open the page with the');
    expect(lost.finish('Thank you.')).toBe('Open the page with the');
    // A short turn with no pass before the last: the last pass is the turn.
    expect(new Dictation().finish(' Caută MacBook-ul. ')).toBe('Caută MacBook-ul.');
    expect(new Dictation().finish('')).toBe('');
  });
});
