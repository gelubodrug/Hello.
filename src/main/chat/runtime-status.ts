import { onThisMac } from '../../shared/connection-name';
import { ownServer } from '../../shared/reasoning';

// What runtime_status answers: the model, its server, where that server is,
// and how fast replies came in. Qwen in kapitsa on this Mac had no way to say
// any of it: it guessed "the cloud", then tried fetch_url and curl on its own
// endpoint (user, 12.11). Hello streams every reply, so Hello times it, on any
// server, with no server API and no credential of its own.

/** One model call, as Hello saw it stream in. */
export interface MeasuredCall {
  /** When the call ended. */
  at: number;
  /** Prompt tokens the server took for it, cached ones included. */
  input: number;
  /** Tokens it wrote, thinking included. */
  output: number;
  /** From the first streamed token to the last. */
  streamMs: number;
  /** From the call's start to its first streamed token: reading the prompt, and the way there. */
  firstTokenMs?: number;
}

/** Below these a rate is noise: a burst of a few tokens divides into thousands a second. */
export const MIN_RATED_TOKENS = 32;
export const MIN_RATED_MS = 1_000;
const rated = (call: MeasuredCall) => call.output >= MIN_RATED_TOKENS && call.streamMs >= MIN_RATED_MS;

/** Where an endpoint is, in words: this Mac, the person's own network, or a provider. */
export function serverPlace(endpointUrl: string): { host: string; place: string } {
  try {
    const url = new URL(endpointUrl.trim());
    if (onThisMac(url.hostname)) return { host: url.host, place: 'a server on this Mac: replies are generated on this computer, not by a cloud provider' };
    if (ownServer(url.hostname)) return { host: url.host, place: 'a server on the person’s own network, not a cloud provider' };
    return { host: url.host, place: 'a provider reached over the internet' };
  } catch {
    return { host: '', place: 'a provider reached over the internet' };
  }
}

const number = (value: number) => value.toLocaleString('en');
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const rate = (output: number, ms: number) => `${(output / (ms / 1000)).toFixed(1)} tokens/s`;
const clock = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour12: false });

/** The answer runtime_status gives, newest call first. */
export function runtimeReport(input: {
  model: string;
  endpointUrl: string;
  /** The server by the name Settings shows it under, e.g. "kapitsa · 8000". */
  serverName: string;
  contextWindow?: number;
  /** Whether the server published the context window, or Hello holds it. */
  published?: boolean;
  /** This chat's measured calls, oldest first. */
  calls: MeasuredCall[];
}): string {
  const { host, place } = serverPlace(input.endpointUrl);
  const server = input.serverName.trim() || host;
  const lines = [
    `Model: ${input.model.trim() || 'none chosen'}`,
    `Server: ${server ? `${server}, at ` : ''}${input.endpointUrl.trim()}: ${place}.`,
    ...(input.contextWindow ? [`Context window: ${number(input.contextWindow)} tokens, ${input.published ? 'as the server publishes it' : 'as Hello is set to use'}.`] : []),
  ];
  // Only timed calls are listed, so asking again without writing in between
  // returns the same answer, word for word — which is what lets the repeat
  // guard stop a loop. Listing every short call, with "ask again" under it,
  // kept Qwen calling this tool twenty times running, 15 tokens each, every
  // answer a little longer than the last (user, 12.11).
  lines.push(`Speed, measured by Hello as each model call streamed in: tokens written ÷ time from the first token to the last. Transport is included, so it may read a little under the server’s own figure. Only a call that writes at least ${MIN_RATED_TOKENS} tokens over at least a second is timed: one that only calls a tool is too short.`);
  const measured = input.calls.filter(rated).slice(-5).reverse();
  for (const call of measured)
    lines.push(`- ${clock(call.at)}: ${number(call.output)} tokens in ${seconds(call.streamMs)} = ${rate(call.output, call.streamMs)}; prompt ${number(call.input)} tokens${call.firstTokenMs === undefined ? '' : `, first token after ${seconds(call.firstTokenMs)}`}`);
  lines.push(measured.length
    ? `${measured.length === 1 ? 'Over this call' : `Over these ${measured.length} calls`}: ${rate(
      measured.reduce((sum, call) => sum + call.output, 0),
      measured.reduce((sum, call) => sum + call.streamMs, 0))}.`
    : 'No call in this chat has been long enough to time yet.');
  lines.push('Calling runtime_status again without writing a long answer first measures nothing new.');
  return lines.join('\n');
}
