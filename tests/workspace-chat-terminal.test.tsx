// @vitest-environment jsdom
import { createElement, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, Conversation, TerminalSession } from '../src/shared/types';

// A CLI as the chat (user, 30.09): "Set as chat tab" moves a terminal into the
// chat pane and back, and the terminal itself is never built again.
const panes = vi.hoisted(() => ({ mounts: 0, shown: new Map<string, { visible: boolean; placement?: string }>() }));
vi.mock('../src/renderer/terminal/TerminalPane', async () => {
  const { createElement: h, useEffect: onMount } = await import('react');
  return {
    TerminalPane: (props: { session: { id: string }; visible: boolean; placement?: string }) => {
      onMount(() => { panes.mounts++; }, []);
      panes.shown.set(props.session.id, { visible: props.visible, placement: props.placement });
      return h('section', { className: 'terminal-stub', 'data-session-id': props.session.id, hidden: !props.visible });
    },
  };
});
vi.mock('../src/renderer/chat/ConversationView', () => ({ ConversationView: () => null }));
vi.mock('../src/renderer/notebook/Notebook', () => ({ Notebook: () => null }));
vi.mock('../src/renderer/browser/BrowserPane', () => ({ BrowserPane: () => null }));
vi.mock('../src/renderer/files/FilesPane', () => ({ FilesPane: () => null }));
vi.mock('../src/renderer/api', () => ({
  api: {
    notebooks: { list: async () => [], onChange: () => () => {} },
    system: { chooseFolder: async () => null },
    conversations: { update: async () => ({}) },
  },
  onNativeBrowserFocus: () => () => {},
}));

import { Workspace, defaultWorkspacePrefs, type WorkspacePrefs, type WorkspaceUpdate } from '../src/renderer/workspace/Workspace';

let conversation = { id: 'c1', title: 'Chat', folder: null } as Conversation;
const terminal = (id: string, title: string, kind: TerminalSession['kind']): TerminalSession =>
  ({ id, conversationId: 'c1', title, kind, cwd: '/tmp', status: 'running', ...(kind === 'worker' ? { workerId: 'kimi' as const } : {}) });
const terminals = [terminal('kimi', 'Kimi Code', 'worker'), terminal('shell', 'Terminal', 'terminal')];
const onCloseTool = vi.fn();
const onLaunch = vi.fn();
const onSplit = vi.fn();
let setUI: (patch: WorkspaceUpdate) => void;
let ui: WorkspacePrefs;

function Harness() {
  const [prefs, setPrefs] = useState<WorkspacePrefs>({ ...defaultWorkspacePrefs(), toolsOpen: true, toolId: 'kimi', focus: 'tools' });
  useEffect(() => { ui = prefs; });
  const onUI = (patch: WorkspaceUpdate) => setPrefs(current => ({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) }));
  setUI = onUI;
  return createElement(Workspace, {
    active: true, conversation, messages: [], ui: prefs, settings: {} as AppSettings, workers: [], terminals, browsers: [],
    sidebarVisible: true, compact: false, onUI, onSettingsChange: vi.fn(), onConversationChange: vi.fn(), onLaunch, onSplit,
    onCloseTool, onBrowserChange: vi.fn(), quote: null, onQuote: vi.fn(), onQuoteConsumed: vi.fn(), reportError: vi.fn(),
  });
}

