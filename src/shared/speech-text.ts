/**
 * What of a reply is spoken: one line that says whether it did what was asked
 * (user, 09.10) — never the whole reply. The answer is on the screen to be
 * read; the voice is there to say "here is the page you asked for" and stop.
 * The prose it is drawn from leaves out code, tables, links' addresses and
 * markup: a voice reading `const x = 1` or a URL letter by letter is noise.
 */

/** A spoken chunk is a sentence or a few short ones; a long sentence is cut at a pause. */
export const SPEECH_CHUNK_CHARS = 280;
/** A confirmation is one sentence, and a long one is cut at a pause. */
export const CONFIRMATION_CHARS = 180;

/** A fenced code block, closed or still open at the end of the reply. */
const FENCED = /^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm;

export function spokenProse(markdown: string): string {
  return markdown
    .replace(FENCED, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/`([^`\n]{1,40})`/g, '$1')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*([-*_]\s*){3,}$/gm, ' ')
    .replace(/(\*\*|~~|\*)(?=\S)([^\n]*?\S)\1/g, '$2')
    // An underscore inside a name (snake_case) is not emphasis.
    .replace(/(?<!\w)(__|_)(?=\S)([^\n]*?\S)\1(?!\w)/g, '$2')
    .replace(/\n{2,}/g, '.\n')
    .replace(/([.!?…:;])\.\n/g, '$1\n')
    .replace(/\s+/g, ' ')
    .replace(/(\s*\.){2,}/g, '.')
    .replace(/^[\s.]+/, '')
    .trim();
}

/** Words that only introduce what follows, or close politely: they confirm nothing. */
const PLEASANTRY = /^(let me know|just let me know|tell me (if|when|what)|hope (this|that|it)\b|i hope\b|happy to help|feel free|anything else|you'?re welcome|enjoy\b)/i;
/** A line that is not prose: a fence, a table, a list item, a heading, a quote, a rule. */
const NOT_PROSE = /^\s{0,3}(?:```|~~~|\||[-*+]\s|\d+[.)]\s|#{1,6}\s|>|(?:[-*_]\s*){3,}$)/;
/** A line above a paragraph rather than part of it: its heading, a quote, a rule. */
const ORNAMENT = /^\s{0,3}(?:#{1,6}\s|>|(?:[-*_]\s*){3,}$)/;

/**
 * The one line a finished reply says aloud: the first sentence of its closing
 * paragraph — or that paragraph's question, when it ends with one, because a
 * question is what the person has to answer. A paragraph that only introduces
 * a list, or only says goodbye, is passed over for an earlier one, and stands
 * in only when there is nothing else. Empty when the reply has no prose at
 * all: silence is better than reading out a code block.
 */
export function spokenConfirmation(markdown: string, limit = CONFIRMATION_CHARS): string {
  // Code goes first: a blank line inside a fence is not a paragraph break.
  const blocks = markdown.replace(FENCED, '\n\n').split(/\n\s*\n+/);
  let weak = '';
  for (let index = blocks.length - 1; index >= 0; index--) {
    // A paragraph starts under its heading and ends where its list or table begins.
    const lines = blocks[index].split('\n');
    let from = 0;
    while (from < lines.length && ORNAMENT.test(lines[from])) from++;
    const rest = lines.slice(from);
    const listed = rest.findIndex(line => NOT_PROSE.test(line));
    const prose = spokenProse((listed < 0 ? rest : rest.slice(0, listed)).join('\n'));
    const sentences = prose.split(/(?<=[.!?…])\s+/).map(sentence => sentence.trim()).filter(Boolean);
    const last = sentences.at(-1);
    const chosen = last?.endsWith('?') ? last : sentences[0];
    if (!chosen) continue;
    if (chosen.endsWith(':') || PLEASANTRY.test(chosen)) { weak ||= chosen; continue; }
    return speechChunks(chosen, limit)[0] ?? '';
  }
  return weak ? speechChunks(weak, limit)[0] ?? '' : '';
}

/** The prose in chunks of at most `limit` characters, each ending where a speaker would pause. */
export function speechChunks(prose: string, limit = SPEECH_CHUNK_CHARS): string[] {
  const sentences = prose.split(/(?<=[.!?…])\s+/).map(sentence => sentence.trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const sentence of sentences) {
    let rest = sentence;
    while (rest.length > limit) {
      const window = rest.slice(0, limit);
      const pause = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(' — '));
      const cut = pause > limit / 3 ? pause + 1 : window.lastIndexOf(' ') > limit / 3 ? window.lastIndexOf(' ') : limit;
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push(rest);
  }
  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks.length - 1;
    // The first chunk stays short, so the voice starts at once.
    if (last > 0 && chunks[last].length + piece.length + 1 <= limit) chunks[last] += ` ${piece}`;
    else chunks.push(piece);
  }
  return chunks;
}
