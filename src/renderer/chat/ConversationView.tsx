import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  BookmarkPlus,
  Check,
  ChevronDown,
  Copy,
  Folder,
  FileText,
  Image as ImageIcon,
  RotateCcw,
  Square,
  Terminal,
  Bot,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  X,
} from "lucide-react";
import type {
  AppSettings,
  ChatAttachment,
  ChatDropResult,
  ChatQuote,
  ConnectionModels,
  Conversation,
  Message,
  MessagePart,
  QueuedMessage,
  VoiceTranscript,
  WorkerId,
  WorkerInfo,
} from "../../shared/types";
import { api } from "../api";
import { endpointIdentity, modelName, suggestedName } from "../settings/presets";
import { ContextMeter, dollars } from "./ContextMeter";
import { ChatFind, type FindJump } from "./ChatFind";
import { droppedPaths, hasFileDrop } from '../drop';
import {
  Dialog,
  ErrorNote,
  ContextMenu,
  IconButton,
  MenuButton,
  Truncated,
  errorText,
  type MenuItem,
} from "../ui/primitives";
import { CodeBlock, Markdown } from "./Markdown";
import { toolCode } from "./ToolCode";
import { useFileMention } from "./FileMention";
import { fetchedSources, readWebResult, sourcesForMessage, withSourceLinks, type WebSource } from '../../shared/web';
import { MessageSources, ActivityGroup, WebToolOutput, webToolArgument, webToolIcon, webToolTitle } from './WebResearch';
import { activityLayout, activityRows, liveTail, replySegments, runtimeLine, stepLabel, suppliedDuration, thinkingTitle, workDuration, type ActivityRow } from './activity';
import { useElapsed } from './useElapsed';
import { PendingMessages } from './PendingMessages';
import { chatCopySnapshot } from './selection';
import { isChatFolderPath } from '../../shared/chat-folder';
import { EFFORT_LEVELS, effortHint, reasoningReach, type Effort } from '../../shared/reasoning';
import { ChatDisclosure } from './ChatDisclosure';
import { ExtensionsPicker } from './ExtensionsPicker';
import { useSkillCommands } from './SkillCommands';
import { useExtensionUi } from './ExtensionPanel';
import { recordVoice } from './voice-input';
import { Dictation } from './dictation';
import { SpeechPlayer } from './voice-playback';

const IMAGE_NAME = /\.(?:png|jpe?g|gif|webp)$/i;
/** Shorter than this, a press on the microphone is a slip, not a turn. */
const HOLD_MIN_MS = 300;
/** How long Space is held before it is the microphone rather than a space. */
const SPACE_HOLD_MS = 250;
/** The longest message main accepts (ChatService refuses a longer one). */
const MESSAGE_LIMIT = 200_000;
/** A send main refused, kept whole: its words still paired with its attachments. */
type UnsentMessage = { id: string; text: string; attachments: ChatAttachment[] };
/** Chips main can show as a picture: an image snapshot, or a draft chip whose name says it is one. */
function previewableAttachment(item: ChatAttachment): boolean {
  return item.kind === 'image' || IMAGE_NAME.test(item.name);
}

function readableJson(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** "Today 19:02" / "Yesterday 14:30" / "Jan 12 09:00" — per-message day separators. */
function formatDayDate(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const msg = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  if (msg.getTime() === today.getTime()) return `Today ${time}`;
  if (msg.getTime() === yesterday.getTime()) return `Yesterday ${time}`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date) + ` ${time}`;
}

function ToolOutput({ name, output }: { name: string; output: string }) {
  try {
    return (
      <CodeBlock
        code={JSON.stringify(JSON.parse(output), null, 2)}
        language="json"
      />
    );
  } catch {
    /* Non-JSON outputs retain their native form. */
  }
  return /shell|bash|terminal|exec|command|file_read|file_list|read_file|grep|list_files/i.test(
    name,
  ) ? (
    <CodeBlock code={output} />
  ) : (
    <Markdown text={output} />
  );
}

export function ThinkingPart({
  part,
  active,
  expanded,
  onExpandedChange,
}: {
  part: Extract<MessagePart, { type: "thinking" }>;
  active: boolean;
  expanded?: boolean | null;
  onExpandedChange?: (open: boolean) => void;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  // Streaming changes the label, never the height of a reasoning disclosure.
  const open = (expanded === undefined ? override : expanded) ?? false;
  const id = useId();
  const duration = suppliedDuration(part.durationMs);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) { setElapsed(0); return; }
    // Counted from when this part became active, not from any stamp in the
    // message: a reload must not resume someone else's clock.
    const started = Date.now();
    const tick = setInterval(() => setElapsed(Date.now() - started), 1000);
    return () => clearInterval(tick);
  }, [active]);
  if (!part.text.trim()) return null;
  return (
    <div className="thinking-part" data-active={active || undefined}>
      <button
        type="button"
        className="disclosure-button activity-step thinking-toggle"
        aria-expanded={open}
        aria-controls={id}
        title={!active && duration !== null ? `Thinking duration: ${duration / 1000}s (${duration} ms)` : undefined}
        onClick={() => onExpandedChange ? onExpandedChange(!open) : setOverride(!open)}
      >
        <span className="tool-action-title thinking-label">{thinkingTitle(active, part.durationMs, elapsed)}</span>
        <ChevronDown size={14} className="disclosure-chevron" aria-hidden />
      </button>
      <ChatDisclosure id={id} open={open}>
        <div className="thinking-body">
          <Markdown text={part.text} />
        </div>
      </ChatDisclosure>
    </div>
  );
}

