// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/renderer/api', () => ({ api: {}, onNativeBrowserFocus: () => () => {} }));
import { rankGoTo, type GoToItem } from '../src/renderer/go-to';
import { CommandPalette } from '../src/renderer/ui/CommandPalette';

// Audit A2: "Go to…" finds a place or a command by its words; only choosing acts.
const item = (id: string, group: GoToItem['group'], label: string, extra: Partial<GoToItem> = {}): GoToItem =>
  ({ id, group, label, run: vi.fn(), ...extra });

describe('the order of what "Go to…" finds', () => {
  it('groups in a fixed order, then the whole name, a start, anywhere, then the most recent', () => {
    const items = [
      item('c1', 'Chats', 'Release notes', { recent: 1 }),
      item('t1', 'Open tabs', 'Release dashboard'),
      item('c2', 'Chats', 'Pre-release', { recent: 3 }),
      item('k1', 'Commands', 'Settings'),
      item('c3', 'Chats', 'release', { recent: 2 }),
      item('c4', 'Chats', 'Docs', { detail: 'release-folder' }),
    ];
    expect(rankGoTo(items, 'release').map(entry => entry.id)).toEqual(['c3', 'c2', 'c1', 'c4', 't1']);
    expect(rankGoTo(items, 'zzz')).toEqual([]);
    // No words: everything, grouped, the most recent chats first.
    expect(rankGoTo(items, '').map(entry => entry.id)).toEqual(['k1', 'c2', 'c3', 'c1', 'c4', 't1']);
  });
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const type = async (field: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
};
const press = async (field: HTMLInputElement, key: string) => {
  await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
};

describe('the "Go to…" dialog', () => {
  it('opens on its field, filters as one types, and acts only on Enter', async () => {
    const onClose = vi.fn();
    const items = [item('k1', 'Commands', 'New chat'), item('c1', 'Chats', 'Budget'), item('c2', 'Chats', 'Build logs')];
    await act(async () => root.render(createElement(CommandPalette, { open: true, items, onClose })));
    const field = document.querySelector<HTMLInputElement>('.go-to-field')!;
    expect(document.activeElement).toBe(field);
    await type(field, 'bu');
    expect([...document.querySelectorAll('.go-to-label')].map(node => node.textContent)).toEqual(['Budget', 'Build logs']);
    expect(items.every(entry => !(entry.run as ReturnType<typeof vi.fn>).mock.calls.length)).toBe(true);
    await press(field, 'ArrowDown');
    await press(field, 'Enter');
    expect(items[2].run).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalled();
    await type(field, 'nothing like it');
    expect(document.querySelector('.go-to-status')?.textContent).toBe('Nothing matches.');
  });

  it('finds messages a moment after the typing stops, and never shows an older answer over a newer one', async () => {
    vi.useFakeTimers();
    let first!: (rows: GoToItem[]) => void;
    const searchMessages = vi.fn()
      .mockImplementationOnce(() => new Promise<GoToItem[]>(resolve => { first = resolve; }))
      .mockImplementationOnce(async () => [item('m2', 'Matching messages', 'the newer match')]);
    await act(async () => root.render(createElement(CommandPalette, { open: true, items: [], searchMessages, onClose: () => {} })));
    const field = document.querySelector<HTMLInputElement>('.go-to-field')!;
    await type(field, 'ol');
    await act(async () => { vi.advanceTimersByTime(300); });
    await type(field, 'older');
    await act(async () => { vi.advanceTimersByTime(300); });
    await act(async () => { first([item('m1', 'Matching messages', 'the older match')]); });
    expect([...document.querySelectorAll('.go-to-label')].map(node => node.textContent)).toEqual(['the newer match']);
    expect(document.querySelector('.go-to-group')?.textContent).toBe('Recent matches');
  });
});
