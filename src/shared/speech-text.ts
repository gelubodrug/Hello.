/**
 * What of a reply is read aloud: its prose. Code, tables, links' addresses and
 * markup are for the eye; a voice reading `const x = 1` or a URL letter by
 * letter is noise. Then the prose is cut into sentences, so the first one
 * plays while the next is being made, and a stop has little left to waste.
 */

/** A spoken chunk is a sentence or a few short ones; a long sentence is cut at a pause. */
export const SPEECH_CHUNK_CHARS = 280;

export function spokenProse(markdown: string): string {
  return markdown
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, ' ')
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
