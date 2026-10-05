// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, Message } from '../src/shared/types';

const compact = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/api', () => ({ api: { chat: { compact } } }));
import { ContextMeter } from '../src/renderer/chat/ContextMeter';

// User, 04.10 (both design audits): the meter showed the worry — a filling
// window — and offered nothing to do about it.
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  compact.mockReset();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settings = { contextWindow: 200_000, model: 'm' } as AppSettings;
const reply = (context: number): Message => ({ id: 'a1', conversationId: 'c1', role: 'assistant', content: 'Answer', status: 'complete', createdAt: 1, usage: { input: 1, output: 1, context } });
const action = () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Summarise now');

describe('the context meter', () => {
  it('stays a quiet reading while the window has room', () => {
    act(() => root.render(createElement(ContextMeter, { messages: [reply(40_000)], settings, conversationId: 'c1' })));
    expect(host.textContent).toContain('20% of 200k');
    expect(action()).toBeUndefined();
  });

  it('offers Summarise now once it fills, and says what the summary freed', async () => {
    compact.mockResolvedValue({ tokensBefore: 160_000, tokensAfter: 30_000 });
    act(() => root.render(createElement(ContextMeter, { messages: [reply(160_000)], settings, conversationId: 'c1' })));
    expect(host.textContent).toContain('80% of 200k · filling up');
    await act(async () => { action()!.click(); });
    expect(compact).toHaveBeenCalledWith('c1');
    expect(host.textContent).toContain('Summarised: 160k → about 30k');
    expect(action()).toBeUndefined();
  });

  it('waits for a running reply, and says when a summary fails', async () => {
    act(() => root.render(createElement(ContextMeter, { messages: [reply(185_000)], settings, conversationId: 'c1', busy: true })));
    expect(action()).toBeUndefined();
    compact.mockRejectedValue(new Error('Pi could not summarise.'));
    act(() => root.render(createElement(ContextMeter, { messages: [reply(185_000)], settings, conversationId: 'c1' })));
    await act(async () => { action()!.click(); });
    expect(host.querySelector('.context-meter-error')?.getAttribute('title')).toBe('Pi could not summarise.');
    // In words on screen and to a screen reader, not only on hover (second review, 05.10).
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Could not summarise: Pi could not summarise.');
    expect(action()).toBeDefined();
  });

  it('keeps its button in place while it works, says so aloud, and the bar agrees with what it reads', async () => {
    let finish!: (value: { tokensBefore: number; tokensAfter: number }) => void;
    compact.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    act(() => root.render(createElement(ContextMeter, { messages: [reply(160_000)], settings, conversationId: 'c1' })));
    await act(async () => { action()!.click(); });
    const working = [...host.querySelectorAll('button')].find(button => button.textContent?.startsWith('Summarising'));
    expect(working?.disabled).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Summarising the conversation');
    await act(async () => { finish({ tokensBefore: 160_000, tokensAfter: 30_000 }); });
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Summarised: 160k → about 30k');
    expect(host.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('15');
    expect(host.querySelector<HTMLElement>('.context-meter-fill')?.style.width).toBe('15%');
  });
});
