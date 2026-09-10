import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BookText,
  ChevronDown,
  ChevronRight,
  Copy,
  Pencil,
  RefreshCw,
  Share,
  Terminal,
} from 'lucide-react';

import type { Message, RunbookContextStatus } from '../../shared/types';
import { conversationsStore, type AgentStep } from '../state/conversations';
import { Popover } from '../ui/Popover';
import { Tooltip } from '../ui/Tooltip';
import { TruncatedText } from '../ui/TruncatedText';
import { CodeBlock } from './CodeBlock';
import { extractMarkdownSources, Markdown, type MarkdownSource } from './Markdown';
import { runbookContextSummary } from './runbook-context';

import styles from './Message.module.css';

export interface MessageProps {
  message: Message;
  /** True when this is the currently-streaming assistant message. */
  isStreaming?: boolean;
  /** Optional tail slot (e.g. streaming caret) rendered after markdown content. */
  streamTail?: ReactNode;
  /** Keeps actions exposed on the latest completed assistant reply. */
  isLastAssistant?: boolean;
  /**
   * The model that answered the previous assistant turn. A thread can be
   * carried by several models — switching mid-conversation is a click — and
   * without this nothing said which reply came from which, so a model's own
   * account of itself could not be checked against anything.
   */
  previousModelId?: string;
  /**
   * Steps the agent took producing this reply (T137 search, T143 AI Mode).
   * Rendered above the answer so what the agent did stays legible.
   */
  agentSteps?: AgentStep[];
  /**
   * Whether this turn's project runbook reached the model (D1 criterion 6).
   * Absent means main sent no verdict for this turn, and the row stays away.
   */
  runbookContext?: RunbookContextStatus;
}

function AgentStepFlags({ step }: { step: AgentStep }): JSX.Element {
  return (
    <>
      {step.tool !== 'shell' && step.willSubmit && step.status === 'running' ? (
        <span className={styles.agentStepFlag}>about to submit</span>
      ) : null}
      {step.status === 'failed' && step.message ? (
        <span className={styles.agentStepFlag}>{step.message}</span>
      ) : null}
      {step.exitCode !== undefined && step.exitCode !== 0 ? (
        <span className={styles.agentStepFlag}>exit {step.exitCode}</span>
      ) : null}
    </>
  );
}

/** One command is expanded while it runs, stays open on failure, and folds
 * itself after success. The exact command is visible before any output lands. */
function ShellCommandRow({ step }: { step: AgentStep }): JSX.Element {
  const [open, setOpen] = useState(step.status !== 'done');
  const previousStatus = useRef(step.status);

  useEffect(() => {
    if (step.status === 'running' || step.status === 'failed') {
      setOpen(true);
    } else if (previousStatus.current === 'running') {
      setOpen(false);
    }
    previousStatus.current = step.status;
  }, [step.status]);

  return (
    <details
      className={styles.terminalCommand}
      data-status={step.status}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className={styles.terminalCommandSummary}>
        <TruncatedText className={styles.terminalCommandLabel}>{step.label}</TruncatedText>
        <ChevronRight className={styles.terminalCommandChevron} aria-hidden="true" />
      </summary>
      <div className={styles.agentStepCode}>
        <CodeBlock code={step.command ?? ''} language="bash" appearance="terminal-command" />
        {step.output !== undefined && step.output.trim() !== '' ? (
          <div className={styles.terminalOutput}>
            <CodeBlock code={step.output.trimEnd()} language="text" appearance="terminal-output" />
          </div>
        ) : (
          <span className={styles.terminalWaiting}>
            {step.status === 'running' ? 'Waiting for output…' : 'No output'}
          </span>
        )}
        <AgentStepFlags step={step} />
      </div>
    </details>
  );
}

/** Claude/Codex-style command group: the transcript first says how many
 * commands are running/ran, then exposes every command and its live output. */
