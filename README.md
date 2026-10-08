# Hello.

A macOS desktop app (Electron) for working with models. Each chat runs on Pi,
headless over RPC, beside a browser, terminals and CLI workers (Claude Code,
Codex, Kimi, Qwen Code, OpenCode, Pi), with a notebook of its own (Runbooks,
Tasks, Plans) and the DSH surface for dsh plugins. Models come from any
OpenAI-compatible endpoint — a server on this Mac or a provider such as
OpenRouter — and each chat keeps the model it last used.

## Run it

```sh
pnpm install
pnpm dev
```

`pnpm typecheck` checks the types and `pnpm test` runs the unit tests.
`pnpm package:mac` builds the app into `release/`. Data lives in Hello's own
user-data directory (SQLite); API keys are encrypted with the system keychain
and never reach the window.

## Where things are

- `src/main/` — the main process: the chat service and Pi, the browser manager,
  terminals and CLI workers, the DSH host, the markets, the data store.
- `src/renderer/` — the window: chat, notebook, workspace, browser pane, settings.
- `docs/ARCHITECTURE.md` — what the app does and how. Start here.
- `docs/SECURITY.md` — its trust boundaries. `docs/PROVENANCE.md` — what was
  reused or adapted, and from where.
- `design/reference/` — the approved visual contract (`design/LOOK.md` in it)
  and a runnable specimen; `design/CHAT-ACTIVITY-RULES.md` — the chat timeline.
- `specs/blaizzy-nativ-hello-monitor/tasks.md` — what is still open (Spec Kit).
- `AGENTS.md` — the rules for agents working in this repository.
- `docs/archive/` — history: plans, reports and research that are no longer current.
