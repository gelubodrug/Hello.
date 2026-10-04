// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageSummary } from '../src/shared/types';

const usage = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/api', () => ({ api: { settings: { usage }, system: { revealPath: vi.fn() } } }));
import { AppAuditSection } from '../src/renderer/settings/AppAuditSection';

// User, 04.10 (the second design audit): total spend, by model and by chat.
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const props = { dataPath: '/data', version: '0.1.0', endpointUrl: 'http://127.0.0.1:8000/v1', extensionsLoaded: 2 };

describe('usage in Settings', () => {
  it('shows what replies cost, by model and by chat', async () => {
    usage.mockResolvedValue({
      replies: 3, input: 13_000, output: 1_900, cost: 0.07,
      models: [{ model: 'anthropic/claude-sonnet-4.5', replies: 2, input: 12_000, output: 1_700, cost: 0.07 }, { model: 'qwen-local', replies: 1, input: 1_000, output: 200, cost: 0 }],
      chats: [{ conversationId: 'c2', title: 'Cloud research', replies: 2, input: 12_000, output: 1_700, cost: 0.07 }],
    } satisfies UsageSummary);
    await act(async () => { root.render(createElement(AppAuditSection, props)); });
    const card = host.querySelector('.audit-card-wide')!;
    expect(card.textContent).toContain('$0.0700 · 13k in · 1.9k out · 3 replies');
    const models = [...card.querySelectorAll('table[aria-label="Usage by model"] tbody tr')].map(row => row.textContent);
    expect(models).toEqual(['anthropic/claude-sonnet-4.5213.7k$0.0700', 'qwen-local11.2k—']);
    expect(card.querySelector('table[aria-label="Usage by chat"]')?.textContent).toContain('Cloud research');
  });

  it('shows nothing until a reply has been counted', async () => {
    usage.mockResolvedValue({ replies: 0, input: 0, output: 0, cost: 0, models: [], chats: [] });
    await act(async () => { root.render(createElement(AppAuditSection, props)); });
    expect(host.querySelector('.audit-card-wide')).toBeNull();
  });
});
