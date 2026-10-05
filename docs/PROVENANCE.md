# Source provenance

Hello. is a new repository, database and application shell. The source locations
below were consulted read-only; no old user database or credentials were copied.

## Approved design

`/Users/q/Documents/app chat local models first/design/mockup/` was copied as a
complete source snapshot into `design/reference/`. Its manifest records the
original source hashes. `design/reference/design/LOOK.md` pins the approved appearance. Production
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

Implemented from `docs/archive/NIGHT-PLAN-2026-09-10.md` against Hello's own code and
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
[EXTENSIONS-VERIFICATION-2026-09-10](archive/EXTENSIONS-VERIFICATION-2026-09-10.md).

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

## Browser page modes (Design, Annotate) — 2026-09-13

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
  cannot strip it. Annotate's markers came later (below).
- `src/runtime/browserDesignMode.ts` → `src/shared/page-mode-format.ts`
  (`composeDesignNote(s)`, `parseDesignNotes`, `parseAnnotationShot`,
  `composeAnnotations`), made pure and extended with checked parsers for what the
  page hands back and `cropBox`. The marker line reads `⟦Hello-ref⟧`. Destination
  changed: a note goes to the chat composer with the element's picture attached
  through the existing attachment import; Copy puts text and picture on the
  clipboard from main. The picture is cropped from `webContents.capturePage()`
  of the viewport, scaled by the picture's own size, and saved under
  `<userData>/page-captures/<chat>/` (pruned after a day, removed with the chat).
- Annotate — the sibling app `browser_view.rs` ANNOTATE block (:351-541: `MARK_COLORS`,
  `ensureMarks`, `layoutMark`, `steerPending`, `commitPending`, `removeMark`,
  `placeMark`, the click-away rule) and `annotationsForShot`/`afterShot`
  (:628-660) → `KINDS.annotate` in `src/main/browser/page-mode-probe.ts`. Kept:
  pins at page coordinates in a layer at the document origin (they scroll with
  the page and are in the picture), six cyclic colours, stable numbers, click on
  a pin removes it, empty notes dropped, no editing after commit, the note being
  typed is hidden by opacity for the picture, `inView` per marker. Changed for
  Hello: the layer is a closed shadow root in the isolated world; the core
  swallows page clicks, so pin and note clicks are sorted by hit-test rather than
  by their own listeners; `at` starts as the DOM path and main reads the React
  component once per committed marker from the page world (`fiberProbe`) and
  hands it back (`setAt`); Escape is main's (`before-input-event`) and disarming
  drops every marker and the open note — there is no `clearAfterShot`, because
  nothing is photographed on commit. Destination changed: nothing leaves on Enter;
  `AnnotateBar.tsx` (app DOM over the page) counts markers and Send takes one
  viewport capture — `capture()` returns the markers the page reported, checked by
  `parseProbeAnnotations`, with main's URL — attaches it to the chat composer with
  the `composeAnnotations` list and ends the mode; Copy puts the same on the
  clipboard. No SQLite, and the person's markers are no agent tool's.
- Added 2026-09-30 (user: "a pointer for agents"): `S.hints`/`S.clearHints`, the
  agent's own marks for `browser_mark` — the same pins, notes and colours, each
  with an outline around the element it means, drawn on a separate closed
  shadow layer (`data-hello-hints`) that needs no armed mode and never joins the
  person's markers, their Send or their exit. Page coordinates from main's
  `boxScript` measurement; only the person's trusted click puts one away.
  Same day, after the user's sketch: an × on every mark, a chat-bubble index
  fixed at the page's left (hover lists them, a click scrolls to one and makes
  it pulse, × there too), a staggered reveal, `S.hintsWait` for main to follow
  what the person kept, and `S.hints` drawing kept page coordinates again for a
  restored tab. Then each mark tied to its element: main's `boxScript` returns a
  CSS path to it (a unique id, else nth-of-type steps), the layer keeps the
  element and follows its box through resize, inner scrolls and layout shifts
  (one layout per frame, a light 600 ms check for content that moves it),
  finds a re-rendered node again by that path, and hides the mark while its
  element is hidden. A restored tab re-anchors by the path before falling back
  to the kept coordinates. Then marks kept per page of the tab (Back or Forward
  to a page shows its own again) and a double click on the bubble fading them
  all away.
