// A whole Hello chat turn with no window: the real ChatService, the real Pi
// child with Hello's extension and tool bridge, the real sheet tools — and, in
// place of a model server, an endpoint whose answers are supplied from outside
// (files in io/), so any model, or a person, can sit in the model's chair.
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ChatService } from '../../src/main/chat/service';
import { createDataStore } from '../../src/main/data/store';
import { scopedPath } from '../../src/main/chat/tools';
import { Workbooks } from '../../src/main/sheets/workbooks';
import type { Message, MessagePart } from '../../src/shared/types';

const root = process.env.HEADLESS_ROOT!;
const io = join(root, 'io');
// A chat with a folder of the person's (folder/), or one with none; and the files dropped onto it (drop/), from outside that folder.
const folder = existsSync(join(root, 'folder')) ? realpathSync(join(root, 'folder')) : undefined;
const dropped = existsSync(join(root, 'drop')) ? readdirSync(join(root, 'drop')).filter(name => !name.startsWith('.')).map(name => realpathSync(join(root, 'drop', name))) : [];
// One message, or several separated by a line of three dashes, each sent once the turn before it has ended.
const prompts = readFileSync(join(root, 'prompt.txt'), 'utf8').split(/^---\s*$/m).map(text => text.trim()).filter(Boolean);
// A real server in the model's chair (HEADLESS_ENDPOINT + HEADLESS_MODEL): the run then needs no replies from io/.
const real = process.env.HEADLESS_ENDPOINT && process.env.HEADLESS_MODEL ? { endpointUrl: process.env.HEADLESS_ENDPOINT, model: process.env.HEADLESS_MODEL } : undefined;
// Ask first (HEADLESS_GATE=1): the messages are the person's, read by the gate before the agent.
const gate = process.env.HEADLESS_GATE === '1';
const trace = (entry: Record<string, unknown>) => appendFileSync(join(root, 'trace.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

// ---- the model's chair: every completion request waits for its answer in io/
let requests = 0;
const server = createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'headless-model', context_length: 200000, max_completion_tokens: 8192 }] }));
    return;
  }
  if (!req.url?.endsWith('/chat/completions')) { res.statusCode = 404; res.end('{}'); return; }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const n = ++requests;
  const body = JSON.parse(raw) as { messages: unknown[]; tools?: Array<{ function: { name: string } }> };
  writeFileSync(join(io, `request-${n}.json`), raw);
  trace({ kind: 'request', n, messages: body.messages.length, tools: (body.tools ?? []).map(tool => tool.function.name), chars: raw.length });
  const answer = join(io, `reply-${n}.json`);
  for (let waited = 0; !existsSync(answer); waited += 250) {
    if (waited > 20 * 60_000 || res.destroyed || req.socket.destroyed) { res.destroy(); return; }
    await sleep(250);
  }
  await sleep(50);
  const reply = JSON.parse(readFileSync(answer, 'utf8')) as { content?: string; tool_calls?: Array<{ name: string; arguments: unknown }> };
  const calls = reply.tool_calls ?? [];
  trace({ kind: 'reply', n, content: (reply.content ?? '').slice(0, 300), calls: calls.map(call => call.name) });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const send = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  if (reply.content) send({ role: 'assistant', content: reply.content });
  calls.forEach((call, index) => send({ tool_calls: [{ index, id: `call_${n}_${index}`, type: 'function',
    function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}) } }] }));
  send({}, calls.length ? 'tool_calls' : 'stop');
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: Math.round(raw.length / 4), completion_tokens: Math.round(JSON.stringify(reply).length / 4) } })}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const port = (server.address() as { port: number }).port;