let host: HTMLDivElement;
let root: Root;
const stub = (id: string) => host.querySelector(`.terminal-stub[data-session-id="${id}"]`)!;
const menuItem = (label: string) => document.querySelector<HTMLButtonElement>(`[role="menuitem"][aria-label="${label}"]`);
async function rightClick(node: Element) {
  await act(async () => { node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 })); });
}
async function click(node: Element) {
  await act(async () => { node.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  panes.mounts = 0;
  panes.shown.clear();
  onCloseTool.mockClear();
  onLaunch.mockClear();
  onSplit.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(createElement(Harness)); });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a CLI as a chat tab', () => {
  it('moves into the chat pane and back, the same terminal throughout', async () => {
    expect(panes.mounts).toBe(2);
    expect(stub('kimi').closest('.tool-host')?.getAttribute('data-tool-host')).toBe('kimi');

    await rightClick(host.querySelector('[data-tool-id="kimi"]')!);
    await click(menuItem('Set as chat tab')!);
    // A chat page beside Chat and Notebook, shown, and gone from Tools.
    const pill = host.querySelector<HTMLButtonElement>('.chat-card [role="tab"][aria-label="Kimi Code"]')!;
    expect(pill.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('[data-tool-id="kimi"]')).toBeNull();
    expect(stub('kimi').closest('.chat-page')?.getAttribute('data-tool-host')).toBe('kimi');
    expect(panes.shown.get('kimi')).toEqual({ visible: true, placement: 'chat' });
    // What brings it back after a restart is kept with it: which CLI.
    expect(ui).toMatchObject({ chatTerminals: [{ id: 'kimi', workerId: 'kimi' }], chatTerminal: 'kimi', toolId: 'shell', focus: 'chat' });
    expect(panes.mounts).toBe(2);

    // Chat is a click away, and the CLI keeps running behind it.
    await click(host.querySelector('.chat-card [role="tab"][aria-label="Chat"]')!);
    expect(ui.chatTerminal).toBeNull();
    expect(panes.shown.get('kimi')?.visible).toBe(false);
    await click(pill);
    expect(panes.shown.get('kimi')?.visible).toBe(true);

    await rightClick(pill.parentElement!);
    await click(menuItem('Move to tools')!);
    expect(host.querySelector('.chat-card [role="tab"][aria-label="Kimi Code"]')).toBeNull();
    expect(stub('kimi').closest('.tool-host')?.getAttribute('data-tool-host')).toBe('kimi');
    expect(panes.shown.get('kimi')).toEqual({ visible: true, placement: 'tools' });
    expect(ui).toMatchObject({ chatTerminals: [], chatTerminal: null, toolId: 'kimi', toolsOpen: true, focus: 'tools' });
    expect(panes.mounts).toBe(2);
  });

  it('is offered for terminals only, and closes from the chat pane like from Tools', async () => {
    await rightClick(host.querySelector('[data-tool-id="shell"]')!);
    expect(menuItem('Set as chat tab')).not.toBeNull();
    await click(menuItem('Set as chat tab')!);
    const pill = host.querySelector('.chat-card [role="tab"][aria-label="Terminal"]')!;
    await rightClick(pill.parentElement!);
    await click(menuItem('Close tab')!);
    expect(onCloseTool).toHaveBeenCalledWith(terminals[1]);
    // Its own X closes it too, and does not send it back to Tools.
    onCloseTool.mockClear();
    await click(pill.parentElement!.querySelector('.chat-page-close')!);
    expect(onCloseTool).toHaveBeenCalledWith(terminals[1]);
    expect(host.querySelector('[data-tool-id="shell"]')).toBeNull();
  });

  // User, 26.11: with more tabs than the strip shows, the rest could not be
  // reached ("o listă verticală under a '...'"). The strip has no scrollbar.
  it('lists every chat tab under "…" while the strip holds more than it shows', async () => {
    await rightClick(host.querySelector('[data-tool-id="kimi"]')!);
    await click(menuItem('Set as chat tab')!);
    const all = () => host.querySelector<HTMLButtonElement>('.chat-card button[aria-label="All chat tabs"]');
    // Everything fits: no button.
    expect(all()).toBeNull();
    const strip = host.querySelector<HTMLElement>('.chat-card [role="tablist"]')!;
    Object.defineProperty(strip, 'scrollWidth', { value: 900, configurable: true });
    Object.defineProperty(strip, 'clientWidth', { value: 300, configurable: true });
    await click(host.querySelector('.chat-card [role="tab"][aria-label="Chat"]')!);
    expect(all()).not.toBeNull();
    await click(all()!);
    const row = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find(item => item.textContent?.includes(label))!;
    // The tab on screen is the checked one; picking another shows it.
    expect(row('Chat').getAttribute('aria-checked')).toBe('true');
    expect(row('Kimi Code').getAttribute('aria-checked')).toBe('false');
    await click(row('Kimi Code'));
    expect(ui.chatTerminal).toBe('kimi');
    expect(panes.shown.get('kimi')).toEqual({ visible: true, placement: 'chat' });
  });

  // The chat's + offers what runs in a chat tab, and opens it there (user, 26.11).
  it('starts a terminal from the chat pane as a chat tab', async () => {
    await click(host.querySelector('.chat-card [aria-label="Add chat tab"]')!);
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map(item => item.textContent?.trim())).toEqual(['Terminal', 'CLI worker…']);
    await click(items[0]);
    expect(onLaunch).toHaveBeenCalledWith('terminal', undefined, 'chat');
  });
});

