// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagePart } from '../src/shared/types';

vi.mock('../src/renderer/api', () => ({ api: { chat: { approve: vi.fn() }, system: { openExternal: vi.fn(), copy: vi.fn() } } }));
import { ToolPart } from '../src/renderer/chat/ConversationView';
import { diffLines } from '../src/renderer/chat/diff';
import { languageOf } from '../src/renderer/chat/ToolCode';

// Audit B1: an edit is approved by reading it, not by decoding escaped JSON.
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the lines an edit takes out and puts in', () => {
  it('keeps what both share, and marks what is taken out and put in', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc')).toEqual([
      { kind: 'same', text: 'a' }, { kind: 'del', text: 'b' }, { kind: 'add', text: 'B' }, { kind: 'same', text: 'c' },
    ]);
    expect(diffLines('a\nc', 'a\nb\nc')).toEqual([{ kind: 'same', text: 'a' }, { kind: 'add', text: 'b' }, { kind: 'same', text: 'c' }]);
    expect(diffLines('a\nb', 'a')).toEqual([{ kind: 'same', text: 'a' }, { kind: 'del', text: 'b' }]);
    // Taking text out entirely adds no empty line; CRLF reads as LF.
    expect(diffLines('x\ny', '')).toEqual([{ kind: 'del', text: 'x' }, { kind: 'del', text: 'y' }]);
    expect(diffLines('a\r\nb', 'a\nb')).toEqual([{ kind: 'same', text: 'a' }, { kind: 'same', text: 'b' }]);
  });

  it('gives up past the cap, so a huge edit is shown apart instead', () => {
    expect(diffLines('a\n'.repeat(10), 'b', 5)).toBeNull();
    expect(diffLines('a', 'b\n'.repeat(10), 5)).toBeNull();
  });

  it('names a file’s language by its extension', () => {
    expect(languageOf('src/app.tsx')).toBe('tsx');
    expect(languageOf('README.MD')).toBe('markdown');
    expect(languageOf('Makefile')).toBe('text');
  });
});

const step = (name: string, input: unknown, status: 'approval' | 'complete' = 'approval'): Extract<MessagePart, { type: 'tool' }> =>
  ({ type: 'tool', id: 't1', name, input: typeof input === 'string' ? input : JSON.stringify(input), status, ...(status === 'approval' ? { approvalId: 'a1' } : {}) });

describe('a code step, readably', () => {
  it('shows an edit waiting for approval as its path and its − and + lines', () => {
    act(() => root.render(createElement(ToolPart, { part: step('file_edit', { path: 'src/app.ts', old: 'const a = 1;', new: 'const a = 2;', all: true }) })));
    expect(host.querySelector('.tool-code-path')?.textContent).toBe('src/app.ts · every occurrence');
    expect([...host.querySelectorAll('.tool-diff-line')].map(line => line.textContent)).toEqual(['− const a = 1;\n', '+ const a = 2;\n']);
    expect([...host.querySelectorAll('.tool-diff-line')].map(line => line.getAttribute('data-kind'))).toEqual(['del', 'add']);
    // The decision itself is unchanged.
    expect([...host.querySelectorAll('button')].some(button => button.textContent === 'Allow once')).toBe(true);
  });

  it('shows a write as its file, a command as its shell line, and anything else as before', () => {
    // A finished step is closed; opening it shows the same readable view.
    const open = (part: Extract<MessagePart, { type: 'tool' }>) => {
      act(() => root.render(createElement(ToolPart, { key: part.name + part.input, part })));
      if (part.status !== 'approval') act(() => { host.querySelector<HTMLButtonElement>('.disclosure-button')!.click(); });
    };
    open(step('file_write', { path: 'notes.md', content: '# Title', replace: true }, 'complete'));
    expect(host.querySelector('.tool-code-path')?.textContent).toBe('notes.md · replaces the whole file');
    expect(host.querySelector('.tool-code .code-block')?.textContent).toContain('# Title');
    open(step('command_run', { command: 'pnpm test' }));
    expect(host.querySelector('.tool-code .code-block')?.textContent).toContain('pnpm test');
    open(step('file_edit', '{"path": broken', 'complete'));
    expect(host.querySelector('.tool-code')).toBeNull();
    expect(host.querySelector('.code-block')?.textContent).toContain('{"path": broken');
    open(step('file_read', { path: 'a.txt' }, 'complete'));
    expect(host.querySelector('.tool-code')).toBeNull();
  });
});