// ---- Hello, as the app builds it, on a data directory of its own
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const store = createDataStore(dataDir, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
store.saveSettings({ endpointUrl: real?.endpointUrl ?? `http://127.0.0.1:${port}/v1`, model: real?.model ?? 'headless-model',
  reasoningEffort: (process.env.HEADLESS_EFFORT as 'off' | 'low' | 'medium' | 'high' | undefined) ?? 'off', contextWindow: 200000, maxOutputTokens: 8192 });
const conversation = store.createConversation('Headless sheets run');
if (folder) store.updateConversation(conversation.id, { folder });
if (gate) store.updateConversation(conversation.id, { askFirst: true });
const sheets = new Workbooks({
  dataDir,
  resolveFile: async (conversationId, path, writing) => {
    const absolute = await scopedPath(store.getConversation(conversationId).folder, path, writing);
    return { absolute, relative: relative(store.getConversation(conversationId).folder!, absolute).split(sep).join('/') };
  },
  changed: event => trace({ kind: 'sheets-changed', ...event }),
});
let last: Message | undefined;
const seen = new Map<string, string>();
const chat = new ChatService({
  store, sheets, localServers: async () => [], requestTimeoutMs: 25 * 60_000,
  ...(process.env.HEADLESS_PI_ENTRY ? { piEntry: () => process.env.HEADLESS_PI_ENTRY! } : {}),
  emit: event => {
    last = event.message;
    for (const part of event.message.parts ?? []) {
      if (part.type !== 'tool') continue;
      const state = `${part.status}`;
      if (seen.get(part.id) === state) continue;
      seen.set(part.id, state);
      if (part.status === 'running') continue;
      trace({ kind: 'tool', name: part.name, status: part.status, input: part.input.slice(0, 600), inputChars: part.input.length,
        output: (part.output ?? '').slice(0, 500), outputChars: (part.output ?? '').length });
    }
  },
});

trace({ kind: 'start', port, folder, conversation: conversation.id, pi: process.env.HEADLESS_PI_ENTRY ?? 'bundled', model: real ?? 'headless', gate, turns: prompts.length });
writeFileSync(join(io, 'ready'), String(port));
// As the window does it: the files are dropped first, and a document that went to the chat's folder is named in the message.
const turns: unknown[] = [];
for (const [index, prompt] of prompts.entries()) {
  let said = prompt;
  if (index === 0 && dropped.length) {
    const landed = await chat.attach(conversation.id, dropped);
    trace({ kind: 'dropped', folder: landed.folder, documents: landed.documents, workbooks: landed.workbooks, attachments: landed.attachments.map(item => item.name) });
    const named = (landed.documents ?? []).filter(name => !said.includes(name));
    if (named.length) said = `${said.trimEnd()} ${named.join(' ')}`;
  }
  const started = Date.now();
  trace({ kind: 'send', turn: index + 1, text: said.slice(0, 300) });
  last = undefined;
  await chat.send(conversation.id, said, [], { gate });
  // send() resolves when the turn is accepted — or, with the gate, when the gate has answered; the turn ends when the message does.
  for (let waited = 0; waited < 60 * 60_000; waited += 300) {
    const state = last?.status;
    if (state && state !== 'streaming') break;
    await sleep(300);
  }
  await sleep(500);
  const final = store.listMessages(conversation.id).filter(message => message.role === 'assistant').at(-1);
  const parts = (final?.parts ?? []) as MessagePart[];
  const steps = parts.map(part => part.type === 'tool'
    ? { tool: part.name, status: part.status, input: part.input.slice(0, 400), output: (part.output ?? '').slice(0, 400) }
    : { [part.type]: part.text.slice(0, 2000) });
  turns.push({ turn: index + 1, said: said.slice(0, 300), status: final?.status, error: final?.error, workedMs: final?.workedMs, elapsedMs: Date.now() - started,
    gate: { waiting: store.getGate(conversation.id), lastOrder: store.getLastOrder(conversation.id) }, steps });
  trace({ kind: 'turn-end', turn: index + 1, status: final?.status, error: final?.error, elapsedMs: Date.now() - started, tools: parts.filter(part => part.type === 'tool').length });
}
const final = store.listMessages(conversation.id).filter(message => message.role === 'assistant').at(-1);
writeFileSync(join(root, 'result.json'), JSON.stringify({
  status: final?.status, error: final?.error, workedMs: final?.workedMs,
  turns,
  workbooks: await sheets.list(conversation.id).catch(() => []),
}, null, 1));
trace({ kind: 'end', status: final?.status, error: final?.error, requests });
writeFileSync(join(io, 'done'), final?.status ?? 'unknown');
await chat.dispose().catch(() => {});
store.close();
server.close();
process.exit(0);
