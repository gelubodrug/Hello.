import { mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../atomic-write';
import { join } from 'node:path';

/**
 * How a CLI worker speaks to the chat that prompted it.
 *
 * Saying something to a worker was the easy half; hearing back was missing.
 * Watching its pane for an answer means guessing when a screen full of repaints
 * has settled, and guessing wrong either way. So the worker SPEAKS, on three
 * channels — the shape the user asked for here (18.09):
 *
 *   report  the work is finished (or blocked, or failed): one message, complete
 *   note    something the chat should know NOW, without ending the turn
 *   ask     a question the worker BLOCKS on, and the answer prints on its stdout
 *
 * The transport is a file in a directory only this pane's channel owns: no
 * port, no token to leak into a transcript, and a report already written
 * survives the app restarting before anyone reads it.
 */
export type ReportKind = 'report' | 'note' | 'ask';
export interface WorkerReport {
  kind: ReportKind;
  /** done, blocked or failed — whatever the worker said, bounded. */
  status: string;
  text: string;
  /** Present for an ask: the worker is waiting for answer(id, …). */
  askId?: string;
}
export interface ReportChannel {
  /** Handed to the worker's process. */
  env: Record<string, string>;
  /** The lines the worker is told about these channels. */
  instructions: string;
  /** Called for every message until close(). */
  listen(handler: (report: WorkerReport) => void): void;
  /** Hands an answer to a worker blocked on ask. */
  answer(askId: string, text: string): void;
  close(): void;
}

const MAX_REPORT_CHARS = 32_000;
/** fs.watch misses events on some volumes; a slow sweep is the floor. */
const SWEEP_MS = 1_000;
/** How long a worker waits for an answer before deciding for itself. */
export const ASK_TIMEOUT_SECONDS = 600;

/**
 * The command a worker runs to speak. POSIX sh, and never fatal to the worker's
 * own turn: it always exits 0, whatever happened on our side.
 */
export function reportScript(kind: ReportKind): string {
  const variable = kind === 'report' ? 'HELLO_REPORT' : kind === 'note' ? 'HELLO_NOTE' : 'HELLO_ASK';
  const heading = kind === 'report'
    ? `#   sh "$${variable}" <<'HELLO_END'\n#   what you did, where, and what is still to do\n#   HELLO_END\n#\n#   sh "$${variable}" --status blocked <<'HELLO_END'   (or failed)`
    : kind === 'note'
      ? `#   sh "$${variable}" "what the chat should know now"`
      : `#   sh "$${variable}" "your question"      # waits, then prints the answer`;
  const waiting = kind === 'ask'
    ? `
# The chat is woken with the question; its answer is printed HERE, on your
# stdout, so read it as ordinary tool output and carry on.
answers="$HELLO_REPORT_INBOX/../answers"
waited=0
while [ "$waited" -lt ${ASK_TIMEOUT_SECONDS} ]; do
  if [ -f "$answers/$id.answer" ]; then
    cat "$answers/$id.answer"
    rm -f "$answers/$id.answer" 2>/dev/null
    exit 0
  fi
  sleep 1
  waited=$((waited + 1))
done
echo "(no answer came back in time — decide it yourself and say what you assumed)"
exit 0`
    : `
echo "(handed to the chat. It arrives whether or not anyone is looking at this pane.)"
exit 0`;
  return `#!/bin/sh
# Hello — the worker speaks to the chat that prompted it. Run it as:
#
${heading}
#
# A quoted heredoc keeps the shell out of your words: backticks and $ inside
# stay text. Nothing printed after this command reaches the chat.
status=""
if [ "$1" = "--status" ]; then status="$2"; shift 2; fi
summary="$*"
if [ -z "$summary" ] && [ ! -t 0 ]; then summary=$(cat); fi
case "$summary" in
  *"--status blocked") status="\${status:-blocked}"; summary=\${summary%--status blocked} ;;
  *"--status failed") status="\${status:-failed}"; summary=\${summary%--status failed} ;;
esac
[ -n "$HELLO_REPORT_INBOX" ] || { echo "(no Hello chat is listening here — carry on and finish your turn normally)"; exit 0; }
[ -n "$summary" ] || { echo "(nothing was passed to send — write it after the command, or as a quoted heredoc)"; exit 0; }
id="${kind}-$(date +%s)-$$"
tmp="$HELLO_REPORT_INBOX/.$id"
{ printf 'kind: ${kind}\\nid: %s\\nstatus: %s\\n\\n' "$id" "\${status:-done}"; printf '%s\\n' "$summary"; } > "$tmp" 2>/dev/null \\
  && mv "$tmp" "$HELLO_REPORT_INBOX/$id.msg" 2>/dev/null || {
  rm -f "$tmp" 2>/dev/null
  echo "(it could not be handed over — say it in your turn instead, and do not retry in a loop)"
  exit 0
}
${waiting}
`;
}

/** A message file: its kind, id and status, a blank line, then the words. */
export function parseReport(content: string): WorkerReport {
  const [head, ...rest] = content.split('\n\n');
  const header = head ?? '';
  const status = /^status:\s*(.*)$/m.exec(header)?.[1]?.trim() || 'done';
  const kind = /^kind:\s*(note|ask)\s*$/m.exec(header)?.[1] as ReportKind | undefined;
  const askId = /^id:\s*(.*)$/m.exec(header)?.[1]?.trim();
  const text = (rest.length ? rest.join('\n\n') : header).trim();
  return {
    kind: kind ?? 'report',
    status: status.slice(0, 40),
    ...(kind === 'ask' && askId ? { askId: askId.slice(0, 120) } : {}),
    text: text.length > MAX_REPORT_CHARS ? `${text.slice(0, MAX_REPORT_CHARS)}\n…(cut here)` : text,
  };
}

/**
 * Opens the channels inside a directory the caller owns and removes: the three
 * scripts, the inbox they drop into, and a watch over it.
 */
export function openReportChannel(directory: string): ReportChannel {
  const inbox = join(directory, 'inbox');
  const answers = join(directory, 'answers');
  const scripts: Record<ReportKind, string> = {
    report: join(directory, 'report.sh'),
    note: join(directory, 'note.sh'),
    ask: join(directory, 'ask.sh'),
  };
  mkdirSync(inbox, { recursive: true, mode: 0o700 });
  mkdirSync(answers, { recursive: true, mode: 0o700 });
  for (const kind of ['report', 'note', 'ask'] as const)
    writeFileSync(scripts[kind], reportScript(kind), { mode: 0o700 });
  let handler: ((report: WorkerReport) => void) | null = null;
  let closed = false;
  const collect = () => {
    if (closed) return;
    let files: string[];
    try { files = readdirSync(inbox).filter(name => name.endsWith('.msg')).sort(); }
    catch { return; }
    for (const name of files) {
      const file = join(inbox, name);
      let content: string;
      try { content = readFileSync(file, 'utf8'); } catch { continue; }
      // Taken before it is delivered: a handler that throws must not leave the
      // same message to arrive again on the next sweep.
      try { unlinkSync(file); } catch { /* already gone */ }
      const report = parseReport(content);
      if (report.text) handler?.(report);
    }
  };
  let watcher: ReturnType<typeof watch> | undefined;
  try { watcher = watch(inbox, () => collect()); } catch { /* the sweep is the floor */ }
  const sweep = setInterval(collect, SWEEP_MS);
  sweep.unref?.();
  return {
    env: {
      HELLO_REPORT: scripts.report,
      HELLO_NOTE: scripts.note,
      HELLO_ASK: scripts.ask,
      HELLO_REPORT_INBOX: inbox,
    },
    instructions: [
      '## Speaking to the chat that opened this pane',
      'A chat in Hello can prompt you here, and these are how you answer it. They are shell commands; nothing else in this pane reaches the chat.',
      '',
      'When the work it asked for is finished:',
      '```sh',
      `sh "$HELLO_REPORT" <<'HELLO_END'`,
      'what you did, where, how it can be checked, and what is still to do',
      'HELLO_END',
      '```',
      'Add `--status blocked` or `--status failed` right after the path when that is the truth. The quoted delimiter keeps the shell out of your words: backticks and $ inside stay text.',
      '',
      'While you are still working, the moment you learn something that changes what the chat asked for — a premise that turned out false, a file it did not know about, something that cannot be done the way it said — send it at once and carry on:',
      '```sh',
      `sh "$HELLO_NOTE" "what you found"`,
      '```',
      '',
      'When you need a decision only the chat can make, ask and wait — the answer is printed back here, on your own output:',
      '```sh',
      `sh "$HELLO_ASK" "your question"`,
      '```',
      `It waits up to ${Math.round(ASK_TIMEOUT_SECONDS / 60)} minutes and then tells you to decide yourself. Ask rather than guessing on something that matters; guess rather than stopping on something that does not.`,
      '',
      'Report work the chat delivered to you, or something the human here asks you to send. A person talking to you in this terminal is a conversation, not a task: answer them here and send nothing.',
      'Nothing printed after these commands reaches the chat, and this screen is not a channel — one report, complete.',
      '',
    ].join('\n'),
    listen(next) {
      handler = next;
      // Anything that arrived before anyone was listening is still theirs.
      collect();
    },
    answer(askId, text) {
      if (closed) throw new Error('That pane has closed; nothing is waiting for an answer.');
      if (!/^ask-[\w.-]{1,100}$/.test(askId)) throw new Error('That is not a question id from this pane.');
      // Written aside and moved into place: the worker polling for it must
      // never read half an answer.
      const file = join(answers, `${askId}.answer`);
      atomicWriteFileSync(file, `${text}\n`);
    },
    close() {
      closed = true;
      clearInterval(sweep);
      watcher?.close();
      handler = null;
      for (const path of [inbox, answers]) {
        try { rmSync(path, { recursive: true, force: true }); } catch { /* the caller removes the directory */ }
      }
    },
  };
}

/** The last lines of a pane, for the words a worker leaves on screen. */
export function lastLines(text: string, count = 30): string {
  const lines = text.split('\n');
  return lines.length <= count ? text : lines.slice(-count).join('\n');
}
