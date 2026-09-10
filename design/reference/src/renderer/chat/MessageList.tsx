import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, ArrowDown, Cpu, Pencil, RefreshCw } from 'lucide-react';
import { useStore } from 'zustand/react';

import { conversationsStore } from '../state/conversations';
import type { AgentStep, StreamFailure, StreamStatus } from '../state/conversations';
import { endpointsStore } from '../state/endpoints';
import { settingsStore } from '../state/settings';
import EndpointSettings, { type EndpointSettingsFocus } from '../endpoints/EndpointSettings';
import { Button } from '../ui/Button';
import { Reveal } from '../ui/Reveal';
import { RequestDiagnosticDetails } from '../ui/RequestDiagnosticDetails';
import { ConversationGreeting } from './ConversationGreeting';
import { MessageView } from './Message';
import type { Message, RunbookContextStatus } from '../../shared/types';

import styles from './MessageList.module.css';

/**
 * MessageList — the scrolling chat transcript.
 *
 * Per research.md Decision 4, the stable message history is virtualized with
 * `@tanstack/react-virtual`, while the *currently streaming* message is pinned
 * OUTSIDE the virtualized window. A growing streaming item measured inside the
 * virtualizer would invalidate its neighbors' measurements every token, causing
 * the reflow storm the DESIGNUIguide Streaming section forbids. Once the stream
 * ends, the finalized message re-enters the virtualized list with a measured
 * height.
 *
 * Auto-scroll follows the transcript only when the user is already near the
 * bottom; otherwise a floating "Jump to latest" control is exposed (FR-019).
 */

// Distance (px) from the bottom within which we consider the user "pinned" to
// the latest content and keep auto-scrolling.
const NEAR_BOTTOM_THRESHOLD = 80;

// Estimated stable-row height fed to the virtualizer before real measurement.
const ESTIMATED_ROW_HEIGHT = 80;
const EMPTY_MESSAGES: Message[] = [];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MS_PER_DAY = 86_400_000;

/** Local calendar day as a day number, so two instants compare by the reader's
 *  own midnight rather than by UTC. */
function localDayNumber(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY;
}

/** 24-hour clock, zero-padded — "19:02", as the design guide writes it. */
function clockTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Label for the separator above the first message of a day (DESIGNUIguide.md
 * §Chat transcript): "Today 19:02" / "Yesterday 09:14" / "Jan 12 08:30" — the
 * day, named relative to the reader where that reads naturally, plus that
 * first message's own time. Formatted by hand rather than through `Intl` so
 * the wording matches the guide verbatim in every environment.
 */
export function dateSeparatorLabel(timestamp: number, now: number): string {
  const days = localDayNumber(now) - localDayNumber(timestamp);
  const date = new Date(timestamp);
  const day =
    days === 0
      ? 'Today'
      : days === 1
        ? 'Yesterday'
        : `${MONTHS[date.getMonth()]} ${date.getDate()}`;

  return `${day} ${clockTime(timestamp)}`;
}

/**
 * Maps each day's FIRST message id to its separator label. Keyed by id, not by
 * index: the pinned streaming message lives outside the virtualized slice, and
 * edits/regenerations can truncate the array, so an index-keyed lookup would
 * hand a stale label to whichever message landed on that index next.
 */
export function dateSeparatorsByMessageId(
  messages: readonly Message[],
  now: number,
): Map<string, string> {
  const labels = new Map<string, string>();
  let previousDay: number | null = null;

  for (const message of messages) {
    const day = localDayNumber(message.createdAt);
    if (day !== previousDay) {
      labels.set(message.id, dateSeparatorLabel(message.createdAt, now));
      previousDay = day;
    }
  }

  return labels;
}

/** Silence past this many seconds is worth saying out loud. */
const STALL_AFTER_SECONDS = 5;

/** Seconds since `since`, ticking once a second while mounted. */
function useElapsedSeconds(since: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);

  return Math.max(0, Math.floor((now - since) / 1000));
}

