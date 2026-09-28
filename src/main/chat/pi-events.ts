// Adapted from an earlier Pi runner (user-authorized reuse).
// Wire contract: @earendil-works/pi-coding-agent 0.85.1 docs/rpc.md and
// dist/modes/json-event.d.ts. This reducer owns presentation only; Pi owns
// the agent loop, retries, compaction, and durable session history.
import type { Message, MessagePart } from '../../shared/types';

type ToolPart = Extract<MessagePart, { type: 'tool' }>;
type ThinkingPart = Extract<MessagePart, { type: 'thinking' }>;
type WireObject = Record<string, unknown>;

export type PiEventPhase = 'waiting' | 'thinking' | 'writing' | 'tool' | 'compacting' | 'retrying' | 'complete' | 'error';
export interface PiReportedUsage {
  /** Pi's uncached input count. Cache counts are separate, never added twice. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** A subset of output, not additional tokens. */
  reasoning?: number;
  /** What the provider billed, when it said; 0 when it did not. */
  cost?: number;
}
export interface PiCompactionState {
  active: boolean;
  reason?: string;
  aborted?: boolean;
  willRetry?: boolean;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  error?: string;
}
export interface PiEventUpdate {
  changed: boolean;
  /** Only agent_settled completes a prompt; tool/message/agent_end do not. */
  settled: boolean;
  phase: PiEventPhase;
  /** Tentative until settled: a successful Pi retry clears this error. */
  error?: string;
  warning?: string;
  aborted: boolean;
  compaction?: PiCompactionState;
  /** Total provider-reported usage for this prompt, including compaction. */
  usage?: PiReportedUsage;
  /** The largest prompt one call of this prompt sent: the most the window held. */
  contextPeak?: number;
}

interface ActiveMessage {
  blocks: Map<number, MessagePart>;
  pendingArgs: Map<number, string>;
  usage?: PiReportedUsage;
}

function object(value: unknown): WireObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as WireObject : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
/**
 * Pi passes a provider's own vocabulary straight through. A person reading the
 * chat needs to know whether the response failed on their side or the model's,
 * and the raw phrase says neither. The reason is kept, never discarded.
 */
export function readableProviderError(message: string): string {
  const match = /^Provider finish_reason:\s*(.+)$/.exec(message.trim());
  if (!match) return message;
  const reason = match[1].trim();
  if (reason === 'content_filter')
    return 'The provider stopped this response: its own content filter rejected it.';
  if (reason === 'network_error')
    return 'The connection to the provider dropped before this response finished.';
  return `The provider ended this response with an error before it finished (finish_reason: ${reason}). Retry, or pick another model.`;
}
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function printable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try { return JSON.stringify(value, null, 2) ?? ''; } catch { return ''; }
}

/** Preserve printable tool output without leaking image/base64 payloads into text. */
export function piToolResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  const result = object(value);
  if (!result) return '';
  if (Array.isArray(result.content)) {
    return result.content.flatMap((item) => {
      const block = object(item);
      return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
    }).join('\n');
  }
  return string(result.text) ?? '';
}

function readUsage(value: unknown): PiReportedUsage | undefined {
  const usage = object(value);
  if (!usage || !['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].some((key) => count(usage[key]) !== undefined)) return undefined;
  const input = count(usage.input) ?? 0;
  const output = count(usage.output) ?? 0;
  const cacheRead = count(usage.cacheRead) ?? 0;
  const cacheWrite = count(usage.cacheWrite) ?? 0;
  const reasoning = count(usage.reasoning);
  const billed = object(usage.cost);
  const cost = count(billed?.total) ?? count(usage.cost);
  return {
    input, output, cacheRead, cacheWrite,
    totalTokens: count(usage.totalTokens) ?? input + output + cacheRead + cacheWrite,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(cost ? { cost } : {}),
  };
}
/** How big one call's prompt was: its uncached input and what it read from or wrote to the cache. */
const promptOf = (usage: PiReportedUsage): number => usage.input + usage.cacheRead + usage.cacheWrite;
function addUsage(a: PiReportedUsage, b: PiReportedUsage): PiReportedUsage {
  return {
    input: a.input + b.input, output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(a.reasoning === undefined && b.reasoning === undefined ? {} : { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) }),
    ...(a.cost || b.cost ? { cost: (a.cost ?? 0) + (b.cost ?? 0) } : {}),
  };
}
const zeroUsage = (): PiReportedUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });

