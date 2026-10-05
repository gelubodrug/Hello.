import { describe, expect, it } from 'vitest';
import type { Message, QueuedMessage } from '../src/shared/types';
import { attentionFor, newWorkerQuestions, notice, requestKind, requestNotice, strongest } from '../src/renderer/attention';

const reply = (status: Message['status'], extra: Partial<Message> = {}): Message =>
  ({ id: 'r1', conversationId: 'c', role: 'assistant', content: 'Saved all four invoices.', status, createdAt: 1, ...extra });
const asking = (status: Message['status']) => reply(status, {
  parts: [{ type: 'tool', id: 't', name: 'command_run', input: '{}', status: 'approval' }],
});

// What a chat is waiting for from the person (user, 28.09 plan: "Attention
// indicator / notification queue"): only a change is news.
describe('what needs the person', () => {
  it('is an approval that just appeared, or a reply that just ended — well or not', () => {
    const started = attentionFor(undefined, reply('streaming'));
    expect(started.kind).toBeNull();
    expect(attentionFor(started.seen, reply('complete')).kind).toBe('done');
    expect(attentionFor(started.seen, reply('error', { error: 'Provider down' })).kind).toBe('error');
    const approval = attentionFor(started.seen, asking('streaming'));
    expect(approval.kind).toBe('approval');
    // Still the same approval: not news again.
    expect(attentionFor(approval.seen, asking('streaming')).kind).toBeNull();
    // A reply that arrived already done (a chat opened, a list loaded) is not news.
    expect(attentionFor(undefined, reply('complete')).kind).toBeNull();
    // The person's own words never are.
    expect(attentionFor({ status: 'streaming', approval: false }, { ...reply('complete'), role: 'user' }).kind).toBeNull();
  });

  it('keeps the most pressing thing a chat waits with', () => {
    expect(strongest('done', 'approval')).toBe('approval');
    expect(strongest('approval', 'done')).toBe('approval');
    expect(strongest('error', 'question')).toBe('question');
    expect(strongest(undefined, 'done')).toBe('done');
  });

  it('finds a worker question new to the waiting list, and says each thing in a line', () => {
    const item = (id: string, text: string): QueuedMessage => ({ id, conversationId: 'c', text, mode: 'next', createdAt: 1 });
    const before = [item('a', '[Worker question] Kimi asks: which folder?')];
    const after = [...before, item('b', 'and then X'), item('c', '[Worker question] Codex asks: may I delete build/?')];
    expect(newWorkerQuestions(before, after).map(entry => entry.id)).toEqual(['c']);
    expect(notice('approval', asking('streaming'))).toBe('Needs your approval: command run.');
    expect(notice('question', null, '[Worker question] Codex asks: may I delete build/?')).toBe('Codex asks: may I delete build/?');
    expect(notice('error', reply('error', { error: 'The provider\nwent away' }))).toBe('The reply failed: The provider went away');
    expect(notice('done', reply('complete'))).toBe('Saved all four invoices.');
    expect(notice('done', reply('complete', { content: '' }))).toBe('The reply is ready.');
  });
});

// Audit A1: an open request is not news that looking at a chat answers.
describe('a request waiting for the person', () => {
  it('ranks a plugin’s question below an approval and above everything else, and says each in a line', () => {
    expect(requestKind({ kind: 'approval' })).toBe('approval');
    expect(requestKind({ kind: 'question' })).toBe('plugin');
    expect(strongest('plugin', 'approval')).toBe('approval');
    expect(strongest('question', 'plugin')).toBe('plugin');
    expect(strongest('done', 'plugin')).toBe('plugin');
    expect(requestNotice({ kind: 'approval', label: 'file_edit' })).toBe('Needs your approval: file edit.');
    expect(requestNotice({ kind: 'question', label: 'Allow   dangerous\ncommand?' })).toBe('A plugin asks: Allow dangerous command?');
  });
});
