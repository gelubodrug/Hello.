import { describe, expect, it, vi } from 'vitest';
import { GATE_MAX_QUESTIONS, GATE_MAX_ROUNDS, gateQuestionsText, gateRequestBody, parseGateAnswer, runGate, workOrder } from '../src/main/chat/gate';
import type { AppSettings } from '../src/shared/types';

// The gate (user, 18.11): a local model given a conversation guesses, loops and
// delivers a fifth of the work; given a work order it executes. So the
// request is read once, before the agent, and the few questions whose answers
// change the result are asked then — never during the work.

const local = { endpointUrl: 'http://127.0.0.1:8000/v1', model: 'qwen3.8-flash-next', apiKeySet: false, systemPrompt: '', temperature: 0.7, connections: [] } as AppSettings;
const provider = { ...local, endpointUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude' } as AppSettings;
const fresh = { request: 'fă un raport din gps.xlsx', questions: [], answers: [], rounds: 0 };

describe('what the gate asks of the model', () => {
  it('sends one short call with thinking off where the connection takes the switch', () => {
    const body = gateRequestBody(local, fresh, '/Users/q/tasks', false);
    expect(body.model).toBe('qwen3.8-flash-next');
    expect(body.stream).toBe(false);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body).not.toHaveProperty('reasoning_effort');
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages.map(message => message.role)).toEqual(['system', 'user']);
    expect(messages[0].content).toContain(`At most ${GATE_MAX_QUESTIONS}`);
    expect(messages[0].content).not.toContain('last round');
    expect(messages[1].content).toContain('/Users/q/tasks');
    expect(messages[1].content).toContain('fă un raport din gps.xlsx');
  });

  it('asks a provider for low effort instead, and says so when it is the last round', () => {
    const body = gateRequestBody(provider, { ...fresh, questions: ['Which sheet?'], answers: ['The first.'] }, null, true);
    expect(body.reasoning_effort).toBe('low');
    expect(body).not.toHaveProperty('chat_template_kwargs');
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0].content).toContain('This is the last round');
    expect(messages[1].content).toContain('1. Which sheet?');
    expect(messages[1].content).toContain('The first.');
    expect(messages[1].content).toContain('no folder attached');
    expect(messages[1].content).not.toContain('executed earlier');
    // The chat's last order travels with the next request, so a follow-up is read as one.
    const next = gateRequestBody(local, fresh, null, false, 'Build report.xlsx from gps.xlsx.') as { messages: Array<{ content: string }> };
    expect(next.messages[1].content).toContain('executed earlier in this chat:\nBuild report.xlsx from gps.xlsx.');
    expect(next.messages[0].content).toContain('follow-up');
    // A file attached to the message is named, so the gate does not ask for it.
    const withFile = gateRequestBody(local, fresh, null, false, undefined, ['gps.xlsx']) as { messages: Array<{ content: string }> };
    expect(withFile.messages[1].content).toContain('Files attached to this message, which the agent receives with it: gps.xlsx.');
  });
});

describe('how the gate reads the answer', () => {
  it('takes the object out of fences, preambles and thinking, and caps the questions', () => {
    const verdict = parseGateAnswer('<think>hm</think>Sure:\n```json\n{"understood":"Build the report","assumptions":[],"questions":["A?","B?","C?","D?"]}\n```');
    expect(verdict).toEqual({ kind: 'ask', understood: 'Build the report', questions: ['A?', 'B?', 'C?'] });
  });

  it('lets a clear request through with its assumptions', () => {
    expect(parseGateAnswer('{"work":true,"understood":"Rename x to y in a.ts","assumptions":["Keep the export name"],"questions":[]}'))
      .toEqual({ kind: 'ready', understood: 'Rename x to y in a.ts', assumptions: ['Keep the export name'], work: true });
    // A conversation is not work; an answer that does not say is taken as work.
    expect(parseGateAnswer('{"work":false,"understood":"Thanks, nothing to do.","assumptions":[],"questions":[]}')).toMatchObject({ kind: 'ready', work: false });
    expect(parseGateAnswer('{"understood":"Do x","assumptions":[],"questions":[]}')).toMatchObject({ kind: 'ready', work: true });
  });

  it('skips, never blocks, when the answer has no usable shape', () => {
    expect(parseGateAnswer('I cannot help with that.').kind).toBe('skipped');
    expect(parseGateAnswer('{"understood": ').kind).toBe('skipped');
    expect(parseGateAnswer('{"questions":["?"]}').kind).toBe('skipped');
    expect(parseGateAnswer('[1,2]').kind).toBe('skipped');
  });
});

