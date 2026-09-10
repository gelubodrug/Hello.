// PTY launcher adapted from the old terminal/cli-workers.ts and coder/provider.ts.
// Own interactive clients, never shell command strings or synthetic prompts.
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { NotebookPaths, WorkerId, WorkerInfo } from "../../shared/types";
import { augmentedPath } from "./env";
import type { WorkerNotebookContext } from "./notebook-context";

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
}
export interface DetectedWorker extends WorkerInfo {
  command: string | null;
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
  } = {},
): DetectedWorker[] {
  const env = options.env ?? process.env;
  const directories = augmentedPath(env, options.home ?? homedir()).split(
    delimiter,
  );
  const available = options.isExecutable ?? executable;
  return WORKER_CATALOG.map(({ binary, ...spec }) => {
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

export function prepareCliWorkerLaunch(input: {
  worker: DetectedWorker;
  endpoint: EndpointCredentials | null;
  notebooks: NotebookPaths;
  userDataDir: string;
  context?: WorkerNotebookContext;
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
  const attachNotebookContext = (): WorkerLaunch => {
    const context = input.context;
    if (!context || worker.id === "aider") return base;
    switch (worker.id) {
      case "claude":
        base.args.push("--append-system-prompt-file", context.instructionsPath);
        break;
      case "codex":
        base.args.push(
          "-c",
          `developer_instructions=${JSON.stringify(context.instructions)}`,
        );
        break;
      case "qwen":
        writeFileSync(join(base.env.QWEN_HOME, "QWEN.md"), context.instructions, {
          mode: 0o600,
        });
        break;
      case "kimi":
        writeFileSync(
          join(base.env.KIMI_CODE_HOME, "AGENTS.md"),
          context.instructions,
          { mode: 0o600 },
        );
        break;
      case "opencode": {
        const config = JSON.parse(base.env.OPENCODE_CONFIG_CONTENT);
        config.instructions = [context.instructionsPath];
        base.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
        break;
      }
      case "pi":
        base.args.push("--append-system-prompt", context.instructionsPath);
        break;
    }
    base.notebookContext = true;
    return base;
  };
  // Keep these clients' own auth and permission settings. No bypass/yolo flags.
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
                generationConfig: { contextWindowSize: 131072 },
              },
            ],
          },
          security: { auth: { selectedType: "openai" } },
          model: { name: model },
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
                models: { [model]: { name: model } },
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
              models: [{ id: model }],
            },
          },
        });
        base.args = ["--model", `${provider}/${model}`];
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