/** One mapper per Hello assistant turn. Parts are mutated in place so an
 * external approval handler can own tool.status/approvalId safely. */
export class PiEventMapper {
  private active?: ActiveMessage;
  private readonly priorUsage?: Message['usage'];
  private readonly priorParts: Set<MessagePart>;
  private readonly tools = new Map<string, ToolPart>();
  private readonly toolStarts = new Map<string, number>();
  private readonly thinkingStarts = new Map<ThinkingPart, number>();
  private readonly endedMessages = new Set<string>();
  private committedUsage = zeroUsage();
  private hasUsage = false;
  /** The prompt of the latest call that reported one, and the largest of them. */
  private lastPrompt?: number;
  private peakPrompt = 0;
  private settled = false;
  private phase: PiEventPhase = 'waiting';
  private pendingError?: string;
  private warning?: string;
  private aborted = false;
  private compaction?: PiCompactionState;

  constructor(readonly message: Message, private readonly now: () => number = Date.now) {
    message.parts ??= [];
    // Legacy/retried bubbles may have text without parts. Preserve that text
    // when subsequent Pi events rebuild the rendered content from its parts.
    if (!message.parts.length && message.content) message.parts.push({ type: 'text', text: message.content });
    this.priorParts = new Set(message.parts);
    this.priorUsage = message.usage ? { ...message.usage } : undefined;
    for (const part of message.parts) if (part.type === 'tool') this.tools.set(part.id, part);
  }

  /** Only text generated by this run; retained output from Retry cannot make
   * an otherwise empty new response look successful. */
  get responseText(): string {
    return this.message.parts!.filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text' && !this.priorParts.has(part)).map(part => part.text).join('\n\n');
  }