/**
 * What the in-flight turn is doing, above the message being written.
 *
 * Send used to be followed by nothing at all until the first token: an empty
 * bubble with a caret, identical whether the model was thinking, a tool was
 * running, or the request had died. The counter is the point — it is what
 * says "still alive" when a slow model takes half a minute to answer.
 */
function StreamStatusLine({ status }: { status: StreamStatus }): JSX.Element | null {
  const elapsed = useElapsedSeconds(status.since);

  // While tokens are arriving the text itself is the status — until they stop
  // arriving. `since` is refreshed by every token, so a counter that keeps
  // climbing here is the endpoint having gone quiet mid-answer.
  const stalled = elapsed >= STALL_AFTER_SECONDS;
  if (status.phase === 'writing' && !stalled) {
    return null;
  }

  const label =
    status.phase === 'writing'
      ? 'No data from the endpoint'
      : status.phase === 'sending'
        ? 'Sending'
        : status.phase === 'working'
          ? 'Working'
          : 'Waiting for the model';

  return (
    <p className={styles.streamStatus} data-stalled={stalled ? 'true' : undefined} role="status">
      <span className={styles.streamStatusDot} aria-hidden="true" />
      {label}
      {status.phase === 'sending' ? '…' : ` · ${elapsed}s`}
    </p>
  );
}

/** The dots spinner every CLI uses, one frame per tick. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;

/**
 * Tail of the message being written. A solid block sat there looking like a
 * rendering artefact; a turning spinner says the same thing — more is coming —
 * in the vocabulary anyone who has used a terminal already reads.
 */
