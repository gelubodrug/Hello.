// @vitest-environment jsdom
import { Fragment, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/renderer/api', () => ({ api: {}, onNativeBrowserFocus: () => () => {} }));
import { Dialog } from '../src/renderer/ui/primitives';
import { KeyboardShortcuts } from '../src/renderer/ui/KeyboardShortcuts';
import { SidebarChrome } from '../src/renderer/ui/SidebarChrome';
import { chatForMenu } from '../src/renderer/menu-chats';
import { AttentionDialog } from '../src/renderer/ui/AttentionDialog';

// The second UI review (05.10): what focus does when surfaces come and go,
// and the keys the app tells a person about.
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('a dialog', () => {
  it('makes the app behind it inert while open, Tabs only through what can take focus, and gives focus back', async () => {
    const app = document.createElement('div');
    app.id = 'root';
    const behind = document.createElement('button');
    behind.textContent = 'Behind';
    app.append(behind);
    document.body.prepend(app);
    const view = (open: boolean) => createElement(Dialog, { open, title: 'Check', onClose: () => {}, children: createElement(Fragment, null,
      createElement('button', { type: 'button' }, 'First'),
      createElement('button', { type: 'button', disabled: true }, 'Off'),
      createElement('button', { type: 'button' }, 'Last'),
      createElement('input', { type: 'hidden', name: 'kept' })) });
    behind.focus();
    await act(async () => root.render(view(true)));
    expect(app.hasAttribute('inert')).toBe(true);
    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close Check"]')!;
    expect(document.activeElement).toBe(close);
    // Back from the first control lands on the last one that can take focus, never the hidden field.
    await act(async () => { close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })); });
    expect(document.activeElement?.textContent).toBe('Last');
    await act(async () => root.render(view(false)));
    expect(app.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(behind);
  });
});

describe('a dialog that chose where focus goes', () => {
  it('opens on the element it names, and leaves focus alone when told not to give it back', async () => {
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    const field = { current: null as HTMLInputElement | null };
    const view = (open: boolean, returnFocus: boolean) => createElement(Dialog, { open, title: 'Pick', onClose: () => {}, initialFocus: field as never, returnFocus,
      children: createElement('input', { ref: (node: HTMLInputElement | null) => { field.current = node; }, 'aria-label': 'Field' }) });
    await act(async () => root.render(view(true, false)));
    expect(document.activeElement).toBe(field.current);
    await act(async () => root.render(view(false, false)));
    expect(document.activeElement).not.toBe(before);
  });
});

describe('the keyboard shortcuts', () => {
  it('lists the keys the app answers to, the transcript’s among them, and nothing it does not do', async () => {
    await act(async () => root.render(createElement(KeyboardShortcuts)));
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true })); });
    const text = document.body.textContent ?? '';
    expect(text).toContain('Transcript');
    expect(text).toContain('Previous or next message');
    expect(text).toContain('First or last message');
    expect(text).toContain('Copy the focused message');
    expect(text).toContain('Show or hide the chats sidebar');
    expect(text).toContain('Find in the chat or the notebook on screen');
    expect(text).toContain('Find in the scrollback (terminal focused)');
    expect(text).toContain('Reuse a previous message');
    expect(text).toContain('Go to a chat, tab, message or command');
    expect(text).not.toContain('command palette');
    expect(text).not.toContain('Step through your earlier messages');
  });
});

describe('the sidebar drawer', () => {
  it('does not keep focus in what it hides: focus goes to the edge that brings it back', async () => {
    await act(async () => root.render(createElement(SidebarChrome, { visible: false,
      children: createElement('button', { type: 'button' }, 'A chat') })));
    const edge = document.querySelector<HTMLButtonElement>('.sidebar-edge')!;
    await act(async () => { edge.click(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    const row = [...document.querySelectorAll<HTMLButtonElement>('#hello-navigation button')].find(button => button.textContent === 'A chat')!;
    row.focus();
    await act(async () => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    expect(document.activeElement).toBe(edge);
  });
});

// S209 F2: between chats from the keyboard, through the app menu.
describe('the menu keys between chats', () => {
  const order = ['a', 'b', 'c', 'd'];
  it('goes by place in the list, and next and previous round the end', () => {
    expect(chatForMenu('chat-1', order, 'c', new Set())).toBe('a');
    expect(chatForMenu('chat-4', order, 'c', new Set())).toBe('d');
    expect(chatForMenu('chat-5', order, 'c', new Set())).toBeNull();
    expect(chatForMenu('next-chat', order, 'c', new Set())).toBe('d');
    expect(chatForMenu('next-chat', order, 'd', new Set())).toBe('a');
    expect(chatForMenu('previous-chat', order, 'a', new Set())).toBe('d');
    expect(chatForMenu('previous-chat', order, null, new Set())).toBe('d');
    expect(chatForMenu('next-chat', [], null, new Set())).toBeNull();
  });
  it('takes ⌘J to the next chat waiting after the open one, round the end, and the open one last', () => {
    expect(chatForMenu('attention-chat', order, 'b', new Set(['a', 'd']))).toBe('d');
    expect(chatForMenu('attention-chat', order, 'd', new Set(['a', 'd']))).toBe('a');
    expect(chatForMenu('attention-chat', order, 'b', new Set(['b']))).toBe('b');
    expect(chatForMenu('attention-chat', order, null, new Set(['c']))).toBe('c');
    expect(chatForMenu('attention-chat', order, 'b', new Set())).toBeNull();
  });
});

// Audit A1: the list of what waits for the person, by chat, oldest first.
describe('the attention list', () => {
  const request = (requestId: string, conversationId: string, createdAt: number, kind: 'approval' | 'question', label: string) =>
    ({ requestId, conversationId, createdAt, kind, label, target: kind === 'approval' ? { messageId: 'm', toolPartId: 't' } : { dialogId: requestId } });
  it('groups requests by chat, the oldest first, and leads to the one chosen', async () => {
    const opened: string[] = [];
    const requests = [
      request('r3', 'b', 3, 'approval', 'command_run'),
      request('r1', 'a', 1, 'approval', 'file_edit'),
      request('r2', 'a', 2, 'question', 'Clear session?'),
    ];
    await act(async () => root.render(createElement(AttentionDialog, { open: true, requests, titles: new Map([['a', 'Release'], ['b', 'Docs']]),
      onOpenRequest: chosen => opened.push(chosen.requestId), onClose: () => {} })));
    expect([...document.querySelectorAll('.attention-group h2')].map(node => node.textContent)).toEqual(['Release', 'Docs']);
    expect([...document.querySelectorAll('.attention-row-label')].map(node => node.textContent)).toEqual(['file edit', 'Clear session?', 'command run']);
    expect(document.querySelector('.attention-summary')?.textContent).toBe('3 requests wait for your answer.');
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.attention-row button')];
    await act(async () => { buttons[1].click(); });
    expect(opened).toEqual(['r2']);
  });
  it('says plainly when nothing waits', async () => {
    await act(async () => root.render(createElement(AttentionDialog, { open: true, requests: [], titles: new Map(), onOpenRequest: () => {}, onClose: () => {} })));
    expect(document.querySelector('.attention-summary')?.textContent).toBe('Nothing is waiting for you.');
  });
});
