import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_VERSION, BATCH_SIZE, batches, evaluationRequest, parseProfile, parseSettings, parseSnapshot, rulesFromAnswers,
  shouldAutoAnalyze, type Candidate,
} from '../src/main/unclutter/model';

const candidate = (index: number, over: Partial<Candidate> = {}): Candidate => ({
  id: `e${index}`, selector: `div.ad-${index}x`, tag: 'div', signals: ` ad-${index}x `, text: 'Advertisement', position: 'static', count: 1, ...over,
});
const context = { key: 'https://news.example|v1|abc', label: 'article · /news/:detail', origin: 'https://news.example', kind: 'article' };

describe('Unclutter requests', () => {
  it('asks in batches whose state holds only that batch — OpenJev re-reads the state for every question', () => {
    const all = Array.from({ length: 13 }, (_, index) => candidate(index));
    const groups = batches(all);
    expect(groups.map(group => group.length)).toEqual([BATCH_SIZE, BATCH_SIZE, 1]);
    const request = evaluationRequest('article', groups[1]!);
    expect(request.model).toBe('openjev');
    expect(request.state.pageType).toBe('article');
    expect(request.state.elements.map(element => element.id)).toEqual(['e6', 'e7', 'e8', 'e9', 'e10', 'e11']);
    expect(Object.keys(request.questions)).toEqual(['e6', 'e7', 'e8', 'e9', 'e10', 'e11']);
    expect(request.questions.e6).toMatchObject({ type: 'choice' });
    expect(Object.keys(request.questions.e6!.criteria)).toEqual(['keep', 'ad', 'cookie', 'promotion', 'newsletter', 'social', 'uncertain']);
    expect(request.questions.e6!.instructions).toContain('element e6');
    expect(request.questions.e6!.instructions).toContain('WITHOUT accepting or rejecting consent');
  });

  it('sends no selector, URL or page title — only what identifies each block', () => {
    const request = evaluationRequest('page', [candidate(0, { selector: 'div#secret-selector' })]);
    expect(JSON.stringify(request)).not.toContain('secret-selector');
    expect(Object.keys(request.state.elements[0]!).sort()).toEqual(['count', 'id', 'position', 'signals', 'tag', 'text']);
  });
});

describe('Unclutter answers', () => {
  const batch = [candidate(0)];
  it('reject incomplete, invalid and non-finite results; uncertain keeps content', () => {
    expect(() => rulesFromAnswers({ answers: {} }, batch)).toThrow(/incomplete/);
    expect(() => rulesFromAnswers({ answers: { e0: { type: 'choice', choice: 'erase' } } }, batch)).toThrow();
    expect(() => rulesFromAnswers({ answers: { e0: { type: 'choice', choice: 'ad', probabilities: { ad: Infinity } } } }, batch)).toThrow();
    expect(() => rulesFromAnswers({ answers: { e0: { type: 'choice', choice: 'ad' }, e9: { type: 'choice', choice: 'ad' } } }, batch)).toThrow();
    expect(rulesFromAnswers({ answers: { e0: { type: 'choice', choice: 'uncertain' } } }, batch)).toEqual([]);
    expect(rulesFromAnswers({ answers: { e0: { type: 'choice', choice: 'keep', probabilities: { keep: 1 } } } }, batch)).toEqual([]);
  });

  it('keep the 0.9 cutoff on both the probability and the confidence OpenJev reports', () => {
    expect(rulesFromAnswers({ answers: { e0: { type: 'choice', choice: 'ad', probabilities: { ad: 0.7 } } } }, batch)).toEqual([]);
    expect(rulesFromAnswers({ answers: { e0: { type: 'choice', choice: 'ad', probabilities: { ad: 0.95 }, confidence: 0.5 } } }, batch)).toEqual([]);
    expect(rulesFromAnswers({ answers: { e0: { type: 'choice', choice: 'cookie', probabilities: { cookie: 0.99, keep: 0.01 }, confidence: 0.93 } } }, batch))
      .toEqual([{ selector: 'div.ad-0x', category: 'cookie', enabled: true }]);
  });
});

describe('Unclutter page input', () => {
  it('refuses a malformed snapshot rather than guessing', () => {
    expect(parseSnapshot({ context, candidates: [candidate(0)] }).candidates).toHaveLength(1);
    expect(() => parseSnapshot({ context, candidates: [{ ...candidate(0), id: 'x' }] })).toThrow();
    expect(() => parseSnapshot({ context, candidates: [{ ...candidate(0), count: 0 }] })).toThrow();
    expect(() => parseSnapshot({ context: { ...context, kind: 'evil' }, candidates: [] })).toThrow();
    expect(() => parseSnapshot({ context, candidates: Array.from({ length: 61 }, (_, i) => candidate(i)) })).toThrow();
  });

  it('reads back a saved profile, and nothing that is not one', () => {
    const profile = { key: context.key, label: context.label, origin: context.origin, enabled: true, version: 1, analyzedAt: 1, candidateCount: 2, rules: [{ selector: 'div.ad-0x', category: 'ad', enabled: true }] };
    expect(parseProfile(profile)?.analysisVersion).toBe(1);
    expect(parseProfile({ ...profile, rules: [{ selector: 'div.x', category: 'nope', enabled: true }] })).toBeNull();
    expect(parseProfile('nonsense')).toBeNull();
  });
});

describe('Unclutter switches', () => {
  it('are on, with Auto off, until the person says otherwise', () => {
    expect(parseSettings(null)).toEqual({ enabled: true, auto: false });
    expect(parseSettings({ enabled: false, auto: 'yes' })).toEqual({ enabled: false, auto: false });
  });

  it('analyse unasked only with Auto on, once, and never a type the person switched off', () => {
    const on = { enabled: true, auto: true };
    expect(shouldAutoAnalyze(on, null, false)).toBe(true);
    expect(shouldAutoAnalyze({ ...on, auto: false }, null, false)).toBe(false);
    expect(shouldAutoAnalyze({ ...on, enabled: false }, null, false)).toBe(false);
    expect(shouldAutoAnalyze(on, null, true)).toBe(false);
    const old = parseProfile({ key: 'k', label: 'l', origin: 'https://o', enabled: true, version: 1, analyzedAt: 1, candidateCount: 0, rules: [] })!;
    expect(shouldAutoAnalyze(on, old, false)).toBe(true);
    expect(shouldAutoAnalyze(on, { ...old, enabled: false }, false)).toBe(false);
    expect(shouldAutoAnalyze(on, { ...old, analysisVersion: ANALYSIS_VERSION }, false)).toBe(false);
  });
});
