import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastLines, openReportChannel, parseReport, type WorkerReport } from '../src/main/terminal/report-channel';

// The worker speaks; nobody guesses from its screen. These run the real shell
// scripts the worker is handed, because a report that the shell mangles is a
// report the chat never gets (learned with backticks in an
// argument — hence the quoted heredoc).
let directory: string;
let channel: ReturnType<typeof openReportChannel>;
const heard: WorkerReport[] = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hello-report-'));
  channel = openReportChannel(directory);
  heard.length = 0;
  channel.listen(report => { heard.push(report); });
});
afterEach(() => {
  channel.close();
  rmSync(directory, { recursive: true, force: true });
});

function run(script: string, args: string[] = [], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('/bin/sh', [script, ...args], { env: { ...process.env, ...channel.env }, timeout: 20_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });
}
const arrived = async () => {
  await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0), { timeout: 5_000, interval: 50 });
  return heard.at(-1)!;
};

describe('a worker reporting to its chat', () => {
  it('carries a whole heredoc report, with the shell kept out of its words', async () => {
    const said = 'Ran `npm test` — 12 passed.\nStill to do: the $PATH case.';
    const printed = await run(channel.env.HELLO_REPORT, [], said);
    expect(printed).toContain('handed to the chat');
    const report = await arrived();
    expect(report.kind).toBe('report');
    expect(report.status).toBe('done');
    // Backticks and $ arrived as text, not as commands that ran.
    expect(report.text).toBe(said);
  });

  it('keeps blocked and failed as what they are, wherever the flag was put', async () => {
    await run(channel.env.HELLO_REPORT, ['--status', 'blocked'], 'No network in this sandbox.');
    expect((await arrived()).status).toBe('blocked');
    heard.length = 0;
    await run(channel.env.HELLO_REPORT, [], 'Tests will not build. --status failed');
    const salvaged = await arrived();
    expect(salvaged.status).toBe('failed');
    expect(salvaged.text).toBe('Tests will not build.');
  });

  it('sends a note without ending the turn', async () => {
    await run(channel.env.HELLO_NOTE, ['The folder has no package.json — using the one a level up.']);
    const note = await arrived();
    expect(note.kind).toBe('note');
    expect(note.text).toContain('no package.json');
  });

  it('blocks on a question and prints the answer the chat gives back', async () => {
    const asking = run(channel.env.HELLO_ASK, ['Overwrite index.html, or write beside it?']);
    const question = await arrived();
    expect(question.kind).toBe('ask');
    expect(question.askId).toMatch(/^ask-/);
    channel.answer(question.askId!, 'Write beside it: index.new.html.');
    await expect(asking).resolves.toContain('Write beside it: index.new.html.');
  });

  it('says so and exits cleanly when no chat is listening, whatever it was given', async () => {
    const orphan = await new Promise<string>((resolve, reject) => {
      const child = execFile('/bin/sh', [channel.env.HELLO_REPORT],
        { env: { ...process.env, HELLO_REPORT_INBOX: '' }, timeout: 10_000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)));
      child.stdin?.end('anything');
    });
    expect(orphan).toContain('no Hello chat is listening here');
    expect(await run(channel.env.HELLO_NOTE, [])).toContain('nothing was passed to send');
  });

  it('reads a message that arrived before anyone was listening', async () => {
    const quiet = openReportChannel(mkdtempSync(join(tmpdir(), 'hello-report-late-')));
    await new Promise<void>((resolve, reject) => {
      const child = execFile('/bin/sh', [quiet.env.HELLO_REPORT], { env: { ...process.env, ...quiet.env }, timeout: 10_000 },
        error => (error ? reject(error) : resolve()));
      child.stdin?.end('finished while the app was busy');
    });
    const late: WorkerReport[] = [];
    quiet.listen(report => { late.push(report); });
    expect(late).toHaveLength(1);
    expect(late[0].text).toBe('finished while the app was busy');
    quiet.close();
  });
});

describe('reading what a worker left', () => {
  it('parses a message and refuses an id that is not one of its own', () => {
    expect(parseReport('kind: note\nid: note-1\nstatus: done\n\nhello')).toEqual({ kind: 'note', status: 'done', text: 'hello' });
    expect(() => channel.answer('../escape', 'no')).toThrow(/not a question id/);
  });

  it('keeps the last lines, where a worker puts what is still to do', () => {
    const screen = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n');
    expect(lastLines(screen, 3)).toBe('line 97\nline 98\nline 99');
    expect(lastLines('short', 30)).toBe('short');
  });
});
