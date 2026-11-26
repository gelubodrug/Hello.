// The page half of Unclutter, ported from kitze/unclutter's tests/core.test.ts
// and tests/v2.test.ts (MIT, 9115ce4): the same documents, the same verdicts,
// driven through the API main calls in the page's isolated world.
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { unclutterCall, unclutterPage } from '../src/main/unclutter/page';

interface PageApi {
  context(): { key: string; label: string; origin: string; kind: string };
  apply(key: string, rules: Array<{ selector: string; category?: string; enabled: boolean }>): { key: string; hidden: number };
  count(): { key: string; hidden: number };
  snapshot(): { context: { key: string }; candidates: Array<{ id: string; selector: string; signals: string; text: string; position: string }> };
  restore(): boolean;
}

const opened: JSDOM[] = [];
afterEach(() => { for (const dom of opened.splice(0)) dom.window.close(); });

function page(html: string, url = 'https://www.bbc.com/'): { doc: Document; api: PageApi; window: JSDOM['window'] } {
  const dom = new JSDOM(html, { url });
  opened.push(dom);
  unclutterPage(dom.window);
  return { doc: dom.window.document, api: (dom.window as unknown as { __HELLO_UNCLUTTER__: PageApi }).__HELLO_UNCLUTTER__, window: dom.window };
}
const ARTICLE = '<meta property="og:type" content="article"><main data-testid="story-page"><article><h1>Story</h1><p>Editorial content stays.</p></article><div class="ad-banner">Advertisement</div></main>';
const keyOf = (html: string, url: string) => page(html, url).api.context().key;
const rule = (selector: string, category = 'ad') => ({ selector, category, enabled: true });

describe('Unclutter page types', () => {
  it('article siblings share rules; homepage, section, site, and a different shell stay separate', () => {
    const one = keyOf(ARTICLE, 'https://www.bbc.com/news/articles/cabc123?utm_source=test');
    expect(keyOf(ARTICLE, 'https://www.bbc.com/news/articles/cdef456')).toBe(one);
    expect(keyOf(ARTICLE, 'https://www.bbc.com/')).not.toBe(one);
    expect(keyOf('<main>Section</main>', 'https://www.bbc.com/news')).not.toBe(one);
    expect(keyOf(ARTICLE, 'https://other.com/news/articles/cabc123')).not.toBe(one);
    expect(keyOf('<meta property="og:type" content="article"><main data-testid="live-page"><article><h1>Live</h1></article></main>', 'https://www.bbc.com/news/articles/cabc123')).not.toBe(one);
  });

  it('JSON-LD @graph article metadata and dated URLs group correctly', () => {
    const html = '<script type="application/ld+json">{"@graph":[{"@type":"NewsArticle"}]}</script><main></main>';
    expect(keyOf(html, 'https://example.com/2026/09/17/first-story')).toBe(keyOf(html, 'https://example.com/2025/04/02/second-story'));
    expect(page(html, 'https://example.com/story').api.context().kind).toBe('article');
  });

  it('numeric article IDs keep route families and searches stay apart from the home page', () => {
    expect(keyOf(ARTICLE, 'https://example.com/news/articles/123')).toBe(keyOf(ARTICLE, 'https://example.com/news/articles/456'));
    expect(keyOf(ARTICLE, 'https://example.com/news/123')).not.toBe(keyOf(ARTICLE, 'https://example.com/sport/456'));
    expect(keyOf(ARTICLE, 'https://example.com/')).not.toBe(keyOf(ARTICLE, 'https://example.com/?q=world'));
  });

  it('generic short section routes are not merged', () => {
    expect(keyOf('<main></main>', 'https://example.com/news/world')).not.toBe(keyOf('<main></main>', 'https://example.com/news/business'));
  });
});