  apply(value: unknown): PiEventUpdate {
    const event = object(value);
    const type = string(event?.type);
    if (!event || !type || this.settled) return this.snapshot(false);
    let changed = true;
    const at = this.now();
    if (type === 'agent_start') {
      this.phase = 'waiting';
      this.message.status = 'streaming';
    } else if (type === 'agent_settled') {
      this.closeThinking(at);
      this.commitActiveUsage();
      this.active = undefined;
      this.settled = true;
      this.phase = this.pendingError ? 'error' : 'complete';
      this.message.status = this.pendingError ? 'error' : 'complete';
      this.message.error = this.pendingError ?? null;
      // A requested tool is not successful merely because the agent stopped.
      for (const part of this.tools.values()) {
        if (part.status === 'running' || part.status === 'approval') {
          part.status = 'error';
          delete part.approvalId;
          // A response cut off mid-call leaves a tool that was requested and
          // never run. Saying "failed" implies it ran; it did not.
          part.output ??= this.aborted
            ? 'Execution stopped.'
            : this.pendingError
              ? 'The response ended before this tool ran.'
              : 'Pi settled without a tool completion result.';
          this.finishToolTiming(part, at);
        }
      }
    } else if (type === 'message_start') {
      const incoming = object(event.message);
      if (incoming?.role !== 'assistant') return this.snapshot(false);
      this.closeThinking(at);
      this.commitActiveUsage();
      this.active = { blocks: new Map(), pendingArgs: new Map() };
      // Pi can emit message_start with an already-finished response when a
      // provider never streamed. Such a snapshot supplies no thinking timing.
      this.acceptContent(incoming.content, true, at);
      this.setActiveUsage(incoming.usage);
    } else if (type === 'message_update') {
      const delta = object(event.assistantMessageEvent);
      if (!delta) return this.snapshot(false);
      const partial = object(delta.partial);
      if (partial?.role && partial.role !== 'assistant') return this.snapshot(false);
      this.ensureActive();
      // SDK/custom emitters may still supply cumulative content. Do not also
      // append the delta in this path, or every streamed token is doubled.
      if (Array.isArray(partial?.content)) this.acceptContent(partial.content, false, at);
      else this.acceptDelta(delta, at);
      this.setActiveUsage(event.usage ?? partial?.usage);
      const subtype = string(delta.type) ?? '';
      if (subtype.startsWith('thinking')) this.phase = 'thinking';
      else if (subtype.startsWith('text')) this.phase = 'writing';
      else if (subtype.startsWith('toolcall')) this.phase = 'tool';
    } else if (type === 'message_end') {
      const incoming = object(event.message);
      if (incoming?.role === 'toolResult') {
        this.acceptToolResultMessage(incoming, at);
      } else if (incoming?.role === 'assistant') {
        // message_end is authoritative; agent_end.messages is intentionally
        // not replayed. Guard a duplicate terminal event as well.
        const key = printable({ timestamp: incoming.timestamp, responseId: incoming.responseId, content: incoming.content, usage: incoming.usage, stopReason: incoming.stopReason });
        if (this.endedMessages.has(key)) return this.snapshot(false);
        this.endedMessages.add(key);
        this.ensureActive();
        this.acceptContent(incoming.content, true, at);
        this.closeThinking(at);
        this.setActiveUsage(incoming.usage);
        this.commitActiveUsage();
        this.active = undefined;
        const reason = string(incoming.stopReason);
        if (reason === 'error' || reason === 'aborted') {
          this.aborted = reason === 'aborted';
          const reported = string(incoming.errorMessage) ?? string(incoming.error);
          this.pendingError = reported
            ? readableProviderError(reported)
            : this.aborted ? 'Request aborted.' : 'The model could not complete this response.';
        } else if (reason === 'length') {
          this.pendingError = 'The model reached its output token limit before completing the response.';
        } else if (reason !== 'pending' && reason !== 'deferred') {
          this.pendingError = undefined;
          this.aborted = false;
        }
        this.phase = 'waiting';
      } else return this.snapshot(false);
    } else if (type.startsWith('tool_execution_')) {
      changed = this.acceptExecution(type, event, at);
    } else if (type === 'compaction_start') {
      this.closeThinking(at);
      this.compaction = { active: true, reason: string(event.reason) };
      this.phase = 'compacting';
    } else if (type === 'compaction_end') {
      const result = object(event.result);
      const error = string(event.errorMessage);
      this.compaction = {
        active: false, reason: string(event.reason), aborted: event.aborted === true,
        willRetry: event.willRetry === true, tokensBefore: count(result?.tokensBefore),
        estimatedTokensAfter: count(result?.estimatedTokensAfter), ...(error ? { error } : {}),
      };
      const usage = readUsage(result?.usage);
      if (usage) { this.committedUsage = addUsage(this.committedUsage, usage); this.hasUsage = true; }
      if (error) this.pendingError = error;
      this.phase = event.willRetry === true ? 'retrying' : 'waiting';
    } else if (type === 'auto_retry_start' || type === 'summarization_retry_scheduled' || type === 'summarization_retry_attempt_start') {
      this.closeThinking(at);
      this.phase = 'retrying';
      this.warning = string(event.errorMessage);
    } else if (type === 'auto_retry_end') {
      if (event.success === false) this.pendingError = string(event.finalError) ?? this.pendingError ?? 'Pi exhausted automatic retries.';
      else if (event.success === true) { this.pendingError = undefined; this.warning = undefined; }
      this.phase = 'waiting';
    } else if (type === 'extension_error') {
      this.warning = string(event.error) ?? string(event.errorMessage) ?? 'A Pi extension reported an error.';
    } else if (type === 'agent_end') {
      this.closeThinking(at);
      this.phase = event.willRetry === true ? 'retrying' : 'waiting';
    } else {
      // turn_end, session entries, queue changes, user messages, and direct
      // RPC bash output are not additional assistant content or completion.
      changed = false;
    }
    this.refreshMessage();
    return this.snapshot(changed);
  }

  private ensureActive(): ActiveMessage {
    return this.active ??= { blocks: new Map(), pendingArgs: new Map() };
  }

  private insertBlock(index: number, part: MessagePart): void {
    const active = this.ensureActive();
    active.blocks.set(index, part);
    const parts = this.message.parts!;
    if (parts.includes(part)) return;
    const next = [...active.blocks].filter(([i]) => i > index).sort(([a], [b]) => a - b)[0]?.[1];
    const nextIndex = next ? parts.indexOf(next) : -1;
    if (nextIndex >= 0) parts.splice(nextIndex, 0, part);
    else parts.push(part);
  }

