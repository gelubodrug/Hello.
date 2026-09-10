import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Conversation,
  NotebookPaths,
  TerminalData,
  TerminalExit,
  WorkerId,
} from "../src/shared/types";
import {
  MainTerminalService,
  FLUSH_INTERVAL_MS,
  MAX_FLUSH_CHARS,
  SCROLLBACK_CHARS,
  MAX_SESSIONS,
  capFlush,
} from "../src/main/terminal/service";
import { WORKER_CATALOG } from "../src/main/terminal/cli-workers";
import type { PtyProcess, SpawnPty } from "../src/main/terminal/native";
import type { WorkerNotebookContext } from "../src/main/terminal/notebook-context";

class FakePty implements PtyProcess {
  pid = 1;
  data = new Set<(data: string) => void>();
  exits = new Set<(event: { exitCode: number }) => void>();
  write = vi.fn();
  resize = vi.fn();
  kill = vi.fn();
  pause = vi.fn();
  resume = vi.fn();
  onData(callback: (data: string) => void) {
    this.data.add(callback);
    return {
      dispose: () => {
        this.data.delete(callback);
      },
    };
  }
  onExit(callback: (event: { exitCode: number }) => void) {
    this.exits.add(callback);
    return {
      dispose: () => {
        this.exits.delete(callback);
      },
    };
  }
  print(data: string) {
    for (const callback of this.data) callback(data);
  }
  exit(exitCode: number) {
    for (const callback of this.exits) callback({ exitCode });
  }
}
const roots: string[] = [];
const services: MainTerminalService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

function fixture(withNotebookContext = false) {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "hello-terminal-test-"));
  roots.push(root);
  const folder = join(root, "repo with spaces ; not a command");
  mkdirSync(folder);
  const conversation: Conversation = {
    id: "chat",
    title: "Chat",
    folder,
    createdAt: 1,
    updatedAt: 1,
  };
  const lookup = vi.fn((id: string) =>
    id === "chat" ? conversation : undefined,
  );
  const notebooks = {
    runbook: join(root, "runbook.md"),
    tasks: join(root, "tasks.md"),
  };
  writeFileSync(notebooks.runbook, "");
  writeFileSync(notebooks.tasks, "");
  const notebookPaths = vi.fn<() => NotebookPaths | Promise<NotebookPaths>>(
    () => notebooks,
  );
  const notebookContext: WorkerNotebookContext = {
    env: {
      HELLO_NOTEBOOK_BRIDGE_URL: "http://127.0.0.1:12345",
      HELLO_NOTEBOOK_BRIDGE_TOKEN: "fake-session-token",
    },
    instructionsPath: join(root, 'context with spaces; "quotes"', "HELLO.md"),
    instructions: "Hello Tasks are app entries for this chat. Wait for the human's request.",
    close: vi.fn(async () => {}),
  };
  const openNotebookContext = vi.fn<(
    conversationId: string,
    cwd: string,
  ) => Promise<WorkerNotebookContext>>().mockResolvedValue(notebookContext);
  const processes: FakePty[] = [];
  const spawn = vi.fn<SpawnPty>(() => {
    const pty = new FakePty();
    processes.push(pty);
    return pty;
  });
  const emitData = vi.fn<(event: TerminalData) => void>();
  const emitExit = vi.fn<(event: TerminalExit) => void>();
  const service = new MainTerminalService({
    lookupConversation: lookup,
    endpoint: () => ({
      endpointUrl: "http://localhost:1234/v1",
      model: "local-model",
    }),
    notebookPaths,
    ...(withNotebookContext ? { openNotebookContext } : {}),
    userDataDir: root,
    emitData,
    emitExit,
    home: root,
    spawn,
    env: {
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/zsh",
      ELECTRON_RUN_AS_NODE: "1",
      OD_DONE: "/not-inherited",
    },
    detectWorkers: () =>
      WORKER_CATALOG.map(({ binary, ...worker }) => ({
        ...worker,
        command: `/test-bin/${binary}`,
        installed: true,
      })),
  });
  services.push(service);
  return {
    service,
    root,
    folder,
    conversation,
    lookup,
    notebookPaths,
    notebookContext,
    openNotebookContext,
    notebooks,
    processes,
    spawn,
    emitData,
    emitExit,
  };
}

