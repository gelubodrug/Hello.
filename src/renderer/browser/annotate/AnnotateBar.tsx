import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, Brush, Copy } from 'lucide-react';
import type { BrowserTab, ChatAttachment, ChatQuoteExtra } from '../../../shared/types';
import { composeAnnotations, type AnnotationShot } from '../../../shared/page-mode-format';
import { api } from '../../api';

interface Props {
  tab: BrowserTab;
  /** Committed markers in the page right now. */
  marks: number;
  /** The pane's viewport element: the page fills exactly this box. */
  slot: RefObject<HTMLElement>;
  onQuote(text: string, extra?: ChatQuoteExtra): void;
  /** Leave Annotate: the page forgets its markers. */
  onExit(): void;
}

const GAP = 12;

/**
 * Annotate's own controls, in Hello's document over the bottom of the page.
 * The markers and their notes live in the page, so the picture shows them;
 * this bar only counts them and sends. Nothing leaves on a note's Enter —
 * Send takes one picture of the viewport and puts it, with the list of what
 * each marker means, into the chat composer, then ends the mode.
 */
export function AnnotateBar({ tab, marks, slot, onQuote, onExit }: Props): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [, setLayout] = useState(0);

  useEffect(() => {
    const again = () => setLayout(value => value + 1);
    const observer = new ResizeObserver(again);
    if (slot.current) observer.observe(slot.current);
    window.addEventListener('resize', again);
    return () => { observer.disconnect(); window.removeEventListener('resize', again); };
  }, [slot]);

  useEffect(() => { setStatus(''); setError(''); }, [marks]);

  useLayoutEffect(() => {
    const node = box.current;
    const area = slot.current?.getBoundingClientRect();
    if (!node || !area || area.width < 2) return;
    const left = Math.max(area.left + GAP, area.left + (area.width - node.offsetWidth) / 2);
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(Math.max(area.top + GAP, area.bottom - node.offsetHeight - GAP))}px`;
  });

  /** One picture of the viewport, markers in it, and what they mean. */
  const shoot = async (): Promise<{ path: string; shot: AnnotationShot }> => {
    const { path, annotations } = await api.browser.mode.capture(tab.id);
    if (!annotations || annotations.marks.length === 0) throw new Error('Write a note on a marker first.');
    return { path, shot: annotations };
  };

  const send = async () => {
    if (!marks || busy) return;
    setBusy(true); setError(''); setStatus('');
    try {
      const { path, shot } = await shoot();
      let attachments: ChatAttachment[] = [];
      try { attachments = (await api.chat.attach(tab.conversationId, [path])).attachments; }
      catch { /* The list still names every marker without its picture. */ }
      onQuote(composeAnnotations(shot, attachments.length ? null : path), { verbatim: true, ...(attachments.length ? { attachments } : {}) });
      onExit();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The annotations could not be added.');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!marks || busy) return;
    setBusy(true); setError(''); setStatus('');
    try {
      const { path, shot } = await shoot();
      await api.browser.mode.copy(composeAnnotations(shot, path), path);
      setStatus('Copied with picture');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The annotations could not be copied.');
    } finally {
      setBusy(false);
    }
  };

  const label = marks === 0 ? 'Click the page to drop a marker' : `${marks} ${marks === 1 ? 'marker' : 'markers'}`;
  const host = document.getElementById('root') ?? document.body;
  return createPortal(
    <div ref={box} className="annotate-bar" role="toolbar" aria-label="Annotations"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onExit(); }
      }}>
      <span className="annotate-bar-count" aria-live="polite">
        <Brush size={14} aria-hidden="true"/>{status || label}
      </span>
      <button type="button" title="Copy picture and notes" aria-label="Copy picture and notes" disabled={!marks || busy} onClick={() => void copy()}>
        <Copy size={14}/>
      </button>
      <button type="button" className="annotate-bar-send" title="Send picture and notes to chat" aria-label="Send to chat" disabled={!marks || busy} onClick={() => void send()}>
        <ArrowUp size={14}/><span>Send</span>
      </button>
      {error ? <span className="annotate-bar-error" role="alert">{error}</span> : null}
    </div>,
    host,
  );
}
