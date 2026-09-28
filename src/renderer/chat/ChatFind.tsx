import { useEffect, useRef, useState, type RefObject } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import type { Message } from '../../shared/types';
import { IconButton } from '../ui/primitives';

/** A search result elsewhere that this chat should open on: the message, and the words. */
export interface FindJump { conversationId: string; messageId: string; query: string; nonce: number }

/**
 * Every place the words occur in the visible text under root, as ranges in
 * page order, case folded. A match split across two elements is not found;
 * text that is hidden (a collapsed disclosure) is not searched.
 */
export function findRanges(root: HTMLElement, query: string): Range[] {
  const wanted = query.trim().toLocaleLowerCase();
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
    const folded = text.toLocaleLowerCase();
    // A letter whose lower case is longer would move every offset after it.
    if (folded.length !== text.length) continue;
    for (let at = folded.indexOf(wanted); at >= 0; at = folded.indexOf(wanted, at + wanted.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + wanted.length);
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
