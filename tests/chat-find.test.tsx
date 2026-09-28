// @vitest-environment jsdom
import { createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../src/shared/types';
import { ChatFind, findRanges, type FindJump } from '../src/renderer/chat/ChatFind';

vi.mock('../src/renderer/api', () => ({ onNativeBrowserFocus: () => () => {} }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const transcript = `
  <article data-message-id="m1"><p>Download the Neon invoice.</p></article>
  <article data-message-id="m2"><p>The invoice is saved.</p><div hidden><p>invoice in a closed disclosure</p></div></article>
  <article data-message-id="m3"><p>Next: the ElevenLabs INVOICE.</p></article>`;
function Harness({ jump }: { jump?: FindJump | null }) {
  const ref = useRef<HTMLDivElement>(null);
  return createElement('div', null,
    createElement(ChatFind, { root: ref, conversationId: 'c', active: true, messages: [] as Message[], jump }),
    createElement('div', { ref, dangerouslySetInnerHTML: { __html: transcript } }));
}
const bar = () => host.querySelector<HTMLElement>('.chat-find');
const count = () => host.querySelector('.chat-find-count')?.textContent;
async function type(text: string) {
  const input = host.querySelector<HTMLInputElement>('.chat-find input')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
}

// Find in a chat (user, 28.09 plan: "in-chat search overlay (Ctrl+K)").
describe('find in chat', () => {
  it('finds the words in the visible text, case folded, and not in what is hidden', () => {
    const div = document.createElement('div');
    div.innerHTML = transcript;
    expect(findRanges(div, 'Invoice').map(range => range.toString())).toEqual(['invoice', 'invoice', 'INVOICE']);
    expect(findRanges(div, '   ')).toEqual([]);
  });

  it('opens on Cmd+F or Ctrl+K, moves with Enter and Shift+Enter, and closes on Escape', async () => {
    await act(async () => { root.render(createElement(Harness)); });
    expect(bar()).toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true })); });
    expect(bar()).not.toBeNull();
    await type('invoice');
    expect(count()).toBe('1 of 3');
    const input = host.querySelector<HTMLInputElement>('.chat-find input')!;
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(count()).toBe('2 of 3');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })); });
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })); });
    expect(count()).toBe('3 of 3');
    await type('flight');
    expect(count()).toBe('No matches');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(bar()).toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true })); });
    // The words are remembered for this chat.
    expect(host.querySelector<HTMLInputElement>('.chat-find input')?.value).toBe('flight');
  });

  it('opens on a result chosen in the sidebar, at the match inside that message', async () => {
    await act(async () => { root.render(createElement(Harness, { jump: { conversationId: 'c', messageId: 'm3', query: 'invoice', nonce: 1 } })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    expect(host.querySelector<HTMLInputElement>('.chat-find input')?.value).toBe('invoice');
    expect(count()).toBe('3 of 3');
  });
});
