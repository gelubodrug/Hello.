// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { applyDocumentLocale, compactNumber, directionOf, formatNumber, locale, resolveLocale, t } from '../src/renderer/i18n';

describe('locale groundwork', () => {
  afterEach(() => applyDocumentLocale());

  it('resolves to a shipped catalog, English for everything else', () => {
    expect(resolveLocale('en-GB')).toBe('en');
    expect(resolveLocale('en')).toBe('en');
    // Romanian has no catalog yet: a product-readiness gap, not a regression.
    expect(resolveLocale('ro-RO')).toBe('en');
    expect(resolveLocale('ar')).toBe('en');
    expect(locale()).toBe('en');
  });

  it('knows which languages read right to left', () => {
    expect(directionOf('en-US')).toBe('ltr');
    expect(directionOf('ro')).toBe('ltr');
    expect(directionOf('ar-EG')).toBe('rtl');
    expect(directionOf('he')).toBe('rtl');
  });

  it('stamps the document with lang and dir, and did so on import', () => {
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
    applyDocumentLocale('ar');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('picks plural forms by CLDR rule and formats the count', () => {
    expect(t('replies', 1)).toBe('1 reply');
    expect(t('replies', 2)).toBe('2 replies');
    expect(t('replies', 1234)).toBe('1,234 replies');
    expect(t('models', 0)).toBe('0 models');
    expect(t('models', 7)).toBe('7 models');
  });

  it('fills named placeholders exactly as given', () => {
    expect(t('tokens', { n: '128K' })).toBe('128K tokens');
    expect(t('perMonth', { n: '1,740' })).toBe('1,740/mo');
    expect(t('millions', { n: '1.2' })).toBe('1.2M');
  });

  it('formats numbers in the active locale', () => {
    expect(formatNumber(1234)).toBe('1,234');
    expect(formatNumber(1.2)).toBe('1.2');
    expect(compactNumber(128_000)).toBe('128K');
  });
});
