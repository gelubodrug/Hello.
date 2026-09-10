# Authorized terminal reuse

Source repository: `/Users/q/Documents/app chat local models first` (read-only during this port).

- `native.ts` ports `src/main/terminal/native.ts`: lazy node-pty loading, native helper discovery/executable repair, readable diagnostics.
- `env.ts` adapts `src/main/terminal/env.ts` and `src/main/coder/binary.ts`: allowlisted environment, Finder/Homebrew PATH augmentation, login shell and truecolor.
- `service.ts` adapts `src/main/terminal/manager.ts`: 8 ms batching, bounded output/scrollback, PTY resize/input/exit cleanup. Hidden sessions no longer pause; lifecycle is independent of pane visibility. Snapshot/live sequence cursors avoid attach races.
- `cli-workers.ts` adapts `src/main/terminal/cli-workers.ts` and the Pi model schema in `src/main/coder/provider.ts`: seven installed CLI choices, exact executable/argv, main-only model credentials, isolated per-session config. Removed automatic permission-bypass/yolo flags. Notebook compatibility paths remain available, including empty notebooks; no task is submitted at launch.

The 2026-09-09 notebook connection is original Hello integration over its existing
Pi loopback transport and notebook tools. Six locally verified CLI context
loaders receive a small guide for live Runbook/Tasks access. Aider's installed
version is explicitly unsupported. No coordinator, worker task ledger, database
or instruction files from the source app were copied or modified.
- `src/renderer/terminal/TerminalPane.tsx` ports the renderer setup in the old `TerminalPane.tsx`: xterm 6, 13 px terminal face, line-height 1.15, 5,000 lines, Unicode 11, fit addon, custom WebGL glyphs with DOM fallback, copy/window shortcuts and font preloading. The old shell, stores, docking chrome and visibility-driven teardown were not imported. Hidden hosts keep their xterm and input state.
- `keys.ts`, `theme.ts`, `webgl.ts` reuse the corresponding old renderer helpers. `TerminalPane.css` carries the old black terminal palette, ANSI slots, padding and scrollbar treatment; surrounding app chrome is owned by the new approved workspace.

Testing uses fake PTYs and disposable temporary folders only. No interactive coding CLI or model is launched by tests.

## Installed-launcher audit (9 September 2026)

Read-only `--help` and `--version` checks covered Claude Code 2.1.265, Codex CLI 0.153.4, Qwen Code 0.20.0, Kimi Code 0.41.0, OpenCode 1.18.29, Pi 0.85.1 and Aider 0.86.2. Each current argv is an interactive invocation without a task/prompt argument. No model request or interactive CLI session was used for verification.

- Qwen's installed `chunks/chunk-IDS7MSUP.js` resolves `QWEN_HOME` directly; `chunk-4XNLIGVA.js` validates the selected `modelProviders` entry and its `envKey`. We explicitly set `OPENAI_API_KEY` in that schema, keeping the value only in the child environment. See [official authentication/schema](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/).
- Pi's installed `dist/core/resolve-config-value.js` and `docs/models.md` explicitly interpolate `$NAME`/`${NAME}`. A plain uppercase name is a literal in 0.85.1, so the existing `$HELLO_CLI_WORKER_API_KEY` reference is intentionally retained. `PI_CODING_AGENT_DIR` and `--model provider/id` are confirmed by installed help.
- Kimi's installed native bundle contains `applyEnvModelConfig`, reading `KIMI_MODEL_NAME`, `KIMI_MODEL_API_KEY`, `KIMI_MODEL_BASE_URL` and `KIMI_MODEL_PROVIDER_TYPE` into an ephemeral in-memory model. No config file is needed. Its user install folder `.kimi-code/bin` is included in Finder PATH augmentation. See [official environment contract](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars.html).
- OpenCode 1.18.29's bundle reads `OPENCODE_CONFIG_CONTENT` at runtime. The custom `@ai-sdk/openai-compatible` provider uses `options.baseURL` and `{env:HELLO_CLI_WORKER_API_KEY}` as documented by [official config](https://opencode.ai/docs/config/) and [providers](https://opencode.ai/docs/providers/).
- Aider's installed help confirms `--model`, `--openai-api-base`, `--no-auto-commits`, `--no-show-model-warnings` and the OpenAI API-key environment channel. Claude and Codex launch with no argv and keep their own authentication and approvals.

Successful launches retain their isolated CLI data homes, because Qwen/Kimi/Pi also save their own transcripts there. Only a failed startup removes its newly allocated directory. No global CLI configuration is modified.
