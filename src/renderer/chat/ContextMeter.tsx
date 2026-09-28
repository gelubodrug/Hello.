import type { AppSettings, Message } from '../../shared/types';
import { modelName } from '../settings/presets';

/** From here the runtime is close to compacting; from here it compacts on the next turn. */
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
 * one selected now. Amber from three quarters, red from nine tenths: past
 * that, the runtime summarises the conversation to make room.
 */
export function ContextMeter({ messages, settings }: { messages: readonly Message[]; settings: AppSettings }): JSX.Element | null {
  const reading = contextReading(messages, settings);
  if (!reading) return null;
  const percent = Math.min(100, Math.round(reading.share * 100));
  const other = reading.model && reading.model !== settings.model ? modelName(reading.model) : null;
  const said = reading.level === 'full' ? ' — the next turn summarises the conversation to make room'
    : reading.level === 'warn' ? ' — close to the point where the conversation is summarised' : '';
  return (
    <div className="context-meter" data-level={reading.level}
      title={`The latest reply held ${reading.used.toLocaleString()} of ${reading.window.toLocaleString()} tokens${said}.`}>
      <span className="context-meter-bar" role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span className="context-meter-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="context-meter-text">
        {percent}% of {tokens(reading.window)}
        {reading.level !== 'ok' && <span className="context-meter-note">{reading.level === 'full' ? ' · summarises next turn' : ' · filling up'}</span>}
        {reading.cost > 0 && <> · {dollars(reading.cost)}</>}
        {other && <> · last reply: {other}</>}
      </span>
    </div>
  );
}