// A chat is a chat until it needs more (user, 17.11): the Workbook pill is there only while the chat has it on.
describe('the Workbook page of a chat', () => {
  const tabs = () => [...host.querySelectorAll('.chat-page-tab')].map(tab => tab.getAttribute('aria-label'));
  afterEach(() => { conversation = { id: 'c1', title: 'Chat', folder: null } as Conversation; });

  it('is not among the chat’s pages while it is off, and a saved place in it shows the chat', async () => {
    expect(tabs()).not.toContain('Workbook');
    expect(host.querySelector('#c1-notebook')).toBeNull();
    conversation = { ...conversation, notebook: true };
    await act(async () => { root.render(createElement(Harness, { key: 'on' })); });
    expect(tabs()).toEqual(expect.arrayContaining(['Chat', 'Workbook']));
    await click(host.querySelector('.chat-page-tab[aria-label="Workbook"]')!);
    expect(ui.chatTab).toBe('notebook');
    expect(host.querySelector('.tab-pill[data-active="true"] .chat-page-tab')?.getAttribute('aria-label')).toBe('Workbook');
    // Switched off while it was in front: the chat is in front, and the page is gone.
    conversation = { ...conversation, notebook: false };
    await act(async () => { root.render(createElement(Harness, { key: 'on' })); });
    expect(tabs()).not.toContain('Workbook');
    expect(host.querySelector('.tab-pill[data-active="true"] .chat-page-tab')?.getAttribute('aria-label')).toBe('Chat');
  });
});

// Terminals side by side in one tab (user, 26.11): the same terminals, never built again.
describe('a split terminal tab', () => {
  const split = async () => {
    // Alone in its tab, a terminal has its own bar with its split commands, and no X but the tab's.
    expect(host.querySelector('[data-split-pane="kimi"] [aria-label="Close Kimi Code"]')).toBeNull();
    await click(host.querySelector('[data-split-pane="kimi"] [aria-label="Split right"]')!);
    expect(onSplit).toHaveBeenCalledWith('kimi', 'kimi', 'row');
    // What App does with it: the new terminal joins the tab's tree.
    await act(async () => { setUI({ terminalSplits: { kimi: { dir: 'row', ratio: 0.5, a: 'kimi', b: 'shell' } } }); });
  };

  it('shows both terminals in the one tab, each with its own X', async () => {
    await split();
    expect(host.querySelector('[data-tool-id="shell"]')).toBeNull();
    expect(stub('kimi').closest('[data-split-pane]')?.getAttribute('data-split-pane')).toBe('kimi');
    expect(stub('shell').closest('[data-split-pane]')?.getAttribute('data-split-pane')).toBe('shell');
    expect(stub('shell').closest('.tool-host')?.getAttribute('data-tool-host')).toBe('kimi');
    expect(panes.shown.get('kimi')?.visible).toBe(true);
    expect(panes.shown.get('shell')?.visible).toBe(true);
    expect(panes.mounts).toBe(2);

    // A pane's own button splits that pane; the tab's menu splits the one clicked in last.
    await click(host.querySelector('[data-split-pane="shell"] [aria-label="Split down"]')!);
    expect(onSplit).toHaveBeenLastCalledWith('kimi', 'shell', 'column');
    await act(async () => { stub('kimi').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    await rightClick(host.querySelector('[data-tool-id="kimi"]')!);
    await click(menuItem('Split down')!);
    expect(onSplit).toHaveBeenLastCalledWith('kimi', 'kimi', 'column');

    await click(host.querySelector('[data-split-pane="shell"] [aria-label="Close Terminal"]')!);
    expect(onCloseTool).toHaveBeenLastCalledWith(terminals[1]);
    await click(host.querySelector('[data-tool-id="kimi"] .pill-close')!);
    expect(onCloseTool).toHaveBeenLastCalledWith(terminals[0], [terminals[1]]);
  });

  it('goes into the chat pane whole, and comes apart without a new terminal', async () => {
    await split();
    await rightClick(host.querySelector('[data-tool-id="kimi"]')!);
    await click(menuItem('Set as chat tab')!);
    expect(stub('kimi').closest('.chat-page')?.getAttribute('data-tool-host')).toBe('kimi');
    expect(stub('shell').closest('.chat-page')?.getAttribute('data-tool-host')).toBe('kimi');
    expect(panes.shown.get('shell')).toEqual({ visible: true, placement: 'chat' });

    await act(async () => { setUI({ terminalSplits: {} }); });
    expect(stub('kimi').closest('.chat-page')?.getAttribute('data-tool-host')).toBe('kimi');
    expect(stub('shell').closest('.tool-host')?.getAttribute('data-tool-host')).toBe('shell');
    expect(panes.mounts).toBe(2);
  });
});