  private textBlock(index: number, type: 'text' | 'thinking', at: number): Extract<MessagePart, { type: 'text' | 'thinking' }> {
    const prior = this.ensureActive().blocks.get(index);
    if (prior?.type === type) return prior;
    const part: Extract<MessagePart, { type: 'text' | 'thinking' }> = { type, text: '' };
    this.insertBlock(index, part);
    if (part.type === 'thinking') this.thinkingStarts.set(part, at);
    return part;
  }

  private toolBlock(index: number, call: WireObject): ToolPart | undefined {
    const id = string(call.id) ?? string(call.toolCallId);
    if (!id) return undefined; // Never fabricate an identity for a tool call.
    let part = this.tools.get(id);
    if (!part) {
      part = { type: 'tool', id, name: string(call.name) ?? string(call.toolName) ?? 'tool', input: '', status: 'running' };
      this.tools.set(id, part);
    }
    const name = string(call.name) ?? string(call.toolName);
    if (name) part.name = name;
    const args = call.arguments ?? call.args ?? call.input;
    if (args !== undefined) part.input = printable(args);
    this.insertBlock(index, part);
    return part;
  }

  private acceptDelta(delta: WireObject, at: number): void {
    const subtype = string(delta.type) ?? '';
    const rawIndex = count(delta.contentIndex);
    if (rawIndex === undefined || !Number.isInteger(rawIndex)) return;
    const index = rawIndex;
    if (subtype.startsWith('text_') || subtype.startsWith('thinking_')) {
      const kind = subtype.startsWith('thinking_') ? 'thinking' : 'text';
      if (kind === 'text') this.closeThinking(at);
      const prior = this.ensureActive().blocks.get(index);
      const part = this.textBlock(index, kind, at);
      if (part.type === 'thinking') {
        if (subtype.endsWith('_end') && !prior) this.thinkingStarts.delete(part);
        else if (!subtype.endsWith('_end') && !this.thinkingStarts.has(part) && part.durationMs === undefined) this.thinkingStarts.set(part, at);
      }
      if (subtype.endsWith('_delta')) part.text += string(delta.delta) ?? '';
      else if (subtype.endsWith('_end')) {
        part.text = string(delta.content) ?? part.text;
        if (part.type === 'thinking') this.finishThinking(part, at);
      }
    } else if (subtype === 'toolcall_start') {
      this.closeThinking(at);
      this.ensureActive().pendingArgs.set(index, '');
      this.toolBlock(index, delta);
    } else if (subtype === 'toolcall_delta') {
      const active = this.ensureActive();
      const args = (active.pendingArgs.get(index) ?? '') + (string(delta.delta) ?? '');
      active.pendingArgs.set(index, args);
      const part = active.blocks.get(index);
      if (part?.type === 'tool') part.input = args;
    } else if (subtype === 'toolcall_end') {
      const call = object(delta.toolCall);
      if (call) this.toolBlock(index, call);
      this.ensureActive().pendingArgs.delete(index);
    }
  }

  private acceptContent(value: unknown, final: boolean, at: number): void {
    if (!Array.isArray(value)) return;
    value.forEach((raw, index) => {
      const block = object(raw);
      if (!block) return;
      const kind = string(block.type)?.toLowerCase();
      if (kind === 'text' || kind === 'thinking' || kind === 'reasoning') {
        const type = kind === 'text' ? 'text' : 'thinking';
        const text = type === 'text' ? string(block.text) : string(block.thinking) ?? string(block.text) ?? string(block.reasoning_content);
        if (text === undefined) return;
        const prior = this.ensureActive().blocks.get(index);
        // A malformed empty final must not erase visible streamed content.
        if (final && text === '' && prior && 'text' in prior && prior.text) return;
        const part = this.textBlock(index, type, at);
        part.text = text;
        if (final && part.type === 'thinking') {
          // A final-only thinking block has no observed duration.
          if (!prior) this.thinkingStarts.delete(part);
          else this.finishThinking(part, at);
        }
      } else if (kind === 'toolcall' || kind === 'tool_call') {
        this.toolBlock(index, object(block.toolCall) ?? block);
      }
    });
  }

  private executionTool(event: WireObject): ToolPart | undefined {
    const id = string(event.toolCallId) ?? string(event.id);
    if (!id) return undefined;
    let part = this.tools.get(id);
    if (!part) {
      part = { type: 'tool', id, name: string(event.toolName) ?? 'tool', input: printable(event.args), status: 'running' };
      this.tools.set(id, part);
      this.message.parts!.push(part);
    }
    if (typeof event.toolName === 'string') part.name = event.toolName;
    if (event.args !== undefined) part.input = printable(event.args);
    return part;
  }

