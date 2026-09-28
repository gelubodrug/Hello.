// Adapted from the old terminal/manager.ts. This module owns PTYs, not UI layout.
import { randomUUID } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type {
  Conversation,
  NotebookPaths,
  TerminalAttach,
  TerminalData,
  TerminalExit,
  TerminalSession,
  WorkerId,
  WorkerInfo,
} from "../../shared/types";
import {
  detectCliWorkers,
  isWorkerId,
  prepareCliWorkerLaunch,
  type DetectedWorker,
  type EndpointCredentials,
  type WorkerLaunch,
} from "./cli-workers";
import { resolveTerminalShell, terminalEnv } from "./env";
import { lastLines, type WorkerReport } from "./report-channel";
import { probeNodePty, type PtyProcess, type SpawnPty } from "./native";
import type { WorkerNotebookContext } from "./notebook-context";

export const FLUSH_INTERVAL_MS = 8;
export const MAX_FLUSH_CHARS = 256 * 1024;
export const SCROLLBACK_CHARS = 256 * 1024;
export const MAX_SESSIONS = 16;

export function trimScrollback(text: string, limit = SCROLLBACK_CHARS): string {
  if (text.length <= limit) return text;
  const tail = text.slice(-limit);
  const breakAt = tail.indexOf("\n");
  return breakAt >= 0 && breakAt < 4096 ? tail.slice(breakAt + 1) : tail;
}

/**
 * A pane's output as words, for an agent to read: escape sequences removed,
 * a line rewritten in place kept only as it ended, and runs of blank lines
 * collapsed. A CLI worker paints its screen over and over, so the raw
 * scrollback is mostly cursor moves and repaints; this is what a person would
 * say was on the screen, not a faithful terminal.
 */
