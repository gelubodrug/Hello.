/**
 * Composer context store (T110): a single pending "page quote" captured from
 * the browser pane's "Send page to chat" action, handed across the layout to
 * the Composer.
 *
 * The BrowserPane and Composer are siblings under App with no shared parent
 * state, so this module-level vanilla store is the seam between them: the pane
 * publishes a captured quote, the composer renders it as an editable quote
 * surface and, on send, prepends {@link formatPageQuote} to the message.
 */

import { createStore } from 'zustand/vanilla';

export interface PageQuote {
  title: string;
  url: string;
  selection: string;
}

export interface ComposerContextState {
  /** The captured page context waiting to be sent, or null when there is none. */
  quote: PageQuote | null;
  /** Publishes a freshly captured quote, replacing any pending one. */
  setQuote: (quote: PageQuote) => void;
  /** Updates the editable selection text of the pending quote. */
  updateSelection: (selection: string) => void;
  /** Drops the pending quote (user removed it, or it was sent). */
  clearQuote: () => void;
}

export const composerContextStore = createStore<ComposerContextState>()((set) => ({
  quote: null,
  setQuote: (quote) => set({ quote }),
  updateSelection: (selection) =>
    set((state) => (state.quote ? { quote: { ...state.quote, selection } } : state)),
  clearQuote: () => set({ quote: null }),
}));

/** Prefixes every non-empty line of `text` with a Markdown blockquote marker. */
function quoteLines(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * Serializes a page quote to a Markdown blockquote: a bold title linked to its
 * URL, then the (trimmed) selection as quoted lines. Rendered as a styled
 * blockquote once the message is sent, so the quoted context reads as context,
 * never as the user's own prose. Returns an empty string for a quote with no
 * title, URL, or selection.
 */
export function formatPageQuote(quote: PageQuote): string {
  const title = quote.title.trim();
  const url = quote.url.trim();
  const selection = quote.selection.trim();

  const header = title !== '' ? title : url;
  const lines: string[] = [];

  if (header !== '') {
    lines.push(url !== '' ? `> **[${header}](${url})**` : `> **${header}**`);
  } else if (url !== '') {
    lines.push(`> ${url}`);
  }

  if (selection !== '') {
    if (lines.length > 0) {
      lines.push('>');
    }
    lines.push(quoteLines(selection));
  }

  return lines.join('\n');
}
