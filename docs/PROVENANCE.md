# Source provenance

Hello. is a new repository, database and application shell. The source locations
below were consulted read-only; no old user database or credentials were copied.

## Approved design

`/Users/q/Documents/app chat local models first/design/mockup/` was copied as a
complete source snapshot into `design/reference/`. Its manifest records the
original source hashes. `design/LOOK.md` pins the approved appearance. Production
reuses the approved tokens and animation primitives; the app/state/IPC are new.

## Chat page label reveal — 2026-09-10

At the owner's request, the sibling app’s `src/Sidebar.tsx` `SessionBranchAddRow` and
`src/ui/app.css` `.sidebar-new-resource-actions .sidebar-new-option-plus`
were consulted read-only in `sibling-app`.
The source reveals a plus through width and opacity with `--t-fast: 80ms ease`.
Hello adapts that motion to the Chat/Coder, Runbook and Tasks titles: active
titles stay open, inactive titles reveal on hover/focus beside a permanent icon.
The existing Hello pill styling and tab ownership remain; no add/branch behavior
or source-app state was copied. Reduced-motion handling uses Hello's settings.

## Terminal and CLI launch

The old repository's PTY manager, xterm renderer, environment, keyboard and CLI
launch mechanisms informed the isolated modules under `src/main/terminal/` and
`src/renderer/terminal/`. See the detailed adaptation notes in
`src/main/terminal/PROVENANCE.md`. The new code avoids pausing hidden PTYs, adds a
sequenced attach/replay boundary, and launches only detected executables using
argument arrays. CLI flags were checked against the locally installed versions.

## Main chat and persistence

Initially, `sibling-app` was inspected for
chat/protocol/launch behavior. Hello.'s SQLite schema, streaming adapter, tool
loop, approvals, preload and React application were implemented independently.
The custom chat engine has been replaced in source as described below; the SQLite/UI
ownership remains Hello's. No Codex or Claude backend or parity claim is involved.

## Pi headless chat — 2026-09-09, source integrated

The owner explicitly selected reuse of the sibling app’s Pi headless chat with tools.
The sibling app was read only; its observed HEAD during this pass was
`135fb998599b3bcc2a87033ea8376e70b6a297de` (working-tree references can contain
newer uncommitted changes). No sibling-app sessions, databases, authentication files
or runtime state were read or copied.

| Source | Hello adaptation |
| --- | --- |
| `src-tauri/src/cmd/pi_agent.rs` | `src/main/chat/pi-rpc.ts`: persistent RPC child ownership, JSONL framing, concurrent commands and shutdown; Tauri/Rust transport becomes Electron/Node argv spawning. |
| `src/runtime/piAgentRunner.ts`, `src/runtime/piRpcFlag.ts` | `src/main/chat/pi-events.ts` and ChatService integration: ordered text/thinking/tool events, actual acceptance versus completion, Stop semantics; no coordinator role or worker channels. |
| The sibling app’s Pi extension boundary and existing authorized `web-tools.ts` reuse | `src/main/chat/pi-extension.ts` / `pi-tool-bridge.ts`: one private conversation-scoped bridge to Hello's existing tools and approvals. The sibling app orchestration/reporting endpoints are excluded. |
| Installed `@earendil-works/pi-coding-agent` 0.85.1 `docs/rpc.md` and package types | Exact protocol, pinned package runtime and session contract; `agent_settled` is the terminal event, while prompt ACK is acceptance only. |

Pi 0.85.1 is an MIT dependency; its license and copyright remain with the
package. The integration retains Hello's renderer, SQLite and secure settings,
adds per-chat Pi JSONL v3 under Hello data, and imports old Hello history once.
Keys are supplied through the child environment, not serialized into model
configuration. The pinned launch disables context-file discovery (`-nc`), with
extension/skill/prompt discovery controlled separately (`-ne`/`-ns`/`-np`), and
disables native tools (`--no-builtin-tools`), retaining the explicit Hello extension.
The broader worker/task-ledger/worktree orchestrator is not being ported.

Status: source integrated, manual acceptance pending. No model or
real CLI work, automated tests, build, packaging or app restart has been run for
this change. Non-emitting type checking is tracked separately. Generic extension
activation, skills UI and MCP integration remain later deliveries. Chat lifecycle
regression fixtures now mock Pi and its bridge and guard against subprocess/model
execution; these tests have been updated but not run during this migration.

## Direct web research and source rendering — 2026-09-09

