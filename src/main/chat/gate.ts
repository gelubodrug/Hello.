// The gate: a short call that stands between the person and the agent.
//
// A model is trained to do something and explain afterwards what it did not
// know, never to ask first (user, 18.11: a 27B spent ten minutes on an Excel
// task and delivered a fifth of what Claude did from the same words, because
// the words were a conversation, not a specification). People write to local
// models the way three years of frontier models taught them to write, and the
// local model has no way to fill the gaps. So the gap is closed before the
// agent sees the request: the same model, with no tools, no manuals and no
// history, reads the request once and answers one of two ways — a work order
// it can execute, or the few questions whose answers it needs. What reaches
// the agent is the work order; the agent assumes at the level of execution,
// never at the level of the problem.
//
// It costs one short call (a 1-2K prompt, thinking off) instead of a turn of
// the agent loop, and it never blocks work when it is broken: any failure of
// the call lets the request through as it was, with a note.
import { reasoningReach, usesQwenThinkingSwitch } from '../../shared/reasoning';
import type { AppSettings } from '../../shared/types';

/** At most this many questions in one round: more is an interrogation, not a gate. */
export const GATE_MAX_QUESTIONS = 3;
/** After this many rounds of questions the gate decides on its own and lets the work through. */
export const GATE_MAX_ROUNDS = 2;
/** The whole call, including the model's thinking if the server ignores the switch. */
export const GATE_TIMEOUT_MS = 90_000;
/** The request as the gate reads it; the rest is referred to, not sent. */
const GATE_REQUEST_CHARS = 12_000;

/** What the gate is waiting on, kept for the chat between its question and the person's answer. */
export interface GateState {
  /** The person's original words, the first time. */
  request: string;
  /** The gate's reading of them, shown with the questions. */
  understood: string;
  /** What it asked, in order. */
  questions: string[];
  /** Every answer so far, in order, each the person's whole message. */
  answers: string[];
  /** Rounds of questions asked, counted from 1. */
  rounds: number;
  at: number;
}

export type GateVerdict =
  /** `work` false: a question or a conversation, which goes to the agent as the person wrote it, not as an order. */
  | { kind: 'ready'; understood: string; assumptions: string[]; work: boolean }
  | { kind: 'ask'; understood: string; questions: string[] }
  /** The call failed or answered in no usable shape: the request goes through as it was. */
  | { kind: 'skipped'; reason: string };

/** The gate's instructions. English like every other prompt here; the person's own language is answered in kind. */
export function gatePrompt(final: boolean): string {
  return [
    'You are the gate in front of a coding and research agent that runs on a local model. The agent executes well when it is given a clear work order, and badly when it is given a conversation: it cannot ask the human anything while it works, so every gap in the request becomes a guess, a loop, or ten minutes of second-guessing.',
    'You read the human’s request once, before the agent sees it. You decide whether it can be executed as a single smooth pass. You never execute anything yourself and you have no tools.',
    'Answer with one JSON object and nothing else, in this shape:',
    '{"work": <true when something is to be done — files, commands, a document, research — false for a plain question, a conversation or an acknowledgement>, "understood": "<what is being asked, as a work order: the input, the output, what done looks like, in 2-8 short lines>", "assumptions": ["<a decision about HOW to do it that you are taking so the human is not asked>"], "questions": ["<a question only the human can answer>"]}',
    'Rules for the three fields:',
    '- understood: restate the request as the order the agent will execute. Name the files, the folder paths, the formats and the numbers the human gave. Do not add work the human did not ask for.',
    '- assumptions: decisions of execution — which library, which script name, which column order, where the output goes when the request does not say — are yours to take. Take them, list them here, and do not ask about them. An assumption about WHAT the human wants (which file, which rows, which result counts as done) is not yours to take: that is a question.',
    `- questions: only what changes the result and cannot be decided from the request, the folder or common sense. At most ${GATE_MAX_QUESTIONS}, each one line, each answerable in a few words. When the request is clear enough to execute, questions is an empty list. A question about taste or style is never asked.`,
    'Write understood, assumptions and questions in the language the human wrote in.',
    'A request that is a plain question, a conversation, or a small edit with every detail in it needs no questions: say what was understood and let it through.',
    'A word in the request that admits several readings which change the result — "the most active", "the best", "useful", "clean up", "important" — is a question, never an assumption, unless the request, the folder or the earlier order settles which reading is meant.',
    'understood is the order itself, in plain imperative lines: no reasoning, no alternatives weighed, no "let\'s assume". Decide, then write the decision under assumptions.',
    'The agent reads and writes files only in the folder attached to the chat. When no folder is attached and the request is about files, the one question is which folder to attach (the person attaches it in the chat); a path written in the request does not replace it. When a folder is attached, assume the files named are in it.',
    'When an earlier order of this chat is given, the new message is usually a follow-up to it: read it against that order, carry its files, names and choices forward, and ask nothing the order already settled.',
    ...(final ? [
      'This is the last round: the human has answered what they will answer. Do not ask again. Decide what is still open as an assumption, name it as one, and let the work through: questions must be an empty list.',
    ] : []),
  ].join('\n');
}