/** A chapter's title from a reply: its first heading, else its first line, short. */
export function chapterTitle(text: string): string {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const heading = lines.find(line => /^#{1,6}\s/.test(line));
  const first = (heading ?? lines[0] ?? "").replace(/^#{1,6}\s+/, "").replace(/^[-*>\d.)\s]+/, "").replace(/[*_`]/g, "").trim();
  if (!first) return "From the chat";
  return first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first;
}

/** The message an arrow key, Home or End leads to from this one, within its transcript. */
export function messageInDirection(from: HTMLElement, key: string): HTMLElement | null {
  const list = [...(from.parentElement?.querySelectorAll<HTMLElement>(':scope > article.message') ?? [])];
  const at = list.indexOf(from);
  if (at < 0) return null;
  const to = key === 'ArrowUp' ? at - 1 : key === 'ArrowDown' ? at + 1 : key === 'Home' ? 0 : key === 'End' ? list.length - 1 : -1;
  return to >= 0 && to < list.length && to !== at ? list[to] : null;
}

export function ToolPart({
  part,
}: {
  part: Extract<MessagePart, { type: "tool" }>;
}) {
  const [open, setOpen] = useState(part.status === "approval");
  const [pending, setPending] = useState<"allow" | "decline" | null>(null);
  // A decision main is slow to take says it is under way, past a second.
  const slow = useElapsed(pending !== null) >= 1000;
  const [error, setError] = useState<string | null>(null);
  const WebIcon = webToolIcon(part.name);
  const id = useId();
  const duration = suppliedDuration(part.durationMs);
  // A step that runs long says for how long, so slow reads as slow, not stuck.
  const running = useElapsed(part.status === 'running');
  const status = part.status === 'complete' ? 'Completed' : part.status === 'approval' ? 'Needs approval' : part.status === 'error' ? 'Failed'
    : running >= 2000 ? `Running ${workDuration(running)}` : 'Running';
  const argument = webToolArgument(part);
  useEffect(() => {
    if (part.status === "approval") setOpen(true);
  }, [part.status]);
  const approve = async (allow: boolean) => {
    if (!part.approvalId) return;
    setPending(allow ? "allow" : "decline");
    setError(null);
    try {
      await api.chat.approve(part.approvalId, allow);
    } catch (reason) {
      setError(errorText(reason));
      setPending(null);
    }
  };
  return (
    <div className="tool-part" data-status={part.status}>
      <button
        type="button"
        className="disclosure-button activity-step"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="tool-action-title" title={webToolTitle(part)}>{webToolTitle(part)}</span>
        {argument && <span className="tool-query" title={argument}>{argument}</span>}
        {part.status !== 'complete' && <span className="tool-query tool-status">{status}</span>}
        <ChevronDown size={14} className="disclosure-chevron" aria-hidden />
      </button>
      <ChatDisclosure id={id} open={open}>
        <div className="tool-detail">
          <p className="activity-metadata">{status}{duration !== null ? ` · ${(duration / 1000).toFixed(1)}s (${duration} ms)` : ''}</p>
          <span className="meta-label">Input</span>
          {WebIcon && webToolArgument(part) !== null
            ? <p className="web-tool-argument">{webToolArgument(part)}</p>
            : toolCode(part) ?? <CodeBlock code={readableJson(part.input)} language="json" />}
          {part.output !== undefined && (
            <>
              <span className="meta-label">Output</span>
              {readWebResult(part) ? <WebToolOutput part={part} /> : <ToolOutput name={part.name} output={part.output} />}
            </>
          )}
          {part.status === "approval" && (
            <div className="approval-actions" role="group" aria-label={`${webToolTitle(part)} asks for your approval`}
              data-request-id={part.approvalId} tabIndex={-1}>
              <p>This tool is asking for your approval.</p>
              <button
                type="button"
                className="pill"
                disabled={pending !== null}
                onClick={() => void approve(false)}
              >
                {slow && pending === "decline" && <Loader2 size={12} className="spin" aria-hidden />}
                Decline
              </button>
              <button
                type="button"
                className="pill primary-button"
                disabled={pending !== null}
                onClick={() => void approve(true)}
              >
                {slow && pending === "allow" && <Loader2 size={12} className="spin" aria-hidden />}
                Allow once
              </button>
            </div>
          )}
          <ErrorNote error={error} />
        </div>
      </ChatDisclosure>
    </div>
  );
}

/** A run of the same work, said once. Opening it shows each step in turn, as
 *  rows of the same tier — a heading for rows, never a card around them. */
function MergedStep({ row, render }: {
  row: ActivityRow;
  render: (index: number, step: boolean) => ReactNode;
}) {
  const wants = row.status === 'approval' || row.status === 'error';
  const [open, setOpen] = useState(wants);
  const id = useId();
  useEffect(() => { if (wants) setOpen(true); }, [wants]);
  const state = row.status === 'approval' ? 'Needs approval'
    : row.status === 'error' ? 'Failed' : row.status === 'running' ? 'Running' : '';
  return (
    <div className="tool-part" data-status={row.status}>
      <button
        type="button"
        className="disclosure-button activity-step"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(value => !value)}
      >
        <span className="tool-action-title">{stepLabel(row.parts)}</span>
        {state && <span className="tool-query tool-status">{state}</span>}
        <ChevronDown size={14} className="disclosure-chevron" aria-hidden />
      </button>
      <ChatDisclosure id={id} open={open}>
        <div className="activity-entries merged-steps">
          {row.parts.map((_part, index) => render(row.start + index, true))}
        </div>
      </ChatDisclosure>
    </div>
  );
}

export function MessageContent({ message, sources }: { message: Message; sources: readonly WebSource[] }) {
  // Keep explicit thinking disclosure choices even when the first arriving tool
  // folds preceding reasoning/commentary into the activity group.
  const [thinkingExpanded, setThinkingExpanded] = useState<Record<number, boolean>>({});
  if (message.compactions?.length) {
    const parts = message.parts?.length ? message.parts : message.content ? [{ type: 'text' as const, text: message.content }] : [];
    let from = 0;
    return <>{message.compactions.map((marker, index) => {
      const end = Math.max(from, Math.min(parts.length, marker.partIndex || (message.parts?.length ? 0 : parts.length)));
      const slice = parts.slice(from, end); from = end;
      return <Fragment key={index}>
        {!!slice.length && <MessageContent message={{ ...message, content: '', parts: slice, compactions: undefined, status: 'complete' }} sources={sources} />}
        <CompactionLine marker={marker} />
      </Fragment>;
    })}{from < parts.length && <MessageContent message={{ ...message, content: '', parts: parts.slice(from), compactions: undefined }} sources={sources} />}</>;
  }
  if (!message.parts?.length) return <Markdown text={message.content} sources={sources} />;
  const parts = message.parts;
  const layout = activityLayout(parts, message.status === 'streaming');
  const renderPart = (index: number) => {
    const part = parts[index];
    return (
        part.type === "text" ? (
          <Markdown key={index} text={part.text} sources={sources} />
        ) : part.type === "thinking" ? (
          <ThinkingPart
            key={index}
            part={part}
            active={layout.activeThinking === index && part.durationMs === undefined && message.runtimePhase !== 'compacting' && message.runtimePhase !== 'retrying'}
            expanded={thinkingExpanded[index] ?? null}
            onExpandedChange={open => setThinkingExpanded(current => ({ ...current, [index]: open }))}
          />
        ) : (
          <ToolPart key={part.id} part={part} />
        )
    );
  };
  const streaming = message.status === 'streaming';
  // In the order it was made, by one rule: what the model says stays on the
  // page where it said it; what it does folds, each run of steps under a line.
  return <>{replySegments(parts).map(segment => {
    if (segment.kind === 'prose') return renderPart(segment.index);
    const indexes = Array.from({ length: segment.end - segment.start }, (_item, offset) => segment.start + offset);
    if (!segment.grouped) return indexes.map(index => renderPart(index));
    const rows = activityRows(parts.slice(segment.start, segment.end));
    const renderRow = (row: ActivityRow) =>
      row.count === 1
        ? renderPart(segment.start + row.start)
        : <MergedStep key={row.key} row={{ ...row, start: segment.start + row.start }} render={renderPart} />;
    // The reply's time, and its live tail, belong to the steps still being made: the last list.
    const live = streaming && segment.last;
    return <ActivityGroup
      key={`steps-${segment.start}`}
      parts={parts.slice(segment.start, segment.end)}
      streaming={live}
      {...(segment.last ? { startedAt: message.createdAt, workedMs: message.workedMs } : {})}
      tail={live ? rows.slice(liveTail(rows)).map(renderRow) : undefined}
    >
      {rows.map(renderRow)}
    </ActivityGroup>;
  })}</>;
}

/** The line a restart draws through the transcript: the model reads nothing above it. */
function RestartLine(): JSX.Element {
  return <div className="thread-restart" role="separator" aria-label="Chat restarted">Restarted — the model starts fresh from here</div>;
}
function CompactionLine({ marker }: { marker: NonNullable<Message['compactions']>[number] }): JSX.Element {
  return <div className="thread-restart" role="separator" aria-label="Conversation compacted">
    Context summarised · {marker.tokensBefore.toLocaleString()} → {marker.tokensAfter === undefined ? 'unknown' : `≈${marker.tokensAfter.toLocaleString()}`} tokens
  </div>;
}
function MessageRow({
  message,
  last,
  streaming,
  onRetry,
  onReuse,
  onAttachSelection,
  sources,
}: {
  message: Message;
  last: boolean;
  streaming: boolean;
  onRetry: () => void;
  onReuse: () => void;
  onAttachSelection: (text: string) => void;
  sources: readonly WebSource[];
}) {
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [kept, setKept] = useState<"saving" | "saved" | null>(null);
  const article = useRef<HTMLElement>(null);
  // Copying and keeping are a round trip to main: past a second, the button
  // says it is under way rather than looking dead (second review, 05.10).
  const copyingSlow = useElapsed(copying) >= 1000;
  const keepingSlow = useElapsed(kept === "saving") >= 1000;
  const [context, setContext] = useState<({ position: { x: number; y: number } } & ReturnType<typeof chatCopySnapshot>) | null>(null);
  const copyPayload = async (payload: { text: string; html?: string }) => {
    setCopying(true);
    setCopied(false);
    setCopyError(null);
    try {
      await api.system.copy(payload);
      setCopied(true);
    } catch (reason) {
      setCopyError(errorText(reason));
    } finally {
      setCopying(false);
    }
  };
  const copyMessage = () => copyPayload({ text: withSourceLinks(message.content, sources) });
  /**
   * A reply worth keeping becomes a Runbook chapter, its sources with it (user,
   * 04.10, the second design audit: what a chat found was lost once it scrolled
   * away, and the notebook stayed a storage afterthought).
   */
  const keepInRunbook = async () => {
    setKept("saving");
    setCopyError(null);
    try {
      await api.notebooks.save({ conversationId: message.conversationId, kind: "runbook", title: chapterTitle(message.content), body: withSourceLinks(message.content, sources) });
      setKept("saved");
    } catch (reason) {
      setKept(null);
      setCopyError(errorText(reason));
    }
  };
  useEffect(() => {
    if (kept !== "saved") return;
    const timer = setTimeout(() => setKept(null), 1800);
    return () => clearTimeout(timer);
  }, [kept]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const hasVisibleContent = Boolean(message.content.trim()) || message.parts?.some(part => part.type === 'tool' || Boolean(part.text.trim()));
  const phase = message.runtimePhase;
  const runtimeStatus = runtimeLine(message, Boolean(hasVisibleContent));
  // How long it has been waiting, beside the words: a slow local model reads as
  // slow, not as stuck (user, 04.10). Kept out of the live region's words.
  const waited = useElapsed(runtimeStatus !== null, undefined, runtimeStatus);
  return (
    <article
      ref={article}
      tabIndex={0}
      aria-keyshortcuts="Meta+C Control+C"
      data-message-id={message.id}
      className={`message message-${message.role}`}
      aria-label={
        message.role === "user" ? "Your message" : "Assistant response"
      }
      onKeyDown={event => {
        // Only the message itself, focused: keys typed in a field inside it are that field's.
        if (event.target !== event.currentTarget || event.altKey) return;
        // ⌘C on a message with nothing selected copies the message, as its Copy button does.
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
          if (window.getSelection()?.toString()) return;
          event.preventDefault();
          void copyMessage();
          return;
        }
        if (event.metaKey || event.ctrlKey) return;
        // ↑/↓ move between messages, Home/End to the first and the last (user,
        // 04.10, the design audit: the transcript is read with the keyboard too).
        const next = messageInDirection(event.currentTarget, event.key);
        if (!next) return;
        event.preventDefault();
        next.focus({ preventScroll: true });
        next.scrollIntoView({ block: 'nearest' });
      }}
      onContextMenu={event => {
        if (!event.currentTarget.contains(event.target as Node)) return;
        event.preventDefault();
        event.stopPropagation();
        const snapshot = chatCopySnapshot(event.currentTarget, message, sources);
        const bounds = event.currentTarget.getBoundingClientRect();
        setContext({ ...snapshot, position: { x: event.clientX || bounds.left + 16, y: event.clientY || bounds.top + 16 } });
      }}
    >
      {/* A reply Pi began on its own — a plugin woke it — says so, above it. */}
      {message.role === "assistant" && message.startedBy && (
        <p className="message-started-by" title={message.startedBy}>{message.startedBy}</p>
      )}
      {message.role === "user" ? (
        <>
          <div className="user-bubble">{message.content}</div>
          <div className="message-actions user-message-actions">
            <IconButton
              label={copied ? "Message copied" : "Copy your message"}
              disabled={copying}
              onClick={() => void copyMessage()}
            >
              {copyingSlow ? <Loader2 size={14} className="spin" aria-hidden /> : copied ? <Check size={14} /> : <Copy size={14} />}
            </IconButton>
            <button className="text-button" onClick={onReuse}>
              Use as draft
            </button>
          </div>
        </>
      ) : (
        <>
          <MessageContent message={message} sources={sources} />
          <ErrorNote error={message.error} />
          {/* Announced as before — the wait for a first word, compacting,
              retrying. The phases of a reply already on the page are shown
              only: read aloud, every switch between them would interrupt it,
              and the composer already says a response is being generated. */}
          {runtimeStatus && <span className="waiting-response"><span {...(!hasVisibleContent || phase === 'compacting' || phase === 'retrying' ? { role: 'status', 'aria-live': 'polite' as const } : {})}>{runtimeStatus}</span>{waited >= 2000 && <span className="waiting-elapsed" aria-hidden="true"> {workDuration(waited)}</span>}</span>}
        </>
      )}
      {message.role === "assistant" && message.status !== "streaming" && (
        <div className="message-actions">
          <IconButton
            label={copied ? "Response copied" : "Copy response"}
            disabled={copying}
            onClick={() => void copyMessage()}
          >
            {copyingSlow ? <Loader2 size={15} className="spin" aria-hidden /> : copied ? <Check size={15} /> : <Copy size={15} />}
          </IconButton>
          {message.content.trim() && (
            <IconButton
              label={kept === "saved" ? "Saved to Runbook" : "Save to Runbook"}
              disabled={kept === "saving"}
              onClick={() => void keepInRunbook()}
            >
              {kept === "saved" ? <Check size={15} /> : keepingSlow ? <Loader2 size={15} className="spin" aria-hidden /> : <BookmarkPlus size={15} />}
            </IconButton>
          )}
          {last && (
            <IconButton
              label="Retry response"
              onClick={onRetry}
              disabled={streaming}
            >
              <RotateCcw size={15} />
            </IconButton>
          )}
          <MessageSources sources={sources} />
          {(message.usage || message.model) && (
            <span className="message-usage">
              {message.model && <span className="message-model" title={message.model}>{modelName(message.model)}</span>}
              {message.model && message.usage && " · "}
              {message.usage && <>
                {message.usage.input.toLocaleString()} in ·{" "}
                {message.usage.output.toLocaleString()} out
                {message.usage.cost ? ` · ${dollars(message.usage.cost)}` : ""}
              </>}
            </span>
          )}
        </div>
      )}
      {message.role === 'user' && message.compactions?.map((marker, index) => <CompactionLine key={index} marker={marker} />)}
      <ErrorNote error={copyError} />
      <ContextMenu position={context?.position ?? null} ariaLabel="Chat text actions"
        items={context ? [
          { id: 'copy', label: 'Copy', shortcut: '⌘ C', disabled: !context.selection.text, action: () => void copyPayload(context.selection) },
          { id: 'copy-message', label: 'Copy message', separator: true, action: () => void copyPayload(context.message) },
          { id: 'copy-markdown', label: 'Copy message as Markdown', action: () => void copyPayload(context.markdown) },
          { id: 'attach-selection', label: 'Attach selection as context', separator: true, disabled: !context.selection.text,
            action: () => onAttachSelection(context.selection.text) },
        ] : []}
        onClose={reason => {
          // Back to the message the menu was opened on, with the words selected
          // in it: after Escape, and after an action that left focus in the
          // menu — never over a field the action focused itself.
          if (reason === 'escape' || (reason === 'action' && document.activeElement?.closest('.menu-popup'))) {
            article.current?.focus({ preventScroll: true });
            const range = context?.range;
            if (range?.startContainer.isConnected && range.endContainer.isConnected) {
              const selection = window.getSelection();
              selection?.removeAllRanges(); selection?.addRange(range);
            }
          }
          setContext(null);
        }} />
    </article>
  );
}

export function ConversationView({
  conversation,
  messages,
  settings,
  workers,
  onSettingsChange,
  onFolderChange,
  onTerminal,
  onWorker,
  quote,
  onQuoteConsumed,
  reportError,
  active = true,
  jump = null,
}: {
  conversation: Conversation;
  messages: Message[];
  settings: AppSettings;
  workers: WorkerInfo[];
  onSettingsChange: (settings: AppSettings) => void;
  onFolderChange: (conversation: Conversation) => void;
  onTerminal: () => void;
  onWorker: (id: WorkerId) => void;
  quote: ChatQuote | null;
  onQuoteConsumed: () => void;
  reportError: (error: unknown) => void;
  /** Legacy callers may still pass this; transcript editing is no longer offered or invoked. */
  onEditMessage?: (id: string, text: string) => void;
  /** Whether this chat is the one on screen: its shortcuts are live only then. */
  active?: boolean;
  /** A search result chosen in the sidebar, to open this chat's find on. */
  jump?: FindJump | null;
}) {
  const draftKey = `hello.draft.${conversation.id}`;
  // Where the model's memory begins after a restart: before the first message
  // from then on, or after the last one when nothing has been said since.
  const restartIndex = conversation.freshFrom === undefined ? -1
    : (() => { const at = messages.findIndex(message => message.createdAt >= conversation.freshFrom!); return at < 0 ? messages.length : at; })();
  const [draft, setDraftState] = useState(() => {
    try {
      return localStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  const [sending, setSending] = useState(false);
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const attachmentDraftKey = `${draftKey}.attachments`;
  const [attachments, setAttachmentsState] = useState<ChatAttachment[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(attachmentDraftKey) ?? '[]');
      return Array.isArray(saved) ? saved.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && ['text', 'image'].includes(item.kind)).slice(0, 8) : [];
    } catch { return []; }
  });
  // Whether the composer changed since a send cleared it. Every way content
  // moves — typing, a quote, @name, recall, an import — passes through these
  // wrappers, so a refused send can tell an untouched composer (put the
  // message straight back) from one holding newer work (stash it instead).
  // State and DOM lag the event that changed them; this ref never does.
  const composerDirty = useRef(false);
  // The draft as it is now, for callbacks that run between renders (a voice
  // turn writing the words it hears).
  const draftNow = useRef(draft);
  draftNow.current = draft;
  const setDraft: typeof setDraftState = value => { composerDirty.current = true; setDraftState(value); };
  const setAttachments: typeof setAttachmentsState = value => { composerDirty.current = true; setAttachmentsState(value); };
  // What a refused send was carrying. By the time main says no, the composer
  // may already hold newer words, so the refused message is kept here whole —
  // its text still paired with its attachments — never written over a draft.
  const unsentKey = `${draftKey}.unsent`;
  const [unsent, setUnsent] = useState<UnsentMessage[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(unsentKey) ?? '[]');
      return Array.isArray(saved) ? saved.filter(item => item && typeof item.id === 'string' && typeof item.text === 'string' && Array.isArray(item.attachments)) : [];
    } catch { return []; }
  });
  // Kept after closing so the picture stays in the dialog while it fades out.
  const [preview, setPreview] = useState<{ item: ChatAttachment; src?: string; error?: string } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewRequest = useRef(0);
  const openPreview = (item: ChatAttachment) => {
    if (!previewableAttachment(item)) return;
    const request = ++previewRequest.current;
    setPreview({ item });
    setPreviewOpen(true);
    void api.chat.previewAttachment(conversation.id, item.id).then(
      src => { if (mounted.current && request === previewRequest.current) setPreview({ item, src }); },
      reason => { if (mounted.current && request === previewRequest.current) setPreview({ item, error: errorText(reason) }); },
    );
  };
  const [importing, setImporting] = useState(false);
  const importLock = useRef(false);
  const [dropActive, setDropActive] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ConnectionModels[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [showBottom, setShowBottom] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const transcriptMessages = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const sticky = useRef(true);
  const generation = messages.some((message) => message.status === "streaming");
  const busy = sending || generation;
  // The folder Hello keeps for a chat is not one the person chose: to them, none is set (user, 17.11).
  const chosenFolder = isChatFolderPath(conversation.folder) ? null : conversation.folder;
  const [voicePhase, setVoicePhase] = useState<'idle' | 'listening' | 'working'>('idle');
  const voiceTurn = useRef<AbortController | null>(null);
  /** Ends the recording and keeps what was said, where `voiceTurn` throws it away. */
  const voiceStop = useRef<AbortController | null>(null);
  /** When the microphone was pressed: a tap too short to hold a word is no turn at all. */
  const heldSince = useRef(0);
  // The words heard so far go into the composer as they are written out (user,
  // 09.10), under whatever was typed before the turn: `base` is that, `written`
  // what this turn last put there. Typing while speaking wins — a draft that is
  // no longer what the turn wrote becomes the base the next words are added to.
  const heard = useRef<{ base: string; written: string } | null>(null);
  /** Whether a pass over the words so far is still being written out. */
  const writingOut = useRef(false);
  useEffect(() => {
    if (!active || !settings.voice?.enabled) voiceTurn.current?.abort();
    return () => { voiceTurn.current?.abort(); };
  }, [active, settings.voice?.enabled, conversation.id]);
  useEffect(() => {
    const cancel = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') voiceTurn.current?.abort(); };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, []);
  // What the chat's plugins show: their questions, notices, widgets and statuses.
  const extensionUi = useExtensionUi({
    conversationId: conversation.id, onError: reportError,
    // A plugin's text for the composer never replaces words already written.
    onEditorText: text => setDraft(current => current.trim() ? current : text),
  });
  // ↑ in an empty composer brings back what you sent, newest first; ↑ and ↓
  // walk through it, Esc gives back what was there (S209 F1). Any other change
  // to the words — typing, a quote, "Use as draft" — leaves the walk.
  const recall = useRef<{ stash: string; index: number; shown: string } | null>(null);
  const sent = useMemo(() => {
    const said: string[] = [];
    for (const message of messages)
      if (message.role === "user" && message.content.trim() && said.at(-1) !== message.content) said.push(message.content);
    return said.reverse();
  }, [messages]);
  useEffect(() => { if (recall.current && draft !== recall.current.shown) recall.current = null; }, [draft]);
  const recallTo = (index: number, input: HTMLTextAreaElement) => {
    const walk = recall.current ?? { stash: input.value, index: -1, shown: input.value };
    const text = index < 0 ? walk.stash : sent[index];
    recall.current = index < 0 ? null : { ...walk, index, shown: text };
    setDraft(text);
    requestAnimationFrame(() => input.setSelectionRange(text.length, text.length));
  };
  const recallKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const input = event.currentTarget;
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.nativeEvent.isComposing) return false;
    if (input.selectionStart !== input.selectionEnd) return false;
    const walk = recall.current;
    if (event.key === "ArrowUp" && (walk
      // Within a recalled message, ↑ moves up its lines first.
      ? !input.value.slice(0, input.selectionStart).includes("\n") && walk.index < sent.length - 1
      : !input.value && sent.length > 0)) {
      recallTo((walk?.index ?? -1) + 1, input);
      return true;
    }
    if (event.key === "ArrowDown" && walk && !input.value.slice(input.selectionEnd).includes("\n")) {
      recallTo(walk.index - 1, input);
      return true;
    }
    if (event.key === "Escape" && walk) {
      recallTo(-1, input);
      return true;
    }
    return false;
  };
  const [caret, setCaret] = useState<number | null>(null);
  const commands = useSkillCommands({
    conversationId: conversation.id, draft, setDraft, onError: reportError,
    focus: () => requestAnimationFrame(() => {
      const input = field.current;
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }),
  });
  // @name attaches a file of the chat's folder (audit A3); the / menu keeps the keys while it is open.
  const mention = useFileMention({
    conversationId: conversation.id, folder: conversation.folder, draft, caret, blocked: commands.expanded,
    setDraft: (text, at) => {
      setDraft(text);
      setCaret(at);
      requestAnimationFrame(() => field.current?.setSelectionRange(at, at));
    },
    onAttach: paths => void importPaths(paths),
    onError: reportError,
  });
  // The waiting list is main's, not this component's: it survives a reload, and
  // main decides when a held message is finally said.
  useEffect(() => {
    let alive = true;
    void api.chat.queued?.(conversation.id)
      .then(items => { if (alive) setQueued(items); })
      .catch(() => { if (alive) setQueued([]); });
    return () => { alive = false; };
  }, [conversation.id, busy]);
  // Main also changes it on its own — a steer said, a held message delivered.
  useEffect(() => api.chat.onQueue?.(event => {
    if (event.conversationId === conversation.id) setQueued(event.items);
  }), [conversation.id]);
  const messageContext = useMemo(() => {
    const known = new Map<number, WebSource>();
    return messages.map(message => {
      const sources = message.role === 'assistant' ? sourcesForMessage(message, [...known.values()]) : [];
      for (const source of fetchedSources([message])) known.set(source.id, source);
      return { sources };
    });
  }, [messages]);
  useEffect(() => {
    try {
      localStorage.setItem(draftKey, draft);
    } catch {
      /* Disk quota must not discard the in-memory draft. */
    }
  }, [draftKey, draft]);
  useEffect(() => {
    try { localStorage.setItem(attachmentDraftKey, JSON.stringify(attachments)); }
    catch { /* Keep the live draft if local persistence is unavailable. */ }
  }, [attachmentDraftKey, attachments]);
  useEffect(() => {
    try {
      if (unsent.length) localStorage.setItem(unsentKey, JSON.stringify(unsent));
      else localStorage.removeItem(unsentKey);
    } catch { /* A reload loses it then; the in-memory copy still stands. */ }
  }, [unsentKey, unsent]);
  useEffect(() => {
    if (!quote) return;
    // A page read is quoted; a note written about a page is the person's own words.
    const body = quote.verbatim
      ? quote.text
      : quote.text.split("\n").map((line) => `> ${line}`).join("\n");
    // Words that would make the message longer than main takes are refused
    // with the next step, never cut (audit A3b).
    setDraft((current) => {
      const next = `${current}${current ? "\n\n" : ""}${body}\n\n`;
      if (next.length <= MESSAGE_LIMIT) return next;
      setError(`Adding this would make the message longer than ${MESSAGE_LIMIT.toLocaleString("en-US")} characters. Send or shorten the draft, then add it again.`);
      return current;
    });
    const added = quote.attachments ?? [];
    if (added.length) {
      // Measured against the list as it is now, not as this effect last saw it.
      // The words always land; a page picture with no room is said out loud.
      setAttachments((current) => {
        const fresh = added.filter((item) => !current.some((kept) => kept.id === item.id));
        const room = Math.max(0, 8 - current.length);
        if (fresh.length > room)
          setError("Attach up to 8 files per message. The page picture was not attached — remove an attachment, then capture the page again.");
        return fresh.length ? [...current, ...fresh.slice(0, room)] : current;
      });
    }
    onQuoteConsumed();
    field.current?.focus();
  }, [quote, onQuoteConsumed]);
  useLayoutEffect(() => {
    const node = transcript.current;
    if (node && sticky.current) node.scrollTop = node.scrollHeight;
  }, [messages]);
  useLayoutEffect(() => {
    const content = transcriptMessages.current;
    if (!content) return;
    // A roll-up changes layout across frames, not only on a message update.
    // Follow that height smoothly only when the reader was already at the end.
    const observer = new ResizeObserver(() => {
      const node = transcript.current;
      if (node && sticky.current) node.scrollTop = node.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [messages.length === 0]);
  useLayoutEffect(() => {
    const node = field.current;
    if (node) {
      node.style.height = "auto";
      node.style.height = `${Math.min(node.scrollHeight, 180)}px`;
    }
  }, [draft]);
  // A refused message goes back into the composer only while the composer is
  // still as the send left it. Once newer words or files are in it, the refused
  // one is stashed whole instead: putting it back would write over them, and
  // merging would pair its attachments with words they never belonged to.
  const keepRefused = (text: string, sent: ChatAttachment[]) => {
    if (!composerDirty.current) {
      setDraft(text);
      if (sent.length) setAttachments(current => [...sent, ...current.filter(item => !sent.some(kept => kept.id === item.id))]);
      return;
    }
    setUnsent(current => [...current, { id: crypto.randomUUID(), text, attachments: sent }]);
  };
  const restoreUnsent = (item: UnsentMessage) => {
    const text = draft.trim() ? `${item.text}\n\n${draft}` : item.text;
    if (text.length > MESSAGE_LIMIT) {
      setError(`Adding this would make the message longer than ${MESSAGE_LIMIT.toLocaleString("en-US")} characters. Send or shorten the draft, then restore it again.`);
      return;
    }
    const fresh = item.attachments.filter(file => !attachments.some(kept => kept.id === file.id));
    if (attachments.length + fresh.length > 8) {
      setError("Attach up to 8 files per message. Remove an attachment, then restore this message again.");
      return;
    }
    setUnsent(kept => kept.filter(value => value.id !== item.id));
    setDraft(text);
    if (fresh.length) setAttachments(kept => [...fresh, ...kept.filter(value => !fresh.some(file => file.id === value.id))]);
    field.current?.focus();
  };
  /** Sends the composer. `words` is the draft the state has not caught up with
   *  yet — a voice turn's, written and sent in the same tick. */
  const send = async (words?: string) => {
    const text = (words ?? draft).trim();
    if (importLock.current) return;
    // Typing while the model works is a correction, not a second question: it
    // goes to the turn already running. Nothing is lost if it arrives late —
    // the pill above the composer shows it, and its landing can still change.
    if (busy) {
      if (!text) return;
      setDraft(""); composerDirty.current = false;
      try { setQueued(await api.chat.queue(conversation.id, text, 'steer')); }
      catch (reason) { setError(errorText(reason)); keepRefused(text, []); }
      return;
    }
    if (!text && !attachments.length) return;
    const sentAttachments = attachments;
    setDraft(""); setAttachments([]); composerDirty.current = false;
    setSending(true);
    setError(null);
    sticky.current = true;
    try {
      await api.chat.send(conversation.id, text, sentAttachments.map(item => item.id));
    } catch (reason) {
      setError(errorText(reason));
      keepRefused(text, sentAttachments);
    } finally {
      setSending(false);
    }
  };
  /** The words heard so far in the composer, replacing the ones this turn put
   *  there. Returns the whole draft they now make. */
  const showHeard = (words: string): string => {
    const turn = heard.current;
    if (!turn) return draftNow.current;
    const base = draftNow.current === turn.written ? turn.base : draftNow.current;
    const written = base.trim() ? `${base.replace(/\s+$/, '')} ${words}` : words;
    heard.current = { base, written };
    draftNow.current = written;
    setDraft(written);
    return written;
  };
  /**
   * The microphone let go: what was said is kept and written out. A press too
   * short to hold a word is a slip, and leaves nothing behind.
   */
  const endHold = () => {
    if (!voiceTurn.current) return;
    if (Date.now() - heldSince.current < HOLD_MIN_MS) voiceTurn.current.abort();
    else voiceStop.current?.abort();
  };
  const startVoice = async () => {
    if (voiceTurn.current) return;
    const transcribe = api.voice?.transcribe;
    if (!active || busy || importing || !settings.voice?.enabled || !transcribe) return;
    const turn = new AbortController(); voiceTurn.current = turn;
    const stop = new AbortController(); voiceStop.current = stop;
    heldSince.current = Date.now();
    const release = SpeechPlayer.listen();
    setError(null); setVoicePhase('working');
    heard.current = { base: draftNow.current, written: draftNow.current };
    // The turn's words: what two passes agreed on stays put (see dictation.ts).
    const words = new Dictation();
    // The language this turn is spoken in, once a pass has heard it: a few
    // English names in a Romanian sentence must not turn the rest English.
    let language = settings.voice?.sourceLanguage || undefined;
    const heardIn = (said: VoiceTranscript) => { language ??= said.language; return said.text; };
    // Main writes out one clip at a time: the last live pass ends before the whole turn is asked for.
    let pass: Promise<unknown> = Promise.resolve();
    try {
      const audio = await recordVoice(turn.signal, () => setVoicePhase('listening'), {
        // The button being let go is what ends the turn (user, 09.10).
        until: stop.signal,
        partial: clip => {
          if (writingOut.current || turn.signal.aborted) return;
          writingOut.current = true;
          pass = transcribe(clip(), language)
            .then(said => { if (!turn.signal.aborted) showHeard(words.pass(heardIn(said))); })
            // A pass that fails says nothing: the next one, or the whole turn, has the words.
            .catch(() => {})
            .finally(() => { writingOut.current = false; });
        },
      });
      if (turn.signal.aborted) return;
      if (!audio) { setError('No speech was heard. Try again.'); return; }
      setVoicePhase('working');
      await pass;
      const said = heardIn(await transcribe(audio, language));
      if (turn.signal.aborted) return;
      const text = words.finish(said);
      if (!text) { setError('No speech was heard. Try again.'); return; }
      const whole = showHeard(text);
      // The words wait in the composer unless the person asked for them to go
      // at once (user, 09.10): what was heard is read before it is sent.
      if (settings.voice?.autoSend !== true) { field.current?.focus(); return; }
      release();
      await send(whole);
    } catch (reason) { if (!turn.signal.aborted) setError(errorText(reason)); }
    finally { release(); heard.current = null; writingOut.current = false; voiceTurn.current = null; voiceStop.current = null; if (mounted.current) setVoicePhase('idle'); }
  };
  // Holding Space is holding the microphone (user, 09.10), in the composer or
  // with nothing focused. A typed space is down for a tenth of a second; one
  // held a quarter of a second — or repeated by the system, which only happens
  // to a held key — is a hold: the spaces it typed are taken back and the turn
  // starts, and letting go of Space ends it, sent or waiting as Auto Send says.
  // The decision is quick because every moment of it is speech that is not
  // being recorded. The latest render's view is read through a ref: the
  // listeners outlive it.
  const spaceHold = useRef<{ before: string; timer?: ReturnType<typeof setTimeout>; speaking: boolean } | null>(null);
  const holdKeys = useRef<{ canSpeak: () => boolean; startVoice: () => Promise<void>; endHold: () => void }>({ canSpeak: () => false, startVoice, endHold });
  holdKeys.current = {
    canSpeak: () => voicePhase === 'idle' && !busy && !importing && settings.voice?.enabled === true && !!api.voice?.transcribe,
    startVoice, endHold,
  };
  useEffect(() => {
    if (!active) return;
    const space = (event: globalThis.KeyboardEvent) => event.code === 'Space' || event.key === ' ';
    const begin = () => {
      const hold = spaceHold.current;
      if (!hold || hold.speaking) return;
      clearTimeout(hold.timer);
      hold.speaking = true;
      // The spaces the key typed before it was a hold are not words.
      if (draftNow.current !== hold.before) { draftNow.current = hold.before; setDraft(hold.before); }
      void holdKeys.current.startVoice();
    };
    const down = (event: globalThis.KeyboardEvent) => {
      if (!space(event) || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing) return;
      const where = document.activeElement;
      if (where !== field.current && where !== document.body) return;
      if (!event.repeat) {
        clearTimeout(spaceHold.current?.timer);
        spaceHold.current = holdKeys.current.canSpeak() ? { before: draftNow.current, speaking: false, timer: setTimeout(begin, SPACE_HOLD_MS) } : null;
        return;
      }
      if (!spaceHold.current) return;
      // A repeat is the system saying the key is held; held, it types nothing more.
      event.preventDefault();
      begin();
    };
    const up = (event: globalThis.KeyboardEvent) => {
      if (!space(event)) return;
      const hold = spaceHold.current;
      spaceHold.current = null;
      if (!hold) return;
      clearTimeout(hold.timer);
      if (hold.speaking) { event.preventDefault(); holdKeys.current.endHold(); }
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      clearTimeout(spaceHold.current?.timer);
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, [active]);
  /** Every way in — a drop, a paste, the picker — lands the same: one at a
   *  time, at most 8, a folder becoming the chat's folder (S209 F4). */
  const importWith = async (bring: () => Promise<ChatDropResult | null>) => {
    if (importLock.current) return;
    importLock.current = true;
    setImporting(true);
    setError(null);
    try {
      const imported = await bring();
      if (!imported || !mounted.current) return;
      if (imported.folder) {
        if (busy) throw new Error('Stop the current response before changing its working folder.');
        const updated = await api.conversations.update(conversation.id, { folder: imported.folder });
        if (mounted.current) onFolderChange(updated);
      }
      if (imported.attachments.length) setAttachments(current => [...current, ...imported.attachments]);
      // A PDF or a workbook that went to the chat's folder is not a chip: it is named in the message, so the request says which file it is about.
      const documents = imported.documents ?? [];
      if (documents.length) setDraft(current => {
        const named = documents.filter(name => !current.includes(name));
        return named.length ? `${current}${current && !/\s$/.test(current) ? ' ' : ''}${named.join(' ')} ` : current;
      });
      field.current?.focus({ preventScroll: true });
    } catch (reason) {
      if (mounted.current) setError(errorText(reason));
    } finally {
      importLock.current = false;
      if (mounted.current) setImporting(false);
    }
  };
  const roomFor = (count: number) => {
    if (count + attachments.length > 8) throw new Error('Attach up to 8 files per message. Remove an attachment before adding more.');
  };
  const importDrop = (transfer: DataTransfer) => importWith(async () => {
    const paths = await droppedPaths(transfer);
    roomFor(paths.length);
    return api.chat.attach(conversation.id, paths);
  });
  const importPaths = (paths: string[]) => importWith(async () => {
    roomFor(paths.length);
    return api.chat.attach(conversation.id, paths);
  });
  // A picture without a file — a screenshot — is read by main from the clipboard.
  const pastePicture = () => importWith(async () => {
    roomFor(1);
    return api.chat.attachClipboard!(conversation.id);
  });
  const pickFiles = () => importWith(async () => {
    const paths = await api.system.chooseFiles?.();
    if (!paths?.length) return null;
    roomFor(paths.length);
    return api.chat.attach(conversation.id, paths);
  });
  const pickFolder = async () => {
    try {
      const folder = await api.system.chooseFolder();
      if (folder)
        onFolderChange(
          await api.conversations.update(conversation.id, { folder }),
        );
    } catch (reason) {
      reportError(reason);
    }
  };
  /**
   * The models are read once for this chat and kept. Settings already found
   * them; rediscovering the whole catalogue every time the picker opens — and
   * again after every pick — makes choosing a model wait on the network for
   * nothing (user, 17.09). A list already in hand is shown at once, and a
   * stale one is refreshed behind it rather than replaced by a blank menu.
   */
  const modelsReadAt = useRef(0);
  const modelsReading = useRef<Promise<void> | null>(null);
  const loadModels = (force = false): Promise<void> => {
    // Opening the picker while the first read is still in flight is the same
    // read, not a second one.
    if (modelsReading.current) return modelsReading.current;
    if (!force && modelsReadAt.current && Date.now() - modelsReadAt.current < 300_000) return Promise.resolve();
    setModelLoading(true);
    const reading = (async () => {
      try {
        const listed = await api.settings.catalog();
        if (!mounted.current) return;
        setCatalog(listed);
        modelsReadAt.current = Date.now();
      } catch (reason) {
        reportError(reason);
      } finally {
        modelsReading.current = null;
        if (mounted.current) setModelLoading(false);
      }
    })();
    modelsReading.current = reading;
    return reading;
  };
  useEffect(() => { void loadModels(); }, [conversation.id]);
  // Every model the chat can reach, side by side: kept connections and the
  // servers running on this Mac. A preset that was kept adds its models, it
  // does not replace the others' (user, 14.09). With several connections their
  // names become the quick filters, and picking a model elsewhere switches to
  // that connection. One that could not answer keeps its place and says why.
  const several = catalog.length > 1;
  // The model this chat runs on (user, 04.10): the last one used or picked in
  // it, or the selection in Settings for a chat that has none yet.
  const chosen = conversation.model ?? { endpointUrl: settings.endpointUrl, id: settings.model };
  const chosenModel = catalog.find(connection => endpointIdentity(connection.endpointUrl) === endpointIdentity(chosen.endpointUrl))
    ?.models.find(model => model.id === chosen.id);
  const imageWarning = chosenModel?.vision === false && attachments.some(item => item.kind === 'image')
    ? 'This model is text-only and cannot read images or screenshots. Choose a model with image input.' : null;
  // Its meter reads against that model's window: the one in Settings for the
  // selection, the published one for a model of the chat's own.
  const chosenSettings: AppSettings = endpointIdentity(chosen.endpointUrl) === endpointIdentity(settings.endpointUrl) && chosen.id === settings.model
    ? settings
    : { ...settings, model: chosen.id, contextWindow: catalog.find(connection => endpointIdentity(connection.endpointUrl) === endpointIdentity(chosen.endpointUrl))
        ?.models.find(model => model.id === chosen.id)?.contextWindow ?? settings.contextWindow };
  // The microphone's two switches, in its own menu (user, 09.10): Voice, and
  // Auto Send, which means nothing while Voice is off.
  const voiceOn = settings.voice?.enabled === true;
  const voiceItems: MenuItem[] = [
    { id: 'voice', label: 'Voice', toggle: true, stayOpen: true, checked: voiceOn,
      action: () => void api.settings.save({ voice: { enabled: !voiceOn } }).then(onSettingsChange).catch(reportError) },
    { id: 'auto-send', label: 'Auto Send', toggle: true, stayOpen: true, checked: settings.voice?.autoSend === true, disabled: !voiceOn,
      action: () => void api.settings.save({ voice: { enabled: true, autoSend: settings.voice?.autoSend !== true } }).then(onSettingsChange).catch(reportError) },
  ];
  // How hard the model thinks, beside the model it is (user, 17.11: "nu avem efort selector"): the setting
  // Settings always had, where it is used. Thinking switches it off and back on at the level it had; a level
  // applies from the next message. What the connection does with a level is said under the switch.
  const effort: Effort = settings.reasoningEffort ?? 'off';
  const setEffort = (level: Effort) => {
    if (level !== 'off') { try { localStorage.setItem('hello.effort.last', level); } catch { /* Best effort. */ } }
    void api.settings.save({ reasoningEffort: level }).then(onSettingsChange).catch(reportError);
  };
  const lastEffort = (): Effort => {
    let saved: string | null = null;
    try { saved = localStorage.getItem('hello.effort.last'); } catch { /* Best effort. */ }
    return EFFORT_LEVELS.find(level => level.value === saved)?.value ?? 'medium';
  };
  const effortItems: MenuItem[] = [
    { id: 'thinking', label: 'Thinking', toggle: true, stayOpen: true, checked: effort !== 'off',
      detail: effortHint(reasoningReach({ endpointUrl: chosen.endpointUrl, model: chosen.id, modelCompatibility: settings.modelCompatibility })),
      action: () => setEffort(effort === 'off' ? lastEffort() : 'off') },
    ...EFFORT_LEVELS.map((level, index): MenuItem => ({ id: `effort:${level.value}`, label: level.label, checked: effort === level.value, separator: index === 0, action: () => setEffort(level.value) })),
  ];
  const modelItems: MenuItem[] = catalog.flatMap((connection): MenuItem[] => {
    const name = connection.name || suggestedName(connection.endpointUrl) || connection.endpointUrl;
    const group = several ? name : undefined;
    // An error beside models is a refresh that failed on a connection whose
    // models are already known: those models stand. Only a connection nobody
    // has ever listed shows the reason instead (user, 17.09: OpenRouter's
    // models disappeared here while Settings listed them fine).
    if (connection.error && !connection.models.length)
      return [{ id: `unreachable:${connection.endpointUrl}`, label: name, detail: connection.error, group, disabled: true }];
    // The connection in use is the settings' one, now — not the list's, which is
    // kept for minutes and was read before the last pick. Trusting the list
    // saved an OpenRouter model alone, onto the local server picked a moment
    // before, and every turn after failed with "model not found" (user, 01.10).
    const inUse = endpointIdentity(connection.endpointUrl) === endpointIdentity(settings.endpointUrl);
    const mine = endpointIdentity(connection.endpointUrl) === endpointIdentity(chosen.endpointUrl);
    return connection.models.map((model) => ({
      id: `${connection.endpointUrl} ${model.id}`,
      label: modelName(model.id),
      detail: [several ? name : '', model.contextWindow ? `${model.contextWindow.toLocaleString('en')} tokens` : '']
        .filter(Boolean).join(' · ') || undefined,
      group,
      checked: mine && model.id === chosen.id,
      action: () => {
        // This chat's model from its next turn, and the selection a new chat
        // starts on. Only the choice: main reads this model's published
        // limits itself, so a model reached any other way launches on the
        // same numbers.
        void api.settings
          .save(inUse ? { model: model.id } : { endpointUrl: connection.endpointUrl, model: model.id })
          .then(onSettingsChange)
          .then(() => api.conversations.update(conversation.id, { model: { endpointUrl: connection.endpointUrl, id: model.id } }))
          .then(onFolderChange)
          .catch(reportError);
      },
    }));
  });
  if (!modelItems.length)
    modelItems.push(
      modelLoading
        // Something in progress is a spinner, not a sentence (user, 17.09).
        ? { id: "models-loading", label: "", leading: <Loader2 size={14} className="spin" aria-label="Reading models" />, disabled: true }
        : { id: "models-empty", label: "No models available", disabled: true },
    );
  // Free first (user, 01.10): the picker opens on the models that cost nothing
  // — the person's own servers, and those a provider prices at zero — and the
  // rest come back with the pill switched off. Offered only where it chooses.
  const freeModels = new Set(catalog.flatMap(connection =>
    connection.models.filter(model => model.free).map(model => `${connection.endpointUrl} ${model.id}`)));
  const freePill = freeModels.size && catalog.some(connection => connection.models.some(model => !model.free))
    ? { label: "Free", title: "Free models only: your own servers, and models priced at zero", keeps: (item: MenuItem) => Boolean(item.disabled) || freeModels.has(item.id) }
    : undefined;
  const workerItems: MenuItem[] = workers.map((worker) => ({
    id: worker.id,
    label: worker.label,
    icon: Bot,
    detail: !worker.installed
      ? "Not installed"
      : worker.usesActiveModel
        ? "Active model"
        : undefined,
    disabled: !worker.installed,
    action: () => onWorker(worker.id),
  }));
  return (
    <div className="conversation-view" data-file-drop={dropActive || undefined}
      onDragOver={event => {
        if (!hasFileDrop(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = importLock.current ? 'none' : 'copy';
        setDropActive(!importLock.current);
      }}
      onDragLeave={event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropActive(false);
      }}
      onDrop={event => {
        if (!hasFileDrop(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        setDropActive(false);
        void importDrop(event.dataTransfer);
      }}>
      <ChatFind root={transcriptMessages} conversationId={conversation.id} active={active} messages={messages} jump={jump} />
      <div
        ref={transcript}
        className="transcript"
        role="log"
        aria-label="Conversation messages"
        aria-live="polite"
        aria-relevant="additions"
        onScroll={event => {
          if (event.target !== event.currentTarget) return;
          const node = transcript.current!;
          sticky.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 80;
          setShowBottom(!sticky.current);
        }}
      >
        {messages.length === 0 ? (
          <div className="conversation-empty">
            <h2>What are we working on?</h2>
            <p>A conversation, a little research, a place to begin.</p>
          </div>
        ) : (
          <div ref={transcriptMessages}>
            {messages.map((message, index) => {
              const prev = index > 0 ? messages[index - 1] : null;
              const showDate = !prev || new Date(message.createdAt).toDateString() !== new Date(prev.createdAt).toDateString();
              return (
                <Fragment key={message.id}>
                  {showDate && (
                    <div className="conversation-date">
                      {formatDayDate(message.createdAt)}
                    </div>
                  )}
                  {index === restartIndex && <RestartLine />}
                  <MessageRow
                message={message}
                sources={messageContext[index].sources}
                last={index === messages.length - 1 && (restartIndex < 0 || index >= restartIndex)}
                streaming={busy}
                onRetry={() => {
                  void api.chat.retry(conversation.id).catch(reportError);
                }}
                onReuse={() => {
                  setDraft((current) =>
                    current
                      ? `${current}\n\n${message.content}`
                      : message.content,
                  );
                  field.current?.focus();
                }}
                onAttachSelection={text => {
                  const quoted = text.split('\n').map(line => `> ${line}`).join('\n');
                  setDraft(current => `${current}${current ? '\n\n' : ''}${quoted}\n\n`);
                  field.current?.focus({ preventScroll: true });
                }}
              />
              </Fragment>
            )
            })}
            {restartIndex === messages.length && <RestartLine />}
          </div>
        )}
      </div>
      {showBottom && (
        <button
          className="jump-to-latest pill"
          onClick={() => {
            sticky.current = true;
            transcript.current?.scrollTo({
              top: transcript.current.scrollHeight,
              behavior: "auto",
            });
            setShowBottom(false);
          }}
        >
          <ArrowDown size={14} />
          Latest response
        </button>
      )}
      <div className="composer-wrap">
        <ErrorNote error={error} />
        <ErrorNote error={imageWarning} />
        {extensionUi.above}
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {(dropActive || importing) && <p className="composer-drop-hint" role="status">
            {importing ? 'Adding attachments…' : 'Drop files to attach · Drop a folder to work in it'}
          </p>}
          {!!unsent.length && <ul className="pending-messages" aria-label="Messages that failed to send">
            {unsent.map(item => <li key={item.id} className="pending-message" data-mode="later">
              <button
                type="button"
                className="pending-text"
                title="Put this message back in the composer"
                aria-label={`Restore unsent message: ${item.text.trim() || item.attachments.map(file => file.name).join(', ')}`}
                onClick={() => restoreUnsent(item)}
              >
                {item.text.trim() || item.attachments.map(file => file.name).join(', ')}
                {!!item.attachments.length && !!item.text.trim() && ` — ${item.attachments.map(file => file.name).join(', ')}`}
              </button>
              <IconButton label="Discard this unsent message" onClick={() => setUnsent(current => current.filter(value => value.id !== item.id))}>
                <X size={13} />
              </IconButton>
            </li>)}
          </ul>}
          <PendingMessages items={queued} onChange={setQueued} onError={reason => setError(errorText(reason))} />
          {!!attachments.length && <div className="composer-attachments" aria-label="Message attachments">
            {attachments.map(item => <span className="composer-attachment" key={item.id} title={item.name}
              {...previewableAttachment(item) ? {
                tabIndex: 0,
                'aria-label': `${item.name}, double-click or press Enter to preview`,
                onDoubleClick: event => { if (!(event.target as Element).closest('button')) openPreview(item); },
                onKeyDown: event => {
                  if (event.key !== 'Enter' || event.target !== event.currentTarget) return;
                  event.preventDefault();
                  openPreview(item);
                },
              } : {}}>
              {item.kind === 'image' ? <ImageIcon size={14} aria-hidden /> : <FileText size={14} aria-hidden />}
              <span className="truncate">{item.name}</span>
              <IconButton label={`Remove attachment ${item.name}`} onClick={() => setAttachments(current => current.filter(value => value.id !== item.id))}>
                <X size={12} />
              </IconButton>
            </span>)}
          </div>}
          <Dialog open={previewOpen} title={preview?.item.name ?? 'Attachment preview'} className="attachment-preview" dismissOnBackdrop
            onClose={() => { previewRequest.current++; setPreviewOpen(false); }}>
            {preview?.src ? <img src={preview.src} alt={preview.item.name} />
              : preview?.error ? <ErrorNote error={preview.error} />
              : <p role="status">Loading preview…</p>}
          </Dialog>
          {chosenFolder && (
            <div className="composer-folder">
              <button
                type="button"
                className="text-button truncate"
                onClick={() =>
                  void api.system
                    .revealPath(chosenFolder)
                    .catch(reportError)
                }
                title={chosenFolder}
              >
                <Folder size={14} />
                {chosenFolder.split("/").filter(Boolean).at(-1)}
              </button>
              <IconButton
                label="Remove working folder"
                onClick={() => {
                  void api.conversations
                    .update(conversation.id, { folder: null })
                    .then(onFolderChange)
                    .catch(reportError);
                }}
              >
                <X size={12} />
              </IconButton>
            </div>
          )}
          {commands.popup}
          {mention.popup}
          <textarea
            ref={field}
            aria-label="Message"
            aria-autocomplete="list"
            aria-controls={commands.expanded ? commands.listId : mention.expanded ? mention.listId : undefined}
            aria-activedescendant={commands.activeId ?? mention.activeId}
            // While it works, saying what Enter will do is the whole affordance:
            // steering is otherwise invisible until something is already queued.
            placeholder={busy ? "Say it now — it reaches this reply" : "Ask anything"}
            value={draft}
            rows={2}
            onChange={(event) => { setDraft(event.target.value); setCaret(event.target.selectionStart); }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onPaste={(event) => {
              const data = event.clipboardData;
              // A file copied in Finder has a path: it is attached as a drop is.
              const files = Array.from(data.files ?? []);
              const paths = files.length ? api.system.pathsForFiles(files).filter(Boolean) : [];
              if (paths.length) { event.preventDefault(); void importPaths(paths); return; }
              // A picture alone becomes an attachment; anything with words pastes as words.
              const picture = Array.from(data.items ?? []).some(item => item.kind === "file" && item.type.startsWith("image/"));
              if (picture && !data.types.includes("text/plain") && api.chat.attachClipboard) {
                event.preventDefault();
                void pastePicture();
              }
            }}
            onKeyDown={(event) => {
              if (commands.onKeyDown(event)) return;
              if (mention.onKeyDown(event)) return;
              if (recallKey(event)) { event.preventDefault(); return; }
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-controls">
            <span className="sr-only" role="status" aria-live="polite">
              {busy ? "Generating response" : ""}
            </span>
            <IconButton
              label={
                chosenFolder
                  ? "Change working folder"
                  : "Choose working folder"
              }
              onClick={() => void pickFolder()}
            >
              <Folder size={16} />
            </IconButton>
            {api.system.chooseFiles && (
              <IconButton label="Attach files…" disabled={busy || importing} onClick={() => void pickFiles()}>
                <Paperclip size={16} />
              </IconButton>
            )}
            <IconButton label="New terminal" onClick={onTerminal}>
              <Terminal size={16} />
            </IconButton>
            <MenuButton label="Launch CLI worker" items={workerItems}>
              <Bot size={16} />
            </MenuButton>
            <ExtensionsPicker conversationId={conversation.id} busy={busy} onError={reportError} />
            <div className="composer-model">
              <MenuButton
                label="Choose model"
                searchPlaceholder="Search models"
                searchPill={freePill}
                className="model-trigger"
                items={modelItems}
                onOpen={() => void loadModels()}
              >
                <Truncated>{chosen.id ? modelName(chosen.id) : "Choose model"}</Truncated>
                {modelLoading ? <Loader2 size={13} className="browser-spinner"/> : <ChevronDown size={13} />}
              </MenuButton>
            </div>
            <MenuButton label={`Reasoning effort: ${effort === 'off' ? 'thinking off' : effort}`} className="model-trigger effort-trigger" items={effortItems}>
              <span>{effort === 'off' ? 'Off' : EFFORT_LEVELS.find(level => level.value === effort)?.label}</span>
              <ChevronDown size={13} />
            </MenuButton>
            {voiceOn || !api.voice?.transcribe ? (
              <IconButton
                className="icon-button voice-mic"
                label={!api.voice?.transcribe ? 'Voice is not available in this window'
                  : voicePhase === 'listening' ? 'Listening — let go when you are done, Esc to cancel'
                  : voicePhase === 'working' ? 'Writing out what you said — click to cancel'
                  : 'Hold to speak, or hold Space'}
                disabled={!voiceOn || !api.voice?.transcribe || (voicePhase === 'idle' && (busy || importing))}
                onPointerDown={event => {
                  // Writing out is the only thing a press can still stop.
                  if (voicePhase !== 'idle') { voiceTurn.current?.abort(); return; }
                  // The press is followed wherever it goes, so letting go off the button still ends the turn.
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  void startVoice();
                }}
                onPointerUp={endHold}
                onPointerCancel={endHold}
              >
                {voicePhase === 'working' ? <Loader2 size={18} className="spin" /> : voicePhase === 'listening' ? <Square size={16} /> : <Mic size={18} />}
              </IconButton>
            ) : (
              // Voice off, the microphone cannot listen: pressing it offers the switch instead (user, 09.10).
              <MenuButton label="Voice off" className="icon-button voice-mic" menuLabel="Voice" items={voiceItems}>
                <MicOff size={18} />
              </MenuButton>
            )}
            {api.voice?.transcribe && (
              <MenuButton label="Voice options" className="icon-button voice-options" menuLabel="Voice" items={voiceItems}>
                <ChevronDown size={13} />
              </MenuButton>
            )}
            {busy ? (
              <IconButton
                className="send-button"
                label="Stop response"
                onClick={() => {
                  void api.chat.stop(conversation.id).catch(reportError);
                }}
              >
                <Square size={13} fill="currentColor" />
              </IconButton>
            ) : (
              <button
                className="icon-button send-button"
                type="submit"
                aria-label="Send message"
                disabled={(!draft.trim() && !attachments.length) || importing}
              >
                <ArrowUp size={17} />
              </button>
            )}
          </div>
        </form>
        {extensionUi.below}
        <ContextMeter messages={messages} settings={chosenSettings} conversationId={conversation.id} busy={busy} />
      </div>
    </div>
  );
}