At the user's explicit request, the sibling app’s
`src-tauri/resources/pi-ext/web-tools.ts` and research/source components in
`src/ui/SessionChatThread.tsx` were consulted read-only. Hello adapts the
`web_search` → `fetch_url` → numbered citation flow into Hello's tool host in
`src/main/chat/web-tools.ts`. That initial research adaptation did not include
the Pi runtime; the later engine integration is recorded separately above.
No source-app credentials, old store or application shell were copied.

The adaptation adds bounded DNS-pinned public HTTP requests, redirect validation,
abort handling, conversation-stable source IDs and structured persisted results.
`src/renderer/chat/WebResearch.tsx` adapts the collapsible “Researched…” activity
and clickable source-icon menu. Only successfully read pages become cited sources;
search previews stay in the search details. Favicons use the sibling app’s fixed DuckDuckGo
icon service, sending only the source hostname and no referrer; failed icons use
a local globe. The existing Hello menu handles focus, dismissal and native occlusion.

## Files viewer — 2026-09-09

At the user's request, the Files tool combines the existing Hello Markdown/GFM
and Shiki renderer with [React Arborist](https://github.com/jameskerr/react-arborist)
3.16.0 (MIT). Its controlled tree, virtual rows, keyboard behavior and filtering
are used without rename, drag/drop or filesystem mutations. The two-column
document-left/tree-right layout follows the supplied screenshot using Hello's
existing tokens and menu primitives. No old app shell, store or file browser was
copied. Filesystem containment/reads and the narrow preload are new Hello code.
Explicit Open / Show in Finder use Electron's
[shell API](https://www.electronjs.org/docs/latest/api/shell), never a command string.

## Extensions library, MCP client and examples — 2026-09-10

Implemented from `docs/NIGHT-PLAN-2026-09-10.md` against Hello's own code and
the installed Pi documentation (`docs/skills.md`, `docs/packages.md`,
`docs/extensions.md`, `docs/rpc.md`, `docs/usage.md` in
`@earendil-works/pi-coding-agent` 0.85.1). No sibling-app source was consulted for
this change.

- Pi's documented flags are used as documented: `--skill <path>` (repeatable,
  additive under `--no-skills`) and `-e <path>` for extensions, with discovery
  left disabled. `usage.md` states that `--system-prompt` still appends skills,
  which is why Hello's own prompt keeps working with them.
- Pi 0.85.1 states it has no built-in MCP (`usage.md`). `src/main/extensions/mcp.ts`
  is a new first-party JSON-RPC 2.0 stdio client written for this app; its tools
  are exposed through Hello's existing tool bridge, not through Pi.
- `src/main/extensions/library.ts` is new: imports copy files into Hello's data
  directory, refuse symbolic links, bound file count/size/depth, and record a
  content fingerprint. Imported code is never executed at import time.
- `piRpcEntry()` in `src/main/chat/pi-session.ts` replaces a bare
  `import.meta.resolve` call so the launch arguments can be inspected by tests;
  the resolved path is unchanged in Electron.
- The bundled examples in `assets/examples/` are original Hello content written
  for this app and packaged through electron-builder `extraResources`.

Status: implemented, typechecked, unit- and native-tested against a local model
fixture and a local MCP fixture (`scripts/extensions-check.mjs`). No paid model,
no third-party MCP server and no global CLI configuration were involved.

The subsequent verification added explicit plugin prompt templates, manifest
path/glob/exclusion resolution and YAML front matter using pinned direct
dependencies (`yaml` 2.9.0, `minimatch` 10.2.6). It consulted the installed Pi
0.85.1 package loader and prompt-template documentation. MCP lifecycle, tools
pagination/capabilities and cancellation were checked against the official
2025-06-18 specification; links, repairs and validation results are recorded in
[EXTENSIONS-VERIFICATION-2026-09-10](EXTENSIONS-VERIFICATION-2026-09-10.md).

## Dependencies and assets

Embedded pages use Electron's documented
[`<webview>` tag](https://www.electronjs.org/docs/latest/api/webview-tag), with
[`will-attach-webview`](https://www.electronjs.org/docs/latest/api/web-contents#event-will-attach-webview)
and `did-attach-webview` as the point where the main process writes the guest's
preferences, and
[setWindowOpenHandler](https://www.electronjs.org/docs/latest/api/web-contents#contentssetwindowopenhandlerhandler)
for popups. The approach — a guest in the document rather than a native view
stacked above it, so ordinary menus can paint over a page — was confirmed against
a shipped Electron application (Cursor 3.20.7) whose browser creates a `webview`
element with `partition`, `preload` and `webpreferences` attributes inside a
positioned container. No third-party authentication script is copied or injected,
and no provider user-agent or security-policy bypass is introduced.

The Files tree and breadcrumb use [React Symbols](https://github.com/pheralb/react-symbols)
(`@react-symbols/icons` 1.4.1, MIT), the React implementation by Pablo Hernández
of Miguel Solorio's Symbols icon family. Filename/extension mapping and SVGs are
used from the installed package; no icon font, image CDN or filesystem content
request is involved. `FileTypeIcon.tsx` adapts sizing, config aliases and a
symlink badge without changing the source artwork. The package's MIT license
and copyright notice remain with the dependency.

Electron, React, React Arborist, xterm, node-pty, better-sqlite3, react-markdown, remark-gfm,
Shiki, Lucide and Inter are pinned in `package.json` / `pnpm-lock.yaml`. Their
respective licenses remain with the installed packages. Fonts are bundled;
there is no font CDN. The app icon is an original code-native vector in
`assets/icon.svg`; `pnpm icon` renders its full-resolution packaging asset.

## Model token budgets — diagnosis read from the sibling app

No code was taken. `src/runtime/localModels/reasoningProfile.ts` in the sibling app
(`sibling-app`, read-only) records why its
DeepSeek V4 profile raises the output budget to 16,000: "the previous
1,024-token direct chat budget was routinely exhausted entirely by reasoning,
leaving a valid response with content:''". That is the failure Hello. hit with
an OpenRouter reasoning model. The sibling app resolves it with a regex over the model id
and a hardcoded budget, and re-probes the running server for the loaded context
(`fetchContextSize`); Hello. instead adopts what the provider publishes for the
selected model, in main (`adoptedLimits` in `src/main/chat/service.ts`), and
prefers a server's loaded `meta.n_ctx` over a model's trained context_length —
the same priority the sibling app’s probe uses.

## Browser page modes (Design; shared base for Annotate) — 2026-09-13

At the owner's request, two sibling-app sources were read-only ported from
`sibling-app`:

- `src-tauri/src/cmd/browser_view.rs` `DESIGN_INIT_JS` → `src/main/browser/page-mode-probe.ts`.
  Kept: hover ring, click-to-pick, click-away ends a pick, `armId` so a late
  disarm cannot end a newer arming, `refBlock` parts (`getFiber`,
  `componentTrail`, `debugSourceOf`, `shortDomPath`, `styleSummary`, `cssPath`),
  and one bridge for every kind. Changed for Hello: the guest has no preload or
  initialization script, so main injects the probe when a mode is armed; it runs
  in an **isolated world** (id 1207), so the page cannot read, forge or switch off
  the mode. React's fiber is a page-world expando, so a pick marks its element
  with a token and main reads component trail and source line once, from the page
  world (`fiberProbe`), treating the answer as untrusted text. The sibling app’s
  `take()` timer poll became a long poll (`wait(armId, ms)` resolves on the next
  event or after 400 ms). Escape is caught in main through `before-input-event`,
  not in the page. The comment bubble, clipboard toast and Annotate markers are
  not in the page: Hello's page is a `<webview>` in its own document, so the
  composer is ordinary app DOM stacked above it (`DesignComposer.tsx`). The
  overlay uses a closed shadow root and a constructed stylesheet so a page CSP
  cannot strip it. Annotate's markers are not ported yet; `KINDS.annotate` is the
  documented slot.
- `src/runtime/browserDesignMode.ts` → `src/shared/page-mode-format.ts`
  (`composeDesignNote(s)`, `parseDesignNotes`, `parseAnnotationShot`,
  `composeAnnotations`), made pure and extended with checked parsers for what the
  page hands back and `cropBox`. The marker line reads `⟦Hello-ref⟧`. Destination
  changed: a note goes to the chat composer with the element's picture attached
  through the existing attachment import; Copy puts text and picture on the
  clipboard from main. The picture is cropped from `webContents.capturePage()`
  of the viewport, scaled by the picture's own size, and saved under
  `<userData>/page-captures/<chat>/` (pruned after a day, removed with the chat).
- The toolbar pill grammar (icon at rest; label and X unfurl from zero width
  when armed) follows the sibling app `src/features/browser/browser.css`
  `.browser-design-btn`, drawn with Hello's tokens and motion variables.

No sibling-app state, IPC names, clipboard helpers or Tauri code were copied. The
browser manager gained only a read-only `pageFor(tabId)` and an
`observePages` notification; its navigation, attach/park and grant behaviour is
unchanged.
