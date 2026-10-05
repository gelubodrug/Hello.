// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/renderer/api', () => ({ api: {} }));
import { mentionAt } from '../src/renderer/chat/FileMention';

// Audit A3: an @ that starts the word at the caret is a mention; one inside a word is not.
describe('the word a mention is', () => {
  it('runs from the @ to the end of the word, wherever the caret sits in it', () => {
    expect(mentionAt('see @rea', 8)).toEqual({ query: 'rea', start: 4, end: 8 });
    expect(mentionAt('@', 1)).toEqual({ query: '', start: 0, end: 1 });
    expect(mentionAt('see @readme now', 7)).toEqual({ query: 'readme', start: 4, end: 11 });
    expect(mentionAt('line one\n@src/app', 17)).toEqual({ query: 'src/app', start: 9, end: 17 });
  });
  it('is not an address, nor a word the caret has left', () => {
    expect(mentionAt('mail ada@example.com', 20)).toBeNull();
    expect(mentionAt('see @rea and more', 17)).toBeNull();
    expect(mentionAt('/@x', 3)).toBeNull();
  });
});
