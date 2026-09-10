import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectCliWorkers,
  prepareCliWorkerLaunch,
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
    expect(launch.args).toEqual([]);
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
    expect(launch.args).toEqual([
      "--model",
      `hello-active/${spec.endpoint.model}`,
    ]);
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
      "aider",
    ]);
    expect(
      workers.filter((worker) => worker.installed).map((worker) => worker.id),
    ).toEqual(["codex"]);
  });

  it.each(WORKER_CATALOG)(
    "builds exact $id argv, path discovery and child-only credentials",
    (worker) => {
      const spec = input(worker);
      const launch = prepareCliWorkerLaunch(spec);
      expect(launch.command).toBe(`/fake/${worker.binary}`);
      expect(launch.env.HELLO_RUNBOOK_PATH).toBe(spec.notebooks.runbook);
      expect(launch.env.HELLO_RUNBOOK_TASKS_PATH).toBe(spec.notebooks.tasks);
      expect(launch.args.join(" ")).not.toMatch(
        /dangerously|yolo|--auto\b|--yes-always|test-only-sentinel/,
      );
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
        expect(launch.args).toEqual([]);
        expect(Object.values(launch.env)).not.toContain("test-only-sentinel");
      }
    },
  );

  it("does not require endpoint credentials for Claude/Codex but explains missing active-model configuration", () => {
    expect(
      prepareCliWorkerLaunch({ ...input(WORKER_CATALOG[1]), endpoint: null })
        .args,
    ).toEqual([]);
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

  it.each(WORKER_CATALOG.filter((worker) => worker.id !== "aider"))(
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
      };
      const launch = prepareCliWorkerLaunch({ ...spec, context });
      expect(launch.notebookContext).toBe(true);
      expect(launch.env).toMatchObject(context.env);
      expect(launch.command).toBe(spec.worker.command);
      expect(launch.args.join(" ")).not.toContain("fake-bridge-secret");
      expect(launch.args.some((arg) => [
        "--prompt", "-p", "--prompt-interactive", "-i",
        "--message", "--message-file", "--print", "--yes", "--auto",
      ].includes(arg))).toBe(false);

      switch (worker.id) {
        case "claude":
          expect(launch.args).toEqual(["--append-system-prompt-file", context.instructionsPath]);
          break;
        case "codex": {
          expect(launch.args).toHaveLength(2);
          expect(launch.args[0]).toBe("-c");
          expect(launch.args[1]).toBe(`developer_instructions=${JSON.stringify(context.instructions)}`);
          expect(JSON.parse(launch.args[1].slice("developer_instructions=".length))).toBe(context.instructions);
          break;
        }
        case "qwen":
        case "kimi": {
          expect(launch.args).toEqual(worker.id === "qwen" ? ["--model", spec.endpoint.model] : []);
          const directory = worker.id === "qwen" ? launch.env.QWEN_HOME : launch.env.KIMI_CODE_HOME;
          const file = join(directory, worker.id === "qwen" ? "QWEN.md" : "AGENTS.md");
          expect(directory).toBe(launch.configurationDirectory);
          expect(directory.startsWith(join(spec.userDataDir, "cli-workers"))).toBe(true);
          expect(readFileSync(file, "utf8")).toBe(context.instructions);
          expect(statSync(file).mode & 0o777).toBe(0o600);
          break;
        }
        case "opencode": {
          expect(launch.args).toEqual(["--model", `hello-active/${spec.endpoint.model}`]);
          const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
          expect(config.instructions).toEqual([context.instructionsPath]);
          expect(config.provider["hello-active"].options.apiKey).toBe("{env:HELLO_CLI_WORKER_API_KEY}");
          break;
        }
        case "pi":
          expect(launch.args).toEqual([
            "--model", `hello-active/${spec.endpoint.model}`,
            "--append-system-prompt", context.instructionsPath,
          ]);
          break;
      }
      expect(context.close).not.toHaveBeenCalled();
    },
  );

  it("does not pretend Aider supports passive notebook context or turn it into a startup prompt", () => {
    const spec = input(WORKER_CATALOG.find((worker) => worker.id === "aider")!);
    const launch = prepareCliWorkerLaunch({
      ...spec,
      context: {
        env: {},
        instructionsPath: join(spec.userDataDir, "HELLO.md"),
        instructions: "Wait for the human; do not run a task at launch.",
        close: vi.fn(async () => {}),
      },
    });
    expect(launch.notebookContext).not.toBe(true);
    expect(launch.args).toEqual([
      "--model", `openai/${spec.endpoint.model}`,
      "--openai-api-base", "http://127.0.0.1:1234/v1",
      "--no-auto-commits", "--no-show-model-warnings",
    ]);
    expect(launch.configurationDirectory).toBeUndefined();
  });
});