- Changed after the page-mode test round (2026-09-13), departing from the sibling app:
  the probe acts only on trusted (the person's) clicks, moves and presses — a
  script's or an agent's `el.click()` goes to the page; a note still being typed
  with words is committed when Send/Copy takes the picture (an empty one still
  leaves it); a marker is `inView` only while its layer is connected and its pin
  has a box; the marker layer keeps its keys and presses from the page's bubble
  listeners and keeps the caret default; `setAt` names its arming. In main,
  Escape inside an IME composition does not end a mode, a same-document
  navigation keeps it, and only another tab becoming active hides it. Text a
  page supplies is stripped of C1 controls, zero-width marks, Unicode line
  separators and bidi controls, and the Design pick URL is bounded like
  Annotate's.
- Annotate Send, deviation from the first cut: if the picture cannot be attached (attach throws or returns none), the bar shows the error, quotes nothing and keeps the markers for a retry. A quoted Send never carries a local `shot:` path; only Copy does, to the clipboard.
- The toolbar pill grammar (icon at rest; label and X unfurl from zero width
  when armed) follows the sibling app `src/features/browser/browser.css`
  `.browser-design-btn`, drawn with Hello's tokens and motion variables.

No sibling-app state, IPC names, clipboard helpers or Tauri code were copied. The
browser manager gained only a read-only `pageFor(tabId)` and an
`observePages` notification; its navigation, attach/park and grant behaviour is
unchanged.

## Worker channels back to the chat — 2026-09-18

At the owner's explicit request ("poți lua implementarea din
sibling-app … să avem hook de răspuns wake
up"), the sibling app’s worker-channel hooks were consulted read-only:
`src-tauri/resources/hooks/worker-done.sh`, `.../worker-ask.sh`, the env wiring
in `src-tauri/src/cmd/run.rs` (`OD_DONE`, `OD_ASK`, `OD_WORKTREE`), and the
report-wake path in `src/runtime/orchestrator/capturedReportWake.ts`.

What was adapted is the SHAPE of the contract, not its code:

- a worker SPEAKS rather than being observed — one command it runs when it is
  finished, and the coordinator is woken with what it said;
- a quoted heredoc carries the report, because a report passed as a
  double-quoted argument had its backticks executed by the shell (the sibling app, 08.09);
- `--status blocked|failed` is lifted even when a model puts the flag at the
  end of its text;
- a blocking ask whose answer is printed on the worker's own stdout, so it
  reads the answer as ordinary tool output and carries on;
- the hooks never break the worker's turn: they always exit 0 and say so.

Hello's implementation is its own: `src/main/terminal/report-channel.ts` writes
three POSIX scripts (`$HELLO_REPORT`, `$HELLO_NOTE`, `$HELLO_ASK`) beside the
existing per-pane notebook context, and the transport is a file dropped into a
directory only that pane's channel owns — no HTTP bridge, no token, and a
report already written survives a restart. Delivery into the chat uses Hello's
own waiting list (`ChatService.workerReported` → `queue(…, 'next')`), so a
report waits its turn during a reply and wakes an idle chat. No sibling-app source
file was copied.

## Pi package market — 2026-09-29

The Pi market reuses the ported market window (`src/renderer/market/`) with a
second backend (`src/main/market/pi-*.ts`). Its list is read from
**pi.dev/packages** (the official gallery; the site's footer says MIT): the card
attributes the page publishes for its own filtering (`data-package-*`), the
author, downloads and date beside them, and its count, with its type and order
menus reproduced in the toolbar. No markup, script or asset of pi.dev is copied
into Hello; a trimmed excerpt of one page is a test fixture
(`tests/fixtures/pi-gallery-page.html`). The npm search fallback follows the
gallery's type rule from keywords. Pi's own installer
(`pi-coding-agent/dist/core/package-manager.js`, MIT) was read for its pnpm
settings; Hello's install differs (scripts off, registry pinned, integrity bound).

## DSH surface and Community Plugin Market — 2026-09-28/29

At the owner's request ("facem suprafața DSH", "il facem la fel ca interfata ...
nu vreau sa inventam nimic"), these MIT-licensed sources were consulted read-only
and adapted:

- **`dsh-community-market` 0.1.0-dev.0** (Anywhere Labs, MIT; shipped inside
  DSH Desktop 2.0.15). Parts ported to TypeScript: `src/client/styles.ts` copied
  verbatim into `src/renderer/market/market.css`, the English strings, the view
  structure of `MarketSettingsTab.tsx` and `MarketOverlay.tsx`,
  `lib/network/restricted-http.js` and `blocked-subnets.js`
  (`src/main/market/net.ts`), `lib/adapters/dsh-1024store.js` for the direct path
  (`src/main/market/store1024.ts`), and the npm verifier and profile bundle update
  from `lib/install/service.js` (`src/main/market/install.ts`), plus
  `lib/adapters/dshfind.js` and `standard-http.js`, the source and
  provider-page rules of `lib/contracts/validate.js` and `query.js`, and the
  `catalog-source` and `catalog-provider-page` schemas
  (`src/main/market/standard.ts`). The source list follows
  `lib/catalog/service.js`: several sources, one in use. Not ported: dshfind's
  full-catalog scan (the provider's paged search is used), source reordering,
  and the multi-category query.
- **`deepseek-harness` `apps/desktop-host/src/index.ts`** (MIT, checkout 21638c5):
  the `runProfile` boot and the `ready`/`fatal`/`shutdown` protocol, reimplemented
  in `src/main/dsh/host-entry.ts`.
- **`@deepseek-ai/dsh-client-ui-theme` 0.1.7-rc.2** (MIT): the list of official
  tokens, snapshotted in `assets/dsh/hello-dsh/official-tokens.json`.
- **`@deepseek-ai/dsh-client-ui-brand-official`** (MIT): the brand-slot
  registration shape, reused for Hello's mark and name.

Hello's own parts, written here and not copied: the host manager, surface,
checkpoints, model proxy, the `node-addon-require-builtin` shim
(`assets/dsh/shims/`), the theme generator (`scripts/dsh-theme.mjs`) and the
compatibility gate.

## Pi tab theme and engine — 2026-10-01

- **the sibling app `src/runtime/piTheme.ts`** (sibling-app, revision 5):
  the dark `the sibling app` Pi theme it writes to `~/.pi/agent/themes/hello.json`, copied
  as-is into `src/main/terminal/pi-theme.ts` (user, 01.10: "copiază tema pi din
  sibling-app să fie default pentru pi în Hello"). Like the sibling app,
  Hello makes it current through the agent folder's `settings.json`, since
  `--theme` alone only registers a theme; the folder is the Pi tab's private
  one, so `~/.pi` is not touched.

Hello's own: the Pi engine updates (`src/main/chat/pi-engine.ts`,
`src/main/updates.ts`) and running the tab on the chats' Pi.