export function plainTranscript(scrollback: string, limit = 8_000): string {
  const text = scrollback
    // OSC (title, hyperlinks) up to its terminator, then CSI/other escapes.
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[[\]()#;?]*[0-9;]*[A-Za-z]/g, '')
    .replace(/\u001b./g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const lines = text.split('\n').map(line => {
    // A progress line rewrites itself with carriage returns: keep what it says now.
    const written = line.split('\r').filter(part => part.trim() !== '').at(-1) ?? '';
    return written.replace(/[ \t]+$/, '');
  });
  const kept: string[] = [];
  for (const line of lines) {
    if (line === '' && kept.at(-1) === '') continue;
    kept.push(line);
  }
  const joined = kept.join('\n').trim();
  return joined.length <= limit ? joined : `…\n${joined.slice(-limit)}`;
}

export function capFlush(text: string, limit = MAX_FLUSH_CHARS): string {
  if (text.length <= limit) return text;
  const marker =
    "\r\n[terminal: earlier output omitted during a large burst]\r\n";
  const kept = Math.max(0, limit - marker.length);
  return marker.slice(0, limit) + (kept > 0 ? text.slice(-kept) : "");
}

interface LiveSession {
  view: TerminalSession;
  /** Resolved when this worker speaks, so a wait ends the moment it does. */
  waiters: Set<() => void>;
  pty: PtyProcess;
  cols: number;
  rows: number;
  pending: string;
  scrollback: string;
  sequence: number;
  timer: ReturnType<typeof setTimeout> | null;
  listeners: Array<{ dispose(): void }>;
  notebookContext?: WorkerNotebookContext;
}

export interface MainTerminalServiceOptions {
  lookupConversation: (id: string) => Conversation | undefined;
  endpoint: () => EndpointCredentials | null;
  notebookPaths: (id: string) => NotebookPaths | Promise<NotebookPaths>;
  openNotebookContext?: (
    conversationId: string,
    cwd: string,
  ) => Promise<WorkerNotebookContext>;
  emitData: (event: TerminalData) => void;
  emitExit: (event: TerminalExit) => void;
  /** A worker spoke to the chat that opened it: a report, a note, a question. */
  onWorkerReport?: (event: WorkerReportEvent) => void;
  userDataDir: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  spawn?: SpawnPty;
  detectWorkers?: () => DetectedWorker[];
}

/**
 * The keys a chat may press in a pane. A CLI that is asking something of its
 * own — a trust prompt, a model picker, a menu — is not at its prompt, and a
 * line typed into it goes into the dialog (user, 20.09: Pi sat in its model
 * picker while the chat kept "sending" a question). Answering a dialog takes
 * keys, so these are the keys.
 */
export const PANE_KEYS = {
  enter: "\r",
  escape: "\u001b",
  up: "\u001b[A",
  down: "\u001b[B",
  left: "\u001b[D",
  right: "\u001b[C",
  tab: "\t",
  space: " ",
  backspace: "\u007f",
  y: "y",
  n: "n",
  "ctrl-c": "\u0003",
  "ctrl-d": "\u0004",
} as const;
export type PaneKey = keyof typeof PANE_KEYS;

/** What the screen showed after typing a line into a pane. */
export interface SubmitEvidence {
  /** The words appeared in the pane: it is taking input. */
  echoed: boolean;
  /** The prompt let go of them: Enter was accepted. */
  submitted: boolean;
  /** The screen moved on its own afterwards: something is running. */
  started: boolean;
  /** The last lines, as they stand now. */
  tail: string;
}

/**
 * Whether the INPUT AREA still holds these words.
 *
 * What was sent stays on screen — a TUI prints the message above its prompt —
 * so "is the text somewhere in the tail" answers nothing. The input area is
 * what comes after the last prompt line, and that is where a line that was
 * never taken is still sitting.
 */
export function promptHolds(transcript: string, line: string): boolean {
  const wanted = normalize(line);
  if (!wanted) return false;
  // A long line wraps, so both ends are looked for: either identifies it.
  const ends = [wanted.slice(0, 24), wanted.slice(-24)];
  const lines = transcript
    .split("\n")
    .map(text => text.replace(/[│|┃┆┊╎]/g, " ").trim())
    .filter(Boolean);
  // `findLastIndex` needs a newer lib target than this project compiles to.
  let prompt = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1)
    if (/^[>❯›$#%]/.test(lines[index])) { prompt = index; break; }
  const area = normalize((prompt >= 0 ? lines.slice(prompt) : lines.slice(-2)).join(" "));
  return ends.some(end => end.length > 0 && area.includes(end));
}
const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/** What a worker said, and which pane said it. */
export interface WorkerReportEvent extends WorkerReport {
  conversationId: string;
  paneId: string;
  title: string;
  worker?: WorkerId;
  /** The end of its screen: where a CLI leaves what is still to do. */
  tail: string;
}

export class MainTerminalService {
  private readonly sessions = new Map<string, LiveSession>();
  private starting = 0;
  private disposed = false;
  private spawn: SpawnPty | undefined;
  constructor(private readonly options: MainTerminalServiceOptions) {
    this.spawn = options.spawn;
  }

  list(): TerminalSession[] {
    return [...this.sessions.values()].map((session) => ({ ...session.view }));
  }

  private detected(): DetectedWorker[] {
    return (
      this.options.detectWorkers?.() ??
      detectCliWorkers({ env: this.options.env, home: this.options.home })
    );
  }

  workers(): WorkerInfo[] {
    return this.detected().map(({ command: _command, ...worker }) => worker);
  }

  private cwd(conversationId: string): string {
    const conversation = this.options.lookupConversation(conversationId);
    if (!conversation) throw new Error("This conversation no longer exists.");
    const cwd = conversation.folder ?? this.options.home ?? homedir();
    if (!isAbsolute(cwd))
      throw new Error("Choose an absolute folder for this chat.");
    try {
      if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Error(
        "The chat folder is unavailable. Choose an existing folder before launching a terminal.",
      );
    }
    return cwd;
  }

  async create(
    conversationId: string,
    workerId?: WorkerId,
  ): Promise<TerminalSession> {
    if (this.disposed) throw new Error("The terminal service has closed.");
    if (workerId !== undefined && !isWorkerId(workerId))
      throw new Error("Unknown CLI worker.");
    if (this.sessions.size + this.starting >= MAX_SESSIONS)
      throw new Error(
        `Close a terminal before opening more than ${MAX_SESSIONS} sessions.`,
      );
    this.cwd(conversationId);
    this.starting += 1;
    let launch: WorkerLaunch | undefined;
    let created: LiveSession | undefined;
    let notebookContext: WorkerNotebookContext | undefined;
    try {
      const worker = workerId
        ? this.detected().find((item) => item.id === workerId)
        : undefined;
      if (workerId && !worker?.installed)
        throw new Error(`${worker?.label ?? workerId} is not installed.`);
      const notebooks = worker
        ? await this.options.notebookPaths(conversationId)
        : undefined;
      // A chat may be deleted or its folder removed while notebooks are exported.
      if (this.disposed) throw new Error("The terminal service has closed.");
      const cwd = this.cwd(conversationId);
      // Aider has no verified passive instruction loader in the installed version.
      // Never replace context discovery with an automatically submitted task.
      if (worker && worker.id !== "aider") {
        notebookContext = await this.options.openNotebookContext?.(
          conversationId,
          cwd,
        );
        if (this.disposed) throw new Error("The terminal service has closed.");
        if (this.cwd(conversationId) !== cwd)
          throw new Error(
            "The chat folder changed while the CLI was opening. Launch it again in the selected folder.",
          );
      }
      if (worker && notebooks) {
        launch = prepareCliWorkerLaunch({
          worker,
          endpoint: this.options.endpoint(),
          notebooks,
          userDataDir: this.options.userDataDir,
          context: notebookContext,
        });
      } else {
        const shell = resolveTerminalShell(this.options.env);
        launch = { command: shell.file, args: shell.args, env: {} };
      }
      if (notebookContext && !launch.notebookContext) {
        await notebookContext.close();
        notebookContext = undefined;
      }
      if (!this.spawn) {
        const probe = probeNodePty();
        if (!probe.ok) throw new Error(probe.reason);
        this.spawn = probe.spawn;
      }
      const pty = this.spawn(launch.command, [...launch.args], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env: {
          ...terminalEnv(this.options.env, this.options.home),
          ...launch.env,
        },
      });
      const view: TerminalSession = {
        id: randomUUID(),
        conversationId,
        title: worker?.label ?? "Terminal",
        kind: worker ? "worker" : "terminal",
        ...(worker
          ? {
              workerId: worker.id,
              notebookContext: launch.notebookContext ?? false,
            }
          : {}),
        cwd,
        status: "running",
      };
      const session: LiveSession = {
        view,
        waiters: new Set(),
        pty,
        cols: 80,
        rows: 24,
        pending: "",
        scrollback: "",
        sequence: 0,
        timer: null,
        listeners: [],
        notebookContext,
      };
      created = session;
      this.sessions.set(view.id, session);
      // The worker speaks to the chat that opened it. Its last lines ride
      // along: a CLI puts "still to do" on the screen, not in the report.
      notebookContext?.listen(report => {
        this.flush(session);
        for (const wake of [...session.waiters]) wake();
        this.options.onWorkerReport?.({
          ...report,
          conversationId,
          paneId: view.id,
          title: view.title,
          ...(view.workerId ? { worker: view.workerId } : {}),
          tail: lastLines(plainTranscript(session.scrollback, 4_000), 30),
        });
      });
      session.listeners.push(
        pty.onData((data) => {
          session.pending = capFlush(session.pending + data);
          if (session.timer === null)
            session.timer = setTimeout(
              () => this.flush(session),
              FLUSH_INTERVAL_MS,
            );
        }),
      );
      session.listeners.push(
        pty.onExit(({ exitCode }) => {
          this.flush(session);
          session.view = { ...session.view, status: "exited", exitCode };
          this.detach(session);
          this.options.emitExit({ id: view.id, exitCode });
        }),
      );
      return { ...view };
    } catch (error) {
      if (created) {
        this.detach(created);
        notebookContext = undefined;
        this.sessions.delete(created.view.id);
        try {
          created.pty.kill();
        } catch {
          /* Preserve the original startup failure. */
        }
      }
      if (notebookContext) {
        try {
          await notebookContext.close();
        } catch {
          /* Preserve the original startup failure. */
        }
      }
      if (launch?.configurationDirectory) {
        try {
          rmSync(launch.configurationDirectory, { recursive: true, force: true });
        } catch {
          /* Preserve the original startup failure. */
        }
      }
      // Never expose child credentials by echoing the environment or launch args.
      throw error;
    } finally {
      this.starting -= 1;
    }
  }

  private get(id: string): LiveSession {
    const session = this.sessions.get(id);
    if (!session)
      throw new Error("This terminal session is no longer available.");
    return session;
  }

  private flush(session: LiveSession): void {
    if (session.timer !== null) clearTimeout(session.timer);
    session.timer = null;
    if (!session.pending) return;
    const data = session.pending;
    session.pending = "";
    session.scrollback = trimScrollback(session.scrollback + data);
    session.sequence += 1;
    // Always consume and deliver bounded output, even when the renderer is hidden.
    // Pausing on hide deadlocks background builds and interactive workers.
    this.options.emitData({
      id: session.view.id,
      data,
      sequence: session.sequence,
    });
  }

  attach(id: string): TerminalAttach {
    const session = this.get(id);
    this.flush(session);
    return {
      session: { ...session.view },
      scrollback: session.scrollback,
      sequence: session.sequence,
    };
  }

  /** What this pane has printed lately, as words. Never its raw escapes. */
  transcript(id: string, limit?: number): { session: TerminalSession; text: string } {
    const session = this.get(id);
    this.flush(session);
    return { session: { ...session.view }, text: plainTranscript(session.scrollback, limit) };
  }

  /** Hands an answer to a worker blocked on a question it asked. */
  answerWorker(id: string, askId: string, text: string): void {
    const session = this.get(id);
    if (!session.notebookContext)
      throw new Error("This pane has no channel back to the worker.");
    session.notebookContext.answer(askId, text);
  }

  /**
   * Types a line into a pane and presses Enter — and then LOOKS.
   *
   * Two things went wrong without this (user, 18.09). A TUI reads a chunk that
   * ends in a carriage return as pasted text, so the line landed in the prompt
   * box and sat there: Enter has to arrive on its own, after the text. And the
   * chat then said "sent" because it had called a tool, not because anything
   * had been submitted. So this reports what the screen shows: whether the
   * words appeared, and whether the prompt let go of them.
   */
  async submit(
    id: string,
    line: string,
    waits: { echo?: number; enter?: number; retry?: number; start?: number } = {},
  ): Promise<SubmitEvidence> {
    const session = this.get(id);
    if (session.view.status !== "running")
      throw new Error("This terminal process has exited.");
    if (line.length > 8_000) throw new Error("Terminal input is too large.");
    const echoWait = waits.echo ?? 150;
    const enterWait = waits.enter ?? 700;
    const retryWait = waits.retry ?? 700;
    const startWait = waits.start ?? 1_500;
    const holds = () => promptHolds(plainTranscript(session.scrollback, 4_000), line);
    session.pty.write(line);
    await pause(echoWait);
    this.flush(session);
    const echoed = holds();
    // Enter alone, in its own write: a chunk ending in CR is a paste.
    session.pty.write("\r");
    await pause(enterWait);
    this.flush(session);
    let submitted = !holds();
    if (!submitted) {
      // A slow repaint looks the same as a prompt that kept the line; wait
      // once more before deciding, and only then try the other Enter.
      await pause(retryWait);
      this.flush(session);
      submitted = !holds();
      if (!submitted) {
        session.pty.write("\n");
        await pause(retryWait);
        this.flush(session);
        submitted = !holds();
      }
    }
    // "It was sent" and "it is working" are two different claims, and the
    // chat was making the second from the first (user, 18.09). This is the
    // evidence for the second: the screen moved on by itself afterwards.
    const settled = plainTranscript(session.scrollback, 4_000);
    await pause(startWait);
    this.flush(session);
    const later = plainTranscript(session.scrollback, 4_000);
    return {
      echoed,
      submitted,
      started: submitted && later !== settled,
      tail: lastLines(later, 30),
    };
  }

  /**
   * Waits for a worker to speak, or for its screen to go quiet — once, instead
   * of the chat reading the pane every second and spending its turn on it
   * (user, 20.09: "verific din secundă în secundă, nu așteaptă raportul").
   */
  async waitFor(
    id: string,
    options: { seconds: number; quietMs?: number; tickMs?: number } = { seconds: 60 },
  ): Promise<{ outcome: "reported" | "quiet" | "still working" | "exited"; waitedMs: number; tail: string }> {
    const session = this.get(id);
    const quietMs = options.quietMs ?? 15_000;
    const tickMs = options.tickMs ?? 400;
    const deadline = Date.now() + Math.max(1_000, options.seconds * 1_000);
    const started = Date.now();
    let spoke = false;
    const wake = () => { spoke = true; };
    session.waiters.add(wake);
    try {
      this.flush(session);
      let seen = session.scrollback;
      let changedAt = Date.now();
      while (Date.now() < deadline) {
        await pause(tickMs);
        this.flush(session);
        if (spoke) break;
        if (session.view.status !== "running") break;
        if (session.scrollback !== seen) {
          seen = session.scrollback;
          changedAt = Date.now();
        } else if (Date.now() - changedAt >= quietMs) break;
      }
      const quiet = Date.now() - changedAt >= quietMs;
      return {
        outcome: spoke ? "reported"
          : session.view.status !== "running" ? "exited"
            : quiet ? "quiet" : "still working",
        waitedMs: Date.now() - started,
        tail: lastLines(plainTranscript(session.scrollback, 4_000), 30),
      };
    } finally {
      session.waiters.delete(wake);
    }
  }

  /** Presses one key in a pane and reports what the screen did about it. */
  async press(id: string, key: PaneKey, waits: { settle?: number } = {}): Promise<{ changed: boolean; tail: string }> {
    const session = this.get(id);
    if (session.view.status !== "running")
      throw new Error("This terminal process has exited.");
    const sequence = PANE_KEYS[key];
    if (sequence === undefined) throw new Error(`There is no ${JSON.stringify(key)} key here.`);
    this.flush(session);
    const before = plainTranscript(session.scrollback, 4_000);
    session.pty.write(sequence);
    await pause(waits.settle ?? 700);
    this.flush(session);
    const after = plainTranscript(session.scrollback, 4_000);
    return { changed: after !== before, tail: lastLines(after, 30) };
  }

  write(id: string, data: string): void {
    const session = this.get(id);
    if (session.view.status !== "running")
      throw new Error("This terminal process has exited.");
    if (typeof data !== "string" || data.length > 1024 * 1024)
      throw new Error("Terminal input is too large.");
    session.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.get(id);
    if (session.view.status !== "running") return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows))
      throw new Error("Invalid terminal size.");
    cols = Math.min(1000, Math.max(1, Math.round(cols)));
    rows = Math.min(1000, Math.max(1, Math.round(rows)));
    if (cols === session.cols && rows === session.rows) return;
    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
  }

  private detach(session: LiveSession): void {
    if (session.timer !== null) clearTimeout(session.timer);
    session.timer = null;
    for (const listener of session.listeners) listener.dispose();
    session.listeners = [];
    const notebookContext = session.notebookContext;
    session.notebookContext = undefined;
    if (notebookContext) void notebookContext.close().catch(() => {
      /* Closing the bridge revokes access before asynchronous server cleanup. */
    });
    // The worker's private home may contain its own saved sessions. Retain it.
  }

  close(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.detach(session);
    this.sessions.delete(id);
    if (session.view.status === "running") session.pty.kill();
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.sessions.keys()]) {
      try {
        this.close(id);
      } catch {
        /* One already-gone process must not leave other PTYs running. */
      }
    }
  }
}