describe("main terminal service", () => {
  it("does not spawn on construction/list/detection; launches a login shell in this chat folder only on create", async () => {
    const f = fixture();
    expect(f.service.list()).toEqual([]);
    expect(f.service.workers()).toHaveLength(7);
    expect(f.spawn).not.toHaveBeenCalled();
    const session = await f.service.create("chat");
    expect(session).toMatchObject({
      conversationId: "chat",
      cwd: f.folder,
      kind: "terminal",
      status: "running",
    });
    expect(f.spawn).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-l"],
      expect.objectContaining({ cwd: f.folder, cols: 80, rows: 24 }),
    );
    expect(f.spawn.mock.calls[0][2].env).not.toHaveProperty(
      "ELECTRON_RUN_AS_NODE",
    );
    expect(f.spawn.mock.calls[0][2].env).not.toHaveProperty("OD_DONE");
    expect(f.notebookPaths).not.toHaveBeenCalled();
  });

  it("uses the home directory for a chat without a folder, without requiring a project group", async () => {
    const f = fixture();
    f.conversation.folder = null;
    expect((await f.service.create("chat")).cwd).toBe(f.root);
  });

  it.each(["missing", "relative", "file"] as const)(
    "rejects an unavailable %s cwd before spawning",
    async (kind) => {
      const f = fixture();
      f.conversation.folder =
        kind === "relative" ? "relative/path" : join(f.root, kind);
      if (kind === "file")
        writeFileSync(f.conversation.folder, "not a directory");
      await expect(f.service.create("chat")).rejects.toThrow(/folder/);
      expect(f.spawn).not.toHaveBeenCalled();
    },
  );

  it("rejects deleted chats and invalid worker IDs", async () => {
    const f = fixture();
    await expect(f.service.create("deleted")).rejects.toThrow(
      /no longer exists/,
    );
    await expect(
      f.service.create("chat", "unknown" as WorkerId),
    ).rejects.toThrow(/Unknown/);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each(["claude", "codex"] as const)(
    "launches %s directly with both empty notebook paths and no injected prompt or bypass",
    async (workerId) => {
      const f = fixture();
      const session = await f.service.create("chat", workerId);
      expect(session).toMatchObject({
        kind: "worker",
        workerId,
        conversationId: "chat",
      });
      expect(f.spawn).toHaveBeenCalledWith(
        `/test-bin/${workerId}`,
        [],
        expect.objectContaining({
          cwd: f.folder,
          env: expect.objectContaining({
            HELLO_RUNBOOK_PATH: f.notebooks.runbook,
            HELLO_RUNBOOK_TASKS_PATH: f.notebooks.tasks,
          }),
        }),
      );
      expect(f.processes[0].write).not.toHaveBeenCalled();
    },
  );

  it("continues consuming bounded output before attachment and while no pane is observing it", async () => {
    const f = fixture();
    const session = await f.service.create("chat");
    const pty = f.processes[0];
    for (let i = 0; i < 30; i++) pty.print("x".repeat(MAX_FLUSH_CHARS));
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(f.emitData).toHaveBeenCalledOnce();
    expect(f.emitData.mock.calls[0][0].data.length).toBeLessThanOrEqual(
      MAX_FLUSH_CHARS,
    );
    expect(pty.pause).not.toHaveBeenCalled();
    expect(pty.resume).not.toHaveBeenCalled();
    pty.print("\nbackground finished\n");
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    const snapshot = f.service.attach(session.id);
    expect(snapshot.scrollback.length).toBeLessThanOrEqual(SCROLLBACK_CHARS);
    expect(snapshot.scrollback).toContain("background finished");
    expect(snapshot.sequence).toBe(2);
  });

  it("flushes the pending prompt into a cursor-bearing snapshot and emits monotonically", async () => {
    const f = fixture();
    const session = await f.service.create("chat");
    f.processes[0].print("prompt");
    expect(f.service.attach(session.id)).toMatchObject({
      scrollback: "prompt",
      sequence: 1,
    });
    f.processes[0].print(" next");
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(f.emitData.mock.calls.map(([event]) => event.sequence)).toEqual([
      1, 2,
    ]);
    expect(f.service.attach(session.id).scrollback).toBe("prompt next");
    expect(f.emitData).toHaveBeenCalledTimes(2);
  });

  it("keeps an exited transcript attachable, rejects input, and detaches listeners", async () => {
    const f = fixture();
    const session = await f.service.create("chat");
    const pty = f.processes[0];
    pty.print("final output");
    pty.exit(7);
    expect(f.emitExit).toHaveBeenCalledWith({ id: session.id, exitCode: 7 });
    expect(f.service.attach(session.id)).toMatchObject({
      session: { status: "exited", exitCode: 7 },
      scrollback: "final output",
    });
    expect(() => f.service.write(session.id, "anything")).toThrow(/exited/);
    expect(pty.data.size).toBe(0);
    expect(pty.exits.size).toBe(0);
    f.service.close(session.id);
    expect(f.service.list()).toEqual([]);
    expect(pty.kill).not.toHaveBeenCalled();
  });

  it("writes exactly the input, clamps resize, closes only the selected session and disposes all remaining PTYs", async () => {
    const f = fixture();
    const one = await f.service.create("chat");
    const two = await f.service.create("chat");
    f.service.write(one.id, "echo $HOME\r");
    expect(f.processes[0].write).toHaveBeenCalledWith("echo $HOME\r");
    f.service.resize(one.id, 0, 2000);
    expect(f.processes[0].resize).toHaveBeenCalledWith(1, 1000);
    expect(() => f.service.resize(one.id, NaN, 24)).toThrow(/Invalid/);
    f.service.close(one.id);
    f.service.close(one.id);
    expect(f.processes[0].kill).toHaveBeenCalledOnce();
    expect(f.processes[1].kill).not.toHaveBeenCalled();
    expect(f.service.list().map((s) => s.id)).toEqual([two.id]);
    f.service.dispose();
    expect(f.processes[1].kill).toHaveBeenCalledOnce();
    expect(f.service.list()).toEqual([]);
    await expect(f.service.create("chat")).rejects.toThrow(/closed/);
  });

  it("reserves capacity across concurrent notebook exports and rechecks chat existence after export", async () => {
    const f = fixture();
    let release!: (paths: NotebookPaths) => void;
    f.notebookPaths.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.service.create("chat", "codex");
    f.lookup.mockReturnValue(undefined);
    release(f.notebooks);
    await expect(pending).rejects.toThrow(/no longer exists/);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("bounds the inventory and does not spawn beyond its session limit", async () => {
    const f = fixture();
    await Promise.all(
      Array.from({ length: MAX_SESSIONS }, () => f.service.create("chat")),
    );
    await expect(f.service.create("chat")).rejects.toThrow(/Close a terminal/);
    expect(f.spawn).toHaveBeenCalledTimes(MAX_SESSIONS);
  });

  it("reserves capacity while asynchronous worker launches are waiting, and disposal cancels them before spawn", async () => {
    const f = fixture();
    const releases: Array<(paths: NotebookPaths) => void> = [];
    f.notebookPaths.mockImplementation(
      () => new Promise((resolve) => releases.push(resolve)),
    );
    const pending = Array.from({ length: MAX_SESSIONS }, () =>
      f.service.create("chat", "codex"),
    );
    await expect(f.service.create("chat", "codex")).rejects.toThrow(
      /Close a terminal/,
    );
    expect(f.spawn).not.toHaveBeenCalled();
    f.service.dispose();
    releases.forEach((resolve) => resolve(f.notebooks));
    const results = await Promise.allSettled(pending);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("retains a successfully launched CLI's own saved transcripts after exit and close", async () => {
    const f = fixture();
    const session = await f.service.create("chat", "pi");
    const directory = f.spawn.mock.calls[0][2].env.PI_CODING_AGENT_DIR;
    const transcript = join(directory, "saved-session.jsonl");
    writeFileSync(transcript, "session history");
    f.processes[0].exit(0);
    f.service.close(session.id);
    expect(readFileSync(transcript, "utf8")).toBe("session history");
  });

  it("removes only private worker configuration after a spawn failure", async () => {
    const f = fixture();
    f.spawn.mockImplementation(() => {
      throw new Error("spawn unavailable");
    });
    await expect(f.service.create("chat", "qwen")).rejects.toThrow(
      "spawn unavailable",
    );
    expect(readdirSync(join(f.root, "cli-workers"))).toEqual([]);
    expect(f.service.list()).toEqual([]);
  });

  it("kills a process and rolls back its inventory if listener setup fails", async () => {
    const f = fixture();
    const pty = new FakePty();
    pty.onData = () => {
      throw new Error("listener failed");
    };
    f.spawn.mockReturnValue(pty);
    await expect(f.service.create("chat")).rejects.toThrow("listener failed");
    expect(f.service.list()).toEqual([]);
    expect(pty.kill).toHaveBeenCalledOnce();
  });

  it("continues disposing other PTYs if one process reports it is already gone", async () => {
    const f = fixture();
    await f.service.create("chat");
    await f.service.create("chat");
    f.processes[0].kill.mockImplementation(() => {
      throw new Error("already gone");
    });
    expect(() => f.service.dispose()).not.toThrow();
    expect(f.processes[1].kill).toHaveBeenCalledOnce();
    expect(f.service.list()).toEqual([]);
  });

  it("bounds even tiny flush limits without accidentally keeping the whole tail", () => {
    expect(capFlush("a".repeat(100), 10)).toHaveLength(10);
  });

  it("binds notebook context to this chat and launch folder without writing a task into the PTY", async () => {
    const f = fixture(true);
    const session = await f.service.create("chat", "pi");
    expect(f.openNotebookContext).toHaveBeenCalledOnce();
    expect(f.openNotebookContext).toHaveBeenCalledWith("chat", f.folder);
    expect(session).toMatchObject({ cwd: f.folder, notebookContext: true });
    expect(f.spawn.mock.calls[0][1]).toEqual([
      "--model", "hello-active/local-model",
      "--append-system-prompt", f.notebookContext.instructionsPath,
    ]);
    expect(f.spawn.mock.calls[0][2]).toMatchObject({
      cwd: f.folder,
      env: f.notebookContext.env,
    });
    expect(f.processes[0].write).not.toHaveBeenCalled();
    expect(f.notebookContext.close).not.toHaveBeenCalled();
    const nextFolder = join(f.root, "other selected folder");
    mkdirSync(nextFolder);
    f.conversation.folder = nextFolder;
    expect(f.service.attach(session.id).session.cwd).toBe(f.folder);
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it.each([undefined, "aider"] as const)(
    "does not open a notebook bridge for %s without a supported passive loader",
    async (workerId) => {
      const f = fixture(true);
      const session = await f.service.create("chat", workerId);
      expect(f.openNotebookContext).not.toHaveBeenCalled();
      expect(session.notebookContext).not.toBe(true);
      expect(f.spawn.mock.calls[0][2].env).not.toHaveProperty("HELLO_NOTEBOOK_BRIDGE_TOKEN");
      expect(f.processes[0].write).not.toHaveBeenCalled();
    },
  );

  it.each(["exit", "close", "dispose"] as const)(
    "revokes notebook access once on terminal %s",
    async (finish) => {
      const f = fixture(true);
      const session = await f.service.create("chat", "codex");
      if (finish === "exit") f.processes[0].exit(0);
      else if (finish === "close") f.service.close(session.id);
      else f.service.dispose();
      expect(f.notebookContext.close).toHaveBeenCalledOnce();
      f.service.close(session.id);
      f.service.dispose();
      expect(f.notebookContext.close).toHaveBeenCalledOnce();
    },
  );

  it.each(["spawn", "listener"] as const)(
    "revokes notebook access when %s setup fails",
    async (stage) => {
      const f = fixture(true);
      if (stage === "spawn") {
        f.spawn.mockImplementation(() => { throw new Error("startup failed"); });
      } else {
        const pty = new FakePty();
        pty.onData = () => { throw new Error("startup failed"); };
        f.spawn.mockReturnValue(pty);
      }
      await expect(f.service.create("chat", "codex")).rejects.toThrow("startup failed");
      expect(f.notebookContext.close).toHaveBeenCalledOnce();
      expect(f.service.list()).toEqual([]);
    },
  );

  it("rejects a folder change during asynchronous notebook connection and closes the unused context", async () => {
    const f = fixture(true);
    let started!: () => void;
    const opening = new Promise<void>((resolve) => { started = resolve; });
    let release!: (context: WorkerNotebookContext) => void;
    f.openNotebookContext.mockImplementation(() => new Promise((resolve) => {
      release = resolve;
      started();
    }));
    const pending = f.service.create("chat", "codex");
    await opening;
    const nextFolder = join(f.root, "new folder during startup");
    mkdirSync(nextFolder);
    f.conversation.folder = nextFolder;
    release(f.notebookContext);
    await expect(pending).rejects.toThrow(/folder changed/);
    expect(f.notebookContext.close).toHaveBeenCalledOnce();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.service.list()).toEqual([]);
  });

  it("revokes a late notebook connection when the service closes before it resolves", async () => {
    const f = fixture(true);
    let started!: () => void;
    const opening = new Promise<void>((resolve) => { started = resolve; });
    let release!: (context: WorkerNotebookContext) => void;
    f.openNotebookContext.mockImplementation(() => new Promise((resolve) => {
      release = resolve;
      started();
    }));
    const pending = f.service.create("chat", "pi");
    await opening;
    f.service.dispose();
    release(f.notebookContext);
    await expect(pending).rejects.toThrow(/closed/);
    expect(f.notebookContext.close).toHaveBeenCalledOnce();
    expect(f.spawn).not.toHaveBeenCalled();
  });
});
