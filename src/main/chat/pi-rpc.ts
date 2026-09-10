// Adapted from an earlier persistent Pi transport.
// Electron owns each child directly; no worker/reporting/orchestration code.
// Protocol: @earendil-works/pi-coding-agent 0.85.1 docs/rpc.md. A prompt ACK is
// acceptance only; consumers must wait for agent_settled, not agent_end.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 128;
const MAX_QUEUED_BYTES = 32 * 1024 * 1024;
const STDERR_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 1_500;
const SHUTDOWN_KILL_MS = 2_000;

export interface PiRpcEvent {
  type: string;
  [key: string]: unknown;
}

export interface PiRpcCommand {
  type: string;
  [key: string]: unknown;
}

export interface PiRpcResponse<T = unknown> {
  type: "response";
  id: string;
  command: string;
  success: true;
  data?: T;
}

export interface PiRpcExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
  error?: string;
  /** Bounded, redacted diagnostics; never contains the launch command/env. */
  stderr: string;
}

export interface PiRpcProcessOptions {
  command: string;
  /** Include --mode rpc here. The transport does not choose provider/session. */
  args?: readonly string[];
  cwd: string;
  /** Full launch environment when supplied; not merged with process.env. */
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: PiRpcEvent) => void;
  onExit?: (exit: PiRpcExit) => void;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  /** Additional secrets that must not appear in error/stderr diagnostics. */
  redactValues?: readonly string[];
}

export interface PiRpcPromptOptions {
  streamingBehavior?: "steer" | "followUp";
  images?: ReadonlyArray<{ type: "image"; data: string; mimeType: string }>;
}