describe('Unclutter candidates', () => {
  it('include cookie banners but protect main content, ordinary forms and paywalls, and redact', () => {
    const { api } = page('<main class="promo-main"><h1>Story</h1></main><div class="ad-slot">Ad contact hello@example.com</div><div class="newsletter"><form><input value="secret" /></form></div><div class="cookie-banner">Accept all cookies</div><div class="paywall-overlay">Subscribe to read</div><div class="promo-modal">Try our summer sale</div>');
    const { candidates } = api.snapshot();
    expect(candidates.map(c => c.selector)).toEqual(['div.ad-slot', 'div.cookie-banner', 'div.promo-modal']);
    expect(JSON.stringify(candidates)).not.toContain('hello@example.com');
    expect(JSON.stringify(candidates)).not.toContain('secret');
  });

  it('include a link or button floating over the page, told apart by its size and corner, but no link in the flow', () => {
    const { api } = page('<main><h1>Story</h1><p>Text <a class="inline-link" href="/x">a link</a></p></main><div class="wrapper"><a class="butonAbonare" href="/abonare" style="position:fixed">Subscribe at 87% off</a></div><button id="ot-sdk-btn" style="position:fixed">Cookie settings</button><div id="bellPopup" style="position:fixed"><svg><style>.cls-1{fill:red}</style></svg></div>');
    const { candidates } = api.snapshot();
    expect(candidates.map(c => c.selector)).toEqual(['div#bellPopup', 'a.butonAbonare', 'button#ot-sdk-btn']);
    const bell = candidates[0]!;
    expect(bell.text).toBe('');
    expect(bell.position).toMatch(/^fixed \d+x\d+ (top|middle|bottom)-(left|center|right)$/);
    const key = api.context().key;
    expect(api.apply(key, [rule('a.butonAbonare', 'promotion'), rule('button#ot-sdk-btn', 'cookie'), rule('div#bellPopup', 'promotion')]).hidden).toBe(3);
  });

  it('turn Sourcepoint numeric IDs into reusable cookie selectors, even after thousands of nodes', () => {
    const { api, doc } = page('<main><h1>BBC</h1></main>' + '<div></div>'.repeat(6100) + '<div id="sp_message_container_123456"><iframe id="sp_message_iframe_123456" title="Privacy consent"></iframe></div>');
    const { candidates } = api.snapshot();
    expect(candidates.some(c => c.selector === 'div[id^="sp_message_container_"]')).toBe(true);
    expect(candidates[0]!.signals).toMatch(/cookie consent/i);
    doc.querySelector('[id^="sp_message_container_"]')!.id = 'sp_message_container_999999';
    const key = api.context().key;
    expect(api.apply(key, [rule('div[id^="sp_message_container_"]', 'cookie')]).hidden).toBe(1);
    expect(api.apply(key, [rule('div[id^="sp_"]', 'cookie')]).hidden).toBe(0);
  });
});

