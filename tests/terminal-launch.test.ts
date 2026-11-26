import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectCliWorkers,
  prepareCliWorkerLaunch,
  saettaPack,
  WORKER_CATALOG,
  type DetectedWorker,
} from "../src/main/terminal/cli-workers";
import { augmentedPath, terminalEnv } from "../src/main/terminal/env";
import type { WorkerNotebookContext } from "../src/main/terminal/notebook-context";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function input(worker: (typeof WORKER_CATALOG)[number]) {
  const root = mkdtempSync(join(tmpdir(), "hello-cli-test-"));
  roots.push(root);
  return {
    worker: {
      ...worker,
      command: `/fake/${worker.binary}`,
      installed: true,
    } as DetectedWorker,
    endpoint: {
      endpointUrl: "http://127.0.0.1:1234/v1/",
      model: "model with spaces;echo nope",
      apiKey: "test-only-sentinel",
    },
    notebooks: {
      runbook: join(root, "runbook.md"),
      tasks: join(root, "tasks.md"),
      plan: join(root, "plan.md"),
    },
    userDataDir: root,
  };
}

describe("reused CLI launch boundary", () => {
  it("finds Kimi in its documented user install directory when Finder provides only a system PATH", () => {
    const spec = input(WORKER_CATALOG[3]);
    const directory = join(spec.userDataDir, ".kimi-code", "bin");
    mkdirSync(directory, { recursive: true });
    expect(
      augmentedPath({ PATH: "/usr/bin:/bin" }, spec.userDataDir).split(":"),
    ).toContain(directory);
    const workers = detectCliWorkers({
      env: { PATH: "/usr/bin:/bin" },
      home: spec.userDataDir,
      isExecutable: (path) => path === join(directory, "kimi"),
    });
    expect(workers.find((worker) => worker.id === "kimi")).toMatchObject({
      installed: true,
      command: join(directory, "kimi"),
    });
  });

  it("writes the Qwen 0.20 provider schema and explicit environment key without storing a secret", () => {
    const spec = input(WORKER_CATALOG[2]);
    const launch = prepareCliWorkerLaunch(spec);
    const config = JSON.parse(
      readFileSync(join(launch.env.QWEN_HOME, "settings.json"), "utf8"),
    );
    expect(config).toMatchObject({
      modelProviders: {
        openai: [
          {
            id: spec.endpoint.model,
            name: spec.endpoint.model,
            baseUrl: "http://127.0.0.1:1234/v1",
            envKey: "OPENAI_API_KEY",
          },
        ],
      },
      security: { auth: { selectedType: "openai" } },
      model: { name: spec.endpoint.model },
      // The flag was removed from qwen-code 0.20; the mode lives here now.
      tools: { approvalMode: "yolo" },
    });
    expect(launch.args).toEqual(["--model", spec.endpoint.model]);
  });

  it("uses Pi 0.85 environment interpolation, not an uppercase string literal", () => {
    const spec = input(WORKER_CATALOG[5]);
    const launch = prepareCliWorkerLaunch(spec);
    const config = JSON.parse(
      readFileSync(join(launch.env.PI_CODING_AGENT_DIR, "models.json"), "utf8"),
    );
    expect(config.providers["hello-active"]).toEqual({
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "$HELLO_CLI_WORKER_API_KEY",
      models: [{ id: spec.endpoint.model }],
    });
    expect(launch.args).toEqual([
      "--model",
      `hello-active/${spec.endpoint.model}`,
    ]);
  });

  it("defines Kimi's ephemeral model only through the installed KIMI_MODEL family", () => {
    const spec = input(WORKER_CATALOG[3]);
    const launch = prepareCliWorkerLaunch(spec);
    expect(launch.env).toMatchObject({
      KIMI_MODEL_NAME: spec.endpoint.model,
      KIMI_MODEL_API_KEY: "test-only-sentinel",
      KIMI_MODEL_BASE_URL: "http://127.0.0.1:1234/v1",
      KIMI_MODEL_PROVIDER_TYPE: "openai",
    });
    expect(readdirSync(launch.env.KIMI_CODE_HOME)).toEqual([]);
    // `--auto` is Never Ask; `--yolo` since 0.40 only means "Ask When Needed".
    expect(launch.args).toEqual(["--auto"]);
  });

  it("provides OpenCode's inline runtime schema and environment placeholder", () => {
    const spec = input(WORKER_CATALOG[4]);
    const launch = prepareCliWorkerLaunch(spec);
    const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
    expect(config.provider["hello-active"]).toMatchObject({
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: "http://127.0.0.1:1234/v1",
        apiKey: "{env:HELLO_CLI_WORKER_API_KEY}",
      },
    });
    // The model is named in the config, never on the command line: OpenCode's root command
    // has no --model, and v2.2.5 exits on an unrecognized flag (user, 20.11). --standalone keeps
    // that config this pane's own, instead of one background service holding another chat's.
    expect(config.model).toBe(`hello-active/${spec.endpoint.model}`);
    expect(launch.args).toEqual(["--standalone", "--auto"]);
    expect(launch.env.OPENCODE_CONFIG_CONTENT).not.toContain(
      "test-only-sentinel",
    );
  });
  it("detects all seven choices without execution and keeps missing workers visible as unavailable", () => {
    const workers = detectCliWorkers({
      env: { PATH: "/fake/bin" },
      home: "/fake/home",
      isExecutable: (path) => path === "/fake/bin/codex",
    });
    expect(workers.map((worker) => worker.id)).toEqual([
      "claude",
      "codex",
      "qwen",
      "kimi",
      "opencode",
      "pi",
      "saetta",
    ]);
    expect(
      workers.filter((worker) => worker.installed).map((worker) => worker.id),
    ).toEqual(["codex"]);
  });

/** The switch each client actually honours. */
const NEVER_ASK: Record<string, string[]> = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  kimi: ["--auto"],
  opencode: ["--auto"],
  // qwen-code 0.20 moved the mode into settings.json; Pi and its port Saetta have no such flag.
  qwen: [],
  pi: [],
  saetta: [],
};

  it.each(WORKER_CATALOG)(
    "builds exact $id argv, path discovery and child-only credentials",
    (worker) => {
      const spec = input(worker);
      const launch = prepareCliWorkerLaunch(spec);
      expect(launch.command).toBe(`/fake/${worker.binary}`);
      expect(launch.env.HELLO_RUNBOOK_PATH).toBe(spec.notebooks.runbook);
      expect(launch.env.HELLO_RUNBOOK_TASKS_PATH).toBe(spec.notebooks.tasks);
      // Every pane starts in the never-ask mode that client actually has
      // (user, 20.09). Where a client has none — Pi — it carries none.
      expect(launch.args).toEqual(expect.arrayContaining(NEVER_ASK[worker.id]));
      expect(launch.args.join(" ")).not.toContain("test-only-sentinel");
      if (worker.id === "pi" || worker.id === "saetta")
        expect(launch.args.join(" ")).not.toMatch(/dangerously|yolo|--auto\b|--yes-always/);
      expect(launch.env).not.toHaveProperty("OPENCODE_PERMISSION");
      if (worker.usesActiveModel) {
        expect(Object.values(launch.env)).toContain("test-only-sentinel");
        if (launch.configurationDirectory) {
          expect(
            launch.configurationDirectory.startsWith(
              join(spec.userDataDir, "cli-workers"),
            ),
          ).toBe(true);
          expect(statSync(launch.configurationDirectory).mode & 0o777).toBe(
            0o700,
          );
          const file =
            worker.id === "qwen"
              ? "settings.json"
              : worker.id === "pi"
                ? "models.json"
                : null;
          if (file)
            expect(
              readFileSync(join(launch.configurationDirectory, file), "utf8"),
            ).not.toContain("test-only-sentinel");
        }
      } else {
        // Claude and Codex keep their own credentials; the only thing Hello
        // adds to their argv is the never-ask flag. Saetta runs a pack on this Mac.
        expect(launch.args).toEqual(worker.id === "saetta"
          ? ["code", "--pack", saettaPack()]
          : NEVER_ASK[worker.id]);
        expect(Object.values(launch.env)).not.toContain("test-only-sentinel");
      }
    },
  );

  it("does not require endpoint credentials for Claude/Codex but explains missing active-model configuration", () => {
    // Codex needs no endpoint of ours, and still starts in its never-ask mode.
    expect(
      prepareCliWorkerLaunch({ ...input(WORKER_CATALOG[1]), endpoint: null })
        .args,
    ).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    expect(() =>
      prepareCliWorkerLaunch({ ...input(WORKER_CATALOG[2]), endpoint: null }),
    ).toThrow(/endpoint and model/);
  });

  it("strips application/runtime secrets from the inherited shell environment", () => {
    const env = terminalEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/example",
      LANG: "ro_RO.UTF-8",
      SSH_AUTH_SOCK: "/socket",
      NODE_OPTIONS: "--bad",
      ELECTRON_RUN_AS_NODE: "1",
      OPENAI_API_KEY: "parent-only",
      OD_DONE: "not-a-terminal-channel",
    });
    expect(env).toMatchObject({
      HOME: "/example",
      LANG: "ro_RO.UTF-8",
      SSH_AUTH_SOCK: "/socket",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: "1",
    });
    for (const key of [
      "NODE_OPTIONS",
      "ELECTRON_RUN_AS_NODE",
      "OPENAI_API_KEY",
      "OD_DONE",
    ])
      expect(env).not.toHaveProperty(key);
  });

  it.each(WORKER_CATALOG)(
    "gives $id passive notebook context without submitting work or splitting special-character paths",
    (worker) => {
      const spec = input(worker);
      const context: WorkerNotebookContext = {
        instructionsPath: join(spec.userDataDir, 'context with spaces; $(noop) "quoted"', "HELLO.md"),
        instructions: 'Hello Tasks belong to this chat.\nUse the live connection; wait for the human.\nFolder: "repo with spaces; $(noop)". Backslash: \\.\n',
        env: {
          HELLO_NOTEBOOK_BRIDGE_URL: "http://127.0.0.1:12345",
          HELLO_NOTEBOOK_BRIDGE_TOKEN: "fake-bridge-secret",
        },
        close: vi.fn(async () => {}),
        listen: vi.fn(),
        answer: vi.fn(),
        piExtension: {
          path: join(spec.userDataDir, "out main", "pi-extension.js"),
          env: { HELLO_PI_BRIDGE_URL: "http://127.0.0.1:12345/", HELLO_PI_BRIDGE_TOKEN: "fake-pi-secret", HELLO_PI_EXTENSION_ROLE: "cli" },
        },
      };
      const launch = prepareCliWorkerLaunch({ ...spec, context });
      expect(launch.notebookContext).toBe(true);
      expect(launch.args.join(" ")).not.toContain("fake-pi-secret");
      // Only Pi loads Hello's own extension, and only Pi is given its connection.
      if (worker.id !== "pi") for (const key of Object.keys(context.piExtension!.env)) expect(launch.env).not.toHaveProperty(key);
      expect(launch.env).toMatchObject(context.env);
      expect(launch.command).toBe(spec.worker.command);
      expect(launch.args.join(" ")).not.toContain("fake-bridge-secret");
      // A pane is opened to be worked in, never handed a task at launch.
      // `--auto` is not on this list any more: it is the never-ask mode.
      expect(launch.args.some((arg) => [
        "--prompt", "-p", "--prompt-interactive", "-i",
        "--message", "--message-file", "--print", "--yes",
      ].includes(arg))).toBe(false);

      switch (worker.id) {
        case "claude":
          expect(launch.args).toEqual([
            "--append-system-prompt-file", context.instructionsPath,
            "--dangerously-skip-permissions",
          ]);
          break;
        case "codex": {
          expect(launch.args).toHaveLength(3);
          expect(launch.args[2]).toBe("--dangerously-bypass-approvals-and-sandbox");
          expect(launch.args[0]).toBe("-c");
          expect(launch.args[1]).toBe(`developer_instructions=${JSON.stringify(context.instructions)}`);
          expect(JSON.parse(launch.args[1].slice("developer_instructions=".length))).toBe(context.instructions);
          break;
        }
        case "qwen":
        case "kimi": {
          expect(launch.args).toEqual(worker.id === "qwen"
            ? ["--model", spec.endpoint.model]
            : ["--auto"]);
          const directory = worker.id === "qwen" ? launch.env.QWEN_HOME : launch.env.KIMI_CODE_HOME;
          const file = join(directory, worker.id === "qwen" ? "QWEN.md" : "AGENTS.md");
          expect(directory).toBe(launch.configurationDirectory);
          expect(directory.startsWith(join(spec.userDataDir, "cli-workers"))).toBe(true);
          expect(readFileSync(file, "utf8")).toBe(context.instructions);
          expect(statSync(file).mode & 0o777).toBe(0o600);
          break;
        }
        case "opencode": {
          // No --model on the root command: v2.2.5 refuses to start on it, and the config names the model.
          // --standalone so the pane runs its own server: a shared one holds whichever config started it.
          expect(launch.args).toEqual(["--standalone", "--auto"]);
          const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
          expect(config.instructions).toEqual([context.instructionsPath]);
          expect(config.provider["hello-active"].options.apiKey).toBe("{env:HELLO_CLI_WORKER_API_KEY}");
          break;
        }
        case "pi":
          // The connection's tools as Pi's own (user, 30.09).
          expect(launch.args).toEqual([
            "--model", `hello-active/${spec.endpoint.model}`,
            "--append-system-prompt", context.instructionsPath,
            "-e", context.piExtension!.path,
          ]);
          expect(launch.env).toMatchObject(context.piExtension!.env);
          break;
        case "saetta":
          // Saetta Code, Pi's port: the subcommand and the local pack first, Pi's own flags after.
          expect(launch.args).toEqual([
            "code", "--pack", saettaPack(),
            "--append-system-prompt", context.instructionsPath,
          ]);
          break;
      }
      expect(context.close).not.toHaveBeenCalled();
    },
  );

  // The connection as an MCP server for Claude Code and Codex (user, 30.09):
  // the token reaches it by name, never through argv.
  it("hands every CLI that speaks MCP Hello's server, with no secret in any of it", () => {
    const context: WorkerNotebookContext = {
      instructionsPath: "/private/session/HELLO.md", instructions: "Wait for the human.",
      env: { HELLO_NOTEBOOK_BRIDGE_URL: "http://127.0.0.1:12345", HELLO_NOTEBOOK_BRIDGE_TOKEN: "fake-bridge-secret" },
      close: vi.fn(async () => {}), listen: vi.fn(), answer: vi.fn(),
      mcp: { runtime: "/Applications/Hello.app/Contents/MacOS/Hello", server: "/private/session/hello-mcp.cjs", config: "/private/session/hello-mcp.json" },
    };
    const launch = (id: string) => prepareCliWorkerLaunch({ ...input(WORKER_CATALOG.find((worker) => worker.id === id)!), context });
    expect(launch("claude").args).toEqual([
      "--append-system-prompt-file", "/private/session/HELLO.md",
      "--mcp-config", "/private/session/hello-mcp.json",
      "--dangerously-skip-permissions",
    ]);
    const codex = launch("codex").args;
    expect(codex.slice(2, 10)).toEqual([
      "-c", 'mcp_servers.hello.command="/Applications/Hello.app/Contents/MacOS/Hello"',
      "-c", 'mcp_servers.hello.args=["/private/session/hello-mcp.cjs"]',
      "-c", 'mcp_servers.hello.env={ ELECTRON_RUN_AS_NODE = "1" }',
      "-c", 'mcp_servers.hello.env_vars=["HELLO_NOTEBOOK_BRIDGE_URL", "HELLO_NOTEBOOK_BRIDGE_TOKEN"]',
    ]);
    for (const id of ["claude", "codex", "qwen", "kimi", "opencode", "pi", "saetta"])
      expect(launch(id).args.join(" ")).not.toContain("fake-bridge-secret");
    // Kimi, Qwen Code and OpenCode take it in their own config, and hand it
    // their environment — the connection's included — so no file holds the token.
    const server = { command: context.mcp!.runtime, args: [context.mcp!.server], env: { ELECTRON_RUN_AS_NODE: "1" } };
    const kimi = launch("kimi");
    const kimiMcp = readFileSync(join(kimi.env.KIMI_CODE_HOME, "mcp.json"), "utf8");
    expect(JSON.parse(kimiMcp)).toEqual({ mcpServers: { hello: server } });
    const qwen = launch("qwen");
    const qwenSettings = readFileSync(join(qwen.env.QWEN_HOME, "settings.json"), "utf8");
    expect(JSON.parse(qwenSettings).mcpServers).toEqual({ hello: server });
    const opencode = JSON.parse(launch("opencode").env.OPENCODE_CONFIG_CONTENT);
    expect(opencode.mcp).toEqual({ hello: { type: "local", command: [context.mcp!.runtime, context.mcp!.server], environment: { ELECTRON_RUN_AS_NODE: "1" } } });
    // Saetta Code reads Pi's mcp.json from a private agent folder.
    const saetta = launch("saetta");
    expect(saetta.env.PI_CODING_AGENT_DIR).toBe(saetta.configurationDirectory);
    const saettaMcp = readFileSync(join(saetta.env.PI_CODING_AGENT_DIR, "mcp.json"), "utf8");
    expect(JSON.parse(saettaMcp)).toEqual({ mcpServers: { hello: server } });
    for (const text of [kimiMcp, qwenSettings, JSON.stringify(opencode), saettaMcp]) expect(text).not.toContain("fake-bridge-secret");
    expect(launch("pi").args.join(" ")).not.toContain("hello-mcp");
  });

  // Reasoning in Settings reaches a local Qwen server from the CLIs too (user,
  // 30.09: "Claude in 10 seconds, the local model in 5 minutes").
  it("switches a local Qwen model's thinking in every CLI that can send the field", () => {
    const local = { endpointUrl: "http://127.0.0.1:18090/v1", model: "mlx-community/Qwen3.8-27B-4bit", reasoningEffort: "off" as const };
    const launch = (id: string, endpoint: typeof local | Record<string, unknown> = local) =>
      prepareCliWorkerLaunch({ ...input(WORKER_CATALOG.find((worker) => worker.id === id)!), endpoint: endpoint as typeof local });
    const off = { chat_template_kwargs: { enable_thinking: false } };
    const qwen = launch("qwen");
    expect(JSON.parse(readFileSync(join(qwen.env.QWEN_HOME, "settings.json"), "utf8")).modelProviders.openai[0].generationConfig)
      .toEqual({ contextWindowSize: 131072, extra_body: off, reasoning: false });
    const opencode = JSON.parse(launch("opencode").env.OPENCODE_CONFIG_CONTENT);
    expect(opencode.provider["hello-active"].models[local.model]).toEqual({ name: local.model, options: off });
    expect(opencode.model).toBe(`hello-active/${local.model}`);
    const pi = launch("pi");
    expect(pi.args.slice(0, 4)).toEqual(["--model", `hello-active/${local.model}`, "--thinking", "off"]);
    expect(JSON.parse(readFileSync(join(pi.env.PI_CODING_AGENT_DIR, "models.json"), "utf8")).providers["hello-active"].models)
      .toEqual([{ id: local.model, reasoning: true, compat: { thinkingFormat: "qwen-chat-template" } }]);
    // Reasoning on says so; another model, or a server not the person's own, is left alone.
    expect(JSON.parse(launch("opencode", { ...local, reasoningEffort: "high" }).env.OPENCODE_CONFIG_CONTENT)
      .provider["hello-active"].models[local.model].options).toEqual({ chat_template_kwargs: { enable_thinking: true } });
    expect(JSON.parse(launch("opencode", { ...local, endpointUrl: "https://api.example.test/v1" }).env.OPENCODE_CONFIG_CONTENT)
      .provider["hello-active"].models[local.model]).toEqual({ name: local.model });
    expect(launch("pi", { ...local, model: "gemma-4-31b" }).args).not.toContain("--thinking");
  });

  // A CLI set as a chat tab comes back after a restart and continues its
  // conversation where the CLI can (user, 30.09): Claude Code and Pi.
  it("continues a conversation by Hello's id where the CLI can, and starts one otherwise", () => {
    const id = "0f3a6c1e-8a51-4c9e-9d2b-7c1f2a3b4c5d";
    const claude = input(WORKER_CATALOG.find((worker) => worker.id === "claude")!);
    const projects = join(claude.userDataDir, "claude-config", "projects", "-Users-q");
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(claude.userDataDir, "claude-config"));
    try {
      expect(prepareCliWorkerLaunch({ ...claude, session: { id, resume: false } }).args)
        .toEqual(["--session-id", id, "--dangerously-skip-permissions"]);
      // Resumed only once Claude has written it.
      expect(prepareCliWorkerLaunch({ ...claude, session: { id, resume: true } }).args)
        .toEqual(["--session-id", id, "--dangerously-skip-permissions"]);
      mkdirSync(projects, { recursive: true });
      writeFileSync(join(projects, `${id}.jsonl`), "{}\n");
      expect(prepareCliWorkerLaunch({ ...claude, session: { id, resume: true } }).args)
        .toEqual(["--resume", id, "--dangerously-skip-permissions"]);
    } finally {
      vi.unstubAllEnvs();
    }
    // Pi: the same id in a session folder that outlives the app.
    const pi = input(WORKER_CATALOG.find((worker) => worker.id === "pi")!);
    const launch = prepareCliWorkerLaunch({ ...pi, session: { id, resume: true } });
    const folder = join(pi.userDataDir, "cli-sessions", "pi");
    expect(launch.args.slice(-4)).toEqual(["--session-dir", folder, "--session-id", id]);
    expect(statSync(folder).isDirectory()).toBe(true);
    // Codex has no such id: nothing is added.
    const codex = input(WORKER_CATALOG.find((worker) => worker.id === "codex")!);
    expect(prepareCliWorkerLaunch({ ...codex, session: { id, resume: true } }).args).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
  });

  // User, 01.10: "tabul Pi să pornească același Pi ca chaturile", in its own theme.
  it("opens Hello's own Pi, the one the chats run on, in its own theme", () => {
    const cli = "/data/pi/runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
    const pi = detectCliWorkers({ env: { PATH: "" }, home: "/nowhere", isExecutable: () => false, piCli: cli }).find(worker => worker.id === "pi")!;
    expect(pi).toMatchObject({ installed: true, command: cli, node: true });
    const launch = prepareCliWorkerLaunch({ ...input(WORKER_CATALOG.find((worker) => worker.id === "pi")!), worker: pi });
    expect(launch.command).toBe(process.execPath);
    expect(launch.args[0]).toBe(cli);
    expect(launch.args.slice(1, 3)).toEqual(["--model", "hello-active/model with spaces;echo nope"]);
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
    const folder = launch.env.PI_CODING_AGENT_DIR;
    expect(JSON.parse(readFileSync(join(folder, "settings.json"), "utf8"))).toEqual({ theme: "hello" });
    expect(JSON.parse(readFileSync(join(folder, "themes", "hello.json"), "utf8"))).toMatchObject({ name: "hello", colors: { accent: "#82aaff", toolErrorBg: "" } });
  });
});