/** The request as the gate reads it, with the answers of earlier rounds. */
export function gateUserMessage(state: Pick<GateState, 'request' | 'questions' | 'answers'>, folder?: string | null, prior?: string, attached: string[] = []): string {
  const lines = [
    folder ? `The agent works in the folder ${folder}.` : 'The agent has no folder attached: file work, if any, needs one.',
    ...(attached.length ? [`Files attached to this message, which the agent receives with it: ${attached.join(', ')}.`] : []),
    ...(prior ? ['', 'The order the agent executed earlier in this chat:', clip(prior, 3_000), ''] : []),
    'The human’s request:',
    clip(state.request, GATE_REQUEST_CHARS),
  ];
  if (state.questions.length) {
    lines.push('', 'You asked:', ...state.questions.map((question, index) => `${index + 1}. ${question}`));
    lines.push('', 'The human answered:', ...state.answers.map(answer => clip(answer, GATE_REQUEST_CHARS)));
  }
  return lines.join('\n');
}

/** The body of the gate's request: the chat's model, thinking off where the connection takes the switch. */
export function gateRequestBody(settings: AppSettings, state: Pick<GateState, 'request' | 'questions' | 'answers'>, folder: string | null | undefined, final: boolean, prior?: string, attached: string[] = []): Record<string, unknown> {
  const compatibility = settings.modelCompatibility ?? 'auto';
  const reach = reasoningReach(settings);
  return {
    model: settings.model,
    messages: [
      { role: 'system', content: gatePrompt(final) },
      { role: 'user', content: gateUserMessage(state, folder, prior, attached) },
    ],
    stream: false,
    temperature: 0,
    max_tokens: 1_200,
    ...(usesQwenThinkingSwitch(settings.endpointUrl, settings.model, compatibility) ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    ...(reach === 'level' ? { reasoning_effort: 'low' } : {}),
  };
}

/** The model's answer, read tolerantly: fences, a preamble, a thinking block before the object. */
export function parseGateAnswer(text: string): GateVerdict {
  const body = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return { kind: 'skipped', reason: 'The gate answered without a JSON object.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return { kind: 'skipped', reason: 'The gate answered with JSON that does not parse.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'skipped', reason: 'The gate answered with something other than an object.' };
  const record = parsed as Record<string, unknown>;
  const understood = typeof record.understood === 'string' ? record.understood.trim() : '';
  if (!understood) return { kind: 'skipped', reason: 'The gate did not say what it understood.' };
  const questions = lines(record.questions).slice(0, GATE_MAX_QUESTIONS);
  if (questions.length) return { kind: 'ask', understood, questions };
  return { kind: 'ready', understood, assumptions: lines(record.assumptions), work: record.work !== false };
}

/**
 * The work order the agent receives in place of the request. The person's own
 * words stay at the end, as reference, so a name or a number the order
 * paraphrased can be checked; the order is what is executed.
 */
export function workOrder(verdict: Extract<GateVerdict, { kind: 'ready' }>, state: Pick<GateState, 'request' | 'questions' | 'answers'>): string {
  const lines = [
    'WORK ORDER — read by Hello’s gate from the human’s request and settled with them. Execute it as written, in one pass. Where it says what was assumed, that is decided: do not ask the human about it and do not reopen it. If a step turns out impossible, say so and stop; do not substitute a different task.',
    '',
    'Understood:',
    verdict.understood,
  ];
  if (verdict.assumptions.length) lines.push('', 'Assumed (decided, not to be asked):', ...verdict.assumptions.map(item => `- ${item}`));
  if (state.questions.length) {
    // One message usually answers a whole round of questions, so answers are paired with questions only when
    // they are as many; otherwise the questions are listed, then every answer, each once.
    if (state.answers.length === state.questions.length) {
      lines.push('', 'Asked and answered:');
      state.questions.forEach((question, index) => lines.push(`- ${question}`, `  ${clip(state.answers[index], 2_000)}`));
    } else {
      lines.push('', 'Asked:', ...state.questions.map(question => `- ${question}`));
      lines.push('', 'The human answered:', ...state.answers.map(answer => clip(answer, 2_000)));
    }
  }
  lines.push('', 'The human’s own words, for reference only:', clip(state.request, GATE_REQUEST_CHARS));
  return lines.join('\n');
}

/**
 * A request whose questions were answered, when there is no order to send:
 * the gate failed, or called the answer a conversation. An answer alone is not
 * a request — "ultimele 24h" sent bare was searched for as the news of the day
 * (user, 26.11) — so the agent is given the request, the questions and the
 * answers together.
 */
export function answeredRequest(state: Pick<GateState, 'request' | 'questions' | 'answers'>): string {
  return [
    'The human’s request:',
    clip(state.request, GATE_REQUEST_CHARS),
    '',
    'Hello asked them:',
    ...state.questions.map((question, index) => `${index + 1}. ${question}`),
    '',
    'They answered:',
    ...state.answers.map(answer => clip(answer, 2_000)),
    '',
    'Do what the request asks, with these answers.',
  ].join('\n');
}

/** The order as the next gate call is told it: what was understood and what was assumed, in a few lines. */
export function orderSummary(verdict: Extract<GateVerdict, { kind: 'ready' }>): string {
  return [verdict.understood, ...verdict.assumptions.map(item => `Assumed: ${item}`)].join('\n');
}

/** What the person reads when the gate asks: its reading, then the questions, numbered, to answer in the next message. */
export function gateQuestionsText(verdict: Extract<GateVerdict, { kind: 'ask' }>): string {
  return [
    verdict.understood,
    '',
    ...verdict.questions.map((question, index) => `${index + 1}. ${question}`),
  ].join('\n');
}

export interface GateCall {
  fetcher: typeof globalThis.fetch;
  url: string;
  key?: string | null;
  settings: AppSettings;
  folder?: string | null;
  /** The last order the agent executed in this chat, so a follow-up is read as one. */
  prior?: string;
  /** The names of the files attached to the message, so the gate does not ask for a file it already has. */
  attached?: string[];
  signal?: AbortSignal;
}

/** One call to the chat's model, no tools, thinking off. Any failure is a `skipped` verdict, never a thrown error. */
export async function runGate(call: GateCall, state: Pick<GateState, 'request' | 'questions' | 'answers'> & { rounds: number }): Promise<GateVerdict> {
  const final = state.rounds >= GATE_MAX_ROUNDS;
  const body = gateRequestBody(call.settings, state, call.folder, final, call.prior, call.attached);
  const timeout = AbortSignal.timeout(GATE_TIMEOUT_MS);
  const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
  try {
    const response = await call.fetcher(call.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(call.key ? { Authorization: `Bearer ${call.key}` } : {}) },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    });
    if (!response.ok) return { kind: 'skipped', reason: `The gate’s call returned HTTP ${response.status}.` };
    const answer = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = answer.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return { kind: 'skipped', reason: 'The gate’s call returned no text.' };
    const verdict = parseGateAnswer(content);
    // The last round asks nothing more, whatever the model wrote.
    if (verdict.kind === 'ask' && final) return { kind: 'ready', understood: verdict.understood, assumptions: verdict.questions.map(question => `Open, decided by the agent: ${question}`), work: true };
    return verdict;
  } catch (error) {
    if (call.signal?.aborted) throw error;
    return { kind: 'skipped', reason: timeout.aborted ? 'The gate’s call timed out.' : `The gate’s call failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function lines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean);
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}… [${text.length - limit} more characters]` : text;
}
