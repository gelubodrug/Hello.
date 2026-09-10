import { describe, expect, it, vi } from 'vitest';
import { executeTool, toolDefinitions, type BrowserHooks } from '../src/main/chat/tools';
import type { DataStore } from '../src/main/data/store';
import type { BrowserTab } from '../src/shared/types';

// These fixtures exercise tool dispatch only: no database, browser process,
// model, local listener, filesystem writes or real network requests.
const HTML_LIMIT_BYTES = 512 * 1024;
const artifact = 'artifact:7ead96ad-eedc-4ce7-b07e-17d583f62e6b';
const html = '<!doctype html><html><body><p>Hello, București ✓</p></body></html>';

function fixture() {
  const tab: BrowserTab = {
    id: 'html-preview', conversationId: 'chat', title: 'Preview',
    url: 'http://127.0.0.1:49152/preview', control: 'off', loading: false,
    canGoBack: false, canGoForward: false,
  };
  const browser = {
    showHtml: vi.fn<NonNullable<BrowserHooks['showHtml']>>(async () => ({ tab, artifact })),
    open: vi.fn<NonNullable<BrowserHooks['open']>>(async () => tab),
    getTabs: vi.fn(() => []),
    read: vi.fn(async () => ({ title: 'Private', url: tab.url, text: 'Never read implicitly' })),
    navigate: vi.fn(), click: vi.fn(), type: vi.fn(), scroll: vi.fn(),
  } satisfies BrowserHooks;
  const controller = new AbortController();
  const context = {
    store: { getConversation: vi.fn(() => ({ id: 'chat', folder: null })) } as unknown as DataStore,
    conversationId: 'chat', browser, signal: controller.signal,
    approve: vi.fn(async () => false),
  };
  return { tab, browser, controller, context };
}