describe('Unclutter cleaner', () => {
  it('never applies a selector that also matches useful content, or one outside the allowed shapes', () => {
    const { api } = page('<div class="ad-slot">Ad</div><div class="ad-slot"><h1>Important</h1></div>');
    const key = api.context().key;
    expect(api.apply(key, [rule('div.ad-slot')]).hidden).toBe(0);
    expect(api.apply(key, [rule('body')]).hidden).toBe(0);
    expect(api.apply(key, [rule('div.ad-slot,main')]).hidden).toBe(0);
  });

  it('hides reversibly, catches late inserts and refuses newly protected matches', () => {
    const { api, doc } = page(ARTICLE);
    const key = api.context().key;
    const rules = [rule('div.ad-banner')];
    const ad = doc.querySelector('.ad-banner') as HTMLElement;
    ad.setAttribute('style', 'color: red');
    expect(api.apply(key, rules).hidden).toBe(1);
    expect(ad.outerHTML).toMatch(/data-unclutter-/);
    const late = doc.createElement('div');
    late.className = 'ad-banner';
    doc.body.append(late);
    expect(api.apply(key, rules).hidden).toBe(2);
    late.innerHTML = '<form><input /></form>';
    expect(api.apply(key, rules).hidden).toBe(0);
    expect(ad.outerHTML).not.toMatch(/data-unclutter-/);
    late.remove();
    api.apply(key, rules);
    api.restore();
    expect(ad.style.color).toBe('red');
    expect(ad.style.display).toBe('');
    expect(doc.documentElement.outerHTML).not.toMatch(/data-unclutter-/);
  });

  it('hides a cookie dialog with its form without clicking or writing consent', () => {
    const { api, doc } = page('<main>Article</main><div id="ngasCookiePrompt" role="dialog"><h1>Cookies</h1><form><input type="checkbox" checked><button>Accept all cookies</button></form></div>');
    let clicked = false;
    doc.querySelector('button')!.addEventListener('click', () => { clicked = true; });
    expect(api.snapshot().candidates.some(c => c.selector === 'div#ngasCookiePrompt')).toBe(true);
    const key = api.context().key;
    api.apply(key, [rule('div#ngasCookiePrompt', 'cookie')]);
    const prompt = doc.querySelector('#ngasCookiePrompt') as HTMLElement;
    expect(prompt.style.display).toBe('none');
    expect(clicked).toBe(false);
    expect((doc.querySelector('input') as HTMLInputElement).checked).toBe(true);
    expect(doc.cookie).toBe('');
    api.restore();
    expect(prompt.style.display).toBe('');
    const password = doc.createElement('input');
    password.type = 'password';
    prompt.append(password);
    expect(api.apply(key, [rule('div#ngasCookiePrompt', 'cookie')]).hidden).toBe(0);
  });

  it('collapses an emptied ad wrapper and its label but keeps useful siblings', () => {
    const { api, doc } = page('<main><h1>News</h1><div id="outer"><section id="slot" style="min-height:300px;padding:40px"><span>Advertisement</span><div class="ad-banner" style="display:block!important">Ad</div></section><p id="story">Real story</p></div></main>');
    const key = api.context().key;
    const rules = [rule('div.ad-banner')];
    expect(api.apply(key, rules).hidden).toBe(1);
    const style = (selector: string) => (doc.querySelector(selector) as HTMLElement).style;
    expect(style('#slot').display).toBe('none');
    expect(style('#outer').display).toBe('');
    expect(style('.ad-banner').display).toBe('none');
    const useful = doc.createElement('p');
    useful.textContent = 'Important update';
    doc.querySelector('#slot')!.append(useful);
    api.apply(key, rules);
    expect(style('#slot').display).toBe('');
    api.restore();
    expect(style('.ad-banner').display).toBe('block');
    expect(style('.ad-banner').getPropertyPriority('display')).toBe('important');
    expect(style('#slot').minHeight).toBe('300px');
  });

  it('releases a cookie overlay’s scroll lock reversibly, but never behind another modal', () => {
    const { api, doc } = page('<body style="overflow-y:hidden"><main>News</main><div class="cookie-banner" style="position:fixed">Cookies <button>Accept</button></div></body>');
    const key = api.context().key;
    const rules = [rule('div.cookie-banner', 'cookie')];
    api.apply(key, rules);
    expect(doc.body.style.overflowY).toBe('auto');
    const login = doc.createElement('div');
    login.setAttribute('role', 'dialog');
    login.textContent = 'Log in';
    doc.body.append(login);
    api.apply(key, rules);
    expect(doc.body.style.overflowY).toBe('hidden');
    login.remove();
    api.apply(key, rules);
    api.restore();
    expect(doc.body.style.overflowY).toBe('hidden');
  });

  it('takes no rules for a page type it is not on, and keeps itself current as the page grows', async () => {
    const { api, doc } = page(ARTICLE, 'https://www.bbc.com/news/articles/c1');
    expect(api.apply('https://www.bbc.com|v1|another', [rule('div.ad-banner')])).toEqual({ key: '', hidden: 0 });
    const key = api.context().key;
    expect(api.apply(key, [rule('div.ad-banner')]).hidden).toBe(1);
    const late = doc.createElement('div');
    late.className = 'ad-banner';
    doc.querySelector('main')!.append(late);
    await new Promise(resolve => setTimeout(resolve, 260));
    expect(api.count()).toEqual({ key, hidden: 2 });
    expect(late.style.display).toBe('none');
  });

  it('is the same cleaner when installed twice, and its source runs on its own', () => {
    const dom = new JSDOM(ARTICLE, { url: 'https://www.bbc.com/news/articles/c1', runScripts: 'outside-only' });
    opened.push(dom);
    const context = dom.window.eval(unclutterCall('context')) as { kind: string };
    expect(context.kind).toBe('article');
    const first = (dom.window as unknown as { __HELLO_UNCLUTTER__: unknown }).__HELLO_UNCLUTTER__;
    dom.window.eval(unclutterCall('count'));
    expect((dom.window as unknown as { __HELLO_UNCLUTTER__: unknown }).__HELLO_UNCLUTTER__).toBe(first);
  });
});
