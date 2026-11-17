import { describe, expect, it } from 'vitest';
import type { MessagePart } from '../src/shared/types';
import { activityLayout, activityRows, activitySummary, liveTail, replySegments, stepDetail, stepLabel, thinkingTitle } from '../src/renderer/chat/activity';

const text = (text: string): MessagePart => ({ type: 'text', text });
const thought = (text: string): MessagePart => ({ type: 'thinking', text });
const search: MessagePart = { type: 'tool', id: 'search', name: 'web_search', input: '{"query":"Bucharest weather"}', status: 'complete',
  output: JSON.stringify({ kind: 'web_search', query: 'Bucharest weather', engine: 'example', results: [], note: '' }) };
const page = (id: string, url: string): MessagePart => ({ type: 'tool', id, name: 'fetch_url', input: JSON.stringify({ url }), status: 'complete',
  output: JSON.stringify({ kind: 'fetch_url', source: { id: 1, url, title: 'Weather', fetchedAt: '2026-09-09T12:00:00Z' },
    status: 200, contentType: 'text/html', text: 'Read excerpt', truncated: false, bytes: 12, note: '' }) });

describe('chat activity layout and truthful labels', () => {
  it('merges a run of the same work into one row, named the way a person would say it', () => {
    const skill = (id: string, name: string): MessagePart =>
      ({ type: 'tool', id, name: 'skill_load', input: JSON.stringify({ name }), status: 'complete', output: 'ok' });
    const rows = activityRows([thought('Plan'), skill('a', 'frontend-design'), skill('b', 'hooks'), skill('c', 'ios')]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ count: 3, status: 'complete' });
    expect(stepLabel(rows[1].parts)).toBe('Read 3 skills');
    // One of them is a single step again, and says the skill by name.
    expect(stepLabel([skill('a', 'frontend-design')])).toBe('Read frontend-design skill');
    // The worst state in a run is the run's state.
    const failed = activityRows([skill('a', 'x'), { ...skill('b', 'y'), status: 'error' } as MessagePart]);
    expect(failed[0]).toMatchObject({ count: 2, status: 'error' });
  });

  it('names every tool Hello can call, so none can ship showing its identifier', async () => {
    const source = await import('node:fs/promises').then(fs =>
      fs.readFile(new URL('../src/main/chat/tools.ts', import.meta.url), 'utf8'));
    // The names main declares to the model, read from the one place they live.
    const declared = [...source.matchAll(/^\s*'([a-z][a-z0-9_]*)',$/gm)].map(match => match[1]);
    expect(declared.length).toBeGreaterThan(10);
    for (const name of declared) {
      const part: MessagePart = { type: 'tool', id: name, name, input: '{}', status: 'complete', output: '' };
      const label = stepLabel([part]);
      expect(label, `${name} shows its identifier`).not.toMatch(/^[a-z0-9]+_[a-z0-9_]+$/);
      // A plugin's tool is said by its own name; Hello's own tools each have one of Hello's.
      expect(label, `${name} has no name of its own`).not.toBe(`Used ${name}`);
    }
  });

  it('says a plugin’s tool by its own name, and which groups tools_find loaded', () => {
    const tool = (name: string, input: unknown = {}, status: 'complete' | 'error' | 'running' = 'complete'): MessagePart =>
      ({ type: 'tool', id: `${name}-${status}`, name, input: JSON.stringify(input), status, output: '' });
    expect(stepLabel([tool('subagent')])).toBe('Used subagent');
    expect(stepLabel([tool('todo', {}, 'running')])).toBe('Use todo');
    expect(stepLabel([tool('subagent'), tool('subagent', {}, 'error'), tool('subagent')])).toBe('Used subagent 3 times');
    expect(stepLabel([tool('tools_find', { groups: ['plugin:pi-subagents', 'plugin:juicesharp-rpiv-todo'] })])).toBe('Loaded pi-subagents, juicesharp-rpiv-todo tools');
    expect(stepLabel([tool('tools_find', { groups: ['browser'] }, 'running')])).toBe('Load browser tools');
    expect(stepLabel([tool('tools_find', { need: 'edit files' })])).toBe('Looked for tools');
  });

  it('never shows a tool identifier, whatever the tool is', () => {
    const unknown: MessagePart = { type: 'tool', id: 'u', name: 'mcp_linear_create_issue', input: '{}', status: 'complete', output: '' };
    expect(stepLabel([unknown])).toBe('Used a connected tool');
    // The identifier is still available — as detail, which is what it is.
    expect(stepDetail([unknown])).toBe('mcp_linear_create_issue');
    expect(stepDetail([search])).toBeUndefined();
  });

  it('keeps the work in hand visible, counted in rows and never split', () => {
    const rows = activityRows([thought('Plan'), search, page('a', 'https://example.com/a'), page('b', 'https://example.com/b')]);
    // Two reads in a row are one row; the search before them is another.
    expect(rows).toHaveLength(3);
    expect(liveTail(rows)).toBe(1);
    // A run of one tool is one row however long it is, so the tail cannot split it.
    const many = activityRows(Array.from({ length: 12 }, (_, index) => page(`p${index}`, `https://example.com/${index}`)));
    expect(many).toHaveLength(1);
    expect(liveTail(many)).toBe(0);
    expect(liveTail([])).toBe(0);
  });

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
  it('lays a reply out by one rule: what is said stays where it was said, what is done folds', () => {
    const answer = text('You are right.\n\nHere is why I went on without asking.');
    const parts = [text('I will check.'), thought('Reasoning'), search, answer, page('first', 'https://example.com/one'), text('I found a source.'), page('second', 'https://example.com/two'), text('Final answer.')];
    expect(replySegments(parts)).toEqual([
      // A short remark is as much said as a long answer: neither is ever a step.
      { kind: 'prose', index: 0 },
      { kind: 'activity', start: 1, end: 3, grouped: true, last: false },
      { kind: 'prose', index: 3 },
      // A single step between two things said is its own row, not a list of one.
      { kind: 'activity', start: 4, end: 5, grouped: false, last: false },
      { kind: 'prose', index: 5 },
      { kind: 'activity', start: 6, end: 7, grouped: false, last: true },
      { kind: 'prose', index: 7 },
    ]);
    // Steps with nothing said between them are one list, however many.
    expect(replySegments([thought('One'), search, page('first', 'https://example.com/one'), page('second', 'https://example.com/two'), text('Answer')]))
      .toEqual([{ kind: 'activity', start: 0, end: 4, grouped: true, last: true }, { kind: 'prose', index: 4 }]);
    // Words and nothing else are simply said; a single thought gets no wrapper; blank text is nothing.
    expect(replySegments([text('An answer')])).toEqual([{ kind: 'prose', index: 0 }]);
    expect(replySegments([thought('Reasoning'), text('An answer')])).toEqual([{ kind: 'activity', start: 0, end: 1, grouped: false, last: true }, { kind: 'prose', index: 1 }]);
    expect(replySegments([thought('One'), text('  '), search])).toEqual([{ kind: 'activity', start: 0, end: 3, grouped: true, last: true }]);
    // Length never decides: the same words are prose before a step arrives and after.
    for (const said of [text('Ok.'), answer]) {
      expect(replySegments([said])).toEqual([{ kind: 'prose', index: 0 }]);
      expect(replySegments([said, search])[0]).toEqual({ kind: 'prose', index: 0 });
    }
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
