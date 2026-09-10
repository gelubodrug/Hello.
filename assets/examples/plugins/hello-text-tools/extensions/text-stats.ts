// Example Pi extension shipped with Hello.
//
// It registers ONE tool that computes statistics over text the model passes in.
// Deliberately pure: no filesystem, no network, no child processes, no access
// to Hello's own tools. It exists to show what a plugin adds and what turning
// the plugin off removes — the tool disappears from the next turn's tool list.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'of', 'to', 'in', 'on',
  'for', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this',
  'that', 'these', 'those', 'as', 'at', 'by', 'from', 'not', 'no',
]);

export default function textStats(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'text_stats',
    label: 'text stats',
    description:
      'Count characters, words, sentences and paragraphs in supplied text, and list its most frequent meaningful terms. Deterministic and local: it reads only the text passed in this call. Use it before summarising a long passage, or to compare two drafts.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to measure.' },
        top: { type: 'integer', minimum: 1, maximum: 25, description: 'How many frequent terms to return. Default 8.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const input = params as { text?: unknown; top?: unknown };
      const text = typeof input.text === 'string' ? input.text : '';
      if (!text.trim()) throw new Error('Pass the text to measure.');
      if (text.length > 400_000) throw new Error('That text is larger than this tool accepts (400,000 characters).');
      const top = Number.isInteger(input.top) ? Math.min(25, Math.max(1, Number(input.top))) : 8;
      const words = text.match(WORD) ?? [];
      const counts = new Map<string, number>();
      for (const word of words) {
        const key = word.toLowerCase();
        if (key.length < 3 || STOP.has(key)) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const frequent = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, top)
        .map(([term, count]) => `${term}: ${count}`);
      const sentences = text.split(/[.!?]+(?:\s|$)/u).filter(part => part.trim()).length;
      const paragraphs = text.split(/\n\s*\n/).filter(part => part.trim()).length;
      const report = [
        `characters: ${text.length}`,
        `words: ${words.length}`,
        `sentences: ${sentences}`,
        `paragraphs: ${paragraphs}`,
        `average word length: ${words.length ? (words.join('').length / words.length).toFixed(1) : '0'}`,
        `frequent terms — ${frequent.join(', ') || 'none above the stop-word threshold'}`,
      ].join('\n');
      return { content: [{ type: 'text', text: report }], details: {} };
    },
  });
}