  private acceptExecution(type: string, event: WireObject, at: number): boolean {
    const part = this.executionTool(event);
    if (!part) return false;
    if (type === 'tool_execution_start') {
      this.closeThinking(at);
      if (!this.toolStarts.has(part.id)) this.toolStarts.set(part.id, at);
      // Approval state belongs to the host bridge, not this wire reducer.
      this.phase = 'tool';
    } else if (type === 'tool_execution_update') {
      if (part.status === 'complete' || part.status === 'error') return false;
      if (event.partialResult !== undefined) part.output = piToolResultText(event.partialResult);
      this.phase = 'tool';
    } else if (type === 'tool_execution_end') {
      if (event.result !== undefined) part.output = piToolResultText(event.result);
      part.status = event.isError === true || object(event.result)?.isError === true ? 'error' : 'complete';
      delete part.approvalId;
      this.finishToolTiming(part, at);
      this.phase = 'waiting';
    } else return false;
    return true;
  }

  private acceptToolResultMessage(incoming: WireObject, at: number): void {
    const part = this.executionTool(incoming);
    if (!part) return;
    part.output = piToolResultText(incoming);
    part.status = incoming.isError === true ? 'error' : 'complete';
    delete part.approvalId;
    this.finishToolTiming(part, at);
  }

  private finishToolTiming(part: ToolPart, at: number): void {
    const started = this.toolStarts.get(part.id);
    if (started !== undefined && part.durationMs === undefined) part.durationMs = Math.max(0, at - started);
  }
  private finishThinking(part: ThinkingPart, at: number): void {
    const started = this.thinkingStarts.get(part);
    if (started !== undefined) { part.durationMs = Math.max(0, at - started); this.thinkingStarts.delete(part); }
  }
  private closeThinking(at: number): void {
    for (const part of this.thinkingStarts.keys()) this.finishThinking(part, at);
  }
  private setActiveUsage(value: unknown): void {
    const usage = readUsage(value);
    if (!usage) return;
    this.ensureActive().usage = usage;
    this.hasUsage = true;
    const prompt = promptOf(usage);
    if (prompt > 0) { this.lastPrompt = prompt; this.peakPrompt = Math.max(this.peakPrompt, prompt); }
  }
  private commitActiveUsage(): void {
    if (this.active?.usage) { this.committedUsage = addUsage(this.committedUsage, this.active.usage); this.active.usage = undefined; }
  }
  private usage(): PiReportedUsage | undefined {
    return this.hasUsage ? addUsage(this.committedUsage, this.active?.usage ?? zeroUsage()) : undefined;
  }
  private refreshMessage(): void {
    this.message.content = this.message.parts!.filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text').map((part) => part.text).join('\n\n');
    const usage = this.usage();
    if (usage) {
      const cost = (this.priorUsage?.cost ?? 0) + (usage.cost ?? 0);
      const context = this.lastPrompt ?? this.priorUsage?.context;
      this.message.usage = {
        input: (this.priorUsage?.input ?? 0) + usage.input + usage.cacheRead + usage.cacheWrite,
        output: (this.priorUsage?.output ?? 0) + usage.output,
        ...(context ? { context } : {}),
        ...(cost > 0 ? { cost } : {}),
      };
    }
  }
  /**
   * After a turn Hello itself cut short — the model going round — the same
   * reply goes on: the next prompt's events land in it as if the turn had
   * not ended. What was already said, and its usage, stays.
   */
  resume(): void {
    this.settled = false;
    this.aborted = false;
    this.pendingError = undefined;
    this.active = undefined;
    this.phase = 'waiting';
    this.message.status = 'streaming';
    this.message.error = null;
  }
  private snapshot(changed: boolean): PiEventUpdate {
    return {
      changed, settled: this.settled, phase: this.phase, aborted: this.aborted,
      ...(this.pendingError ? { error: this.pendingError } : {}),
      ...(this.warning ? { warning: this.warning } : {}),
      ...(this.compaction ? { compaction: { ...this.compaction } } : {}),
      ...(this.hasUsage ? { usage: this.usage() } : {}),
      ...(this.peakPrompt ? { contextPeak: this.peakPrompt } : {}),
    };
  }
}
