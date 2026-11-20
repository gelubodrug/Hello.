import { describe, expect, it } from 'vitest';
import { runGate, type GateVerdict } from '../src/main/chat/gate';
import type { AppSettings } from '../src/shared/types';

// A manual evaluation of the gate against a real local server, skipped unless asked for:
//
//   GATE_EVAL=1 GATE_URL=http://127.0.0.1:8000/v1 GATE_MODEL=<id> node scripts/run-tests.mjs tests/gate-eval.test.ts
//
// It prints what the gate made of each request so the prompt can be tuned by reading, and it
// fails only on the gross errors: a question asked of a clear request or a conversation, none
// asked of a request that cannot be executed as it stands, more than three, or a skipped call.
const url = process.env.GATE_URL ?? 'http://127.0.0.1:8000/v1';
const model = process.env.GATE_MODEL ?? '';
const folder = process.env.GATE_FOLDER ?? '/Users/q/Downloads/tasks/gps file test 3';

type Expect = 'clear' | 'ask' | 'either';
interface Case { name: string; request: string; expect: Expect; folder?: boolean; prior?: string; work?: boolean }
const cases: Case[] = [
  // Clear: every detail is in the request, or is an execution decision.
  { name: 'exact edit', expect: 'clear', work: true, folder: true, request: 'În fișierul build_report.py, în funcția care scrie foaia pivot_ore, schimbă culoarea heatmap-ului din roșu în albastru. Nimic altceva.' },
  { name: 'convert file', expect: 'clear', folder: true, request: 'Convertește gps_tracking_3months.xlsx în CSV, aceleași coloane, separator virgulă, salvat ca gps.csv lângă sursă.' },
  { name: 'readme', expect: 'clear', folder: true, request: 'Scrie un README.md în folder care descrie scriptul build_report.py: ce intrare ia, ce iese, cum se rulează.' },
  { name: 'rename fn', expect: 'clear', folder: true, request: 'Rename the function parseGateAnswer to readGateAnswer in gate.ts and update its call sites.' },
  { name: 'count rows', expect: 'clear', folder: true, request: 'Fă un script Python care numără rândurile din fiecare CSV din folder și scrie totalul pe fișier într-un summary.txt.' },
  // Conversation and questions: nothing to execute, nothing to ask.
  { name: 'question', expect: 'clear', work: false, request: 'Ce e diferența dintre MTP și un drafter DFlash2?' },
  { name: 'thanks', expect: 'clear', work: false, request: 'mulțumesc, e perfect' },
  { name: 'explain', expect: 'clear', work: false, request: 'How does a jet engine work, in short?' },
  // Vague: the result depends on what only the person knows.
  { name: 'gps vague', expect: 'ask', folder: true, request: 'fă-mi un raport din fișierul gps cu mașinile cele mai active și pune-l într-un excel' },
  { name: 'clean data', expect: 'ask', folder: true, request: 'curăță datele astea și fă ceva util cu ele' },
  { name: 'faster site', expect: 'ask', request: 'fă site-ul mai rapid' },
  { name: 'send invoice', expect: 'ask', request: 'trimite factura clientului' },
  { name: 'login bug', expect: 'ask', request: 'fix the bug in the login' },
  { name: 'no folder, file work', expect: 'ask', request: 'fă-mi un raport din fișierul gps cu mașinile cele mai active și pune-l într-un excel' },
  // Borderline: assumptions should carry it, or one question at most.
  { name: 'compare pdfs', expect: 'either', folder: true, request: 'compară cele două fișiere PDF din folder și spune-mi ce diferă' },
  { name: 'chart no context', expect: 'either', folder: true, request: 'Adaugă un grafic cu bare în raportul Excel de ieri' },
  // Follow-ups to an order the agent already executed in this chat.
  { name: 'follow-up sheet', expect: 'clear', folder: true, prior: 'Build top_10_active_cars.xlsx from gps_tracking_3months.xlsx: total km per car from speed over time, top 10 by km, sheets Top 10, Toate masinile, Metodă.',
    request: 'acum adaugă și o foaie cu kilometrii pe lună pentru fiecare mașină' },
  { name: 'follow-up chart', expect: 'clear', folder: true, prior: 'Build top_10_active_cars.xlsx from gps_tracking_3months.xlsx: total km per car from speed over time, top 10 by km, sheets Top 10, Toate masinile, Metodă.',
    request: 'pune un grafic cu bare pe foaia Top 10' },
];

const settings = { endpointUrl: url, model, apiKeySet: false, systemPrompt: '', temperature: 0.7, connections: [] } as AppSettings;

function summary(verdict: GateVerdict): string {
  if (verdict.kind === 'skipped') return `SKIPPED: ${verdict.reason}`;
  const lines = [`understood: ${verdict.understood.replace(/\n/g, ' / ')}`];
  if (verdict.kind === 'ready') lines.push(...verdict.assumptions.map(item => `assumed: ${item}`));
  else lines.push(...verdict.questions.map(item => `Q: ${item}`));
  return lines.join('\n      ');
}

describe.skipIf(!process.env.GATE_EVAL)('the gate against a live server', () => {
  it('reads every case', async () => {
    expect(model, 'GATE_MODEL names the served model').toBeTruthy();
    const report: string[] = [];
    const failures: string[] = [];
    for (const item of cases) {
      const started = Date.now();
      const verdict = await runGate({ fetcher: fetch, url: `${url.replace(/\/$/, '')}/chat/completions`, settings, folder: item.folder ? folder : null, prior: item.prior },
        { request: item.request, questions: [], answers: [], rounds: 0 });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const questions = verdict.kind === 'ask' ? verdict.questions.length : 0;
      const verdictName = verdict.kind === 'skipped' ? 'skipped' : questions ? `ask ${questions}` : verdict.kind === 'ready' && !verdict.work ? 'chat' : 'ready';
      let bad = '';
      if (verdict.kind === 'skipped') bad = 'skipped';
      else if (item.expect === 'clear' && questions) bad = 'asked a clear request';
      else if (item.expect === 'ask' && !questions) bad = 'let an unclear request through';
      else if (questions > 3) bad = 'too many questions';
      else if (verdict.kind === 'ready' && item.work !== undefined && verdict.work !== item.work) bad = verdict.work ? 'took a conversation for work' : 'took work for a conversation';
      report.push(`${bad ? 'FAIL' : 'ok  '} ${item.name.padEnd(22)} ${verdictName.padEnd(7)} ${seconds}s${bad ? `  <- ${bad}` : ''}\n      ${summary(verdict)}`);
      if (bad) failures.push(`${item.name}: ${bad}`);
    }
    console.log(`\n${report.join('\n')}\n`);
    expect(failures, failures.join('; ')).toEqual([]);
  }, 20 * 60_000);
});
