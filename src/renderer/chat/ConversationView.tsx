import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
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
  X,
} from "lucide-react";
import type {
  AppSettings,
  ChatAttachment,
  ChatQuote,
  Conversation,
  Message,
  MessagePart,
  ModelChoice,
  QueuedMessage,
  WorkerId,
  WorkerInfo,
} from "../../shared/types";
import { api } from "../api";
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
import { fetchedSources, readWebResult, sourcesForMessage, withSourceLinks, type WebSource } from '../../shared/web';
import { MessageSources, ActivityGroup, WebToolOutput, webToolArgument, webToolIcon, webToolTitle } from './WebResearch';
import { activityLayout, activityRows, liveTail, stepLabel, suppliedDuration, thinkingTitle, type ActivityRow } from './activity';
import { PendingMessages } from './PendingMessages';
import { chatCopySnapshot } from './selection';
import { ChatModeSwitch } from './ChatModeSwitch';
import { ChatDisclosure } from './ChatDisclosure';
import { ExtensionsPicker } from './ExtensionsPicker';

const IMAGE_NAME = /\.(?:png|jpe?g|gif|webp)$/i;
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

export function ToolPart({
  part,
}: {
  part: Extract<MessagePart, { type: "tool" }>;
}) {
  const [open, setOpen] = useState(part.status === "approval");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const WebIcon = webToolIcon(part.name);
  const id = useId();
  const duration = suppliedDuration(part.durationMs);
  const status = part.status === 'complete' ? 'Completed' : part.status === 'approval' ? 'Needs approval' : part.status === 'error' ? 'Failed' : 'Running';
  const argument = webToolArgument(part);
  useEffect(() => {
    if (part.status === "approval") setOpen(true);
  }, [part.status]);
  const approve = async (allow: boolean) => {
    if (!part.approvalId) return;
    setPending(true);
    setError(null);
    try {
      await api.chat.approve(part.approvalId, allow);
    } catch (reason) {
      setError(errorText(reason));
      setPending(false);
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
        {part.status !== 'complete' && <span className="tool-query">{status}</span>}
        <ChevronDown size={14} className="disclosure-chevron" aria-hidden />
      </button>
      <ChatDisclosure id={id} open={open}>
        <div className="tool-detail">
          <p className="activity-metadata">{status}{duration !== null ? ` · ${(duration / 1000).toFixed(1)}s (${duration} ms)` : ''}</p>
          <span className="meta-label">Input</span>
          {WebIcon && webToolArgument(part) !== null
            ? <p className="web-tool-argument">{webToolArgument(part)}</p>
            : <CodeBlock code={readableJson(part.input)} language="json" />}
          {part.output !== undefined && (
            <>
              <span className="meta-label">Output</span>
              {readWebResult(part) ? <WebToolOutput part={part} /> : <ToolOutput name={part.name} output={part.output} />}
            </>
          )}
          {part.status === "approval" && (
            <div className="approval-actions">
              <p>This tool is asking for your approval.</p>
              <button
                className="pill"
                disabled={pending}
                onClick={() => void approve(false)}
              >
                Decline
              </button>
              <button
                className="pill primary-button"
                disabled={pending}
                onClick={() => void approve(true)}
              >
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
        {state && <span className="tool-query">{state}</span>}
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

/** How much commentary reads as a step rather than as a wall. */
const NOTE_CAP = 96;

/**
 * What the model said between its actions. In the activity list every entry is
 * a step and every step is one row: a sentence or two can simply be said, but
 * anything longer — a whole file printed out loud, say — folds to the same
 * single line as the thinking and the tools around it. One list, one tier.
 */
export function ActivityNote({ text, sources }: { text: string; sources: readonly WebSource[] }) {
  const body = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  const id = useId();
  useLayoutEffect(() => {
    const node = body.current;
    if (!node) return;
    // Measured while clipped: scrollHeight is the whole content either way.
    const measure = () => setLong(node.scrollHeight > NOTE_CAP);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);
  const summary = text.trim().split('\n').find(line => line.trim()) ?? text;
  return (
    <div className="activity-note" data-folded={long && !open || undefined}>
      {long && (
        <button
          type="button"
          className="disclosure-button activity-step"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(value => !value)}
        >
          <span className="tool-action-title">{summary}</span>
          <ChevronDown size={14} className="disclosure-chevron" aria-hidden />
        </button>
      )}
      <div ref={body} id={id} className="activity-note-body">
        <Markdown text={text} sources={sources} />
      </div>
    </div>
  );
}

export function MessageContent({ message, sources }: { message: Message; sources: readonly WebSource[] }) {
  // Keep explicit thinking disclosure choices even when the first arriving tool
  // folds preceding reasoning/commentary into the activity group.
  const [thinkingExpanded, setThinkingExpanded] = useState<Record<number, boolean>>({});
  if (!message.parts?.length) return <Markdown text={message.content} sources={sources} />;
  const parts = message.parts;
  const layout = activityLayout(parts, message.status === 'streaming');
  const renderPart = (index: number, step = false) => {
    const part = parts[index];
    return (
        part.type === "text" ? (
          step
            ? <ActivityNote key={index} text={part.text} sources={sources} />
            : <Markdown key={index} text={part.text} sources={sources} />
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
  const rows = activityRows(layout.activity);
  const renderRow = (row: ActivityRow) =>
    row.count === 1
      ? renderPart(row.start, true)
      : <MergedStep key={row.key} row={row} render={renderPart} />;
  const tailFrom = liveTail(rows);
  return <>
    {layout.grouped
      ? <ActivityGroup
          parts={layout.activity}
          streaming={message.status === 'streaming'}
          tail={rows.slice(tailFrom).map(renderRow)}
        >
          {rows.map(renderRow)}
        </ActivityGroup>
      : layout.activity.map((_part, index) => renderPart(index))}
    {layout.answer.map((_part, index) => renderPart(layout.answerStart + index))}
  </>;
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
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const hasVisibleContent = Boolean(message.content.trim()) || message.parts?.some(part => part.type === 'tool' || Boolean(part.text.trim()));
  const runtimeStatus = message.status !== 'streaming' ? null
    : message.runtimePhase === 'compacting' ? 'Compacting conversation…'
    : message.runtimePhase === 'retrying' ? 'Retrying response…'
    : !hasVisibleContent ? message.runtimePhase === 'starting' ? 'Starting chat…' : 'Waiting for response…'
    : null;
  return (
    <article
      tabIndex={0}
      className={`message message-${message.role}`}
      aria-label={
        message.role === "user" ? "Your message" : "Assistant response"
      }
      onContextMenu={event => {
        if (!event.currentTarget.contains(event.target as Node)) return;
        event.preventDefault();
        event.stopPropagation();
        const snapshot = chatCopySnapshot(event.currentTarget, message, sources);
        const bounds = event.currentTarget.getBoundingClientRect();
        setContext({ ...snapshot, position: { x: event.clientX || bounds.left + 16, y: event.clientY || bounds.top + 16 } });
      }}
    >
      {message.role === "user" ? (
        <>
          <div className="user-bubble">{message.content}</div>
          <div className="message-actions user-message-actions">
            <IconButton
              label={copied ? "Message copied" : "Copy your message"}
              disabled={copying}
              onClick={() => void copyMessage()}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
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
          {runtimeStatus && <span className="waiting-response" role="status" aria-live="polite">{runtimeStatus}</span>}
        </>
      )}
      {message.role === "assistant" && message.status !== "streaming" && (
        <div className="message-actions">
          <IconButton
            label={copied ? "Response copied" : "Copy response"}
            disabled={copying}
            onClick={() => void copyMessage()}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </IconButton>
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
          {message.usage && (
            <span className="message-usage">
              {message.usage.input.toLocaleString()} in ·{" "}
              {message.usage.output.toLocaleString()} out
            </span>
          )}
        </div>
      )}
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
          if (reason === 'escape' && context?.range) {
            const selection = window.getSelection();
            if (context.range.startContainer.isConnected && context.range.endContainer.isConnected) {
              context.range.startContainer.parentElement?.closest<HTMLElement>('.message')?.focus({ preventScroll: true });
              selection?.removeAllRanges(); selection?.addRange(context.range);
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
}) {
  const draftKey = `hello.draft.${conversation.id}`;
  const [draft, setDraft] = useState(() => {
    try {
      return localStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  const [sending, setSending] = useState(false);
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const attachmentDraftKey = `${draftKey}.attachments`;
  const [attachments, setAttachments] = useState<ChatAttachment[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(attachmentDraftKey) ?? '[]');
      return Array.isArray(saved) ? saved.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && ['text', 'image'].includes(item.kind)).slice(0, 8) : [];
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
  const [dropActive, setDropActive] = useState(false);
  const [importing, setImporting] = useState(false);
  const importLock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [showBottom, setShowBottom] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const transcriptMessages = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const sticky = useRef(true);
  const generation = messages.some((message) => message.status === "streaming");
  const busy = sending || generation;
  // The waiting list is main's, not this component's: it survives a reload, and
  // main decides when a held message is finally said.
  useEffect(() => {
    let alive = true;
    void api.chat.queued?.(conversation.id)
      .then(items => { if (alive) setQueued(items); })
      .catch(() => { if (alive) setQueued([]); });
    return () => { alive = false; };
  }, [conversation.id, busy]);
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
    if (!quote) return;
    // A page read is quoted; a note written about a page is the person's own words.
    const body = quote.verbatim
      ? quote.text
      : quote.text.split("\n").map((line) => `> ${line}`).join("\n");
    setDraft((current) => `${current}${current ? "\n\n" : ""}${body}\n\n`);
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
  const send = async () => {
    const text = draft.trim();
    if (importLock.current) return;
    // Typing while the model works is a correction, not a second question: it
    // goes to the turn already running. Nothing is lost if it arrives late —
    // the pill above the composer shows it, and its landing can still change.
    if (busy) {
      if (!text) return;
      setDraft("");
      try { setQueued(await api.chat.queue(conversation.id, text, 'steer')); }
      catch (reason) { setError(errorText(reason)); setDraft(current => current || text); }
      return;
    }
    if (!text && !attachments.length) return;
    const sentAttachments = attachments;
    setDraft("");
    setAttachments([]);
    setSending(true);
    setError(null);
    sticky.current = true;
    try {
      await api.chat.send(conversation.id, text, sentAttachments.map(item => item.id));
    } catch (reason) {
      setError(errorText(reason));
      setDraft((current) => current || text);
      setAttachments(current => [...sentAttachments, ...current.filter(item => !sentAttachments.some(sent => sent.id === item.id))]);
    } finally {
      setSending(false);
    }
  };
  const importDrop = async (transfer: DataTransfer) => {
    if (importLock.current) return;
    importLock.current = true;
    setImporting(true);
    setError(null);
    try {
      const paths = await droppedPaths(transfer);
      if (paths.length + attachments.length > 8) throw new Error('Attach up to 8 files per message. Remove an attachment before adding more.');
      const imported = await api.chat.attach(conversation.id, paths);
      if (!mounted.current) return;
      if (imported.folder) {
        if (busy) throw new Error('Stop the current response before changing its working folder.');
        const updated = await api.conversations.update(conversation.id, { folder: imported.folder });
        if (mounted.current) onFolderChange(updated);
      } else {
        setAttachments(current => [...current, ...imported.attachments]);
      }
      field.current?.focus({ preventScroll: true });
    } catch (reason) {
      if (mounted.current) setError(errorText(reason));
    } finally {
      importLock.current = false;
      if (mounted.current) setImporting(false);
    }
  };
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
  const refreshModels = async () => {
    setModelLoading(true);
    try {
      setModels(await api.settings.models());
    } catch (reason) {
      reportError(reason);
    } finally {
      setModelLoading(false);
    }
  };
  const modelItems: MenuItem[] = models.length
    ? models.map((model) => ({
        id: model.id,
        label: model.id,
        detail: model.contextWindow ? `${model.contextWindow.toLocaleString('en')} tokens` : undefined,
        checked: model.id === settings.model,
        action: () => {
          // Only the choice: main reads this model's published limits itself,
          // so a model reached any other way launches on the same numbers.
          void api.settings
            .save({ model: model.id })
            .then(onSettingsChange)
            .catch(reportError);
        },
      }))
    : [
        {
          id: "models-empty",
          label: modelLoading ? "Loading models…" : "No models available",
          disabled: true,
        },
      ];
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
            <div className="conversation-date">
              {new Intl.DateTimeFormat(undefined, {
                month: "short",
                day: "numeric",
              }).format(messages[0].createdAt)}
            </div>
            {messages.map((message, index) => (
              <MessageRow
                key={message.id}
                message={message}
                sources={messageContext[index].sources}
                last={index === messages.length - 1}
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
            ))}
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
          {conversation.folder && (
            <div className="composer-folder">
              <button
                type="button"
                className="text-button truncate"
                onClick={() =>
                  void api.system
                    .revealPath(conversation.folder!)
                    .catch(reportError)
                }
                title={conversation.folder}
              >
                <Folder size={14} />
                {conversation.folder.split("/").filter(Boolean).at(-1)}
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
          <textarea
            ref={field}
            aria-label="Message"
            // While it works, saying what Enter will do is the whole affordance:
            // steering is otherwise invisible until something is already queued.
            placeholder={busy ? "Say it now — it reaches this reply" : "Ask anything"}
            value={draft}
            rows={2}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
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
            <ChatModeSwitch
              value={conversation.chatMode ?? 'chat'}
              disabled={busy}
              onChange={chatMode => {
                if (chatMode === (conversation.chatMode ?? 'chat')) return;
                void api.conversations.update(conversation.id, { chatMode })
                  .then(onFolderChange).catch(reportError);
              }}
            />
            <IconButton
              label={
                conversation.folder
                  ? "Change working folder"
                  : "Choose working folder"
              }
              onClick={() => void pickFolder()}
            >
              <Folder size={16} />
            </IconButton>
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
                searchPlaceholder={'search models try "free"'}
                className="model-trigger"
                items={modelItems}
                onOpen={() => void refreshModels()}
              >
                <Truncated>{settings.model || "Choose model"}</Truncated>
                <ChevronDown size={13} />
              </MenuButton>
            </div>
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
      </div>
    </div>
  );
}
