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

const conversation = { id: 'c1', title: 'Chat', folder: null } as Conversation;
const terminal = (id: string, title: string, kind: TerminalSession['kind']): TerminalSession =>
  ({ id, conversationId: 'c1', title, kind, cwd: '/tmp', status: 'running', ...(kind === 'worker' ? { workerId: 'kimi' as const } : {}) });
const terminals = [terminal('kimi', 'Kimi Code', 'worker'), terminal('shell', 'Terminal', 'terminal')];
const onCloseTool = vi.fn();
let ui: WorkspacePrefs;

function Harness() {
  const [prefs, setPrefs] = useState<WorkspacePrefs>({ ...defaultWorkspacePrefs(), toolsOpen: true, toolId: 'kimi', focus: 'tools' });
  useEffect(() => { ui = prefs; });
  const onUI = (patch: WorkspaceUpdate) => setPrefs(current => ({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) }));
  return createElement(Workspace, {
    active: true, conversation, messages: [], ui: prefs, settings: {} as AppSettings, workers: [], terminals, browsers: [],
    sidebarVisible: true, compact: false, onUI, onSettingsChange: vi.fn(), onConversationChange: vi.fn(), onLaunch: vi.fn(),
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
  });
});
