# Hello.

A macOS desktop app (Electron) for working with models. Each chat runs on Pi,
headless over RPC, beside a browser, terminals and CLI workers (Claude Code,
Codex, Kimi, Qwen Code, OpenCode, Pi), with a notebook of its own (Runbooks,
Tasks, Plans) and a hosted DSH launch from the sidebar, with upgrades to the
latest npm release. Plugins and add-ons belong to Hello/Pi. Models come from any
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

## Packaging

Package from a tree that matches the lockfile. electron-builder walks
`node_modules`, not `pnpm-lock.yaml`, so a tree left behind by an earlier
dependency set makes it hunt packages the current Pi no longer names (it looked
for `@mariozechner/clipboard` once, after the Pi upgrade). Before a package:

```sh
rm -rf node_modules && pnpm install --frozen-lockfile && pnpm rebuild:native
pnpm test tests/packaging.test.ts   # the parts of the contract a file can answer
pnpm package:mac
```

`tests/packaging.test.ts` holds that contract: every dependency pinned to an
exact version, the lockfile agreeing with `package.json` name for name, every
`extraResources` folder present, and every path the app resolves as a real file
named by an `asarUnpack` pattern. A read through `app.asar` reaches an unpacked
file transparently, so only what is spawned or `dlopen`ed needs the real path:
node-pty's `spawn-helper` (`terminal/native.ts`) and esbuild's binary
(`extensions/bundle.ts`, through `ESBUILD_BINARY_PATH`) rewrite `app.asar` to
`app.asar.unpacked` themselves. Everything else — Pi's `rpc-entry.js` and
`cli.js`, Hello's `pi-extension.js`, the bundled pnpm — is launched by Electron
as Node, which reads the archive, and is unpacked so its own files are on disk.

What only a real package can answer, and is still unverified: whether the
unpacked Pi, pnpm and esbuild behave inside `Hello.app`, whether the DSH
`extraResources` copy boots, and the size of the result.

## Where things are

- `src/main/` — the main process: the chat service and Pi, the browser manager,
  terminals and CLI workers, the DSH host, the Pi market, the data store.
- `src/renderer/` — the window: chat, notebook, workspace, browser pane, settings.
- `docs/ARCHITECTURE.md` — what the app does and how. Start here.
- `docs/SECURITY.md` — its trust boundaries. `docs/PROVENANCE.md` — what was
  reused or adapted, and from where.
- `design/reference/` — the approved visual contract (`design/LOOK.md` in it)
  and a runnable specimen; `design/CHAT-ACTIVITY-RULES.md` — the chat timeline.
- `specs/blaizzy-nativ-hello-monitor/tasks.md` — what is still open (Spec Kit).
- `AGENTS.md` — the rules for agents working in this repository.
- `docs/archive/` — history: plans, reports and research that are no longer current.
