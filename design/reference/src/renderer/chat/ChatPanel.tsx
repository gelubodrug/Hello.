import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  Maximize2,
  MessageCircle,
  Minimize2,
  Minus,
  PanelRight,
  Pin,
  Share,
  X,
} from 'lucide-react';

import { Tooltip } from '../ui/Tooltip';
import { TruncatedText } from '../ui/TruncatedText';
import { animateSurface } from '../ui/surface-motion';
import {
  chatPanelReducer,
  initialChatPanelState,
  loadChatPresentation,
  saveChatPresentation,
  type ChatPanelAction,
  type ChatPresentation,
} from './chat-panel-state';

import styles from './ChatPanel.module.css';

export interface ChatPanelProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onShare?: () => void;
  /** A renderer-only preview can opt out of the saved app preference. */
  initialPresentation?: ChatPresentation;
  /** Temporary workspace-owned layout. It never changes the user's own layout. */
  workMode?: boolean;
}

/**
 * First module of the Linear-inspired design. Its frame changes, not its
 * children: streaming, drafts and live content keep the same React identity.
 * The host owns the allotted region; this card never overlays a native web
 * view or takes an overlay lock. Native floating is a separate shell change.
 */
export function ChatPanel({
  title,
  children,
  onClose,
  onShare,
  initialPresentation,
  workMode = false,
}: ChatPanelProps): JSX.Element {
  const [state, setState] = useState(() =>
    initialChatPanelState(initialPresentation ?? loadChatPresentation()),
  );
  const [motion, setMotion] = useState<'enter' | 'idle' | 'exit'>(workMode ? 'idle' : 'enter');
  const [layoutRevision, setLayoutRevision] = useState(0);
  const panelRef = useRef<HTMLElement>(null);
  const desiredState = useRef(state);
  const displayedState = useRef(state);
  const requestSequence = useRef(0);
  const cancelMotion = useRef<() => void>(() => undefined);
  const closeAction = useRef(onClose);
  const workModeRef = useRef(workMode);
  const previousWorkMode = useRef(workMode);
  displayedState.current = state;
  closeAction.current = onClose;
  workModeRef.current = workMode;
  const visibleState = workMode
    ? { presentation: 'pinned' as const, minimized: false, expanded: false }
    : state;
  const contentId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const savedScroll = useRef<{
    top: number;
    atBottom: boolean;
    conversationId: string | null;
  } | null>(null);

  const transition = (action: ChatPanelAction | 'close'): void => {
    const sequence = ++requestSequence.current;
    if (action !== 'close') {
      // Queue against the latest intent, not a layout that is still fading out.
      desiredState.current = chatPanelReducer(desiredState.current, action);
    }
    setMotion('exit');
    const finish = (): void => {
      if (sequence !== requestSequence.current) return;
      if (action === 'close') {
        closeAction.current();
        return;
      }
      const next = desiredState.current;
      if (!displayedState.current.minimized && next.minimized) {
        const scroller = bodyRef.current?.querySelector<HTMLElement>('[data-chat-scroll]');
        savedScroll.current = scroller
          ? {
              top: scroller.scrollTop,
              atBottom: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 80,
              conversationId: scroller.getAttribute('data-conversation-id'),
            }
          : null;
      }
      // The frame is fully faded here. Commit geometry without animating height
      // or remounting the transcript/composer, then reveal the same DOM again.
      setState(next);
      setLayoutRevision((revision) => revision + 1);
    };
    if (panelRef.current) {
      cancelMotion.current = animateSurface(panelRef.current, 'exit', { onFinish: finish });
    } else {
      finish();
    }
  };

  useLayoutEffect(() => {
    const sequence = requestSequence.current;
    const panel = panelRef.current;
    if (!panel) return;
    if (workModeRef.current) {
      setMotion('idle');
      return () => cancelMotion.current();
    }
    setMotion('enter');
    cancelMotion.current = animateSurface(panel, 'enter', {
      onFinish: () => {
        if (sequence === requestSequence.current) setMotion('idle');
      },
    });
    return () => cancelMotion.current();
  }, [layoutRevision]);

  useLayoutEffect(() => {
    if (previousWorkMode.current === workMode) return;
    previousWorkMode.current = workMode;
    // The parent fades the whole workspace before switching its columns. Do
    // not run a second card animation or commit an earlier local layout intent.
    requestSequence.current += 1;
    cancelMotion.current();
    desiredState.current = displayedState.current;
    setMotion('idle');
  }, [workMode]);

  useLayoutEffect(() => {
    if (visibleState.minimized || savedScroll.current === null) return;
    const saved = savedScroll.current;
    // Let the virtualizer re-measure after display:none before restoring its
    // reading position. A hidden stream may have gained content meanwhile.
    const frame = requestAnimationFrame(() => {
      const scroller = bodyRef.current?.querySelector<HTMLElement>('[data-chat-scroll]');
      if (scroller) {
        const changedChat = scroller.getAttribute('data-conversation-id') !== saved.conversationId;
        scroller.scrollTo({
          top: saved.atBottom || changedChat ? scroller.scrollHeight : saved.top,
          behavior: 'instant',
        });
      }
      savedScroll.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [visibleState.minimized]);

  useEffect(() => {
    if (initialPresentation === undefined) saveChatPresentation(state.presentation);
  }, [initialPresentation, state.presentation]);

  const pinned = visibleState.presentation === 'pinned';
  const pinLabel = pinned ? 'Float chat' : 'Pin chat';
  const sizeLabel = state.expanded ? 'Restore chat size' : 'Expand chat';
  const bodyInactive = visibleState.minimized || motion === 'exit';

  return (
    <div
      className={styles.stage}
      data-chat-design
      data-presentation={visibleState.presentation}
      data-expanded={visibleState.expanded}
      data-minimized={visibleState.minimized}
      data-work-mode={workMode || undefined}
      data-surface-motion={motion}
    >
      <section
        ref={panelRef}
        className={styles.panel}
        data-surface-rim="bottom-right"
        aria-label="Chat panel"
        aria-busy={motion !== 'idle' || undefined}
      >
        <header className={styles.header}>
          <MessageCircle size={16} className={styles.mark} aria-hidden="true" />
          {visibleState.minimized ? (
            <button
              type="button"
              className={styles.restore}
              aria-label={`Restore chat: ${title}`}
              aria-controls={contentId}
              aria-expanded={false}
              onClick={() => transition('restore')}
            >
              <TruncatedText>{title}</TruncatedText>
            </button>
          ) : (
            <TruncatedText className={styles.title}>{title}</TruncatedText>
          )}
          <div className={styles.actions}>
            {!workMode ? (
              <button
                type="button"
                className={styles.mode}
                aria-label={pinLabel}
                aria-pressed={pinned}
                onClick={() => transition('toggle-pin')}
              >
                {pinned ? (
                  <Pin size={14} aria-hidden="true" />
                ) : (
                  <PanelRight size={14} aria-hidden="true" />
                )}
                <span>{pinned ? 'Pinned' : 'Floating'}</span>
              </button>
            ) : null}
            {onShare && !visibleState.minimized ? (
              <Tooltip label="Share chat">
                <button
                  type="button"
                  className={styles.control}
                  aria-label="Share chat"
                  onClick={onShare}
                >
                  <Share size={16} aria-hidden="true" />
                </button>
              </Tooltip>
            ) : null}
            {!workMode ? (
              <Tooltip label={state.minimized ? 'Restore chat' : 'Minimize chat'}>
                <button
                  type="button"
                  className={styles.control}
                  aria-label={state.minimized ? 'Restore chat' : 'Minimize chat'}
                  aria-controls={contentId}
                  aria-expanded={!state.minimized}
                  onClick={() => transition('toggle-minimize')}
                >
                  <Minus size={16} aria-hidden="true" />
                </button>
              </Tooltip>
            ) : null}
            {!workMode && !pinned ? (
              <Tooltip label={sizeLabel}>
                <button
                  type="button"
                  className={styles.control}
                  aria-label={sizeLabel}
                  aria-pressed={state.expanded}
                  onClick={() => transition('toggle-expand')}
                >
                  {state.expanded ? (
                    <Minimize2 size={16} aria-hidden="true" />
                  ) : (
                    <Maximize2 size={16} aria-hidden="true" />
                  )}
                </button>
              </Tooltip>
            ) : null}
            <Tooltip label="Close chat">
              <button
                type="button"
                className={styles.control}
                aria-label="Close chat"
                onClick={() => transition('close')}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </Tooltip>
          </div>
        </header>
        <div
          ref={bodyRef}
          id={contentId}
          className={styles.body}
          hidden={visibleState.minimized}
          aria-hidden={bodyInactive || undefined}
          {...(bodyInactive ? { inert: '' } : {})}
        >
          {children}
        </div>
      </section>
    </div>
  );
}
