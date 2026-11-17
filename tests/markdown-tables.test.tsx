// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/renderer/api', () => ({ api: { system: { openExternal: vi.fn(), copy: vi.fn() } } }));
import { Markdown } from '../src/renderer/chat/Markdown';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a link to a file whose name has spaces', () => {
  it('is a link, as the model meant it, and code is left as written', async () => {
    const { spacedLinks } = await import('../src/shared/files');
    expect(spacedLinks('Gata, în [Profi Phone List 22.05.2023.xlsx](Profi Phone List 22.05.2023.xlsx), salvat.')).toBe('Gata, în [Profi Phone List 22.05.2023.xlsx](<Profi Phone List 22.05.2023.xlsx>), salvat.');
    expect(spacedLinks('[x](rapoarte/Raport final.md:12) și [y](a.md) și [z](<b c.md>) și [t](https://example.com/a "titlu")')).toBe('[x](<rapoarte/Raport final.md:12>) și [y](a.md) și [z](<b c.md>) și [t](https://example.com/a "titlu")');
    expect(spacedLinks('`[a](b c.md)` și\n```\n[a](b c.md)\n```\n[a](b c.md)')).toBe('`[a](b c.md)` și\n```\n[a](b c.md)\n```\n[a](<b c.md>)');
    expect(spacedLinks('f(x) = [1](2 3) fără extensie')).toBe('f(x) = [1](2 3) fără extensie');
    const opened: unknown[] = [];
    await act(async () => { root.render(createElement(Markdown, { text: 'Gata, în [Profi Phone List 22.05.2023.xlsx](Profi Phone List 22.05.2023.xlsx).', onOpenFile: target => { opened.push(target); } })); });
    const link = host.querySelector('a')!;
    expect(link.textContent).toBe('Profi Phone List 22.05.2023.xlsx');
    expect(host.textContent).toBe('Gata, în Profi Phone List 22.05.2023.xlsx.');
    await act(async () => { link.click(); });
    expect(opened).toEqual([{ path: 'Profi Phone List 22.05.2023.xlsx' }]);
  });
});

describe('a table a model writes', () => {
  it('breaks a cell’s lines at <br>, and still renders no other HTML', async () => {
    const text = [
      '| Language | Disadvantages |',
      '| --- | --- |',
      '| Rust | Steep learning curve<br>• Verbose<br/>• Slow builds |',
      '| Go | <b>bold?</b> <script>alert(1)</script> |',
    ].join('\n');
    await act(async () => { root.render(createElement(Markdown, { text })); });
    const cells = [...host.querySelectorAll('td')];
    expect(cells[1].querySelectorAll('br')).toHaveLength(2);
    expect(cells[1].textContent?.replace(/\n/g, '')).toBe('Steep learning curve• Verbose• Slow builds');
    expect(host.textContent).not.toContain('<br');
    expect(cells[3].querySelector('b, script')).toBeNull();
  });

  it('keeps a <br> inside code as text', async () => {
    await act(async () => { root.render(createElement(Markdown, { text: 'Use `<br>` in HTML.' })); });
    expect(host.querySelector('code')?.textContent).toBe('<br>');
  });
});
