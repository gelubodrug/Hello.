import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  executeTool,
  scopedPath,
  toolDefinitions,
  type BrowserHooks,
} from '../src/main/chat/tools';
import type { DataStore } from '../src/main/data/store';
import type { BrowserTab } from '../src/shared/types';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'hello-tools-test-'));
  await mkdir(path.join(directory, 'repo'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
function browserFixture(folder: string | null = null, tabs: BrowserTab[] = []) {
  const opened: BrowserTab = {
    id: 'opened', conversationId: 'c', title: 'Opened page',
    url: 'http://localhost:5173/preview', control: 'off', loading: false,
    canGoBack: false, canGoForward: false,
  };
  const browser = {
    getTabs: vi.fn(() => tabs),
    open: vi.fn(async () => opened),
    read: vi.fn(async () => ({ title: 'Page', url: opened.url, text: 'Private page text' })),
    navigate: vi.fn(), click: vi.fn(), type: vi.fn(), scroll: vi.fn(),
  } satisfies BrowserHooks;
  return {
    browser,
    context: {
      store: { getConversation: () => ({ id: 'c', folder }) } as unknown as DataStore,
      conversationId: 'c', browser,
      signal: new AbortController().signal,
      approve: vi.fn(async () => false),
    },
  };
}
describe('tool authority boundaries', () => {
  it.each([
    ['browser_open', 'open', { url: 'https://example.test/next' }],
    ['browser_read', 'read', {}],
    ['browser_navigate', 'navigate', { url: 'https://example.test/next' }],
    ['browser_click', 'click', { selector: 'button' }],
    ['browser_type', 'type', { selector: 'input', text: 'test' }],
    ['browser_scroll', 'scroll', { deltaY: 300 }],
  ] as const)(
    'cancels pending %s and forwards the run signal to its hook',
    async (name, method, input) => {
      const controller = new AbortController();
      const pendingHook = vi.fn(() => new Promise<never>(() => {}));
      const browser: BrowserHooks = {
        getTabs: () => [
          {
            id: 'tab',
            conversationId: 'c',
            title: 'Test',
            url: 'https://example.test',
            control: 'full',
            loading: false,
            canGoBack: false,
            canGoForward: false,
          },
        ],
        read: async () => ({
          title: 'Test',
          url: 'https://example.test',
          text: 'body',
        }),
        navigate: vi.fn(),
        click: vi.fn(),
        type: vi.fn(),
        scroll: vi.fn(),
        [method]: pendingHook,
      };
      const context = {
        store: {
          getConversation: () => ({ id: 'c', folder: null }),
        } as unknown as DataStore,
        conversationId: 'c',
        browser,
        signal: controller.signal,
        approve: async () => false,
      };
      const pending = executeTool(name, name === 'browser_open' ? input : { tabId: 'tab', ...input }, context);
      await vi.waitFor(() => expect(pendingHook).toHaveBeenCalledOnce());
      expect((pendingHook.mock.calls[0] as unknown[]).at(-1)).toBe(
        controller.signal,
      );
      const cancelled = expect(pending).rejects.toThrow('Stopped by you.');
      controller.abort(new Error('Stopped by you.'));
      await cancelled;
    },
  );
  it('does not call a browser hook for an already aborted run', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Cancelled'));
    const getTabs = vi.fn(() => []);
    const browser = { getTabs } as unknown as BrowserHooks;
    await expect(
      executeTool(
        'browser_tabs',
        {},
        {
          store: {} as DataStore,
          conversationId: 'c',
          browser,
          signal: controller.signal,
          approve: async () => false,
        },
      ),
    ).rejects.toThrow('Cancelled');
    expect(getTabs).not.toHaveBeenCalled();
  });
  it('cancels a pending metadata lookup before any browser mutation dispatch', async () => {
    const controller = new AbortController();
    const getTabs = vi.fn(() => new Promise<never>(() => {}));
    const click = vi.fn();
    const browser = { getTabs, click } as unknown as BrowserHooks;
    const pending = executeTool(
      'browser_click',
      { tabId: 'tab', selector: 'button' },
      {
        store: { getConversation: () => ({ id: 'c' }) } as unknown as DataStore,
        conversationId: 'c',
        browser,
        signal: controller.signal,
        approve: async () => false,
      },
    );
    const cancelled = expect(pending).rejects.toThrow('Cancelled');
    controller.abort(new Error('Cancelled'));
    await cancelled;
    expect(click).not.toHaveBeenCalled();
  });
  it('consumes a late hook rejection after cancellation without an unhandled error', async () => {
    const controller = new AbortController();
    let reject!: (error: Error) => void;
    const getTabs = vi.fn(
      () =>
        new Promise<never>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    const pending = executeTool(
      'browser_tabs',
      {},
      {
        store: { getConversation: () => ({ id: 'c' }) } as unknown as DataStore,
        conversationId: 'c',
        browser: { getTabs } as unknown as BrowserHooks,
        signal: controller.signal,
        approve: async () => false,
      },
    );
    const cancelled = expect(pending).rejects.toThrow('Cancelled');
    controller.abort(new Error('Cancelled'));
    await cancelled;
    reject(new Error('Late renderer failure'));
    await Promise.resolve();
  });
  it('rejects path traversal, symlink escapes and common credential files', async () => {
    const repo = path.join(directory, 'repo');
    await writeFile(path.join(directory, 'outside.txt'), 'outside');
    await symlink(
      path.join(directory, 'outside.txt'),
      path.join(repo, 'escape.txt'),
    );
    await writeFile(path.join(repo, '.env'), 'NOT A REAL SECRET');
    await expect(scopedPath(repo, '../outside.txt')).rejects.toThrow(/outside/);
    await expect(scopedPath(repo, 'escape.txt')).rejects.toThrow(/outside/);
    await expect(scopedPath(repo, '.env')).rejects.toThrow(/secret/);
    await expect(scopedPath(null, '.')).rejects.toThrow(/Attach/);
  });
  it('reads only a regular file within the chat folder', async () => {
    const folder = path.join(directory, 'repo');
    await writeFile(path.join(folder, 'readme.md'), '# Hello');
    const store = {
      getConversation: () => ({ id: 'c', folder }),
    } as unknown as DataStore;
    const result = await executeTool(
      'file_read',
      { path: 'readme.md' },
      {
        store,
        conversationId: 'c',
        signal: new AbortController().signal,
        approve: async () => false,
      },
    );
    expect(result).toBe('# Hello');
  });
  it('offers browser_open without a required tab or attached folder', () => {
    const definition = toolDefinitions(false, true).find(item => item.function.name === 'browser_open');
    expect(definition?.function.parameters).toMatchObject({ required: ['url'] });
    expect(definition?.function.parameters.properties).not.toHaveProperty('tabId');
    expect(toolDefinitions(false, false).some(item => item.function.name === 'browser_open')).toBe(false);
  });
  it('opens a requested web page with no existing tabs, without reading or elevating page access', async () => {
    const { browser, context } = browserFixture();
    const result = await executeTool('browser_open', { url: 'http://localhost:5173/preview' }, context);
    expect(browser.open).toHaveBeenCalledWith('c', 'http://localhost:5173/preview', context.signal);
    expect(JSON.parse(result)).toMatchObject({ id: 'opened', control: 'off' });
    expect(browser.getTabs).not.toHaveBeenCalled();
    expect(browser.read).not.toHaveBeenCalled();
    expect(browser.navigate).not.toHaveBeenCalled();
    expect(context.approve).not.toHaveBeenCalled();
  });
  it.each(['relative', 'absolute', 'file URL'] as const)(
    'resolves an attached HTML %s to its canonical scoped path before opening',
    async form => {
      const folder = path.join(directory, 'repo');
      const file = path.join(folder, 'preview page.html');
      await writeFile(file, '<h1>Preview</h1>');
      const canonical = await scopedPath(folder, file);
      const url = form === 'relative' ? 'preview page.html' : form === 'absolute' ? file : pathToFileURL(file).href;
      const { browser, context } = browserFixture(folder);
      await executeTool('browser_open', { url }, context);
      expect(browser.open).toHaveBeenCalledWith('c', canonical, context.signal);
      expect(browser.read).not.toHaveBeenCalled();
    },
  );
  it('rejects HTML traversal and symlink escape before opening a preview', async () => {
    const folder = path.join(directory, 'repo');
    const outside = path.join(directory, 'outside.html');
    await writeFile(outside, '<h1>Other project</h1>');
    await symlink(outside, path.join(folder, 'escape.html'));
    const { browser, context } = browserFixture(folder);
    for (const url of ['../outside.html', outside, pathToFileURL(outside).href, 'escape.html']) {
      await expect(executeTool('browser_open', { url }, context)).rejects.toThrow(/outside/);
    }
    expect(browser.open).not.toHaveBeenCalled();
  });
  it('requires an attached folder for local previews and rejects missing or non-HTML files', async () => {
    const folder = path.join(directory, 'repo');
    await writeFile(path.join(folder, 'notes.txt'), 'Not a preview');
    const unattached = browserFixture();
    await expect(executeTool('browser_open', { url: 'preview.html' }, unattached.context)).rejects.toThrow(/Attach/);
    expect(unattached.browser.open).not.toHaveBeenCalled();
    const { browser, context } = browserFixture(folder);
    for (const url of ['notes.txt', 'missing.html']) {
      await expect(executeTool('browser_open', { url }, context)).rejects.toThrow();
    }
    expect(browser.open).not.toHaveBeenCalled();
  });
  it.each([
    {}, { url: '' }, { url: 123 }, { url: 'javascript:alert(1)' },
    { url: 'data:text/html,<h1>Hello</h1>' }, { url: 'ftp://example.test/page.html' },
    { url: 'https://user:secret@example.test/page' }, { url: 'https://example.test/' + 'x'.repeat(8192) },
  ])('rejects invalid browser_open input %j before its hook', async input => {
    const { browser, context } = browserFixture(path.join(directory, 'repo'));
    await expect(executeTool('browser_open', input, context)).rejects.toThrow();
    expect(browser.open).not.toHaveBeenCalled();
  });
  it('does not dispatch browser_open for an already-cancelled run', async () => {
    const { browser, context } = browserFixture();
    const controller = new AbortController();
    controller.abort(new Error('Cancelled'));
    await expect(executeTool('browser_open', { url: 'https://example.test' }, {
      ...context, signal: controller.signal,
    })).rejects.toThrow('Cancelled');
    expect(browser.open).not.toHaveBeenCalled();
  });
  it.each(['off', 'read', 'full'] as const)('navigates an owned %s tab without granting read or interaction', async control => {
    const tab: BrowserTab = {
      id: 'tab', conversationId: 'c', title: 'Existing', url: 'https://example.test', control,
      loading: false, canGoBack: false, canGoForward: false,
    };
    const { browser, context } = browserFixture(null, [tab]);
    await executeTool('browser_navigate', { tabId: 'tab', url: 'http://localhost:5173' }, context);
    expect(browser.navigate).toHaveBeenCalledWith('c', 'tab', 'http://localhost:5173/', context.signal);
    expect(tab.control).toBe(control);
    expect(browser.read).not.toHaveBeenCalled();
    expect(browser.click).not.toHaveBeenCalled();
    if (control === 'off') {
      await expect(executeTool('browser_read', { tabId: 'tab' }, context)).rejects.toThrow(/Agent control/);
      expect(browser.read).not.toHaveBeenCalled();
    }
  });
  it('checks per-chat ownership and per-tab control before browser hooks', async () => {
    let mode: 'off' | 'read' | 'full' = 'off';
    const browser: BrowserHooks = {
      getTabs: () => [
        {
          id: 'tab',
          conversationId: 'c',
          title: 'Test',
          url: 'https://example.test',
          control: mode,
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
      ],
      read: vi.fn(async () => ({
        title: 'Test',
        url: 'https://example.test',
        text: 'body',
      })),
      navigate: vi.fn(),
      click: vi.fn(),
      type: vi.fn(),
      scroll: vi.fn(),
    };
    const context = {
      store: {
        getConversation: () => ({ id: 'c', folder: null }),
      } as unknown as DataStore,
      conversationId: 'c',
      browser,
      signal: new AbortController().signal,
      approve: async () => false,
    };
    await expect(
      executeTool('browser_read', { tabId: 'tab' }, context),
    ).rejects.toThrow(/Agent control/);
    mode = 'read';
    expect(
      await executeTool('browser_read', { tabId: 'tab' }, context),
    ).toContain('body');
    for (const [name, input] of [
      ['browser_click', { tabId: 'tab', selector: 'button' }],
      ['browser_type', { tabId: 'tab', selector: 'input', text: 'value' }],
      ['browser_scroll', { tabId: 'tab', deltaY: 300 }],
    ] as const) {
      await expect(executeTool(name, input, context)).rejects.toThrow(/Agent control/);
    }
    expect(browser.click).not.toHaveBeenCalled();
    expect(browser.type).not.toHaveBeenCalled();
    expect(browser.scroll).not.toHaveBeenCalled();
    mode = 'full';
    await executeTool(
      'browser_click',
      { tabId: 'tab', selector: 'button' },
      context,
    );
    expect(browser.click).toHaveBeenCalledOnce();
    await expect(
      executeTool(
        'browser_read',
        { tabId: 'tab' },
        { ...context, conversationId: 'other' },
      ),
    ).rejects.toThrow(/owned/);
    await expect(executeTool('browser_navigate', {
      tabId: 'tab', url: 'https://example.test/next',
    }, { ...context, conversationId: 'other' })).rejects.toThrow(/owned/);
    expect(browser.navigate).not.toHaveBeenCalled();
  });
});

describe('a folder whose name ends in a space', () => {
  it('names the folder in the refusal, because the difference is invisible', async () => {
    const { mkdtemp, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const base = await mkdtemp(join(tmpdir(), 'hello-space-'));
    // Both exist on the user's disk; the chat is attached to the one with the
    // space, and any sensible path written without it is a different directory.
    const attached = join(base, 'globe ');
    await mkdir(attached);
    await mkdir(join(base, 'globe'));
    const error = await scopedPath(attached, join(base, 'globe')).then(() => null, (reason: Error) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`"${attached}"`);
    expect((error as Error).message).toContain('relative to it');
    // And the folder itself, named exactly, is still allowed — compared after
    // the symlinked ancestor is resolved, as everywhere else here.
    const { realpath } = await import('node:fs/promises');
    const real = await realpath(attached);
    await expect(scopedPath(attached, attached)).resolves.toBe(real);
    await expect(scopedPath(attached, '.')).resolves.toBe(real);
  });
});
