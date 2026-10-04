// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagePart } from '../src/shared/types';

vi.mock('../src/renderer/api', () => ({ api: { chat: { approve: vi.fn() }, system: { openExternal: vi.fn() } } }));
import { ActivityGroup } from '../src/renderer/chat/WebResearch';
import { ToolPart } from '../src/renderer/chat/ConversationView';
import { workDuration } from '../src/renderer/chat/activity';

// User, 04.10 (the design audit, points 1 and 5): where a piece of work ends
// should read at a glance, and a step that runs long should say for how long.
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

const tool = (status: 'running' | 'complete'): Extract<MessagePart, { type: 'tool' }> =>
  ({ type: 'tool', id: 't1', name: 'run_command', input: '{"command":"pnpm test"}', status });

describe('how long work took', () => {
  it('is said the way people say it', () => {
    expect(workDuration(400)).toBe('0s');
    expect(workDuration(42_000)).toBe('42s');
    expect(workDuration(65_000)).toBe('1m 05s');
    expect(workDuration(3_725_000)).toBe('1h 02m');
  });

  it('closes the activity header once the reply has worked, and counts live while it works', () => {
    act(() => root.render(createElement(ActivityGroup, { parts: [tool('complete')], streaming: false, workedMs: 42_000, children: null })));
    expect(host.querySelector('.activity-counts')?.textContent).toContain('42s');
    vi.useFakeTimers();
    const start = Date.now();
    act(() => root.render(createElement(ActivityGroup, { parts: [tool('running')], streaming: true, startedAt: start - 5_000, children: null })));
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(host.querySelector('.activity-counts')?.textContent).toContain('7s');
  });

  it('shows on a step that keeps running', () => {
    vi.useFakeTimers();
    act(() => root.render(createElement(ToolPart, { part: tool('running') })));
    expect(host.querySelector('.tool-status')?.textContent).toBe('Running');
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(host.querySelector('.tool-status')?.textContent).toBe('Running 3s');
  });
});
