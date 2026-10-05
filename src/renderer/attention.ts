import type { Message, PendingRequest, QueuedMessage } from '../shared/types';

/**
 * What in a chat is waiting for the person, most pressing first: an action the
 * model may not take without them, a worker blocked on a question, a reply
 * that failed, a reply that is ready. A chat keeps its most pressing one until
 * the person looks at it.
 */
export type AttentionKind = 'approval' | 'plugin' | 'question' | 'error' | 'done';
const rank: Record<AttentionKind, number> = { approval: 5, plugin: 4, question: 3, error: 2, done: 1 };

export function strongest(a: AttentionKind | undefined, b: AttentionKind | undefined): AttentionKind | undefined {
  if (!a) return b;
  if (!b) return a;
  return rank[b] > rank[a] ? b : a;
}

/** What was seen of a reply the last time it changed. */
export interface Seen { status: Message['status']; approval: boolean }

/**
 * What a reply's change asks of the person, if anything: an approval that has
 * just appeared, or the reply having just finished — well or not. Replies that
 * were already done when they arrived (a chat opened, a list loaded) ask
 * nothing: only a change is news.
 */
export function attentionFor(previous: Seen | undefined, message: Message): { kind: AttentionKind | null; seen: Seen } {
  const approval = message.role === 'assistant' && (message.parts ?? []).some(part => part.type === 'tool' && part.status === 'approval');
  const seen: Seen = { status: message.status, approval };
  if (message.role !== 'assistant') return { kind: null, seen };
  if (approval && !previous?.approval) return { kind: 'approval', seen };
  if (previous?.status === 'streaming' && message.status !== 'streaming')
    return { kind: message.status === 'error' ? 'error' : 'done', seen };
  return { kind: null, seen };
}

/** Worker questions that were not in the waiting list before. */
export function newWorkerQuestions(before: readonly QueuedMessage[], after: readonly QueuedMessage[]): QueuedMessage[] {
  const known = new Set(before.map(item => item.id));
  return after.filter(item => !known.has(item.id) && item.text.startsWith('[Worker question]'));
}

/** The words of the notification macOS shows for it. */
export function notice(kind: AttentionKind, message: Pick<Message, 'content' | 'error' | 'parts'> | null, question?: string): string {
  const firstLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 140);
  if (kind === 'approval') {
    const tool = (message?.parts ?? []).find(part => part.type === 'tool' && part.status === 'approval');
    return `Needs your approval${tool && tool.type === 'tool' ? `: ${tool.name.replace(/_/g, ' ')}` : ''}.`;
  }
  if (kind === 'question') return firstLine(question?.replace(/^\[Worker question\]\s*/, '') ?? 'A worker is waiting for an answer.');
  if (kind === 'error') return `The reply failed${message?.error ? `: ${firstLine(message.error)}` : '.'}`;
  return firstLine(message?.content ?? '') || 'The reply is ready.';
}

/**
 * An open request (audit A1) is not news that looking at a chat answers: it
 * stays until it is answered, runs out or its reply ends. Its dot is a tool's
 * approval, or a plugin's question.
 */
export const requestKind = (request: Pick<PendingRequest, 'kind'>): AttentionKind =>
  request.kind === 'approval' ? 'approval' : 'plugin';
/** The words of the one notification an open request gets. */
export function requestNotice(request: Pick<PendingRequest, 'kind' | 'label'>): string {
  const words = request.label.replace(/\s+/g, ' ').trim().slice(0, 140);
  return request.kind === 'approval' ? `Needs your approval: ${words.replace(/_/g, ' ')}.` : `A plugin asks: ${words}`;
}

export const attentionLabel: Record<AttentionKind, string> = {
  approval: 'Needs your approval',
  plugin: 'A plugin is asking',
  question: 'A worker is asking',
  error: 'The reply failed',
  done: 'Reply ready',
};
