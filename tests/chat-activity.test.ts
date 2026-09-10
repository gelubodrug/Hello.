import { describe, expect, it } from 'vitest';
import type { MessagePart } from '../src/shared/types';
import { activityLayout, activitySummary, thinkingTitle } from '../src/renderer/chat/activity';

const text = (text: string): MessagePart => ({ type: 'text', text });
const thought = (text: string): MessagePart => ({ type: 'thinking', text });
const search: MessagePart = { type: 'tool', id: 'search', name: 'web_search', input: '{"query":"Bucharest weather"}', status: 'complete',
  output: JSON.stringify({ kind: 'web_search', query: 'Bucharest weather', engine: 'example', results: [], note: '' }) };
const page = (id: string, url: string): MessagePart => ({ type: 'tool', id, name: 'fetch_url', input: JSON.stringify({ url }), status: 'complete',
  output: JSON.stringify({ kind: 'fetch_url', source: { id: 1, url, title: 'Weather', fetchedAt: '2026-09-09T12:00:00Z' },
    status: 200, contentType: 'text/html', text: 'Read excerpt', truncated: false, bytes: 12, note: '' }) });

describe('chat activity layout and truthful labels', () => {
  it('keeps commentary, tools and thinking ordered inside one prefix, with the final answer outside', () => {
    const parts = [text('I will check.'), thought('Reasoning'), search, text('I found a source.'),
      page('first', 'https://example.com/one'), thought('Compare sources'), page('second', 'https://example.com/two'), text('Final answer.')];
    const layout = activityLayout(parts, false);
    expect(layout.grouped).toBe(true);
    expect(layout.activity).toEqual(parts.slice(0, -1));
    expect(layout.answer).toEqual([parts.at(-1)]);
    expect([...layout.activity, ...layout.answer]).toEqual(parts);
    expect(activitySummary(layout.activity)).toMatchObject({ title: 'Research', counts: '1 search · 2 pages read' });
  });
  it('never groups text-only messages or creates an extra wrapper for a single thought', () => {
    expect(activityLayout([text('An answer')], false)).toMatchObject({ activity: [], grouped: false });
    expect(activityLayout([thought('Reasoning'), text('An answer')], false).grouped).toBe(false);
  });
  it('ends earlier thinking when any tool or later meaningful part arrives', () => {
    const preparing: MessagePart = { type: 'tool', id: 'new', name: 'Preparing tool', input: '', status: 'running' };
    expect(activityLayout([thought('One'), preparing], true).activeThinking).toBe(-1);
    expect(activityLayout([thought('One'), thought('Two'), text(' ')], true).activeThinking).toBe(1);
    expect(activityLayout([thought('One'), text('Answer')], true).activeThinking).toBe(-1);
    expect(activityLayout([thought('One')], false).activeThinking).toBe(-1);
  });
  it('counts actual structured results, deduplicates page reads and exposes partial failure/approval', () => {
    const valid = page('one', 'https://example.com/one');
    const failed: MessagePart = { type: 'tool', id: 'failed', name: 'fetch_url', input: '{}', status: 'error', output: 'Denied' };
    const approval: MessagePart = { type: 'tool', id: 'ask', name: 'notebook_update', input: '{}', status: 'approval' };
    expect(activitySummary([search, valid, page('again', 'https://example.com/one'), failed, approval])).toMatchObject({
      counts: '1 search · 1 page read', failed: 1, approvals: 1,
    });
    expect(activitySummary([{ ...failed, status: 'complete' }]).counts).toBe('');
    expect(activitySummary([search]).counts).toBe('1 search'); // Search snippets are not read pages.
  });
  it('shows brief thinking only for a supplied duration below one second', () => {
    expect(thinkingTitle(false, 612)).toBe('Thought briefly');
    expect(thinkingTitle(false, 1000)).toBe('Thought 1s');
    expect(thinkingTitle(false)).toBe('Thought');
    expect(thinkingTitle(false, NaN)).toBe('Thought');
    expect(thinkingTitle(false, -1)).toBe('Thought');
    expect(thinkingTitle(true, 612)).toBe('Thinking');
  });
});
