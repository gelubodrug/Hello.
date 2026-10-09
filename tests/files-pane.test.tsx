// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentSearch, FileDocument, ModelFileChange } from '../src/shared/files';
import type { Conversation } from '../src/shared/types';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  onChange: vi.fn(),
  searchContents: vi.fn(),
  cancelSearch: vi.fn(async () => {}),
  copy: vi.fn(async () => {}),
}));
vi.mock('../src/renderer/api', () => ({
  api: {
    files: { list: mocks.list, read: mocks.read, onChange: mocks.onChange, open: vi.fn(), reveal: vi.fn(), resolvePaths: vi.fn(), searchContents: mocks.searchContents, cancelSearch: mocks.cancelSearch },
    system: { copy: mocks.copy },
  },
  onNativeBrowserFocus: () => () => {},
}));
import { FilesPane, type FileRequest } from '../src/renderer/files/FilesPane';
import { QUOTE_LIMIT, fileSelection, selectionQuote } from '../src/renderer/files/selection';

// Audit A3b: Contents searches inside the files of the chat's folder; a
// selection in the viewer goes to the chat's draft with where it came from.
const chat: Conversation = { id: 'chat-1', title: 'Files', folder: '/work', createdAt: 1, updatedAt: 1 };
const doc = (path: string, content: string): FileDocument => ({ path, absolutePath: `/work/${path}`, name: path.split('/').pop()!, size: content.length, modifiedAt: 1, content });
const answer = (requestId: string, matches: ContentSearch['matches'], extra: Partial<ContentSearch> = {}): ContentSearch =>
  ({ requestId, matches, limited: false, reasons: [], filesScanned: 3, bytesScanned: 120, skipped: 0, ...extra });

