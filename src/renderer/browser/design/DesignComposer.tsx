import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, Copy, SquareDashedMousePointer } from 'lucide-react';
import type { BrowserTab, ChatAttachment, ChatQuoteExtra } from '../../../shared/types';
import { composeDesignNote } from '../../../shared/page-mode-format';
import { api } from '../../api';
import type { PageModePicked } from '../usePageMode';

interface Props {
  tab: BrowserTab;
  picked: PageModePicked;
  /** The pane's viewport element: the page fills exactly this box. */
  slot: RefObject<HTMLElement>;
  onQuote(text: string, extra?: ChatQuoteExtra): void;
  /** The note is done; the mode stays on for the next element. */
  onRelease(): void;
  /** Escape: leave Design mode. */
  onExit(): void;
}

const GAP = 8;

/**
 * "Describe the change", in Hello's own document, over the element that was
 * picked. The page is a <webview> in this document, so this sits above it by
 * stacking alone — no drawing inside someone else's page. The element's
 * picture is taken the moment it is picked, while the page still looks the
 * way it did, and rides into the chat composer as an attachment.
 */
export function DesignComposer({ tab, picked, slot, onQuote, onRelease, onExit }: Props): JSX.Element | null {
  const { pick } = picked;
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [shotState, setShotState] = useState<'pending' | 'ready' | 'none'>('pending');
  const shot = useRef<Promise<string | null>>(Promise.resolve(null));
  /** Copy lets its status show before releasing; a new pick or closing cancels that. */
  const releaseTimer = useRef<number | undefined>(undefined);
  const [, setLayout] = useState(0);

  // One picture per pick, taken before anyone types a word.
  useEffect(() => {
    let alive = true;
    setShotState('pending');
    const taking = api.browser.mode.capture(tab.id, pick.rect)
      .then(result => result.path)
      .catch(() => null);
    shot.current = taking;
    void taking.then(path => { if (alive) setShotState(path ? 'ready' : 'none'); });
    setText(''); setStatus(''); setError('');
    field.current?.focus();
    return () => {
      alive = false;
      window.clearTimeout(releaseTimer.current);
      releaseTimer.current = undefined;
    };
    // pick.at names the pick; its rect changing as the page scrolls is not a new one.
  }, [tab.id, pick.armId, pick.at]);

  useEffect(() => {
    const again = () => setLayout(value => value + 1);
    const observer = new ResizeObserver(again);
    if (slot.current) observer.observe(slot.current);
    window.addEventListener('resize', again);
    return () => { observer.disconnect(); window.removeEventListener('resize', again); };
  }, [slot]);

  useLayoutEffect(() => {
    const node = box.current;
    const area = slot.current?.getBoundingClientRect();
    if (!node || !area || area.width < 2 || pick.viewport.w <= 0) return;
    // Page CSS pixels to window pixels: the page's viewport fills the slot.
    const scale = area.width / pick.viewport.w;
    const element = { left: area.left + pick.rect.x * scale, top: area.top + pick.rect.y * scale,
      width: pick.rect.w * scale, height: pick.rect.h * scale };
    const width = node.offsetWidth, height = node.offsetHeight;
    const left = Math.max(area.left + GAP, Math.min(element.left, area.right - width - GAP));
    let top = element.top + element.height + GAP;
    if (top + height > area.bottom - GAP) top = element.top - height - GAP;
    top = Math.max(area.top + GAP, Math.min(top, area.bottom - height - GAP));
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
  });

  const note = () => composeDesignNote({ text, ref: pick.ref, selector: pick.selector, tag: pick.tag, url: pick.url });

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const path = await shot.current;
      let attachments: ChatAttachment[] = [];
      if (path) {
        try { attachments = (await api.chat.attach(tab.conversationId, [path])).attachments; }
        catch { /* The words still point at the element without its picture. */ }
      }
      onQuote(note(), { verbatim: true, ...(attachments.length ? { attachments } : {}) });
      onRelease();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The note could not be added.');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const path = await shot.current;
      await api.browser.mode.copy(note(), path ?? undefined);
      setStatus(path ? 'Copied with picture' : 'Copied');
      window.clearTimeout(releaseTimer.current);
      releaseTimer.current = window.setTimeout(onRelease, 700);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The note could not be copied.');
    } finally {
      setBusy(false);
    }
  };

  const host = document.getElementById('root') ?? document.body;
  return createPortal(
    <div ref={box} className="design-composer" role="dialog" aria-label={`Describe a change to this ${pick.tag}`}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onExit(); }
      }}>
      <span className="design-composer-tag" data-shot={shotState}
        title={shotState === 'pending' ? 'Taking a picture of the element…' : shotState === 'ready' ? 'A picture of the element goes with the note' : 'No picture — the note goes without one'}>
        <SquareDashedMousePointer size={14} aria-hidden="true"/>{pick.tag}
      </span>
      <input ref={field} type="text" value={text} placeholder="Describe the change" aria-label="Describe the change"
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
        }}/>
      {status ? <span className="design-composer-status" role="status">{status}</span> : null}
      <button type="button" title="Copy note" aria-label="Copy note" disabled={!text.trim() || busy} onClick={() => void copy()}>
        <Copy size={14}/>
      </button>
      <button type="button" className="design-composer-send" title="Add to chat" aria-label="Add to chat" disabled={!text.trim() || busy} onClick={() => void send()}>
        <ArrowUp size={14}/>
      </button>
      {error ? <span className="design-composer-error" role="alert">{error}</span> : null}
    </div>,
    host,
  );
}
