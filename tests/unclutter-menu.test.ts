// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { pageLine, rulesSummary } from '../src/renderer/browser/UnclutterMenu';

describe('Unclutter menu words', () => {
  it('say what a page type hides, by kind', () => {
    expect(rulesSummary({ ad: 3, cookie: 1 })).toBe('3 ads · 1 consent banner');
    expect(rulesSummary({})).toBe('Nothing to hide was found');
  });

  it('say where the page stands', () => {
    const base = { tabId: 't', eligible: true, hidden: 0, profile: null, analyzing: null, label: 'article · /news/:detail' };
    expect(pageLine({ ...base, eligible: false }).label).toBe('Not cleaned');
    expect(pageLine({ ...base, analyzing: { done: 1, total: 4 } }).label).toBe('Analysing… 1 of 4');
    expect(pageLine(base)).toEqual({ label: 'Nothing hidden', detail: 'article · /news/:detail — not analysed yet' });
    expect(pageLine({ ...base, hidden: 1, profile: { enabled: false, rules: 1, analyzedAt: 1, categories: { ad: 1 } } }))
      .toEqual({ label: '1 block hidden', detail: 'article · /news/:detail (off) — 1 ad' });
  });
});
