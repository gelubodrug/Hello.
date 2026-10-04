// A dsh plugin row: `apply(ctx)` with the services it needs in `inject`.
// dsh's tool registry takes a definition from defineTool: model-facing name,
// description and parameters, a mandatory output schema with its render, and
// execute(args, exec), which must honour exec.signal.
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-plugin-word-count'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'word_count',
    description: 'Count the words, characters and lines of a text. Use it when the user asks how long a text is.',
    parameters: {
      text: { type: 'string', required: true, description: 'The text to measure.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          words: { type: 'integer', required: true },
          characters: { type: 'integer', required: true },
          lines: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.words} words, ${value.characters} characters, ${value.lines} lines.` }],
    },
    async execute(args, exec) {
      exec.signal?.throwIfAborted()
      const text = String(args.text)
      return {
        words: text.trim() ? text.trim().split(/\s+/u).length : 0,
        characters: [...text].length,
        lines: text ? text.split(/\r?\n/u).length : 0,
      }
    },
  }))
}