interface PendingRequest {
  command: string;
  resolve: (value: PiRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function timeoutValue(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(600_000, Math.max(100, value))
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One persistent process per session. Disposed instances cannot be restarted. */
export class PiRpcProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private disposing: Promise<void> | undefined;
  private stopping = false;
  private closed = false;
  private ready = false;
  private failure: Error | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: PiRpcEvent) => void>();
  private stdoutParts: Buffer[] = [];
  private stdoutBytes = 0;
  private stderrTail: Buffer = Buffer.alloc(0);
  private stderrTruncated = false;
  private writeTail: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private readonly secrets: string[];
  private resolveClosed!: () => void;
  private readonly whenClosed = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });

  constructor(private readonly options: PiRpcProcessOptions) {
    this.secrets = [
      ...(options.redactValues ?? []),
      ...Object.entries(options.env ?? process.env)
        .filter(([key]) => /key|token|secret|password|credential|auth/i.test(key))
        .map(([, value]) => value ?? ""),
    ]
      .filter((value) => value.length >= 4)
      .sort((a, b) => b.length - a.length);
    if (options.onEvent) this.listeners.add(options.onEvent);
  }

  get isRunning(): boolean {
    return Boolean(this.child && !this.stopping && !this.closed);
  }

  subscribe(listener: (event: PiRpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Spawn and verify that Pi answers get_state. No model request is made. */
  start(): Promise<void> {
    if (this.stopping || this.closed) {
      return Promise.reject(this.failure ?? new Error("Pi session is closed."));
    }
    if (!this.starting) {
      this.starting = this.spawnAndHandshake().catch((error: unknown) => {
        const failure = this.asError(error, "Pi failed to start.");
        this.fail(failure);
        throw failure;
      });
    }
    return this.starting;
  }

  async request<T = unknown>(
    command: PiRpcCommand,
    timeoutMs?: number,
  ): Promise<PiRpcResponse<T>> {
    if (command.type === "extension_ui_response") {
      throw new Error("Use respondToExtension for one-way UI responses.");
    }
    await this.start();
    return this.dispatch(command, timeoutMs) as Promise<PiRpcResponse<T>>;
  }

  /** Resolves on acceptance, never on completion of the agent's work. */
  prompt(
    text: string,
    options: PiRpcPromptOptions = {},
  ): Promise<PiRpcResponse> {
    return this.request({ type: "prompt", message: text, ...options });
  }

  /** UI responses are not RPC commands: Pi does not acknowledge them. */
  async respondToExtension(response: {
    id: string;
    value?: string;
    confirmed?: boolean;
    cancelled?: boolean;
  }): Promise<void> {
    if (!response.id) throw new Error("An extension request id is required.");
    // Startup extensions may ask for input before get_state can complete.
    // Their responses must bypass the readiness handshake to avoid deadlock.
    if (!this.child) await this.start();
    const line = this.serialize({ ...response, type: "extension_ui_response" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.enqueueWrite(line),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error("Pi extension response could not be sent in time.");
            this.fail(error);
            reject(error);
          }, timeoutValue(this.options.requestTimeoutMs, DEFAULT_TIMEOUT_MS));
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Clear pending messages before abort, so Stop cannot start a queued turn. */
  async abort(): Promise<void> {
    if (!this.child || this.stopping || this.closed) return;
    if (!this.ready) {
      await this.dispose();
      return;
    }
    try {
      await this.request({ type: "clear_queue" }, 5_000);
      await this.request({ type: "abort" }, 5_000);
    } catch (error) {
      // A stuck/unresponsive abort cannot leave an invisible agent working.
      await this.dispose();
      throw error;
    }
  }

  /** Terminates the process group and waits for close; idempotent and bounded. */
  dispose(): Promise<void> {
    if (!this.disposing) this.disposing = this.terminate();
    return this.disposing;
  }

  private async spawnAndHandshake(): Promise<void> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.command, [...(this.options.args ?? [])], {
        cwd: this.options.cwd,
        env: this.options.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // A private POSIX process group lets shutdown include tool children.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
      this.failure = new Error(`Pi could not be launched${code ? ` (${code})` : ""}.`);
      this.finish(null, null);
      throw this.failure;
    }
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.readStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.stderrTail.length + chunk.length > STDERR_BYTES) this.stderrTruncated = true;
      this.stderrTail = Buffer.concat([this.stderrTail, chunk]).subarray(
        -STDERR_BYTES,
      );
    });
    child.stdout.on("error", () => this.fail(new Error("Pi output pipe failed.")));
    child.stderr.on("error", () => this.fail(new Error("Pi error pipe failed.")));
    child.stdin.on("error", () => this.fail(new Error("Pi input pipe failed.")));
    child.on("error", (error) => {
      // Error messages from spawn contain argv; expose only the error code.
      const code = (error as NodeJS.ErrnoException).code;
      this.fail(new Error(`Pi could not run${code ? ` (${code})` : ""}.`));
    });
    child.once("close", (code, signal) => this.finish(code, signal));
    child.once("exit", () => {
      if (!this.stopping && !this.closed) {
        // Descendants may retain pipe descriptors after the Pi parent exits.
        this.fail(new Error("Pi process exited unexpectedly."));
      }
    });
    child.stdout.once("end", () => {
      if (!this.stopping && !this.closed) {
        this.fail(new Error("Pi closed its RPC output."));
      }
    });
    await this.dispatch(
      { type: "get_state" },
      timeoutValue(this.options.startupTimeoutMs, DEFAULT_TIMEOUT_MS),
    );
    this.ready = true;
  }

  private dispatch(
    command: PiRpcCommand,
    timeoutMs?: number,
  ): Promise<PiRpcResponse> {
    if (this.stopping || this.closed || !this.child) {
      return Promise.reject(this.failure ?? new Error("Pi session is closed."));
    }
    if (typeof command.type !== "string" || !command.type) {
      return Promise.reject(new Error("An RPC command type is required."));
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error("Too many pending Pi commands."));
    }
    const id = randomUUID();
    let line: string;
    try {
      line = this.serialize({ ...command, id });
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        // An unacknowledged command may already be acting: close rather than
        // continue a warm session whose state is now unknown to the caller.
        this.fail(new Error(`Pi command timed out (${command.type}).`));
      }, timeoutValue(
        timeoutMs,
        timeoutValue(this.options.requestTimeoutMs, DEFAULT_TIMEOUT_MS),
      ));
      timer.unref();
      this.pending.set(id, { command: command.type, resolve, reject, timer });
      void this.enqueueWrite(line).catch((error: unknown) => {
        this.fail(this.asError(error, "Pi command could not be sent."));
      });
    });
  }

  private serialize(value: Record<string, unknown>): string {
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
      throw new Error("Pi command exceeds the 16 MiB transport limit.");
    }
    return line;
  }

  private enqueueWrite(line: string): Promise<void> {
    const bytes = Buffer.byteLength(line);
    if (this.queuedBytes + bytes > MAX_QUEUED_BYTES) {
      return Promise.reject(new Error("Pi command queue is full."));
    }
    this.queuedBytes += bytes;
    const write = this.writeTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.stopping || this.closed || !this.child?.stdin.writable) {
            reject(this.failure ?? new Error("Pi session is closed."));
            return;
          }
          // A full JSONL record is written in one call; callbacks serialize
          // concurrent callers and respect pipe backpressure.
          this.child.stdin.write(line, "utf8", (error) => {
            if (error) reject(new Error("Pi input pipe failed."));
            else resolve();
          });
        }),
    );
    this.writeTail = write.catch(() => undefined);
    return write.finally(() => {
      this.queuedBytes -= bytes;
    });
  }

  private readStdout(chunk: Buffer): void {
    if (this.stopping || this.closed) return;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      const piece = chunk.subarray(start, end);
      this.stdoutBytes += piece.length;
      if (this.stdoutBytes > MAX_RECORD_BYTES) {
        this.fail(new Error("Pi output exceeds the 16 MiB record limit."));
        return;
      }
      if (piece.length) this.stdoutParts.push(piece);
      if (newline === -1) return;
      let line = Buffer.concat(this.stdoutParts, this.stdoutBytes).toString(
        "utf8",
      );
      this.stdoutParts = [];
      this.stdoutBytes = 0;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length) this.readRecord(line);
      if (this.stopping || this.closed) return;
      start = newline + 1;
    }
  }

  private readRecord(line: string): void {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // Never echo malformed output: it may contain prompt text or secrets.
      this.fail(new Error("Pi emitted invalid JSON on its RPC output."));
      return;
    }
    if (!isRecord(record) || typeof record.type !== "string") {
      this.fail(new Error("Pi emitted an invalid RPC record."));
      return;
    }
    if (record.type === "response") {
      const pending =
        typeof record.id === "string" ? this.pending.get(record.id) : undefined;
      if (!pending) {
        if (record.command === "parse") {
          this.fail(new Error("Pi rejected an RPC command as invalid JSON."));
        }
        return;
      }
      if (
        record.command !== pending.command ||
        typeof record.success !== "boolean"
      ) {
        this.fail(new Error("Pi returned a mismatched RPC response."));
        return;
      }
      this.pending.delete(record.id as string);
      clearTimeout(pending.timer);
      if (record.success) pending.resolve(record as unknown as PiRpcResponse);
      else {
        pending.reject(
          new Error(
            this.redact(
              typeof record.error === "string"
                ? record.error
                : "Pi rejected the command.",
            ),
          ),
        );
      }
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(record as PiRpcEvent);
      } catch {
        // Consumer failures must not crash Electron or corrupt JSONL framing.
      }
    }
  }

  private fail(error: Error): void {
    if (this.closed || this.stopping) return;
    this.failure = error;
    this.rejectPending(error);
    void this.dispose().catch(() => undefined);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async terminate(): Promise<void> {
    this.stopping = true;
    this.rejectPending(this.failure ?? new Error("Pi session was closed."));
    this.stdoutParts = [];
    this.stdoutBytes = 0;
    if (!this.child) {
      this.finish(null, null);
      return;
    }
    if (this.closed) return;
    this.child.stdin.destroy();
    this.signalTree("SIGTERM");
    if (await this.waitForClose(SHUTDOWN_GRACE_MS)) return;
    this.signalTree("SIGKILL");
    if (await this.waitForClose(SHUTDOWN_KILL_MS)) return;
    // Escaped descendants can keep inherited pipes open; do not retain them.
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    if (await this.waitForClose(100)) return;
    throw new Error("Pi did not confirm process shutdown after termination.");
  }

  private signalTree(signal: "SIGTERM" | "SIGKILL"): void {
    const pid = this.child?.pid;
    if (!pid) return;
    if (process.platform === "win32") {
      // Windows has no POSIX process groups. taskkill is an executable, never
      // a shell command, and /T includes tools launched by the Pi process.
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => this.child?.kill(signal));
      const timer = setTimeout(() => killer.kill(), SHUTDOWN_KILL_MS);
      timer.unref();
      killer.once("close", () => clearTimeout(timer));
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      // It may already be reaped; still try the retained ChildProcess handle.
      this.child?.kill(signal);
    }
  }

  private async waitForClose(timeoutMs: number): Promise<boolean> {
    if (this.closed) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    });
    const closed = await Promise.race([this.whenClosed.then(() => true), timeout]);
    if (timer) clearTimeout(timer);
    return closed;
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    // A tool can ignore SIGTERM and close inherited pipes. Reap the private
    // group even if the Pi parent closed before the escalation timer fired.
    this.signalTree("SIGKILL");
    const expected = this.stopping && !this.failure;
    this.closed = true;
    const error =
      this.failure ??
      (!expected ? new Error("Pi session exited unexpectedly.") : undefined);
    this.rejectPending(error ?? new Error("Pi session is closed."));
    this.stdoutParts = [];
    this.stdoutBytes = 0;
    const exit: PiRpcExit = {
      code,
      signal,
      expected,
      ...(error ? { error: error.message } : {}),
      stderr: this.stderrDiagnostics(),
    };
    this.stderrTail = Buffer.alloc(0);
    this.resolveClosed();
    try {
      this.options.onExit?.(exit);
    } catch {
      // Shutdown must complete even if the consumer is already disposed.
    }
    this.listeners.clear();
  }

  private redact(value: string): string {
    let text = value;
    for (const secret of this.secrets) text = text.split(secret).join("[redacted]");
    return text
      .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
      .replace(/\b(?:sk|pk)-[a-zA-Z0-9_-]{8,}/g, "[redacted]")
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
      .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&#\s]+/gi, "$1[redacted]")
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
      .slice(-STDERR_BYTES);
  }

  private stderrDiagnostics(): string {
    let text = this.stderrTail.toString("utf8");
    if (this.stderrTruncated) {
      // Drop the truncated first line so a clipped secret cannot leak as an
      // unmatched suffix after exact-value redaction.
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : text.slice(newline + 1);
      text = `[Earlier stderr omitted]\n${text}`;
    }
    return this.redact(text);
  }

  private asError(error: unknown, fallback: string): Error {
    return new Error(error instanceof Error ? this.redact(error.message) : fallback);
  }
}
