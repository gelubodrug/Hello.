// PTY launcher adapted from the old terminal/cli-workers.ts and coder/provider.ts.
// Own interactive clients, never shell command strings or synthetic prompts.
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { NotebookPaths, WorkerId, WorkerInfo } from "../../shared/types";
import { augmentedPath } from "./env";
import type { WorkerNotebookContext } from "./notebook-context";
import { usesQwenThinkingSwitch } from "../chat/qwen-thinking";
import { PI_THEME, PI_THEME_NAME } from "./pi-theme";

export const WORKER_CATALOG: ReadonlyArray<
  Omit<WorkerInfo, "installed"> & { binary: string }
> = [
  {
    id: "claude",
    label: "Claude Code",
    binary: "claude",
    usesActiveModel: false,
  },
  { id: "codex", label: "Codex CLI", binary: "codex", usesActiveModel: false },
  { id: "qwen", label: "Qwen Code", binary: "qwen", usesActiveModel: true },
  { id: "kimi", label: "Kimi Code", binary: "kimi", usesActiveModel: true },
  {
    id: "opencode",
    label: "OpenCode",
    binary: "opencode",
    usesActiveModel: true,
  },
  { id: "pi", label: "Pi", binary: "pi", usesActiveModel: true },
  { id: "aider", label: "Aider", binary: "aider", usesActiveModel: true },
];
export const WORKER_API_KEY_ENV = "HELLO_CLI_WORKER_API_KEY";
export interface EndpointCredentials {
  endpointUrl: string;
  model: string;
  apiKey?: string | null;
  /** Settings' Reasoning and model compatibility: what decides the thinking switch. */
  reasoningEffort?: "off" | "low" | "medium" | "high";
  modelCompatibility?: "auto" | "openai" | "qwen-chat-template";
}
export interface DetectedWorker extends WorkerInfo {
  command: string | null;
  /** A script of Hello's own that Electron runs as Node: the Pi the chats run on. */
  node?: boolean;
}