function ShellCommandGroup({ steps }: { steps: AgentStep[] }): JSX.Element {
  const runningCount = steps.filter((step) => step.status === 'running').length;
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (runningCount > 0) setOpen(true);
  }, [runningCount]);

  const noun = (runningCount > 0 ? runningCount : steps.length) === 1 ? 'command' : 'commands';
  const title =
    runningCount > 0 ? `Running ${runningCount} ${noun}` : `Ran ${steps.length} ${noun}`;

  return (
    <details
      className={styles.terminalGroup}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      role="listitem"
    >
      <summary className={styles.terminalGroupSummary}>
        <Terminal className={styles.terminalGroupIcon} aria-hidden="true" />
        <span role="status" aria-live="polite">
          {title}
        </span>
        <ChevronRight className={styles.terminalGroupChevron} aria-hidden="true" />
      </summary>
      <div className={styles.terminalGroupBody}>
        {steps.map((step) => (
          <ShellCommandRow key={step.id} step={step} />
        ))}
      </div>
    </details>
  );
}

/**
 * The quiet trail of what the agent did. Shell work is deliberately larger:
 * a real terminal activity surface, not a generic background status line.
 */
function AgentStepTrail({ steps }: { steps: AgentStep[] }): JSX.Element {
  const shellSteps = steps.filter((step) => step.tool === 'shell' && step.command !== undefined);
  let renderedShellGroup = false;

  return (
    <div className={styles.agentSteps} aria-label="Agent steps" role="list">
      {steps.map((step) => {
        if (step.tool === 'shell' && step.command !== undefined) {
          if (renderedShellGroup) return null;
          renderedShellGroup = true;
          return <ShellCommandGroup key="shell-commands" steps={shellSteps} />;
        }

        return (
          <div key={step.id} className={styles.agentStep} data-status={step.status} role="listitem">
            <TruncatedText className={styles.agentStepLabel}>{step.label}</TruncatedText>
            <AgentStepFlags step={step} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * One quiet line saying whether the project runbook reached the model on this
 * turn — and when it did not, why. It sits in the step trail above the answer
 * because that is where this transcript already keeps "what went into this
 * reply"; the full sentence lives in the tooltip and in the accessible name,
 * so the state never rests on the short label alone.
 */
function RunbookContextRow({ status }: { status: RunbookContextStatus }): JSX.Element {
  const summary = runbookContextSummary(status);

  return (
    <Tooltip label={summary.description}>
      <div
        className={styles.runbookContext}
        data-included={summary.included ? 'true' : 'false'}
        role="note"
        aria-label={summary.description}
        tabIndex={0}
      >
        <BookText className={styles.runbookContextIcon} aria-hidden="true" />
        <TruncatedText className={styles.agentStepLabel}>{summary.label}</TruncatedText>
        {summary.flags.map((flag) => (
          <span key={flag} className={styles.agentStepFlag}>
            {flag}
          </span>
        ))}
      </div>
    </Tooltip>
  );
}

const COPIED_RESET_MS = 1500;

/**
 * Cheap first-pass guard for the bounded user bubble. The DOM height still
 * decides whether the control stays visible, but short messages never need a
 * measurement-driven state change.
 */
const LONG_USER_MESSAGE_CHARS = 700;
const LONG_USER_MESSAGE_LINES = 12;

export function isLongUserMessage(content: string): boolean {
  return (
    content.length >= LONG_USER_MESSAGE_CHARS ||
    content.split(/\r?\n/).length >= LONG_USER_MESSAGE_LINES
  );
}

interface SourcesPopoverProps {
  anchorRef: RefObject<HTMLElement>;
  id: string;
  open: boolean;
  sources: MarkdownSource[];
  onClose: () => void;
}

/** Two-line source menu with the same roving-keyboard behavior as app menus. */
function SourcesPopover({
  anchorRef,
  id,
  open,
  sources,
  onClose,
}: SourcesPopoverProps): JSX.Element {
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    const frame = requestAnimationFrame(() => itemRefs.current[0]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const focusSource = (index: number): void => {
    const nextIndex = (index + sources.length) % sources.length;
    setActiveIndex(nextIndex);
    itemRefs.current[nextIndex]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusSource(activeIndex + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusSource(activeIndex - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusSource(0);
        break;
      case 'End':
        event.preventDefault();
        focusSource(sources.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
      default:
        break;
    }
  };

  return (
    <Popover
      open={open}
      anchorRef={anchorRef}
      placement="bottom-start"
      className={styles.sourcesPopover}
      onClose={onClose}
    >
      <div
        id={id}
        role="menu"
        aria-label="Sources"
        className={styles.sourcesMenu}
        onKeyDown={handleKeyDown}
      >
        {sources.map((source, index) => (
          <a
            key={source.url}
            ref={(node) => {
              itemRefs.current[index] = node;
            }}
            role="menuitem"
            className={styles.sourceItem}
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            tabIndex={index === activeIndex ? 0 : -1}
            onFocus={() => setActiveIndex(index)}
            onClick={onClose}
          >
            <TruncatedText className={styles.sourceTitle}>{source.title}</TruncatedText>
            <TruncatedText className={styles.sourceUrl}>{source.url}</TruncatedText>
          </a>
        ))}
      </div>
    </Popover>
  );
}

/**
 * Message — a single transcript row (tasks T056 / T098 / T103 / DESIGNUIguide.md §Chat layout).
 *
 * Roles are distinguished STRUCTURALLY, never by bright fill: the user message
 * is a quiet right-aligned bubble, the assistant message is plain left-aligned
 * text, and the rare system message is centered and subdued. Content renders
 * through `Markdown`, with fenced code blocks delegated to `CodeBlock`.
 *
 * T149: user Copy, Share, and Edit actions mirror the assistant action row in
 * a reserved row beneath the bubble. Both rows reveal on hover/focus without
 * changing layout; the latest assistant answer keeps its actions visible.
 *
 * T098: the copy action writes `message.content` — the original markdown source,
 * never the rendered DOM text — and confirms via the polite live region.
 */
export function MessageView({
  message,
  isStreaming = false,
  streamTail,
  isLastAssistant = false,
  previousModelId,
  agentSteps,
  runbookContext,
}: MessageProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [longMessageExpanded, setLongMessageExpanded] = useState(false);
  const [longMessageOverflows, setLongMessageOverflows] = useState(() =>
    isLongUserMessage(message.content),
  );
  const [draft, setDraft] = useState(message.content);
  const rowRef = useRef<HTMLElement | null>(null);
  const longMessageRef = useRef<HTMLDivElement | null>(null);
  const pendingLongMessageAnchorRef = useRef<{
    row: HTMLElement;
    scroller: HTMLElement;
    bottomBefore: number;
  } | null>(null);
  const longMessageAnchorFrameRef = useRef<number | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sourcesMenuId = useId();

  useEffect(
    () => () => {
      if (resetTimer.current !== null) {
        clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  const longMessageCandidate = isUser && isLongUserMessage(message.content);
  const sources = useMemo(
    () => (isAssistant ? extractMarkdownSources(message.content) : []),
    [isAssistant, message.content],
  );

  // The character/line guard avoids work for normal prompts; rendered height
  // makes the final call because wrapping changes with the conversation width.
  useEffect(() => {
    setLongMessageExpanded(false);
    setLongMessageOverflows(longMessageCandidate);
  }, [longMessageCandidate, message.content]);

  useEffect(() => {
    const content = longMessageRef.current;
    if (!longMessageCandidate || !content || longMessageExpanded) return;

    const measure = (): void => {
      setLongMessageOverflows(content.scrollHeight > content.clientHeight + 1);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [longMessageCandidate, longMessageExpanded]);

  // The expanded DOM is already laid out here, but the browser has not painted
  // it yet. Hold the row in its old visual position for this frame; after the
  // virtualizer updates the scroll height, exchange that temporary transform
  // for the equivalent scroll offset. There is never a frame where the full
  // message flashes downward.
  useLayoutEffect(() => {
    const anchor = pendingLongMessageAnchorRef.current;
    if (!anchor) return;

    if (longMessageAnchorFrameRef.current !== null) {
      cancelAnimationFrame(longMessageAnchorFrameRef.current);
    }

    anchor.row.style.transform = '';
    anchor.row.style.willChange = '';
    const layoutDelta = anchor.row.getBoundingClientRect().bottom - anchor.bottomBefore;
    anchor.row.style.transform = `translateY(${-layoutDelta}px)`;
    anchor.row.style.willChange = 'transform';

    longMessageAnchorFrameRef.current = requestAnimationFrame(() => {
      // Give ResizeObserver/virtualizer one complete frame to resize the
      // spacer. The temporary transform stays painted, so this wait is clean.
      longMessageAnchorFrameRef.current = requestAnimationFrame(() => {
        // Account for native scroll anchoring or clamping that may already have
        // happened while the virtualizer resized its spacer.
        const transformedBottom = anchor.row.getBoundingClientRect().bottom;
        const naturalBottom = transformedBottom + layoutDelta;
        anchor.scroller.scrollTop += naturalBottom - anchor.bottomBefore;

        anchor.row.style.transform = '';
        anchor.row.style.willChange = '';
        pendingLongMessageAnchorRef.current = null;
        longMessageAnchorFrameRef.current = null;
      });
    });
  }, [longMessageExpanded]);

  useEffect(() => () => {
    if (longMessageAnchorFrameRef.current !== null) {
      cancelAnimationFrame(longMessageAnchorFrameRef.current);
    }
    const anchor = pendingLongMessageAnchorRef.current;
    if (anchor) {
      anchor.row.style.transform = '';
      anchor.row.style.willChange = '';
    }
  });

  /**
   * Keep the row's lower edge visually fixed. In the bottom-anchored chat this
   * makes expansion reveal older content upward, matching the reference UI.
   */
  const toggleLongMessage = (): void => {
    const row = rowRef.current;
    const scroller = row?.closest<HTMLElement>('[aria-label="Messages"]') ?? null;

    if (row && scroller) {
      pendingLongMessageAnchorRef.current = {
        row,
        scroller,
        bottomBefore: row.getBoundingClientRect().bottom,
      };
    }

    setLongMessageExpanded((expanded) => !expanded);
  };

  /** Closes the source list and restores focus to its soft-pill trigger. */
  const closeSources = (): void => {
    setSourcesOpen(false);
    requestAnimationFrame(() => sourceTriggerRef.current?.focus());
  };

  const handleStartEdit = (): void => {
    setDraft(message.content);
    setIsEditing(true);
  };

  const handleCancelEdit = (): void => {
    setIsEditing(false);
  };

  const handleSaveEdit = async (): Promise<void> => {
    const newText = draft.trim();
    setIsEditing(false);
    if (newText === message.content) {
      return;
    }
    await conversationsStore.getState().editUserMessage(message.id, newText);
  };

  /** Copies the stored markdown source verbatim — not the rendered Markdown output. */
  const handleCopy = async (): Promise<void> => {
    const markdownSource = message.content;

    try {
      await navigator.clipboard.writeText(markdownSource);
    } catch {
      // Clipboard can be unavailable/denied; fail silently rather than throw.
      return;
    }

    setCopied(true);
    if (resetTimer.current !== null) {
      clearTimeout(resetTimer.current);
    }
    resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  /** Resends the latest user turn through the conversation recovery path. */
  const handleRegenerate = async (): Promise<void> => {
    await conversationsStore.getState().retryLast();
  };

  /** Opens the existing Markdown export flow for the active conversation. */
  const handleShare = async (): Promise<void> => {
    await conversationsStore.getState().exportActiveConversation();
  };

  // A throughput that rounds to 0.0 is not a measurement — it is what a turn
  // that produced nothing leaves behind, and printing it reads as a result.
  // Shown only when the model changed: repeating it on every reply would be
  // noise in the common case of one model per thread.
  const showModel =
    message.role === 'assistant' &&
    !isStreaming &&
    message.modelId !== '' &&
    previousModelId !== undefined &&
    previousModelId !== message.modelId;

  const showMetrics =
    message.role === 'assistant' &&
    !isStreaming &&
    typeof message.metrics?.tokensPerSec === 'number' &&
    message.metrics.tokensPerSec >= 0.05;

  return (
    <article
      ref={rowRef}
      className={styles.row}
      data-role={message.role}
      role="article"
      aria-label={`${message.role} message`}
    >
      <div className={styles.bubble}>
        {isEditing ? (
          <div className={styles.editor}>
            <textarea
              className={styles.editorTextarea}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label="Edit message"
              autoFocus
            />
            <div className={styles.editorActions}>
              <button type="button" className={styles.editorCancel} onClick={handleCancelEdit}>
                Cancel
              </button>
              <button
                type="button"
                className={styles.editorSave}
                onClick={() => void handleSaveEdit()}
              >
                Save
              </button>
            </div>
          </div>
        ) : isUser && longMessageCandidate ? (
          <div
            className={styles.longMessage}
            data-expanded={longMessageExpanded ? 'true' : undefined}
          >
            <div
              ref={longMessageRef}
              className={styles.longMessageContent}
              data-collapsed={!longMessageExpanded ? 'true' : undefined}
            >
              <div className={styles.content}>
                <Markdown content={message.content} CodeBlockComponent={CodeBlock} />
              </div>
            </div>
            {longMessageOverflows ? (
              <button
                type="button"
                className={styles.longMessageToggle}
                aria-expanded={longMessageExpanded}
                onClick={toggleLongMessage}
              >
                {longMessageExpanded ? 'Show less' : 'Show more'}
                <ChevronDown className={styles.longMessageChevron} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : (
          <div className={styles.content}>
            {isAssistant && runbookContext ? <RunbookContextRow status={runbookContext} /> : null}
            {isAssistant && agentSteps && agentSteps.length > 0 ? (
              <AgentStepTrail steps={agentSteps} />
            ) : null}
            <Markdown
              content={message.content}
              CodeBlockComponent={CodeBlock}
              showSourceChips={isAssistant}
            />
            {streamTail}
          </div>
        )}

        {showModel || showMetrics ? (
          <div className={styles.metrics}>
            {showModel ? <span className={styles.metricsModel}>{message.modelId}</span> : null}
            {showModel && showMetrics ? ' · ' : null}
            {showMetrics ? `tok/s: ${message.metrics?.tokensPerSec?.toFixed(1)}` : null}
          </div>
        ) : null}

        {isAssistant ? (
          <div
            className={`${styles.messageActions} ${styles.assistantActions}`}
            data-latest={isLastAssistant ? 'true' : undefined}
            data-streaming={isStreaming ? 'true' : undefined}
          >
            <Tooltip label={copied ? 'Copied' : 'Copy'}>
              <button
                type="button"
                className={styles.actionButton}
                aria-label="Copy message"
                disabled={isStreaming}
                onClick={() => void handleCopy()}
              >
                <Copy className={styles.actionIcon} size={18} aria-hidden="true" />
              </button>
            </Tooltip>
            <Tooltip label="Regenerate">
              <button
                type="button"
                className={styles.actionButton}
                aria-label="Regenerate response"
                disabled={isStreaming}
                onClick={() => void handleRegenerate()}
              >
                <RefreshCw className={styles.actionIcon} size={18} aria-hidden="true" />
              </button>
            </Tooltip>
          </div>
        ) : null}

        {isAssistant && sources.length > 0 ? (
          <div className={styles.sourcesRow}>
            <button
              ref={sourceTriggerRef}
              type="button"
              className={styles.sourcesTrigger}
              aria-haspopup="menu"
              aria-expanded={sourcesOpen}
              aria-controls={sourcesOpen ? sourcesMenuId : undefined}
              data-open={sourcesOpen ? '' : undefined}
              onClick={() => setSourcesOpen((current) => !current)}
            >
              Sources
            </button>
            <SourcesPopover
              anchorRef={sourceTriggerRef}
              id={sourcesMenuId}
              open={sourcesOpen}
              sources={sources}
              onClose={closeSources}
            />
          </div>
        ) : null}
      </div>

      {isUser && !isEditing ? (
        <div className={`${styles.messageActions} ${styles.userActions}`}>
          <Tooltip label={copied ? 'Copied' : 'Copy'}>
            <button
              type="button"
              className={styles.actionButton}
              aria-label="Copy message"
              onClick={() => void handleCopy()}
            >
              <Copy className={styles.actionIcon} size={18} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip label="Share">
            <button
              type="button"
              className={styles.actionButton}
              aria-label="Share conversation"
              onClick={() => void handleShare()}
            >
              <Share className={styles.actionIcon} size={18} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip label="Edit">
            <button
              type="button"
              className={styles.actionButton}
              aria-label="Edit message"
              onClick={handleStartEdit}
            >
              <Pencil className={styles.actionIcon} size={18} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
      ) : null}

      <span className={styles.srOnly} role="status" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </article>
  );
}
