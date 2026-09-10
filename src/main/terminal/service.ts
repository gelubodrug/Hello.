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

export function capFlush(text: string, limit = MAX_FLUSH_CHARS): string {
  if (text.length <= limit) return text;
  const marker =
    "\r\n[terminal: earlier output omitted during a large burst]\r\n";
  const kept = Math.max(0, limit - marker.length);
  return marker.slice(0, limit) + (kept > 0 ? text.slice(-kept) : "");
}

interface LiveSession {
  view: TerminalSession;
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
  userDataDir: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  spawn?: SpawnPty;
  detectWorkers?: () => DetectedWorker[];
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
