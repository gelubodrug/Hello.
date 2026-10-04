import { useEffect, useState } from 'react';
import type { AppSettings, Message } from '../../shared/types';
import { api } from '../api';
import { modelName } from '../settings/presets';
import { workDuration } from './activity';
import { useElapsed } from './useElapsed';

/** From here the runtime is close to compacting; from here it compacts soon (it decides by its own estimate). */
export const CONTEXT_WARN = 0.75;
export const CONTEXT_FULL = 0.9;

export interface ContextReading {
  /** The prompt of the latest reply's latest call: what the model holds now. */
  used: number;
  window: number;
  share: number;
  level: 'ok' | 'warn' | 'full';
  /** The model that wrote the latest reply. */
  model?: string;
  /** What this chat's replies cost, when the provider said. */
  cost: number;
}

/**
 * How full the model's window is, from the latest reply that reported its
 * prompt, against the window the chat runs with. A reply's own input adds the
 * context once per tool step, so it is its bill, never its size.
 */
export function contextReading(messages: readonly Message[], settings: Pick<AppSettings, 'contextWindow'>): ContextReading | null {
  const cost = messages.reduce((sum, message) => sum + (message.usage?.cost ?? 0), 0);
  const last = [...messages].reverse().find(message => message.role === 'assistant' && message.usage?.context);
  const window = settings.contextWindow ?? 0;
  if (!last?.usage?.context || !(window > 0)) return null;
  const used = last.usage.context;
  const share = used / window;
  return { used, window, share, level: share >= CONTEXT_FULL ? 'full' : share >= CONTEXT_WARN ? 'warn' : 'ok', model: last.model, cost };
}

/** "13.1k", "205k", "1.2M". */
export function tokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 100_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}
/** "$0.0042", "$0.12", "$3.40". */
export function dollars(amount: number): string {
  return `$${amount < 0.1 ? amount.toFixed(4) : amount.toFixed(2)}`;
}

/**
 * Under the composer: how full the window is, what the chat has cost when the
 * provider says, and which model wrote the latest reply when that is not the
 * one selected now. Amber from three quarters, red from nine tenths, where
 * the runtime soon summarises the conversation by itself — and from amber
 * on, "Summarise now" does it at once (user, 04.10, both design audits: the
 * meter showed the worry and offered nothing to do about it).
 */
export function ContextMeter({ messages, settings, conversationId, busy = false }: {
  messages: readonly Message[];
  settings: AppSettings;
  /** The chat a summary is asked for; without it the meter only reads. */
  conversationId?: string;
  /** A reply is running: a summary waits for it. */
  busy?: boolean;
}): JSX.Element | null {
  const reading = contextReading(messages, settings);
  const latest = messages.at(-1)?.id;
  const [summary, setSummary] = useState<{ state: 'running' } | { state: 'done'; before: number; after?: number; at?: string } | { state: 'failed'; error: string } | null>(null);
  const summarising = summary?.state === 'running';
  const elapsed = useElapsed(summarising);
  // What a summary freed holds until the next reply reads the window again.
  useEffect(() => { setSummary(current => current?.state === 'done' && current.at !== latest ? null : current); }, [latest]);
  if (!reading) return null;
  const percent = Math.min(100, Math.round(reading.share * 100));
  const other = reading.model && reading.model !== settings.model ? modelName(reading.model) : null;
  const said = reading.level === 'full' ? ' — the conversation is summarised soon, by itself or with Summarise now'
    : reading.level === 'warn' ? ' — close to the point where the conversation is summarised' : '';
  const canSummarise = Boolean(conversationId && api.chat.compact) && reading.level !== 'ok' && !busy && summary?.state !== 'done';
  const summarise = () => {
    if (!conversationId || !api.chat.compact) return;
    setSummary({ state: 'running' });
    api.chat.compact(conversationId).then(
      result => setSummary({ state: 'done', before: result.tokensBefore, ...(result.tokensAfter !== undefined ? { after: result.tokensAfter } : {}), at: latest }),
      (error: unknown) => setSummary({ state: 'failed', error: error instanceof Error ? error.message : String(error) }),
    );
  };
  return (
    <div className="context-meter" data-level={summary?.state === 'done' ? 'ok' : reading.level}
      title={`The latest reply held ${reading.used.toLocaleString()} of ${reading.window.toLocaleString()} tokens${said}.`}>
      <span className="context-meter-bar" role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span className="context-meter-fill" style={{ width: `${summary?.state === 'done' && summary.after !== undefined ? Math.min(100, Math.round((summary.after / reading.window) * 100)) : percent}%` }} />
      </span>
      <span className="context-meter-text">
        {summary?.state === 'done'
          ? <>Summarised{summary.after !== undefined ? `: ${tokens(summary.before)} → about ${tokens(summary.after)}` : ''}</>
          : <>{percent}% of {tokens(reading.window)}</>}
        {summary?.state !== 'done' && reading.level !== 'ok' && !summarising && <span className="context-meter-note">{reading.level === 'full' ? ' · summarises soon' : ' · filling up'}</span>}
        {summarising && <span className="context-meter-note"> · summarising{elapsed >= 2000 ? ` ${workDuration(elapsed)}` : '…'}</span>}
        {summary?.state === 'failed' && <span className="context-meter-error" title={summary.error}> · could not summarise</span>}
        {reading.cost > 0 && <> · {dollars(reading.cost)}</>}
        {other && <> · last reply: {other}</>}
      </span>
      {canSummarise && !summarising && (
        <button type="button" className="context-meter-action" onClick={summarise}
          title="Summarise the conversation now: the model keeps a summary and the recent turns; the transcript stays whole">
          Summarise now
        </button>
      )}
    </div>
  );
}