function StreamingCaret(): JSX.Element {
  const reducedMotion = useStore(settingsStore, (state) => state.reducedMotion);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (reducedMotion) return;
    const timer = setInterval(
      () => setFrame((current) => (current + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [reducedMotion]);

  return (
    <span className={styles.streamCaret} aria-hidden="true">
      {SPINNER_FRAMES[reducedMotion ? 0 : frame]}
    </span>
  );
}

/**
 * Centered day heading above the first message of each day (DESIGNUIguide.md
 * §Chat transcript): 12px tertiary text, padding 16px 0 8px, no rule lines,
 * nothing to interact with. It renders inside the day-first message's row so
 * it is measured with that row rather than becoming an unmeasured virtual item.
 */
function DateSeparator({ label }: { label: string | undefined }): JSX.Element | null {
  if (label === undefined) {
    return null;
  }

  return <div className={styles.dateSeparator}>{label}</div>;
}

function MessageRow({
  message,
  isStreaming = false,
  streamTail,
  isLastAssistant = false,
  agentSteps,
  runbookContext,
  previousModelId,
}: {
  message: Message;
  isStreaming?: boolean;
  streamTail?: ReactNode;
  isLastAssistant?: boolean;
  agentSteps?: AgentStep[];
  runbookContext?: RunbookContextStatus;
  previousModelId?: string;
}): JSX.Element {
  return (
    <div className={styles.msg} data-message-id={message.id}>
      <MessageView
        message={message}
        isStreaming={isStreaming}
        streamTail={streamTail}
        isLastAssistant={isLastAssistant}
        agentSteps={agentSteps}
        runbookContext={runbookContext}
        previousModelId={previousModelId}
      />
    </div>
  );
}

function AnimatedMessageRow({
  animateOnMount,
  ...props
}: {
  animateOnMount: boolean;
  message: Message;
  isStreaming?: boolean;
  streamTail?: ReactNode;
  isLastAssistant?: boolean;
  agentSteps?: AgentStep[];
  runbookContext?: RunbookContextStatus;
  previousModelId?: string;
}): JSX.Element {
  // Capture the append decision for this component instance. Streaming token
  // updates must not replace the Reveal midway through its 160ms entrance.
  const [animated] = useState(animateOnMount);

  if (!animated) {
    return <MessageRow {...props} />;
  }

  return (
    <Reveal className={styles.messageAppend} duration="base">
      <MessageRow {...props} />
    </Reveal>
  );
}

/**
 * Inline recovery affordance for a stream that ended in 'error' or 'aborted'
 * (FR-018). Anchored to the assistant message the failure happened on — see
 * `activeFailure` below. It can resend the last user turn, edit the active
 * endpoint's config, or hand model switching back to the composer chip —
 * DESIGNUIguide.md §Errors requires all three, and forbids embedding a second
 * selector here, so "Switch model…" only raises the store flag the chip
 * listens on.
 */
/**
 * What a terminal stream failure says, and where "Edit endpoint" should land
 * (DESIGNUIguide.md §Errors). Pure so the mapping is assertable without a DOM
 * — the rendered banner is only its presentation.
 *
 * A 401/403 is not "the request was wrong" but "these credentials were not
 * accepted", and the fix is a key, so it says so and sends the user straight
 * to the key field (T147). The raw upstream line always stays as the
 * secondary detail underneath.
 */
export function streamFailureCopy(failure: StreamFailure): {
  message: string;
  focusField?: EndpointSettingsFocus;
} {
  const wasStopped =
    failure.kind === 'aborted' ||
    /\b(?:abort(?:ed)?|cancel(?:led)?|interrupted|stopped)\b/i.test(failure.message);

  if (wasStopped) {
    return { message: 'Generation stopped before completion.' };
  }

  if (failure.errorType === 'auth') {
    return {
      message: 'The endpoint rejected the credentials — add or update the API key.',
      focusField: 'apiKey',
    };
  }

  return { message: 'The endpoint rejected the request.' };
}

export function StreamFailureBanner({
  failure,
  onEditEndpoint,
}: {
  failure: StreamFailure;
  /** Opens the endpoint dialog, optionally landing focus on one field. */
  onEditEndpoint: (focusField?: EndpointSettingsFocus) => void;
}): JSX.Element {
  const retryLast = useStore(conversationsStore, (s) => s.retryLast);
  const requestModelPopover = useStore(settingsStore, (s) => s.setModelPopoverRequested);
  const { message: humanMessage, focusField } = streamFailureCopy(failure);

  return (
    <div className={styles.failure} role="alert">
      <div className={styles.failureHeader}>
        <AlertTriangle className={styles.failureIcon} size={16} aria-hidden="true" />
        <div className={styles.failureCopy}>
          <span className={styles.failureMessage}>{humanMessage}</span>
          <span className={styles.failureDetail}>{failure.message}</span>
          {failure.diagnostic ? (
            <RequestDiagnosticDetails
              diagnostic={failure.diagnostic}
              idPrefix={`failure-${failure.messageId}`}
            />
          ) : null}
        </div>
      </div>
      <div className={styles.failureActions}>
        <Button variant="secondary" icon={RefreshCw} onClick={() => void retryLast()}>
          Retry
        </Button>
        <Button variant="secondary" icon={Pencil} onClick={() => onEditEndpoint(focusField)}>
          Edit endpoint
        </Button>
        {/* DESIGNUIguide.md §Errors: the third action opens the composer's
            model chip rather than embedding a second model selector here. */}
        <Button variant="secondary" icon={Cpu} onClick={() => requestModelPopover(true)}>
          Switch model…
        </Button>
      </div>
    </div>
  );
}

export default function MessageList(): JSX.Element {
  const activeConversation = useStore(conversationsStore, (s) => s.activeConversation);
  const streamId = useStore(conversationsStore, (s) => s.streamId);
  const lastStreamFailure = useStore(conversationsStore, (s) => s.lastStreamFailure);
  const agentSteps = useStore(conversationsStore, (s) => s.agentSteps);
  const runbookContext = useStore(conversationsStore, (s) => s.runbookContext);
  const streamStatus = useStore(conversationsStore, (s) => s.streamStatus);

  /** The model of the assistant reply before `index`, for change detection. */
  const previousAssistantModel = (index: number): string | undefined => {
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = messages[i];
      if (candidate.role === 'assistant') {
        return candidate.modelId;
      }
    }
    return undefined;
  };
  const activeEndpointId = useStore(endpointsStore, (s) => s.activeEndpointId);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Ref so autoscroll reads the latest pin state synchronously on each token,
  // without waiting for a scroll-driven state update to land.
  const pinnedToBottomRef = useRef(true);
  const [showJumpChip, setShowJumpChip] = useState(false);
  const [editEndpointOpen, setEditEndpointOpen] = useState(false);
  const [editEndpointFocus, setEditEndpointFocus] = useState<EndpointSettingsFocus | undefined>();

  const messages = activeConversation?.messages ?? EMPTY_MESSAGES;
  const streaming = streamId != null && messages.length > 0;
  const conversationId = activeConversation?.id ?? null;

  const previousMessagesRef = useRef<{
    conversationId: string | null;
    ids: Set<string>;
  } | null>(null);
  const previousMessages = previousMessagesRef.current;
  const appendedMessageIds = new Set<string>();

  if (previousMessages?.conversationId === conversationId) {
    for (const message of messages) {
      if (!previousMessages.ids.has(message.id)) {
        appendedMessageIds.add(message.id);
      }
    }
  }

  useLayoutEffect(() => {
    previousMessagesRef.current = {
      conversationId,
      ids: new Set(messages.map((message) => message.id)),
    };
  }, [conversationId, messages]);

  // The failure only applies while it's still attached to the current last
  // message — once a retry appends a fresh turn (or a different conversation
  // is selected), the ids no longer match and the banner disappears on its own.
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const activeFailure: StreamFailure | null =
    !streaming && lastMessage && lastStreamFailure && lastMessage.id === lastStreamFailure.messageId
      ? lastStreamFailure
      : null;

  // While streaming, pin the trailing assistant message outside the virtualized
  // window; everything before it is the stable, virtualized history.
  const stableMessages = streaming ? messages.slice(0, -1) : messages;
  const pinnedStreamingMessage = streaming ? messages[messages.length - 1] : null;
  const lastAssistantId = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant')?.id;

  // Date separators are derived from the FULL message list, not the virtualized
  // slice, so the pinned streaming message still opens a new day correctly.
  // "Today"/"Yesterday" are resolved against render time; a transcript left
  // open across midnight relabels on its next render, which is the first moment
  // the reader can see it anyway.
  const daySeparators = useMemo(() => dateSeparatorsByMessageId(messages, Date.now()), [messages]);

  const getScrollElement = useCallback(() => scrollRef.current, []);

  // Key the measurement cache by message id, not array index. Edits and
  // regenerations (editUserMessage/regenerateFromMessage) can truncate or
  // shift `stableMessages`, so an index-keyed cache would hand a stale
  // measured height to whatever different message lands on that index next.
  // Id-keyed recycling means a stable message's cached height only ever
  // applies to that message, so growth in the pinned streaming message
  // (rendered outside this virtualizer entirely) can never trigger a
  // neighbor re-measurement.
  const getItemKey = useCallback(
    (index: number) => stableMessages[index]?.id ?? index,
    [stableMessages],
  );

  const virtualizer = useVirtualizer({
    count: stableMessages.length,
    getScrollElement,
    getItemKey,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 6,
  });

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = scrollRef.current;
    if (!el || el.clientHeight === 0) {
      return;
    }
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const syncScrollPin = useCallback(() => {
    const el = scrollRef.current;
    if (!el || el.clientHeight === 0) {
      return;
    }
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_THRESHOLD;
    pinnedToBottomRef.current = atBottom;
    // Expose the chip while scrolled away during an active stream (FR-019 / T099).
    setShowJumpChip(!atBottom && streaming);
  }, [streaming]);

  // Signature of what's rendered: when it changes and the user was pinned to the
  // bottom, follow new tokens down. Includes streaming content length and any
  // inline failure banner so layout growth stays in sync with autoscroll.
  const contentSignature = `${messages.length}:${pinnedStreamingMessage?.content.length ?? 0}:${activeFailure?.messageId ?? ''}`;

  useLayoutEffect(() => {
    if (pinnedToBottomRef.current) {
      scrollToBottom('auto');
    }
  }, [contentSignature, scrollToBottom]);

  // Keep the pin flag accurate when the container resizes or content grows.
  useEffect(() => {
    syncScrollPin();
  }, [syncScrollPin, contentSignature]);

  // New conversation: start pinned at the latest turn.
  useEffect(() => {
    pinnedToBottomRef.current = true;
    setShowJumpChip(false);
    scrollToBottom('auto');
  }, [conversationId, scrollToBottom]);

  const handleJumpToLatest = useCallback(() => {
    pinnedToBottomRef.current = true;
    setShowJumpChip(false);
    scrollToBottom('smooth');
  }, [scrollToBottom]);

  const virtualItems = virtualizer.getVirtualItems();

  // A selected conversation with nothing in it yet is the same empty state as
  // no conversation at all (DESIGNUIguide.md §Empty states) — a blank
  // transcript offers nothing to act on. It renders INSIDE the scroller rather
  // than in place of it: unmounting the scroll container would remount the
  // virtualizer on the first turn, and that row would miss its append reveal
  // (§Motion "Message append") while the virtualizer measured. The failure
  // banner, when one is attached, still wins over the greeting.
  const showGreeting =
    stableMessages.length === 0 && pinnedStreamingMessage === null && activeFailure === null;

  return (
    <section
      aria-label="Messages"
      data-chat-scroll
      data-conversation-id={conversationId}
      className={styles.scroller}
      ref={scrollRef}
      onScroll={syncScrollPin}
    >
      {showGreeting ? (
        <div className={styles.emptyOverlay}>
          <ConversationGreeting />
        </div>
      ) : null}

      <div className={styles.virtualSpacer} style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualItems.map((virtualRow) => {
          const message = stableMessages[virtualRow.index];
          if (!message) {
            return null;
          }
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className={styles.virtualRow}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {/* Part of the day-first message's own row, never a separate
                  virtual item: `measureElement` above measures the separator
                  and the message together, so the virtualizer's offsets stay
                  exact and no row is left unmeasured. */}
              <DateSeparator label={daySeparators.get(message.id)} />
              <AnimatedMessageRow
                message={message}
                animateOnMount={appendedMessageIds.has(message.id)}
                isLastAssistant={message.id === lastAssistantId}
                previousModelId={previousAssistantModel(
                  messages.findIndex((candidate) => candidate.id === message.id),
                )}
                agentSteps={agentSteps[message.id]}
                runbookContext={runbookContext[message.id]}
              />
            </div>
          );
        })}
      </div>

      {pinnedStreamingMessage ? (
        <div className={styles.pinned} data-streaming>
          <DateSeparator label={daySeparators.get(pinnedStreamingMessage.id)} />
          {streamStatus !== null && streamStatus.messageId === pinnedStreamingMessage.id ? (
            <StreamStatusLine status={streamStatus} />
          ) : null}
          <AnimatedMessageRow
            message={pinnedStreamingMessage}
            animateOnMount={appendedMessageIds.has(pinnedStreamingMessage.id)}
            isStreaming
            streamTail={<StreamingCaret />}
            isLastAssistant={pinnedStreamingMessage.id === lastAssistantId}
            previousModelId={previousAssistantModel(messages.length - 1)}
            agentSteps={agentSteps[pinnedStreamingMessage.id]}
            runbookContext={runbookContext[pinnedStreamingMessage.id]}
          />
        </div>
      ) : null}

      {activeFailure ? (
        <div className={styles.failureWrap}>
          <StreamFailureBanner
            failure={activeFailure}
            onEditEndpoint={(focusField) => {
              setEditEndpointFocus(focusField);
              setEditEndpointOpen(true);
            }}
          />
        </div>
      ) : null}

      <EndpointSettings
        open={editEndpointOpen}
        onClose={() => setEditEndpointOpen(false)}
        endpointId={activeEndpointId ?? undefined}
        focusField={editEndpointFocus}
      />

      <Reveal show={showJumpChip} duration="fast" className={styles.jumpChipPresence}>
        <button
          type="button"
          aria-label="Jump to latest"
          className={styles.jumpChip}
          onClick={handleJumpToLatest}
        >
          <ArrowDown size={14} aria-hidden="true" />
          Jump to latest
        </button>
      </Reveal>
    </section>
  );
}
