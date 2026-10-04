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
