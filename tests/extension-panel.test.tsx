// @vitest-environment jsdom
import { createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionUiState } from '../src/shared/types';

const state = vi.hoisted(() => ({ listeners: new Set<(value: ExtensionUiState) => void>() }));
const mocks = vi.hoisted(() => ({ extensionUi: vi.fn(), answerExtension: vi.fn(async () => {}) }));
vi.mock('../src/renderer/api', () => ({
  api: {
    chat: {
      extensionUi: mocks.extensionUi,
      onExtensionUi: (listener: (value: ExtensionUiState) => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
      answerExtension: mocks.answerExtension,
    },
  },
}));

import { useExtensionUi } from '../src/renderer/chat/ExtensionPanel';

let host: HTMLDivElement;
let root: Root;
const texts: string[] = [];
function Panel() {
  const { above, below } = useExtensionUi({ conversationId: 'c1', onEditorText: text => texts.push(text), onError: vi.fn() });
  return createElement(Fragment, null, createElement('div', { id: 'above' }, above), createElement('div', { id: 'below' }, below));
}
const blank = (patch: Partial<ExtensionUiState> = {}): ExtensionUiState => ({ conversationId: 'c1', widgets: [], statuses: [], notices: [], dialogs: [], ...patch });
async function push(value: ExtensionUiState) {
  await act(async () => { for (const listener of state.listeners) listener(value); });
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  texts.length = 0;
  state.listeners.clear();
  mocks.extensionUi.mockResolvedValue(blank({ statuses: [{ key: 'subagents', text: 'fan-out running' }] }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(createElement(Panel)); });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('what a chat’s plugins show beside the composer', () => {
  it('shows their text widgets, statuses and notices, each where the plugin placed it', async () => {
    expect(host.querySelector('.extension-status')?.textContent).toBe('fan-out running');
    await push(blank({
      widgets: [{ key: 'todo', lines: ['Todos (2/7)', '✓ entity'], placement: 'aboveEditor' }, { key: 'foot', lines: ['footer'], placement: 'belowEditor' }],
      notices: [{ id: 'n', message: 'Run finished', kind: 'warning', at: Date.now() }],
    }));
    expect(host.querySelector('#above .extension-widget')?.textContent).toBe('Todos (2/7)\n✓ entity');
    expect(host.querySelector('#below .extension-widget')?.textContent).toBe('footer');
    expect(host.querySelector('.extension-notice')?.getAttribute('data-kind')).toBe('warning');
    // Another chat's state is not this one's.
    await push({ ...blank({ widgets: [{ key: 'x', lines: ['other chat'], placement: 'aboveEditor' }] }), conversationId: 'c2' });
    expect(host.textContent).not.toContain('other chat');
  });

  it('asks a plugin’s question and sends the answer', async () => {
    await push(blank({ dialogs: [
      { id: 'ask-1', method: 'select', title: 'Allow dangerous command?', options: ['Allow', 'Block'] },
      { id: 'ask-2', method: 'input', title: 'Name?' },
    ] }));
    expect(host.textContent).toContain('A plugin asks');
    expect(host.textContent).toContain('1 more waiting');
    const block = [...host.querySelectorAll('button')].find(node => node.textContent === 'Block')!;
    await act(async () => { block.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(mocks.answerExtension).toHaveBeenCalledWith('c1', 'ask-1', { value: 'Block' });
    await push(blank({ dialogs: [{ id: 'ask-2', method: 'input', title: 'Name?' }] }));
    const input = host.querySelector<HTMLInputElement>('.extension-question input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Ada');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(mocks.answerExtension).toHaveBeenLastCalledWith('c1', 'ask-2', { value: 'Ada' });
  });

  it('shows pi-subagents’ run status as a list of runs, never its data for hosts', async () => {
    const snapshot = { kind: 'pi-subagents.async-status-snapshot', runs: [
      { id: '92c5652e-a3f4-48b7-9627-4a092b07ab88', kind: 'single', label: 'delegate', state: 'running', activity: { currentTool: 'bash', toolCount: 3 }, children: [
        { id: 'child-1', label: 'reviewer', state: 'complete', children: [] },
      ] },
    ] };
    await push(blank({ widgets: [
      { key: 'subagent-async', lines: [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(snapshot)}`], placement: 'aboveEditor' },
      // Inspection replies are for hosts, which must not render them.
      { key: 'subagent-inspect', lines: ['PI_SUBAGENT_INSPECT_JSON:{"kind":"inspect"}'], placement: 'aboveEditor' },
    ] }));
    expect(host.textContent).not.toContain('_JSON:');
    expect(host.querySelector('.extension-widget')).toBeNull();
    expect([...host.querySelectorAll('.extension-run')].map(row => row.textContent)).toEqual(['runningdelegateusing bash · 3 tools · 92c5652e', 'donereviewerchild-1']);
    expect(host.querySelector('.extension-run')?.getAttribute('data-state')).toBe('running');
    // No runs left: nothing to show.
    await push(blank({ widgets: [{ key: 'subagent-async', lines: ['PI_SUBAGENT_ASYNC_JSON:{"runs":[]}'], placement: 'aboveEditor' }] }));
    expect(host.querySelector('.extension-runs')).toBeNull();
    expect(host.querySelector('.extension-panel')).toBeNull();
  });

  it('hands text a plugin put in the composer to it once', async () => {
    await push(blank({ editorText: { text: 'suggested prompt', at: 1 } }));
    await push(blank({ editorText: { text: 'suggested prompt', at: 1 } }));
    expect(texts).toEqual(['suggested prompt']);
  });
});
