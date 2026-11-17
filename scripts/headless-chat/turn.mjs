// The model's chair, from the outside. `turn` prints what the chat sends the
// model next; `turn reply.json` first hands in the model's answer to the
// request that is waiting, then prints the one after it.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const io = join(dirname(fileURLToPath(import.meta.url)), 'io');
const statePath = join(io, 'state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { answered: 0, shown: [] };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const text = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => part?.type === 'text' ? part.text : `[${part?.type ?? 'part'}]`).join('\n') : JSON.stringify(content);

const answer = process.argv[2];
if (answer) {
  const pending = join(io, `request-${state.answered + 1}.json`);
  if (!existsSync(pending)) { console.log('There is no request waiting for an answer. Run `turn` with no argument to see the next one.'); process.exit(1); }
  let reply;
  try { reply = JSON.parse(readFileSync(answer, 'utf8')); } catch (error) { console.log(`Your reply file is not valid JSON (${error.message}). Nothing was sent; fix the file and run this again.`); process.exit(1); }
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply) || (reply.tool_calls !== undefined && !Array.isArray(reply.tool_calls))) {
    console.log('A reply is {"content": "...", "tool_calls": [{"name": "...", "arguments": {...}}]} — either key may be left out. Nothing was sent.'); process.exit(1);
  }
  for (const call of reply.tool_calls ?? []) if (typeof call?.name !== 'string') { console.log('Each tool call needs a "name". Nothing was sent.'); process.exit(1); }
  copyFileSync(answer, join(io, `reply-${state.answered + 1}.json`));
  state.answered += 1;
  writeFileSync(statePath, JSON.stringify(state));
}

const next = join(io, `request-${state.answered + 1}.json`);
for (let waited = 0; !existsSync(next); waited += 300) {
  if (existsSync(join(io, 'done'))) { console.log(`RUN COMPLETE — the chat turn has ended (${readFileSync(join(io, 'done'), 'utf8')}). There is nothing more to answer.`); process.exit(0); }
  if (waited > 9 * 60_000) { console.log('Still waiting for the chat to send its next request (a tool may be running). Run `turn` again with no argument.'); process.exit(0); }
  await sleep(300);
}
await sleep(150);
const request = JSON.parse(readFileSync(next, 'utf8'));
const messages = request.messages ?? [];
const out = [];
out.push(`===== MODEL INPUT ${state.answered + 1} =====`);
let from = 0;
if (state.answered === 0) {
  for (const message of messages.filter(item => item.role === 'system' || item.role === 'developer')) out.push('--- SYSTEM PROMPT ---', text(message.content));
} else {
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index].role === 'assistant') { from = index + 1; break; }
}
for (const message of messages.slice(from)) {
  if (message.role === 'system' || message.role === 'developer') continue;
  const label = message.role === 'tool' ? `TOOL RESULT (${message.tool_call_id ?? ''})` : message.role === 'user' ? 'USER / CONTEXT MESSAGE' : String(message.role).toUpperCase();
  out.push(`--- ${label} ---`, text(message.content));
}
const tools = (request.tools ?? []).map(tool => tool.function);
const fresh = tools.filter(tool => !state.shown.includes(tool.name));
out.push('--- TOOLS YOU CAN CALL IN THIS STEP ---', tools.map(tool => tool.name).join(', ') || '(none)');
if (fresh.length) {
  out.push('--- DEFINITIONS OF TOOLS NOT SHOWN TO YOU BEFORE ---');
  for (const tool of fresh) out.push(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  state.shown.push(...fresh.map(tool => tool.name));
  writeFileSync(statePath, JSON.stringify(state));
}
out.push('===== END OF MODEL INPUT — answer by writing a reply file and running `turn <that file>` =====');
console.log(out.join('\n'));