let root: Root;
let host: HTMLDivElement;
let changed: ((event: ModelFileChange) => void) | undefined;
const render = async (props: { conversation?: Conversation; visible?: boolean; request?: FileRequest | null; onQuote?: (text: string, extra?: { verbatim?: boolean }) => void }) => {
  await act(async () => {
    root.render(createElement(FilesPane, { conversation: props.conversation ?? chat, visible: props.visible ?? true, request: props.request ?? null, onChooseFolder: vi.fn(), onQuote: props.onQuote }));
  });
};
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === name || item.getAttribute('aria-label') === name)!;
const click = async (target: Element) => { await act(async () => { (target as HTMLElement).click(); }); };
const type = async (field: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const wait = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
/** Selects from a line and column to a line and column of the file shown in Source. */
const select = async (from: [number, number], to: [number, number]) => {
  const text = (line: number) => host.querySelector(`.files-document [data-line="${line}"]`)!.firstChild!;
  const range = document.createRange();
  range.setStart(text(from[0]), from[1]);
  range.setEnd(text(to[0]), to[1]);
  await act(async () => {
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
};

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  changed = undefined;
  mocks.onChange.mockImplementation((listener: (event: ModelFileChange) => void) => { changed = listener; return () => { changed = undefined; }; });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  mocks.list.mockResolvedValue({ root: '/work', entries: [{ path: 'notes.txt', name: 'notes.txt', kind: 'file' }], limited: false, skipped: 0 });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.getSelection()?.removeAllRanges();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('refresh after model file mutations', () => {
  const event = (extra: Partial<ModelFileChange> = {}): ModelFileChange => ({ conversationId: chat.id, folder: chat.folder!, path: 'notes.txt', source: 'file_edit', ...extra });
  it('refreshes just the open file, retaining scroll and text selection without repeated reads', async () => {
    mocks.read.mockResolvedValueOnce(doc('notes.txt', 'alpha\nbeta\ngamma')).mockResolvedValueOnce(doc('notes.txt', 'alpha\nbeta\ngamma changed'));
    await render({ request: { path: 'notes.txt', nonce: 1 } });
    const area = host.querySelector<HTMLElement>('.files-document')!;
    await select([2, 1], [2, 3]);
    area.scrollTop = 240; area.scrollLeft = 41;
    await act(async () => {
      changed?.(event({ path: 'other.txt' }));
      changed?.(event({ conversationId: 'other-chat' }));
      changed?.(event({ folder: '/other-folder' }));
    });
    await wait(100);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await act(async () => { changed?.(event()); changed?.(event({ source: 'file_write' })); });
    await wait(75);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(area.textContent).toContain('gamma changed');
    expect(area.scrollTop).toBe(240); expect(area.scrollLeft).toBe(41);
    expect(document.getSelection()?.toString()).toBe('et');
    await wait(5000);
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
  it('does not replace a newly opened file with an older refresh result', async () => {
    const stale = deferred<FileDocument>();
    mocks.read.mockResolvedValueOnce(doc('notes.txt', 'old')).mockReturnValueOnce(stale.promise).mockResolvedValueOnce(doc('other.txt', 'current'));
    await render({ request: { path: 'notes.txt', nonce: 1 } });
    await act(async () => { changed?.(event()); }); await wait(75);
    await render({ request: { path: 'other.txt', nonce: 2 } });
    await act(async () => { stale.resolve(doc('notes.txt', 'stale result')); });
    expect(host.querySelector('.files-document')?.textContent).toContain('current');
    expect(host.querySelector('.files-document')?.textContent).not.toContain('stale result');
  });
});

describe('Files: Contents', () => {
  it('finds words in the bodies of the files, as text, and a line opens in Source', async () => {
    mocks.searchContents.mockImplementation(async (_id: string, requestId: string) =>
      answer(requestId, [{ path: 'src/a.txt', line: 2, snippet: 'the <b>needle</b> here', start: 7, end: 13 }], { skipped: 2 }));
    mocks.read.mockResolvedValue(doc('src/a.txt', 'one\nthe <b>needle</b> here\nthree'));
    await render({});
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Filter files"]')).not.toBeNull();
    await click(button('Contents'));
    const field = host.querySelector<HTMLInputElement>('input[aria-label="Search file contents"]')!;
    await type(field, 'n');
    await wait(300);
    expect(mocks.searchContents).not.toHaveBeenCalled();
    expect(host.querySelector('.files-notice')!.textContent).toContain('Type two or more characters');
    await type(field, 'needle');
    await wait(250);
    expect(mocks.searchContents).toHaveBeenCalledWith('chat-1', expect.any(String), 'needle', { matchCase: false });
    expect(host.querySelector('.files-results-status')!.textContent).toBe('1 line in 1 file');
    expect(host.querySelector<HTMLElement>('.files-tree-box')!.hidden).toBe(true);
    const row = host.querySelector<HTMLButtonElement>('.files-result')!;
    // The snippet is words, never markup.
    expect(row.querySelector('b')).toBeNull();
    expect(row.querySelector('mark')!.textContent).toBe('needle');
    expect(row.textContent).toBe('2the <b>needle</b> here');
    expect(host.querySelector('.files-notice')!.textContent).toContain('2 skipped.');
    await click(row);
    expect(mocks.read).toHaveBeenCalledWith('chat-1', 'src/a.txt');
    expect(host.querySelector('.files-document [data-line="2"]')!.textContent).toBe('the <b>needle</b> here');
  });

  it('sends Match case; an older answer, or one after leaving Contents, is dropped, and main is told to stop', async () => {
    const first = deferred<ContentSearch>(), second = deferred<ContentSearch>();
    mocks.searchContents.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render({});
    await click(button('Contents'));
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Search file contents"]')!, 'ne');
    await wait(250);
    const firstId = mocks.searchContents.mock.calls[0][1] as string;
    await click(button('Match case'));
    expect(mocks.cancelSearch).toHaveBeenCalledWith('chat-1');
    await wait(250);
    expect(mocks.searchContents).toHaveBeenLastCalledWith('chat-1', expect.any(String), 'ne', { matchCase: true });
    const secondId = mocks.searchContents.mock.calls[1][1] as string;
    expect(secondId).not.toBe(firstId);
    await act(async () => { first.resolve(answer(firstId, [{ path: 'old.txt', line: 1, snippet: 'ne', start: 0, end: 2 }])); });
    expect(host.querySelector('.files-result')).toBeNull();
    await act(async () => { second.resolve(answer(secondId, [])); });
    expect(host.querySelector('.files-results-status')!.textContent).toBe('No line in this folder has that.');
    mocks.cancelSearch.mockClear();
    await click(button('Names'));
    expect(mocks.cancelSearch).toHaveBeenCalledWith('chat-1');
    expect(host.querySelector('.files-results')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Filter files"]')!.value).toBe('ne');
  });

  it('hiding Files or changing the folder stops the scan, and nothing from the old folder shows', async () => {
    const pending = deferred<ContentSearch>();
    mocks.searchContents.mockReturnValueOnce(pending.promise);
    await render({});
    await click(button('Contents'));
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Search file contents"]')!, 'needle');
    await wait(250);
    const requestId = mocks.searchContents.mock.calls[0][1] as string;
    await render({ visible: false });
    expect(mocks.cancelSearch).toHaveBeenCalledWith('chat-1');
    mocks.cancelSearch.mockClear();
    mocks.searchContents.mockReturnValueOnce(new Promise(() => {}));
    await render({ visible: true });
    await wait(250);
    await render({ conversation: { ...chat, folder: '/elsewhere' } });
    expect(mocks.cancelSearch).toHaveBeenCalledWith('chat-1');
    await act(async () => { pending.resolve(answer(requestId, [{ path: 'old.txt', line: 1, snippet: 'needle', start: 0, end: 6 }])); });
    expect(host.querySelector('.files-result')).toBeNull();
  });

  it('a partial search says where it stopped', async () => {
    mocks.searchContents.mockImplementation(async (_id: string, requestId: string) =>
      answer(requestId, [{ path: 'a.txt', line: 1, snippet: 'needle', start: 0, end: 6 }], { limited: true, reasons: ['results', 'time'] }));
    await render({});
    await click(button('Contents'));
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Search file contents"]')!, 'needle');
    await wait(250);
    expect(host.querySelector('.files-notice')!.textContent).toContain('Partial results: stopped at 200 lines, stopped after 4 seconds.');
  });
});

describe('Files: Add selection to chat', () => {
  const open = async (content: string, onQuote = vi.fn()) => {
    mocks.read.mockResolvedValue(doc('notes.txt', content));
    await render({ request: { path: 'notes.txt', nonce: 1 }, onQuote });
    return onQuote;
  };

  it('puts the selected lines, taken from the file, in the draft with where they came from — once, never sent', async () => {
    const onQuote = await open('alpha\nbeta gamma\ndelta');
    const add = button('Add selection to chat');
    expect(add.disabled).toBe(true);
    await select([2, 5], [3, 2]);
    expect(add.disabled).toBe(false);
    await click(add);
    expect(onQuote).toHaveBeenCalledTimes(1);
    expect(onQuote).toHaveBeenCalledWith('From `notes.txt` (lines 2–3):\n```\ngamma\nde\n```', { verbatim: true });
  });

  it('the menu takes the selection before it has focus: Add selection to chat, and Copy', async () => {
    const onQuote = await open('alpha\nbeta gamma\ndelta');
    await select([2, 0], [2, 4]);
    const area = host.querySelector<HTMLElement>('.files-document')!;
    await act(async () => { area.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); });
    const items = [...document.querySelectorAll<HTMLButtonElement>('.menu-popup [role="menuitem"]')];
    expect(items.map(item => item.textContent)).toEqual(['Add selection to chat', 'Copy⌘ C']);
    await click(items[1]);
    expect(mocks.copy).toHaveBeenCalledWith({ text: 'beta' });
    await act(async () => { area.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); });
    await click(document.querySelector<HTMLButtonElement>('.menu-popup [role="menuitem"]')!);
    expect(onQuote).toHaveBeenCalledWith('From `notes.txt` (line 2):\n```\nbeta\n```', { verbatim: true });
  });

  it('a selection over the limit is refused with the next step, not cut', async () => {
    const onQuote = await open(`short\n${'x'.repeat(QUOTE_LIMIT + 1)}\nend`);
    await select([2, 0], [2, QUOTE_LIMIT + 1]);
    await click(button('Add selection to chat'));
    expect(onQuote).not.toHaveBeenCalled();
    expect(host.textContent).toContain(`The selection has ${(QUOTE_LIMIT + 1).toLocaleString('en-US')} characters`);
    expect(host.textContent).toContain('Select less, or attach the file instead.');
  });
});

describe('what a selection in the viewer is', () => {
  const viewer = (lines: string[]) => {
    const area = document.createElement('div');
    area.innerHTML = `<div class="code-block" data-line-numbers="true"><pre><code>${lines.map((line, index) => `<span class="code-line" data-line="${index + 1}">${line || ' '}</span>`).join('')}</code></pre></div>`;
    document.body.append(area);
    return area;
  };
  const pick = (startNode: Node, startOffset: number, endNode: Node, endOffset: number) => {
    const range = document.createRange();
    range.setStart(startNode, startOffset); range.setEnd(endNode, endOffset);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
  };
  const line = (area: HTMLElement, number: number) => area.querySelector(`[data-line="${number}"]`)!;

  it('in Source, the words come from the file — CRLF and blank lines as written', () => {
    const area = viewer(['first', '', 'third line']);
    const file = doc('a.txt', 'first\r\n\r\nthird line\r\n');
    pick(line(area, 1).firstChild!, 2, line(area, 3).firstChild!, 5);
    expect(fileSelection(area, file, true)).toEqual({ text: 'rst\n\nthird', path: 'a.txt', lines: { from: 1, to: 3 } });
    area.remove();
  });

  it('a selection that ends at the start of a line, or between lines, claims only the lines it covers', () => {
    const area = viewer(['one', 'two', 'three']);
    const file = doc('a.txt', 'one\ntwo\nthree');
    pick(line(area, 2).firstChild!, 0, line(area, 3).firstChild!, 0);
    expect(fileSelection(area, file, true)).toEqual({ text: 'two', path: 'a.txt', lines: { from: 2, to: 2 } });
    const code = area.querySelector('code')!;
    pick(code, 0, code, 2);
    expect(fileSelection(area, file, true)).toEqual({ text: 'one\ntwo', path: 'a.txt', lines: { from: 1, to: 2 } });
    area.remove();
  });

  it('outside Source no line is claimed; outside the viewer nothing is selected', () => {
    const area = viewer(['alpha beta']);
    const file = doc('a.md', 'alpha beta');
    pick(line(area, 1).firstChild!, 0, line(area, 1).firstChild!, 5);
    expect(fileSelection(area, file, false)).toEqual({ text: 'alpha', path: 'a.md' });
    const elsewhere = document.createElement('p');
    elsewhere.textContent = 'not the file';
    document.body.append(elsewhere);
    pick(elsewhere.firstChild!, 0, elsewhere.firstChild!, 3);
    expect(fileSelection(area, file, true)).toBeNull();
    area.remove(); elsewhere.remove();
  });

  it('says where the words come from: code fenced past any backticks in it, prose quoted', () => {
    expect(selectionQuote({ text: 'const a = `x`;\n```', path: 'src/a.ts', lines: { from: 4, to: 5 } }, 'typescript'))
      .toBe('From `src/a.ts` (lines 4–5):\n````typescript\nconst a = `x`;\n```\n````');
    expect(selectionQuote({ text: 'Two\nlines', path: 'docs/read me.md' }, 'markdown'))
      .toBe('From `docs/read me.md`:\n> Two\n> lines');
  });
});