function executable(path: string): boolean {
  try {
    accessSync(
      path,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function detectCliWorkers(
  options: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    isExecutable?: (path: string) => boolean;
    /** Hello's own Pi CLI, beside the rpc-entry its chats start (user, 01.10:
     *  "tabul Pi să pornească același Pi ca chaturile"): an update from the
     *  sidebar updates the tab too, and Pi needs no install of its own. */
    piCli?: string;
  } = {},
): DetectedWorker[] {
  const env = options.env ?? process.env;
  const directories = augmentedPath(env, options.home ?? homedir()).split(
    delimiter,
  );
  const available = options.isExecutable ?? executable;
  return WORKER_CATALOG.map(({ binary, ...spec }) => {
    if (spec.id === "pi" && options.piCli) return { ...spec, installed: true, command: options.piCli, node: true };
    // Shell scripts on POSIX use their shebang. Windows .cmd wrappers require
    // a command interpreter, so only true executable shims are accepted here.
    const names =
      process.platform === "win32" ? [`${binary}.exe`, binary] : [binary];
    const command =
      directories
        .flatMap((dir) => names.map((name) => join(dir, name)))
        .find(available) ?? null;
    return { ...spec, installed: command !== null, command };
  });
}

export function isWorkerId(value: unknown): value is WorkerId {
  return WORKER_CATALOG.some((worker) => worker.id === value);
}

export interface WorkerLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Retain after successful launch: the client also stores its transcripts here. */
  configurationDirectory?: string;
  /** The client received passive Hello notebook guidance through its own loader. */
  notebookContext?: boolean;
}

/**
 * The never-ask switch each client actually has, verified against the
 * installed CLIs:
 *
 *   claude    --dangerously-skip-permissions
 *   codex     --dangerously-bypass-approvals-and-sandbox
 *   kimi      --auto            (`--yolo` is only "Ask When Needed" since 0.40)
 *   opencode  --auto
 *   aider     --yes-always
 *   qwen      settings tools.approvalMode = "yolo" (the flag was removed in 0.20)
 *   pi        nothing: Pi exposes no approval flag. `--approve` trusts a
 *             project's own files for the run, which is a different decision
 *             and not this one.
 */
export function autoMode(worker: WorkerId, launch: WorkerLaunch): void {
  const flags: Partial<Record<WorkerId, string[]>> = {
    claude: ["--dangerously-skip-permissions"],
    codex: ["--dangerously-bypass-approvals-and-sandbox"],
    kimi: ["--auto"],
    opencode: ["--auto"],
    aider: ["--yes-always"],
  };
  for (const flag of flags[worker] ?? [])
    if (!launch.args.includes(flag)) launch.args.push(flag);
}

/**
 * Hello's MCP server as a CLI's own config names it: no secret in it — the
 * CLI hands the server its environment, the connection's address and token
 * included (verified for Kimi, Qwen Code and OpenCode; user, 30.09).
 */
function helloServer(mcp: NonNullable<WorkerNotebookContext["mcp"]>) {
  return { command: mcp.runtime, args: [mcp.server], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** The CLIs that can continue a conversation by an id Hello gives them. */
export function continuesSessions(worker: WorkerId): boolean {
  return worker === "claude" || worker === "pi";
}

/**
 * Whether Claude Code wrote this conversation: it does so at the first message,
 * and `--resume` of one never spoken in ends the CLI. Found by its file name
 * in any project, however Claude names the project's folder.
 */
function claudeConversationWritten(id: string): boolean {
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  try {
    return readdirSync(projects).some((project) => existsSync(join(projects, project, `${id}.jsonl`)));
  } catch {
    return false;
  }
}

export function prepareCliWorkerLaunch(input: {
  worker: DetectedWorker;
  endpoint: EndpointCredentials | null;
  notebooks: NotebookPaths;
  userDataDir: string;
  context?: WorkerNotebookContext;
  /** The conversation it starts, or continues when `resume` (continuesSessions). */
  session?: { id: string; resume: boolean };
}): WorkerLaunch {
  const { worker } = input;
  if (!worker.command || !worker.installed)
    throw new Error(`${worker.label} is not installed.`);
  const base: WorkerLaunch = {
    command: worker.command,
    args: [],
    env: {
      HELLO_RUNBOOK_PATH: input.notebooks.runbook,
      HELLO_RUNBOOK_TASKS_PATH: input.notebooks.tasks,
      ...input.context?.env,
    },
  };
  /**
   * A CLI set as a chat tab comes back after a restart (user, 30.09), and one
   * that can continue its conversation continues it: Claude Code by the id it
   * was started with, Pi by its id in a session folder that outlives the app
   * (its private configuration folder does not).
   */
  const continueSession = (): void => {
    const session = input.session;
    if (!session || !continuesSessions(worker.id)) return;
    if (worker.id === "claude")
      base.args.push(...(session.resume && claudeConversationWritten(session.id)
        ? ["--resume", session.id] : ["--session-id", session.id]));
    else {
      const directory = join(input.userDataDir, "cli-sessions", "pi");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      base.args.push("--session-dir", directory, "--session-id", session.id);
    }
  };
  /** Hello's own Pi is a script, run by Electron as Node as the chats' Pi is. */
  const finish = (launch: WorkerLaunch): WorkerLaunch => worker.node
    ? { ...launch, command: process.execPath, args: [launch.command, ...launch.args], env: { ...launch.env, ELECTRON_RUN_AS_NODE: "1" } }
    : launch;
  const attachNotebookContext = (): WorkerLaunch => {
    const context = input.context;
    if (!context || worker.id === "aider") {
      continueSession();
      autoMode(worker.id, base);
      return finish(base);
    }
    switch (worker.id) {
      case "claude":
        base.args.push("--append-system-prompt-file", context.instructionsPath);
        // The connection as an MCP server (user, 30.09): its notebook and
        // browser tools as Claude's own. The token reaches the server by name.
        if (context.mcp) base.args.push("--mcp-config", context.mcp.config);
        break;
      case "codex":
        base.args.push(
          "-c",
          `developer_instructions=${JSON.stringify(context.instructions)}`,
        );
        // The same server for Codex, which hands the connection on by name
        // (env_vars) from its own environment.
        if (context.mcp)
          base.args.push(
            "-c", `mcp_servers.hello.command=${JSON.stringify(context.mcp.runtime)}`,
            "-c", `mcp_servers.hello.args=${JSON.stringify([context.mcp.server])}`,
            "-c", 'mcp_servers.hello.env={ ELECTRON_RUN_AS_NODE = "1" }',
            "-c", 'mcp_servers.hello.env_vars=["HELLO_NOTEBOOK_BRIDGE_URL", "HELLO_NOTEBOOK_BRIDGE_TOKEN"]',
          );
        break;
      case "qwen": {
        writeFileSync(join(base.env.QWEN_HOME, "QWEN.md"), context.instructions, {
          mode: 0o600,
        });
        // The connection as an MCP server in its private settings; Qwen Code
        // hands the server its own environment, the connection's included.
        if (context.mcp) {
          const file = join(base.env.QWEN_HOME, "settings.json");
          const settings = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> };
          settings.mcpServers = { ...settings.mcpServers, hello: helloServer(context.mcp) };
          writeFileSync(file, JSON.stringify(settings, null, 2), { mode: 0o600 });
        }
        break;
      }
      case "kimi":
        writeFileSync(
          join(base.env.KIMI_CODE_HOME, "AGENTS.md"),
          context.instructions,
          { mode: 0o600 },
        );
        // Its user-level mcp.json, in the private home Hello gives it: Kimi
        // merges its whole environment into a stdio server's.
        if (context.mcp)
          writeFileSync(
            join(base.env.KIMI_CODE_HOME, "mcp.json"),
            JSON.stringify({ mcpServers: { hello: helloServer(context.mcp) } }, null, 2),
            { mode: 0o600 },
          );
        break;
      case "opencode": {
        const config = JSON.parse(base.env.OPENCODE_CONFIG_CONTENT);
        config.instructions = [context.instructionsPath];
        // A local MCP server gets OpenCode's environment, the connection's included.
        if (context.mcp)
          config.mcp = { ...config.mcp, hello: {
            type: "local", command: [context.mcp.runtime, context.mcp.server],
            environment: { ELECTRON_RUN_AS_NODE: "1" },
          } };
        base.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
        break;
      }
      case "pi":
        base.args.push("--append-system-prompt", context.instructionsPath);
        // Hello's own extension (user, 30.09): the connection's notebook and
        // browser tools become Pi's own, not shell commands it has to recall.
        if (context.piExtension) {
          base.args.push("-e", context.piExtension.path);
          Object.assign(base.env, context.piExtension.env);
        }
        break;
    }
    continueSession();
    base.notebookContext = true;
    // Last, so the never-ask flag reads at the end of the argv — and after the
    // model-using clients have rebuilt their own argument list, which would
    // otherwise throw it away.
    autoMode(worker.id, base);
    return finish(base);
  };
  // EVERY CLI STARTS IN ITS OWN NEVER-ASK MODE (user, 20.09: "lansează toate
  // CLI-urile în auto mode, permission all, Never Ask… fiecare cu ce setare
  // are în acest sens"). A pane opened from Hello exists to work, and the
  // human gates the work in Hello — approvals here, the chat's own Tool
  // approvals setting, and what they choose to launch — not in a prompt inside
  // a pane nobody is watching. The flags differ per client, and each is the
  // one that client actually honours; where a client has none, it has none and
  // that is said rather than papered over.
  if (!worker.usesActiveModel) return attachNotebookContext();
  const selected = input.endpoint;
  if (!selected?.model.trim() || !selected.endpointUrl.trim()) {
    throw new Error(`${worker.label} needs an endpoint and model in Settings.`);
  }
  const url = new URL(selected.endpointUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "The model endpoint must be an HTTP(S) URL without embedded credentials.",
    );
  }
  const endpoint = selected.endpointUrl.replace(/\/+$/, "");
  const model = selected.model.trim();
  const key = selected.apiKey?.trim() || "dummy-key";
  // Reasoning in Settings reaches a local Qwen server from the CLIs too (user,
  // 30.09: "Claude in 10 seconds, the local model in 5 minutes"), each by the
  // way it takes extra request fields. Kimi has none for an OpenAI server: on
  // one, its "off" sends nothing and the server thinks at its own level.
  const effort = selected.reasoningEffort ?? "off";
  const qwenThinking = usesQwenThinkingSwitch(endpoint, model, selected.modelCompatibility ?? "auto");
  const thinkingFields = { chat_template_kwargs: { enable_thinking: effort !== "off" } };
  const privateConfig = (name?: string, value?: unknown): string => {
    const root = join(input.userDataDir, "cli-workers");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(join(root, `${worker.id}-`));
    base.configurationDirectory = directory;
    try {
      if (name)
        writeFileSync(join(directory, name), JSON.stringify(value, null, 2), {
          mode: 0o600,
        });
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    return directory;
  };
  try {
    switch (worker.id) {
      case "qwen": {
        const directory = privateConfig("settings.json", {
          modelProviders: {
            openai: [
              {
                id: model,
                name: model,
                envKey: "OPENAI_API_KEY",
                baseUrl: endpoint,
                generationConfig: {
                  contextWindowSize: 131072,
                  // Sent as written on an OpenAI-compatible server.
                  ...(qwenThinking ? { extra_body: thinkingFields, ...(effort === "off" ? { reasoning: false } : {}) } : {}),
                },
              },
            ],
          },
          security: { auth: { selectedType: "openai" } },
          model: { name: model },
          // qwen-code 0.20 removed `--approval-mode` from the CLI and moved it
          // here, where it holds for every launch.
          tools: { approvalMode: "yolo" },
        });
        base.args = ["--model", model];
        Object.assign(base.env, {
          QWEN_HOME: directory,
          OPENAI_API_KEY: key,
          OPENAI_BASE_URL: endpoint,
        });
        break;
      }
      case "kimi":
        base.args = [];
        Object.assign(base.env, {
          KIMI_CODE_HOME: privateConfig(),
          KIMI_MODEL_NAME: model,
          KIMI_MODEL_API_KEY: key,
          KIMI_MODEL_BASE_URL: endpoint,
          KIMI_MODEL_PROVIDER_TYPE: "openai",
          KIMI_MODEL_MAX_CONTEXT_SIZE: "262144",
        });
        break;
      case "opencode": {
        const provider = "hello-active";
        base.args = ["--model", `${provider}/${model}`];
        Object.assign(base.env, {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            provider: {
              [provider]: {
                npm: "@ai-sdk/openai-compatible",
                name: "Hello endpoint",
                options: {
                  baseURL: endpoint,
                  apiKey: `{env:${WORKER_API_KEY_ENV}}`,
                },
                // A model's options reach the request body through @ai-sdk/openai-compatible.
                models: { [model]: { name: model, ...(qwenThinking ? { options: thinkingFields } : {}) } },
              },
            },
            model: `${provider}/${model}`,
          }),
          [WORKER_API_KEY_ENV]: key,
        });
        break;
      }
      case "pi": {
        const provider = "hello-active";
        const directory = privateConfig("models.json", {
          providers: {
            [provider]: {
              api: "openai-completions",
              baseUrl: endpoint,
              apiKey: `$${WORKER_API_KEY_ENV}`,
              // The switch Hello's own chat uses, set by --thinking below.
              models: [{ id: model, ...(qwenThinking ? { reasoning: true, compat: { thinkingFormat: "qwen-chat-template" } } : {}) }],
            },
          },
        });
        // Hello's Pi theme, current in this Pi's own folder (user, 01.10): a theme
        // is found in themes/, and only settings' `theme` makes it the one used.
        mkdirSync(join(directory, "themes"), { recursive: true, mode: 0o700 });
        writeFileSync(join(directory, "themes", `${PI_THEME_NAME}.json`), JSON.stringify(PI_THEME, null, 2), { mode: 0o600 });
        writeFileSync(join(directory, "settings.json"), JSON.stringify({ theme: PI_THEME_NAME }, null, 2), { mode: 0o600 });
        base.args = ["--model", `${provider}/${model}`, ...(qwenThinking ? ["--thinking", effort] : [])];
        Object.assign(base.env, {
          PI_CODING_AGENT_DIR: directory,
          [WORKER_API_KEY_ENV]: key,
        });
        break;
      }
      case "aider":
        base.args = [
          "--model",
          `openai/${model}`,
          "--openai-api-base",
          endpoint,
          "--no-auto-commits",
          "--no-show-model-warnings",
        ];
        // Its model settings carry extra request fields (JSON is YAML).
        if (qwenThinking) {
          const directory = privateConfig("model-settings.yml", [
            { name: `openai/${model}`, extra_params: { extra_body: thinkingFields } },
          ]);
          base.args.push("--model-settings-file", join(directory, "model-settings.yml"));
        }
        base.env.OPENAI_API_KEY = key;
        break;
    }
    return attachNotebookContext();
  } catch (error) {
    if (base.configurationDirectory)
      rmSync(base.configurationDirectory, { recursive: true, force: true });
    throw error;
  }
}
