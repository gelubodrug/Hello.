import { describe, expect, it, vi } from 'vitest';
import { WebResearch, type PageRenderer } from '../src/main/chat/web-tools';

type Get = NonNullable<ConstructorParameters<typeof WebResearch>[1]>['get'];
const page = (url: string, body: string, contentType = 'text/html') => ({ url, status: 200, contentType, body, bytes: body.length });
const never = new AbortController().signal;

// The engine's plain page, as it answers a request it believes.
const PLAIN = `<html><body>
  <div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Feditors&amp;rut=x">Open source editors</a>
    <a class="result__snippet" href="#">A list of <b>editors</b> you can read the source of.</a></div>
  <div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.net%2Fcompare">Editors compared</a>
    <a class="result__snippet" href="#">Side by side.</a></div></body></html>`;
// What it answers a request it takes for a robot.
const CHALLENGE = '<html><body><form id="challenge-form" action="/anomaly.js">Unfortunately, bots use DuckDuckGo too.</form></body></html>';
// The page a person sees, once its scripts have drawn it.
const DRAWN = `<html><body><ol>
  <li><article><h2><a data-testid="result-title-a" href="https://example.org/editors"><span>Open source editors</span></a></h2>
    <div data-result="snippet"><span>A list of editors.</span></div></article></li>
  <li><article><h2><a data-testid="result-title-a" href="https://duckduckgo.com/about">About</a></h2></article></li></ol></body></html>`;

// User, 26.11: "ce e asta cu duck??? nu găsim un headless browser" — a search the
// engine blocked was handed back to the model with three steps to do by hand.
describe('a search the engine takes for a robot', () => {
  it('is run again in a real browser page, out of sight, and answers as a search', async () => {
    const get = vi.fn<NonNullable<Get>>(async url => page(url.href, CHALLENGE));
    const render = vi.fn<PageRenderer>(async url => ({ url, html: PLAIN }));
    const found = await new WebResearch([], { get, render }).search('open source editors', 5, never);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0][0]).toBe('https://html.duckduckgo.com/html/?q=open%20source%20editors');
    expect(found.engine).toBe('DuckDuckGo, in a hidden browser page');
    expect(found.results).toEqual([
      { title: 'Open source editors', url: 'https://example.org/editors', snippet: 'A list of editors you can read the source of.' },
      { title: 'Editors compared', url: 'https://example.net/compare', snippet: 'Side by side.' },
    ]);
  });

  it('reads the page a person sees when the plain one is refused there too, and when the request itself fails', async () => {
    const get = vi.fn<NonNullable<Get>>(async () => { throw new Error('Website returned HTTP 202; no source was read.'); });
    const render = vi.fn<PageRenderer>(async url => ({ url, html: url.startsWith('https://html.') ? CHALLENGE : DRAWN }));
    const found = await new WebResearch([], { get, render }).search('open source editors', 5, never);
    expect(render.mock.calls.map(call => call[0])).toEqual([
      'https://html.duckduckgo.com/html/?q=open%20source%20editors', 'https://duckduckgo.com/?q=open%20source%20editors&ia=web']);
    // The engine's own links are not results.
    expect(found.results).toEqual([{ title: 'Open source editors', url: 'https://example.org/editors', snippet: 'A list of editors.' }]);
  });

  it('is not sent to a browser when the plain request found results, or found none without being blocked', async () => {
    const render = vi.fn<PageRenderer>();
    expect((await new WebResearch([], { get: async url => page(url.href, PLAIN), render }).search('editors', 1, never)).results).toHaveLength(1);
    expect((await new WebResearch([], { get: async url => page(url.href, '<html><body>No results.</body></html>'), render }).search('zzqx', 5, never)).results).toEqual([]);
    expect(render).not.toHaveBeenCalled();
  });

  it('says how to do it by hand only when there is no hidden page, or it was blocked as well', async () => {
    const get: Get = async url => page(url.href, CHALLENGE);
    await expect(new WebResearch([], { get }).search('editors', 5, never)).rejects.toThrow(/blocked this search with bot protection.*browser_open/s);
    const render = vi.fn<PageRenderer>(async url => ({ url, html: CHALLENGE }));
    await expect(new WebResearch([], { get, render }).search('editors', 5, never)).rejects.toThrow(/blocked this search with bot protection/);
    expect(render).toHaveBeenCalledTimes(2);
  });
});

describe('a page a plain request cannot read', () => {
  const article = '<html><head><title>The real article</title></head><body><main><p>Drawn by its scripts.</p></main></body></html>';

  it('is read in the hidden page when it is empty until its scripts run, or shows a robot check', async () => {
    for (const body of ['<html><head><title>App</title></head><body><div id="root"></div></body></html>', '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>']) {
      const render = vi.fn<PageRenderer>(async () => ({ url: 'https://example.org/article', html: article }));
      const read = await new WebResearch([], { get: async url => page(url.href, body), render }).fetchURL('https://example.org/article', never);
      expect(render).toHaveBeenCalledWith('https://example.org/article', expect.anything());
      expect(read).toMatchObject({ kind: 'fetch_url', text: 'Drawn by its scripts.', source: { id: 1, url: 'https://example.org/article', title: 'The real article' } });
    }
  });

  it('is tried there after a refusal a browser often does not get, and never for a page that is not there', async () => {
    const render = vi.fn<PageRenderer>(async url => ({ url, html: article }));
    const refused = (status: number): Get => async () => { throw new Error(`Website returned HTTP ${status}; no source was read.`); };
    expect((await new WebResearch([], { get: refused(403), render }).fetchURL('https://example.org/a', never)).text).toBe('Drawn by its scripts.');
    render.mockClear();
    await expect(new WebResearch([], { get: refused(404), render }).fetchURL('https://example.org/gone', never)).rejects.toThrow('HTTP 404');
    expect(render).not.toHaveBeenCalled();
  });

  it('keeps its own refusal when the hidden page cannot read it either, and reads a readable page without it', async () => {
    const blocked = vi.fn<PageRenderer>(async url => ({ url, html: '<html><head><title>Access denied</title></head><body>No.</body></html>' }));
    await expect(new WebResearch([], { get: async () => { throw new Error('Website returned HTTP 403; no source was read.'); }, render: blocked })
      .fetchURL('https://example.org/a', never)).rejects.toThrow('HTTP 403');
    await expect(new WebResearch([], { get: async url => page(url.href, '<html><body></body></html>'), render: blocked })
      .fetchURL('https://example.org/a', never)).rejects.toThrow(/No readable page was returned.*browser_open/s);
    const unused = vi.fn<PageRenderer>();
    expect((await new WebResearch([], { get: async url => page(url.href, article), render: unused }).fetchURL('https://example.org/a', never)).text).toBe('Drawn by its scripts.');
    expect(unused).not.toHaveBeenCalled();
  });
});