describe('generated HTML browser tools', () => {
  it('offers browser_show_html without a folder, requiring only html', () => {
    const definition = toolDefinitions(false, true).find(item => item.function.name === 'browser_show_html');
    expect(definition?.function.parameters).toMatchObject({
      required: ['html'], additionalProperties: false,
      properties: { html: { type: 'string' } },
    });
    expect(definition?.function.parameters.properties).not.toHaveProperty('title');
    expect(definition?.function.parameters.properties).not.toHaveProperty('tabId');
    expect(toolDefinitions(false, false).some(item => item.function.name === 'browser_show_html')).toBe(false);
  });

  it('opens generated HTML without folder, tabs, approval or content verification', async () => {
    const { browser, context } = fixture();
    const result = JSON.parse(await executeTool('browser_show_html', { html }, context));
    expect(browser.showHtml).toHaveBeenCalledWith('chat', html, context.signal);
    expect(result).toMatchObject({
      id: 'html-preview', url: 'http://127.0.0.1:49152/preview', control: 'off',
      artifact, openedIn: 'Hello Browser', contentVerified: false,
    });
    expect(result.note).toEqual(expect.any(String));
    expect(browser.open).not.toHaveBeenCalled();
    expect(browser.getTabs).not.toHaveBeenCalled();
    expect(browser.read).not.toHaveBeenCalled();
    expect(context.approve).not.toHaveBeenCalled();
  });

  it('reports a missing HTML hook instead of falling back to another browser action', async () => {
    const { browser, context } = fixture();
    await expect(executeTool('browser_show_html', { html }, {
      ...context, browser: { ...browser, showHtml: undefined },
    })).rejects.toThrow(/unavailable|not available|not supported/i);
    expect(browser.open).not.toHaveBeenCalled();
    expect(browser.read).not.toHaveBeenCalled();
    expect(context.approve).not.toHaveBeenCalled();
  });

  it.each([{}, { html: '' }, { html: '   \n' }, { html: null }, { html: 123 }])(
    'rejects missing, blank or non-string HTML input %j before its hook', async input => {
      const { browser, context } = fixture();
      await expect(executeTool('browser_show_html', input, context)).rejects.toThrow();
      expect(browser.showHtml).not.toHaveBeenCalled();
    },
  );

  it('accepts an HTML document exactly at the UTF-8 byte limit', async () => {
    const { browser, context } = fixture();
    const document = '<p>' + 'a'.repeat(HTML_LIMIT_BYTES - 7) + '</p>';
    expect(Buffer.byteLength(document, 'utf8')).toBe(HTML_LIMIT_BYTES);
    await executeTool('browser_show_html', { html: document }, context);
    expect(browser.showHtml).toHaveBeenCalledWith('chat', document, context.signal);
  });

  it('rejects HTML over the byte limit even when its JavaScript character count is smaller', async () => {
    const { browser, context } = fixture();
    const document = '<p>' + 'é'.repeat(HTML_LIMIT_BYTES / 2) + '</p>';
    expect(document.length).toBeLessThan(HTML_LIMIT_BYTES);
    expect(Buffer.byteLength(document, 'utf8')).toBeGreaterThan(HTML_LIMIT_BYTES);
    await expect(executeTool('browser_show_html', { html: document }, context))
      .rejects.toThrow(/512|large|size|limit/i);
    expect(browser.showHtml).not.toHaveBeenCalled();
  });

  it('reopens a valid artifact handle without requiring a folder or creating another artifact', async () => {
    const { browser, context } = fixture();
    const result = JSON.parse(await executeTool('browser_open', { url: artifact }, context));
    expect(browser.open).toHaveBeenCalledWith('chat', artifact, context.signal);
    expect(result).toMatchObject({ id: 'html-preview', control: 'off' });
    expect(browser.showHtml).not.toHaveBeenCalled();
    expect(browser.getTabs).not.toHaveBeenCalled();
    expect(browser.read).not.toHaveBeenCalled();
    expect(context.approve).not.toHaveBeenCalled();
  });

  it.each([
    'artifact:', 'artifact:not-a-uuid', 'artifact:../../another-chat',
    `${artifact}/extra`, `${artifact}?token=extra`,
  ])('rejects malformed artifact handle %s before opening', async url => {
    const { browser, context } = fixture();
    await expect(executeTool('browser_open', { url }, context)).rejects.toThrow(/artifact|handle|invalid/i);
    expect(browser.open).not.toHaveBeenCalled();
    expect(browser.showHtml).not.toHaveBeenCalled();
  });

  it.each([
    ['raw HTML', `data:text/html,${html}`, html],
    ['percent-encoded HTML', `data:text/html,${encodeURIComponent(html)}`, html],
    ['UTF-8 HTML', `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`, html],
    ['base64 HTML', `data:text/html;base64,${Buffer.from(html).toString('base64')}`, html],
    ['UTF-8 base64 HTML', `data:text/html;charset=utf-8;base64,${Buffer.from(html).toString('base64')}`, html],
    ['raw percentage signs', 'data:text/html,<p style="width:50%">50% complete</p>', '<p style="width:50%">50% complete</p>'],
  ])('converts %s data URLs into HTML previews without navigating to data:', async (_name, url, expectedHtml) => {
    const { browser, context } = fixture();
    const result = JSON.parse(await executeTool('browser_open', { url }, context));
    expect(browser.showHtml).toHaveBeenCalledWith('chat', expectedHtml, context.signal);
    expect(browser.open).not.toHaveBeenCalled();
    expect(browser.getTabs).not.toHaveBeenCalled();
    expect(browser.read).not.toHaveBeenCalled();
    expect(context.approve).not.toHaveBeenCalled();
    expect(result).toMatchObject({ artifact, control: 'off', contentVerified: false });
  });

  it('accepts data HTML through the HTML hook even when ordinary open is unavailable', async () => {
    const { browser, context } = fixture();
    await executeTool('browser_open', { url: `data:text/html,${html}` }, {
      ...context, browser: { ...browser, open: undefined },
    });
    expect(browser.showHtml).toHaveBeenCalledWith('chat', html, context.signal);
    expect(browser.open).not.toHaveBeenCalled();
  });

  it('rejects data HTML when its HTML hook is unavailable, never forwarding data: to open', async () => {
    const { browser, context } = fixture();
    await expect(executeTool('browser_open', { url: `data:text/html,${html}` }, {
      ...context, browser: { ...browser, showHtml: undefined },
    })).rejects.toThrow(/unavailable|not available|not supported/i);
    expect(browser.open).not.toHaveBeenCalled();
  });

  it.each([
    'data:text/plain,<p>Not HTML media</p>',
    'data:image/svg+xml,<svg/>',
    'data:text/html;charset=iso-8859-1,<p>Unsupported charset</p>',
    'data:text/html;base64,not!valid!base64',
    'data:text/html;base64,a',
    'data:text/html;charset=utf-8;base64,/w==',
    'data:text/html;charset=utf-8,%3Cp%3E%FF%3C%2Fp%3E',
    'data:text/html',
    'data:text/html,',
  ])('rejects invalid HTML data input %s with a useful error before any hook', async url => {
    const { browser, context } = fixture();
    await expect(executeTool('browser_open', { url }, context))
      .rejects.toThrow(/HTML|UTF|charset|base64|data|encoding|empty|provide/i);
    expect(browser.showHtml).not.toHaveBeenCalled();
    expect(browser.open).not.toHaveBeenCalled();
  });

  it('applies the HTML byte limit after base64 decoding rather than the ordinary URL limit', async () => {
    const { browser, context } = fixture();
    const document = '<p>' + 'a'.repeat(HTML_LIMIT_BYTES - 7) + '</p>';
    const url = `data:text/html;base64,${Buffer.from(document).toString('base64')}`;
    await executeTool('browser_open', { url }, context);
    expect(browser.showHtml).toHaveBeenCalledWith('chat', document, context.signal);
    expect(browser.open).not.toHaveBeenCalled();
  });

  it('rejects data HTML whose decoded bytes exceed the limit before invoking its hook', async () => {
    const { browser, context } = fixture();
    const document = '<p>' + 'a'.repeat(HTML_LIMIT_BYTES - 6) + '</p>';
    const url = `data:text/html;base64,${Buffer.from(document).toString('base64')}`;
    await expect(executeTool('browser_open', { url }, context)).rejects.toThrow(/512|large|size|limit/i);
    expect(browser.showHtml).not.toHaveBeenCalled();
    expect(browser.open).not.toHaveBeenCalled();
  });

  it.each([
    ['browser_show_html', { html }],
    ['browser_open', { url: `data:text/html,${html}` }],
  ] as const)('cancels a pending %s HTML hook and forwards its signal', async (name, input) => {
    const { browser, controller, context } = fixture();
    browser.showHtml.mockImplementationOnce(() => new Promise<never>(() => {}));
    const pending = executeTool(name, input, context);
    await vi.waitFor(() => expect(browser.showHtml).toHaveBeenCalledOnce());
    expect(browser.showHtml.mock.calls[0].at(-1)).toBe(controller.signal);
    const rejected = expect(pending).rejects.toThrow('Stopped by you.');
    controller.abort(new Error('Stopped by you.'));
    await rejected;
    expect(browser.open).not.toHaveBeenCalled();
    expect(browser.read).not.toHaveBeenCalled();
  });

  it('does not dispatch HTML work for an already-cancelled run', async () => {
    const { browser, controller, context } = fixture();
    controller.abort(new Error('Stopped by you.'));
    await expect(executeTool('browser_show_html', { html }, context)).rejects.toThrow('Stopped by you.');
    expect(browser.showHtml).not.toHaveBeenCalled();
    expect(browser.open).not.toHaveBeenCalled();
  });
});
