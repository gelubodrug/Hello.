// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppSettings, Message } from '../src/shared/types';
import { ContextMeter, contextReading, dollars, tokens } from '../src/renderer/chat/ContextMeter';

const settings = { endpointUrl: 'http://127.0.0.1:1234/v1', model: 'qwen3.6-27b', apiKeySet: false, temperature: 0.7,
  systemPrompt: '', connections: [], contextWindow: 32_000 } as AppSettings;
const reply = (id: string, usage: Message['usage'], model = 'qwen3.6-27b'): Message =>
  ({ id, conversationId: 'c', role: 'assistant', content: id, status: 'complete', createdAt: 1, usage, model });

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = async (messages: Message[], overrides: Partial<AppSettings> = {}) => {
  await act(async () => { root.render(createElement(ContextMeter, { messages, settings: { ...settings, ...overrides } })); });
  return host.querySelector<HTMLElement>('.context-meter');
};

// The meter under the composer (user, 28.09 plan: "Context meter + model per
// răspuns în composer"): how full the window is, from one call — never the
// reply's total, which counts the context again for every tool step.
describe('the context meter', () => {
  it('reads the latest reply’s prompt against the window, with the level from three quarters and nine tenths', () => {
    expect(contextReading([reply('a', { input: 900_000, output: 10, context: 12_000 })], settings)).toMatchObject({ used: 12_000, share: 0.375, level: 'ok' });
    expect(contextReading([reply('a', { input: 1, output: 1, context: 24_000 })], settings)?.level).toBe('warn');
    expect(contextReading([reply('a', { input: 1, output: 1, context: 29_000 })], settings)?.level).toBe('full');
    // Nothing to say without a reported prompt or a window.
    expect(contextReading([reply('a', { input: 5, output: 5 })], settings)).toBeNull();
    expect(contextReading([reply('a', { input: 1, output: 1, context: 1_000 })], { contextWindow: undefined })).toBeNull();
    expect(tokens(13_100)).toBe('13.1k');
    expect(tokens(205_000)).toBe('205k');
    expect(tokens(1_200_000)).toBe('1.2M');
    expect(dollars(0.0042)).toBe('$0.0042');
    expect(dollars(3.4)).toBe('$3.40');
  });

  it('shows the share, what the chat cost, and the model of the latest reply when it is not the one selected', async () => {
    const meter = await render([
      reply('a', { input: 50_000, output: 100, context: 20_000, cost: 0.01 }, 'gpt-oss-20b'),
      reply('b', { input: 60_000, output: 100, context: 24_500, cost: 0.02 }, 'gpt-oss-20b'),
    ]);
    expect(meter?.dataset.level).toBe('warn');
    expect(meter?.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('77');
    expect(meter?.textContent).toBe('77% of 32k · filling up · $0.0300 · last reply: gpt-oss-20b');
    expect(meter?.title).toContain('held 24,500 of 32,000 tokens');
    const same = await render([reply('b', { input: 60_000, output: 100, context: 8_000 })]);
    expect(same?.textContent).toBe('25% of 32k');
    expect(await render([reply('b', { input: 60_000, output: 100 })])).toBeNull();
  });
});
