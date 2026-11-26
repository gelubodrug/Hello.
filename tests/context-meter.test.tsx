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

// The window the model publishes, whole, as Pi's own CLI shows it (user, 26.11:
// "să fie 1:1 cu cli-ul"). Pi summarises when fewer than 16,384 tokens are free:
// at 183,616 here.
const settings = { contextWindow: 200_000, model: 'm' } as AppSettings;
const reply = (context: number): Message => ({ id: 'a1', conversationId: 'c1', role: 'assistant', content: 'Answer', status: 'complete', createdAt: 1, usage: { input: 1, output: 1, context } });
const action = () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Summarise now');

describe('the context meter', () => {
  it('stays a quiet reading while the window has room', () => {
    act(() => root.render(createElement(ContextMeter, { messages: [reply(22_000)], settings, conversationId: 'c1' })));
    expect(host.textContent).toContain('11% of 200k');
    expect(action()).toBeUndefined();
  });

  it('offers Summarise now once it fills, and says what the summary freed', async () => {
    compact.mockResolvedValue({ tokensBefore: 140_000, tokensAfter: 30_000 });
    // Half full is still quiet; past seven tenths of the way to the summary it says so.
    act(() => root.render(createElement(ContextMeter, { messages: [reply(88_000)], settings, conversationId: 'c1' })));
    expect(host.textContent).toContain('44% of 200k');
    expect(action()).toBeUndefined();
    act(() => root.render(createElement(ContextMeter, { messages: [reply(140_000)], settings, conversationId: 'c1' })));
    expect(host.textContent).toContain('70% of 200k · filling up');
    await act(async () => { action()!.click(); });
    expect(compact).toHaveBeenCalledWith('c1');
    expect(host.textContent).toContain('Summarised: 140k → about 30k');
    expect(action()).toBeUndefined();
  });

  it('waits for a running reply, and says when a summary fails', async () => {
    act(() => root.render(createElement(ContextMeter, { messages: [reply(170_000)], settings, conversationId: 'c1', busy: true })));
    expect(action()).toBeUndefined();
    compact.mockRejectedValue(new Error('Pi could not summarise.'));
    act(() => root.render(createElement(ContextMeter, { messages: [reply(170_000)], settings, conversationId: 'c1' })));
    await act(async () => { action()!.click(); });
    expect(host.querySelector('.context-meter-error')?.getAttribute('title')).toBe('Pi could not summarise.');
    // In words on screen and to a screen reader, not only on hover (second review, 05.10).
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Could not summarise: Pi could not summarise.');
    expect(action()).toBeDefined();
  });

  /**
   * The bar read 37% at the moment the conversation summarised itself, because
   * Hello held 45% of the window free (user, 24.11: "nici un prag"); then it was
   * drawn against what was left, and read "100% of 72.1k" on a 131,072 model
   * (26.11). Now the reserve is Pi's own 16,384 and the bar is the window's:
   * the number is the CLI's, and the summary comes near the end of it.
   */
  it('reads against the window the model holds, and warns before Pi summarises', () => {
    const theirs = { contextWindow: 65_536, maxOutputTokens: 32_768, model: 'm' } as AppSettings;
    act(() => root.render(createElement(ContextMeter, { messages: [reply(24_078)], settings: theirs, conversationId: 'c1' })));
    expect(host.textContent).toContain('37% of 65.5k');
    expect(host.textContent).not.toContain('summarises soon');
    expect(host.querySelector('.context-meter')?.getAttribute('title')).toContain('24,078 of the 65,536 tokens the model holds');
    expect(host.querySelector('.context-meter')?.getAttribute('title')).toContain('fewer than 16,384 are free');
    // Pi summarises this window at 49,152: the warning is there just before it.
    act(() => root.render(createElement(ContextMeter, { messages: [reply(48_000)], settings: theirs, conversationId: 'c1' })));
    expect(host.textContent).toContain('73% of 65.5k · summarises soon');
    // A window scaled down by an older Hello is drawn whole again.
    act(() => root.render(createElement(ContextMeter, { messages: [reply(24_078)], settings: { ...theirs, contextScale: 0.5 } as AppSettings, conversationId: 'c1' })));
    expect(host.textContent).toContain('37% of 65.5k');
  });

  it('keeps its button in place while it works, says so aloud, and the bar agrees with what it reads', async () => {
    let finish!: (value: { tokensBefore: number; tokensAfter: number }) => void;
    compact.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    act(() => root.render(createElement(ContextMeter, { messages: [reply(140_000)], settings, conversationId: 'c1' })));
    await act(async () => { action()!.click(); });
    const working = [...host.querySelectorAll('button')].find(button => button.textContent?.startsWith('Summarising'));
    expect(working?.disabled).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Summarising the conversation');
    await act(async () => { finish({ tokensBefore: 140_000, tokensAfter: 30_000 }); });
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Summarised: 140k → about 30k');
    expect(host.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('15');
    expect(host.querySelector<HTMLElement>('.context-meter-fill')?.style.width).toBe('15%');
  });
});