describe('what the person and the agent each receive', () => {
  it('shows the person the reading, then the questions, numbered', () => {
    expect(gateQuestionsText({ kind: 'ask', understood: 'A report from gps.xlsx.', questions: ['Which month?', 'One sheet or one per car?'] }))
      .toBe('A report from gps.xlsx.\n\n1. Which month?\n2. One sheet or one per car?');
  });

  it('hands the agent a work order: the reading, what was assumed, what was answered, and the words only as reference', () => {
    const order = workOrder({ kind: 'ready', understood: 'Build report.xlsx from gps.xlsx, one sheet per car.', assumptions: ['openpyxl', 'Output beside the source'], work: true },
      { request: 'fă un raport din gps.xlsx', questions: ['Which month?'], answers: ['October'] });
    expect(order).toContain('WORK ORDER');
    expect(order).toContain('Understood:\nBuild report.xlsx from gps.xlsx, one sheet per car.');
    expect(order).toContain('Assumed (decided, not to be asked):\n- openpyxl\n- Output beside the source');
    expect(order).toContain('- Which month?\n  October');
    expect(order).toContain('for reference only:\nfă un raport din gps.xlsx');
    // The order comes first; the words last.
    expect(order.indexOf('Understood:')).toBeLessThan(order.indexOf('for reference only'));
    // One message answering two questions is written once, not under each question.
    const once = workOrder({ kind: 'ready', understood: 'x', assumptions: [], work: true },
      { request: 'r', questions: ['Which file?', 'Which metric?'], answers: ['1. gps.xlsx 2. km'] });
    expect(once).toContain('Asked:\n- Which file?\n- Which metric?\n\nThe human answered:\n1. gps.xlsx 2. km');
    expect(once.split('1. gps.xlsx 2. km')).toHaveLength(2);
  });
});

describe('the call itself', () => {
  const call = (fetcher: typeof fetch, settings = local) => ({ fetcher, url: 'http://127.0.0.1:8000/v1/chat/completions', key: null, settings, folder: null });
  const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

  it('posts the body with the key and reads the verdict', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply('{"understood":"Do x","assumptions":[],"questions":["Where?"]}'));
    const verdict = await runGate({ ...call(fetcher), key: 'secret' }, fresh);
    expect(verdict).toEqual({ kind: 'ask', understood: 'Do x', questions: ['Where?'] });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8000/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    expect(JSON.parse(init?.body as string).stream).toBe(false);
  });

  it('skips on an HTTP error, a broken body or a thrown fetch, with the reason', async () => {
    expect(await runGate(call(async () => new Response('busy', { status: 503 })), fresh)).toEqual({ kind: 'skipped', reason: 'The gate’s call returned HTTP 503.' });
    expect(await runGate(call(async () => new Response('{}', { status: 200 })), fresh)).toEqual({ kind: 'skipped', reason: 'The gate’s call returned no text.' });
    expect((await runGate(call(async () => { throw new Error('ECONNREFUSED'); }), fresh))).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('ECONNREFUSED') });
  });

  it('asks nothing more after the last round: what is still open becomes an assumption', async () => {
    const verdict = await runGate(call(async () => reply('{"understood":"Do x","assumptions":["a"],"questions":["Still unclear?"]}')),
      { ...fresh, questions: ['Q1', 'Q2'], answers: ['A1', 'A2'], rounds: GATE_MAX_ROUNDS });
    expect(verdict).toEqual({ kind: 'ready', understood: 'Do x', assumptions: ['Open, decided by the agent: Still unclear?'], work: true });
  });

  it('rethrows a stop by the person, and only that', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))));
    const pending = runGate({ ...call(fetcher), signal: controller.signal }, fresh);
    controller.abort(new Error('Stopped by you.'));
    await expect(pending).rejects.toThrow('Stopped by you.');
  });
});
