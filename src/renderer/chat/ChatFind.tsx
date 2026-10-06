import { useEffect, useRef, useState, type RefObject } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import type { Message } from '../../shared/types';
import { IconButton } from '../ui/primitives';

/** A search result elsewhere that this chat should open on: the message, and the words. */
export interface FindJump { conversationId: string; messageId: string; query: string; nonce: number }

const MARK = /\p{M}/u;
/**
 * The text as search compares it — NFC-composed, lower-cased, İ's dot folded
 * away — with every folded unit remembering the original offset it came from,
 * so a match in folded space maps back to a Range over the original text.
 * Folding is done one base-with-marks unit at a time, because that is the span
 * inside which NFC composes and lowercasing grows (İ → i + U+0307): a letter
 * that changes length moves every offset after it, and the map is what keeps
 * them honest where the old code skipped the whole node (06.10).
 */
export function foldForSearch(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  for (let at = 0; at < text.length; ) {
    let next = at + (text.codePointAt(at)! > 0xffff ? 2 : 1);
    while (next < text.length) {
      const following = String.fromCodePoint(text.codePointAt(next)!);
      if (!MARK.test(following)) break;
      next += following.length;
    }
    // İ lowers to i + combining dot; dropping that dot is what lets dotted İ
    // and plain i find each other, while dotless ı stays its own letter.
    const unit = text.slice(at, next).normalize('NFC').toLocaleLowerCase().replace(/i̇/g, 'i');
    for (let i = 0; i < unit.length; i++) map.push(at);
    folded += unit;
    at = next;
  }
  return { folded, map };
}

/**
 * Every place the words occur in the visible text under root, as ranges in
 * page order — case folded and Unicode-normalized, so composed and decomposed
 * spellings (ș as one character or as s + comma) find each other, and offsets
 * always point into the original text. A match split across two elements is
 * not found; text that is hidden (a collapsed disclosure) is not searched.
 */
export function findRanges(root: HTMLElement, query: string): Range[] {
  const wanted = foldForSearch(query.trim()).folded;
  if (!wanted) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      if (parent.closest('[hidden], [aria-hidden="true"], .chat-find, textarea, script, style')) return NodeFilter.FILTER_REJECT;
      const check = (parent as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility;
      if (check && !check.call(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? '';
    const { folded, map } = foldForSearch(text);
    for (let at = folded.indexOf(wanted); at >= 0; at = folded.indexOf(wanted, at + wanted.length)) {
      // Never end inside a folded unit: a match reaching into İ covers all of İ.
      let tail = at + wanted.length;
      while (tail < folded.length && map[tail] === map[tail - 1]) tail++;
      const range = document.createRange();
      range.setStart(node, map[at]);
      range.setEnd(node, tail < folded.length ? map[tail] : text.length);
      ranges.push(range);
    }
  }
  return ranges;
}

type Registry = { set(name: string, value: unknown): void; delete(name: string): void };
/** Paint the matches with the CSS Custom Highlight API: nothing in the page's DOM changes. */
function paint(all: Range[], current: Range | undefined): void {
  const registry = (globalThis as { CSS?: { highlights?: Registry } }).CSS?.highlights;
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry || !Highlight) return;
  if (all.length) registry.set('hello-find', new Highlight(...all)); else registry.delete('hello-find');
  if (current) registry.set('hello-find-current', new Highlight(current)); else registry.delete('hello-find-current');
}
const remembered = (key: string): string => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } };

/**
 * Find in this chat: Cmd+F or Cmd+K (Ctrl on other systems) opens it over the
 * transcript, Enter and Shift+Enter move between matches, Escape closes it.
 * The words are remembered per chat. A search result chosen in the sidebar
 * opens it on the message it found (user, 28.09 plan: "Full-text search în
 * mesaje + jump to source").
 */
export function ChatFind({ root, conversationId, active, messages, jump }: {
  root: RefObject<HTMLElement>;
  conversationId: string;
  active: boolean;
  messages: readonly Message[];
  jump?: FindJump | null;
}): JSX.Element | null {
  const storageKey = `hello.find.${conversationId}`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(() => remembered(storageKey));
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const ranges = useRef<Range[]>([]);
  const field = useRef<HTMLInputElement>(null);
  const pending = useRef<FindJump | null>(null);

  const show = (found: Range[], at: number) => {
    paint(found, found[at]);
    const element = found[at]?.startContainer.parentElement;
    element?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  };
  const move = (step: number) => {
    const found = ranges.current;
    if (!found.length) return;
    const next = (index + step + found.length) % found.length;
    setIndex(next);
    show(found, next);
  };
  const focusField = () => requestAnimationFrame(() => { field.current?.focus(); field.current?.select(); });

  // The shortcut belongs to the chat on screen, and only while its transcript is.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (!['f', 'k'].includes(event.key.toLowerCase())) return;
      if (!root.current || root.current.closest('[hidden]')) return;
      event.preventDefault();
      setOpen(true);
      focusField();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, root]);

  // A result chosen elsewhere: open on its words, then on its message.
  useEffect(() => {
    if (!jump || jump.conversationId !== conversationId) return;
    pending.current = jump;
    setQuery(jump.query);
    setOpen(true);
  }, [jump?.nonce, conversationId]);

  useEffect(() => { try { if (query) localStorage.setItem(storageKey, query); else localStorage.removeItem(storageKey); } catch { /* optional */ } }, [query, storageKey]);

  // The matches, again whenever the words or the transcript change.
  useEffect(() => {
    if (!open || !active) { paint([], undefined); return; }
    const timer = setTimeout(() => {
      const found = root.current ? findRanges(root.current, query) : [];
      ranges.current = found;
      setCount(found.length);
      let at = Math.min(index, Math.max(0, found.length - 1));
      const target = pending.current;
      if (target) {
        pending.current = null;
        const row = root.current?.querySelector(`[data-message-id="${target.messageId.replace(/["\\]/g, '')}"]`);
        const inside = row ? found.findIndex(range => row.contains(range.startContainer)) : -1;
        if (inside >= 0) at = inside;
        else row?.scrollIntoView?.({ block: 'center' });
      }
      setIndex(at);
      show(found, at);
    }, 100);
    return () => clearTimeout(timer);
  }, [open, active, query, messages]);

  useEffect(() => () => paint([], undefined), []);

  if (!open) return null;
  const close = () => { setOpen(false); paint([], undefined); };
  return (
    <div className="chat-find" role="search" aria-label="Find in chat">
      <Search size={14} aria-hidden="true" />
      <input ref={field} aria-label="Find in chat" placeholder="Find in chat" value={query} autoFocus spellCheck={false}
        onChange={event => { setQuery(event.target.value); setIndex(0); }}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); close(); }
          if (event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
        }} />
      <span className="chat-find-count" aria-live="polite">{query.trim() ? count ? `${index + 1} of ${count}` : 'No matches' : ''}</span>
      <IconButton label="Previous match" disabled={!count} onClick={() => move(-1)}><ChevronUp size={14} /></IconButton>
      <IconButton label="Next match" disabled={!count} onClick={() => move(1)}><ChevronDown size={14} /></IconButton>
      <IconButton label="Close find" onClick={close}><X size={14} /></IconButton>
    </div>
  );
}
