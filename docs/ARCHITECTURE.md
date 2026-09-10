# Architecture

Hello. is a greenfield Electron desktop application built around a conversation,
its shared notebooks, and its tools. The approved appearance reference lives in
[`design/reference/`](../design/reference/). The application does not load the old
application's database or renderer stores. The authorized terminal/CLI reuse
boundary is recorded in
[`terminal/PROVENANCE.md`](../src/main/terminal/PROVENANCE.md).

## Process ownership

| Layer | Responsibility | Entry points |
| --- | --- | --- |
| Main process | SQLite, encrypted key access, endpoint discovery, Pi lifecycle/bridge, tool execution, PTYs, browser guest authority and permission decisions | [`main/index.ts`](../src/main/index.ts), [`main/ipc.ts`](../src/main/ipc.ts) |
| Preload | Explicit typed `window.hello` methods and event subscriptions; no general-purpose IPC exposure | [`preload/index.ts`](../src/preload/index.ts), [`shared/types.ts`](../src/shared/types.ts) |
| App renderer | Conversation UI, notebooks, tool pills, layout, local drafts, Markdown and terminal display | [`renderer/`](../src/renderer/) |
| Web content | Remote pages in `<webview>` guests, separately sandboxed and without the app preload; every preference written by main at attach | [`browser/manager.ts`](../src/main/browser/manager.ts) |
| Chat child (manual validation pending) | Pinned Pi 0.85.1 in persistent RPC mode; agent execution and session context | [`chat/pi-rpc.ts`](../src/main/chat/pi-rpc.ts), [`chat/pi-extension.ts`](../src/main/chat/pi-extension.ts) |
| Terminal children | Interactive shells and explicitly launched CLI clients; separate from the chat engine | [`terminal/`](../src/main/terminal/) |

The main window uses context isolation, Electron sandboxing and no Node
integration. Production app files are served through `hello://app`; development
uses the local renderer server. Main IPC accepts only the main window's top frame
and validates arguments again before delegating to services.

## Conversation workspace

The left sidebar contains conversations. Each conversation owns its messages,
optional working folder, Runbook and Tasks entries, browser tabs and current
terminal/worker sessions. Settings, including the selected model endpoint, are
application-wide.

The chat area contains permanent Chat/Runbook/Tasks switch pills without close
buttons; legacy closed-notebook preferences cannot hide a section. The tool area
contains browser, terminal and CLI-worker session pills. Only one tool surface
is visible at a time. With
tools open, chat is pinned beside them; closing the chat area gives tools the
available space. On narrow layouts the surfaces are shown one at a time. Reopen
controls live in the visible pane's tab/action row, outside native web content;
when neither pane is visible they share an empty-workspace row. There is no
portalled global workspace header or conversation-title row. App navigation is
272px wide at top-left; Settings is at the bottom of the sidebar. Pane tabs
start at the window top (48px row), and the browser toolbar is the second row.
The first pane reserves 96px for native window controls when navigation is hidden.

`SidebarChrome` keeps hidden navigation out of layout and exposes a 4px left
pointer/keyboard edge. Hovering reveals the complete navigation as a temporary
overlay with the shared fade and a 24px leftward slide. The sidebar's Show button
pins it into layout. Peeking never changes pane geometry or saved preferences.
The drawer owns a measured native-occlusion region through its exit animation;
only intersecting native content is hidden, never closed or reloaded.

Without Tools, the original cloud panel contains workspace context and an optional
working folder at left, with a 600px chat stage inset 16px at right. Chat defaults
to Floating (560px/760px limits). Expand pins it to fill that stage and Restore
size returns to Floating; there is no independent mode control. Minimize leaves
its short bottom-right bar and preserves the previous expanded size. Closed chat
leaves the context and header reopening control. Below a 760px workspace width,
context stacks above the chat stage. This mode does not hide the sidebar on Expand.
Tools has independent minimized/expanded state and matching visible controls.
With Tools open, minimized panes occupy bottom grid rows, not overlays or
abandoned columns. An expanded pane fills the workspace, hiding the other pane
and sidebar without changing their saved split or sidebar preference. Restore
restores that layout. Native browser and terminal
visibility is false while their group is minimized or hidden, but their hosts
and sessions stay mounted. Chrome preference revision 4 removes the old independent
pin flag, mapping an explicit v3 solo Pin choice to Expanded. Runtime pinning is
derived from `expanded || toolsOpen`, so Restore size cannot leave solo chat pinned.
Workspace preferences and draft recovery use renderer local storage.
Visited workspaces remain mounted when hidden. Closing a **group of panels**
hides it; closing an individual terminal tab terminates that session. Hidden
sessions are not automatically stopped.

A page is a `<webview>` guest in the app document, held in its own fixed host
that follows the pane's viewport. Menus and dialogs stack above it by CSS, so
nothing hides or re-presents a page to make room for app chrome, and there are no
measured menu regions or window-wide holds left. A pane that is not on screen
parks its host behind the app rather than collapsing it: Chromium creates no page
for an element without a box, and the agent must still be able to read a tab
whose pane is closed. Header controls remain in the app renderer.

## Conversation Files tool

`src/main/files/service.ts` owns lazy directory listings, bounded filename/path
search and bounded UTF-8 reads under the current conversation folder. Every
operation derives its root from the main store; paths are checked lexically and
after realpath, with escaping symlinks rejected. Search does not follow symlink
directories. Directory limits and skipped folders are returned as metadata.
Reads open only regular files, reject a final symlink swapped after validation,
and cap bytes/lines before renderer IPC. This is not an OS sandbox against a
hostile local process changing parent directories concurrently.

`files.list/read/open/reveal` use the trusted main-frame IPC gate. No general
filesystem bridge, model tool or automatic content injection is added. External
Open is a separate human action; unfamiliar/executable file types prompt before
the default app is invoked. It does not execute a constructed shell command.

`FilesPane` retains its controlled Arborist tree, selection, source/preview mode
and document across hiding, minimizing and tab switches. It remounts on working
folder changes to discard stale content. Only the open Files pill is persisted
with layout preferences; file contents stay in memory and are not copied to chat
history or recovery storage. Request sequencing rejects late document results.
`FileNavigation` routes clicked local links from Markdown to the same viewer;
`shared/files.ts` parses local paths/line anchors without granting access. Markdown
relative links resolve from the displayed file. Native browsers remain mounted
but unpresented while Files is selected. Existing tool expand/restore applies.

## Durable data

[`DataStore`](../src/main/data/store.ts) owns a versioned SQLite database with WAL,
foreign keys, transactional updates and a busy timeout. Messages store structured
text, thinking and tool parts, status, errors and usage. Browser persistence
contains tab metadata, not Agent control grants. Interrupted streaming responses
and pending tool approvals are marked interrupted on startup, not resumed.

The default macOS data directory is:

```text
~/Library/Application Support/Hello Workspace/
  hello.sqlite                  conversations, messages, notebooks, settings, encrypted secrets
  hello.sqlite-wal / -shm        SQLite-managed sidecars while applicable
  notebooks/<conversation-id>/
    runbook.md
    tasks.md
  cli-workers/                  app-created private configuration homes for applicable clients
  …                             Electron-managed browser storage and renderer local storage
```

An absolute `HELLO_DATA_DIR` overrides this location, principally for isolated QA.
The store creates private directories and restricts its database/export file
permissions. This is separate storage from the old app, not an import or migration
of it. Chat and notebook contents are plaintext; see [Security](SECURITY.md).

The Pi migration adds one private JSONL v3 session per conversation under this
same Hello data root. An existing Hello chat is imported once into that session;
SQLite keeps the displayed history and no schema migration is required. Pi
becomes authoritative for the engine's context, including compaction records.
The application must not rebuild/reinject its full SQLite transcript on every
prompt. The sibling app transcripts and credentials are outside this migration. Restoring
a session permits an explicit next prompt; it does not automatically repeat
interrupted tool effects or restore a previously running process.

SQLite is authoritative for notebooks. Saving or deleting an entry refreshes two
separate Markdown exports in the app's data directory; requesting paths refreshes
them too. Each export is replaced atomically. Empty notebooks produce empty files.
No export is written into the attached repository automatically.

The Runbook and Tasks views use the same entry-list/rich-editor module, based on
Tiptap/ProseMirror. Markdown remains the authoritative body format; opening a
document does not itself serialize or save it. Formatting uses editor selections,
not string-prefix insertion. Unsupported Markdown has an explicit source-editing
fallback to preserve content rather than accepting a lossy conversion.

Saves are debounced and serialized; local draft recovery remains until
persistence is acknowledged. Pending and in-flight local changes take precedence
over incoming notebook refreshes. Editor history is scoped to the entry. This is
not a simultaneous multi-user document editor.

The selection-aware context menu snapshots its copy payload before moving focus
to the menu. Copy supplies HTML and plain text; Copy Markdown supplies source
text. The main process accepts a bounded, write-only clipboard request from the
trusted app main frame. It does not grant embedded websites clipboard access.

## Pi chat engine — source integrated, manual validation pending

The replacement for the custom HTTP/tool loop is **Pi 0.85.1 headless**,
using the sibling app’s existing persistent-RPC chat patterns. The integration is wired
into [ChatService](../src/main/chat/service.ts); these are its source contracts,
not a claim of live acceptance or complete CLI parity. Hello retains endpoint
discovery and its configured OpenAI-compatible connection. Pi's broader provider
catalog does not automatically become a supported Hello settings/authentication UI.

The Chat/Coder composer switch persists under `chat-mode:<conversationId>` in
the existing settings table, without a schema migration. Chat uses Hello's
conversational prompt; Coder appends Hello capability guidance to Pi's coding
prompt. Both share the same JSONL history and main-process tool gates. IPC rejects
mode changes while a response is active. The next request restarts a warm process
whose mode/configuration changed, reopening its existing session.

Flow: renderer → typed preload → ChatService → persistent Pi RPC child. Pi calls
the Hello extension → authenticated loopback bridge → existing main-process
tools. Main continues to own SQLite, approvals, browser grants and secure key
access. Model keys are passed to the child environment; model configuration
files refer to that environment instead of containing the key. No sibling-app
reporting, task-ledger or worker-orchestration transport is part of this flow.

[pi-rpc.ts](../src/main/chat/pi-rpc.ts) launches argv without a shell, verifies
readiness with `get_state`, correlates command IDs and parses bounded LF-delimited
JSON records. Prompt acknowledgment is acceptance; `agent_end` can precede retry
or compaction, so completion follows `agent_settled`. The current ChatService Stop
closes the owned runtime and cancels its tool work. The transport's graceful
`abort()` also clears queued messages first if used. Disposal terminates the child process group and waits for closure;
request timeouts close a session whose command state is uncertain.
[pi-events.ts](../src/main/chat/pi-events.ts) maps streaming and final events
into Hello's ordered text/thinking/tool parts and reported input/output usage.
The displayed runtime phase is transient, not a new database status or proof of
task success. No thinking content is invented.

The configured starting limits are **32,768 context / 4,096 output tokens** and
must match the server. Compatibility is explicit: `auto`, `openai`, or
`qwen-chat-template`. Pi owns retries and automatic compaction against the
configured context window minus `reserve = max(16384, output + 4096)` tokens.
The defaults trigger above 16,384 estimated context tokens (50% in this profile).
Recent retained context is `min(20000, floor(context / 4), floor((context - reserve) / 2))`.
Configuration must leave enough history beyond that reserve. This is not a universal compaction percentage, a
measured server capability, a second Hello compactor, or a guarantee of correct
answers. Same-model/same-prompt validation is still required.
The first profile requires at least 20,480 actual server context tokens;
the output cap can raise this minimum. Smaller profiles need separate tuning.

The pinned startup contract disables AGENTS.md/CLAUDE.md discovery with Pi 0.85.1's
`-nc`; extension/skill/prompt discovery stays disabled with `-ne`, `-ns` and `-np`.
It disables only native tools with `--no-builtin-tools`, while explicitly loading
the Hello tool extension. `--no-tools` would disable extension tools too and is
not an equivalent flag.

Skills, plugins and MCP servers the human imported into the library and activated
for a conversation are added to that contract explicitly: `--skill <folder>` per
skill, `-e <entry>` per plugin extension and `--prompt-template <file>` per
plugin template, with discovery still off. Changing the selection, imported
fingerprint, MCP configuration or tool definitions changes the session
fingerprint, so the child restarts on the same
durable session file. MCP is not a Pi feature: `src/main/extensions/mcp.ts` is
Hello's own stdio client, and its tools are offered through the same tool bridge
as Hello's built-in ones. `src/main/extensions/library.ts` owns import,
verification and the imported copies under `<data>/library/`.

`src/main/extensions/discovery.ts` reads the configuration other agent tools
write (JSON, TOML and YAML shapes) and the skill folders they keep, so a server
or skill can be adopted without retyping it; it returns entries to the renderer
without their environment values, and importing goes through the same library
paths as a manual add.

The library uses explicit Pi manifest paths/directories/globs/exclusions when
present and conventional discovery otherwise. YAML front matter supplies skill
names and descriptions. MCP keeps one process per configured server, shared by
activated chats; access is checked at both discovery and call time. Pending
starts are owned and stopped on disconnect/dispose too. Its stdio client validates
the protocol version and tools capability, follows bounded tool pagination and
refreshes a changed tool catalog between turns. See the
[verification report](EXTENSIONS-VERIFICATION-2026-09-10.md) for tested boundaries
and compatibility limits.

Tools cover bounded folder listing/reading, approved file writes and shell
commands, notebook discovery/editing, independent public web research, and gated
browser reading/actions. Notebook contents are **not automatically injected**
into a prompt or CLI task. The model can request notebook tools; a person can
ask a CLI worker to use the shared notebook connection described below. Tool authority is described
separately in [Security](SECURITY.md).

The extension forwards these tools through
[pi-tool-bridge.ts](../src/main/chat/pi-tool-bridge.ts); it does not introduce
Pi-native filesystem or shell tools that bypass those gates. Existing
terminal/CLI clients retain their own permission systems.

### Independent web research

`web_search` and `fetch_url` are available even without a folder or Browser pane.
`WebResearch` uses bounded GET requests in main, with DNS pinning and public-IP
validation repeated for redirects. Requests have a 20s total deadline, five-hop
redirect cap, 2 MiB transfer cap and 16,000-character returned excerpt. It does
not use browser cookies, model keys, a shell, or authenticated page state.
DuckDuckGo HTML is default; `HELLO_SEARXNG_URL` can opt into a public standard-port
SearXNG instance, with DuckDuckGo fallback. Empty narrow queries broaden once.

Structured results persist in existing message tool parts. Successful fetches
get conversation-stable source IDs; retries seed the registry from history.
The renderer groups consecutive research/reasoning parts without reordering
prose or unrelated tools. A Sources icon menu lists actually fetched pages, and
the Markdown transform links known [N] markers without touching code or existing
links. Copy/export append the source URLs. Search previews and failed fetches
cannot create citations. Source icons use the fixed DuckDuckGo icon endpoint,
without referrers, with a local globe fallback.

Browser metadata is refreshed before every model request, including between
tool rounds. Only tabs owned by the conversation are listed, with their current
IDs, URL/title, visibility and grants; titles/URLs are labelled untrusted data.
Permission failures also return current candidates. Execution still checks the
selected tab's ownership and grant in main; no automatic privilege escalation
or silent retargeting is introduced.

Opening a result is separate from reading/controlling its page. `browser_open`
creates a new Off tab in Hello for a requested HTTP(S) URL (including a running
local dev server) or an HTML file in the attached folder. `browser_navigate`
can navigate an explicitly targeted owned tab in every mode. Reads still require
Read/Full; DOM actions require Full. Tool descriptions and the Pi prompt encode
this distinction and prefer the in-app browser over shell `open`/`xdg-open`.

`browser/local-preview.ts` serves local HTML and relative static assets through
a lazy, bounded loopback server with a token-scoped route. Paths are resolved
and checked against the attached folder on every request; secret/hidden paths,
unsupported types and escapes are denied. No global file: URL exception is added.
Local-preview tabs are session-only. Folder changes/deletion revoke their routes;
shutdown closes the server. This is a static preview, not a general dev-server
manager; root-relative assets and server-side applications use their own dev URL.

`browser_show_html` creates a bounded, private output via `HtmlArtifacts` and
opens it through a separate `LocalPreviewServer`. No folder is required: the
artifact directory itself is the preview root, never the whole app-data folder.
Files live at `artifacts/<conversation-sha256>/<uuid>/index.html` and persist
across restarts. `browser_open` resolves returned `artifact:<uuid>` handles only
within the calling conversation. Artifact routes are session-only; attaching a
different repository revokes folder previews but keeps these independent outputs.
Conversation deletion revokes their routes and deletes their files; shutdown
closes both preview servers. Creation/deletion has cancellation and generation
guards to prevent late publication. `html-input.ts` converts bounded UTF-8 HTML
data URLs at the tool boundary for compatibility; native navigation still rejects
`data:` and `file:`. Tool results report `contentVerified: false`: a loaded tab
is not evidence of a correct visualization.

## Browser and terminal lifecycle

File drops use Electron `webUtils.getPathForFile` in preload for real disk files.
Internal Files rows supply conversation-relative drag data, resolved against the
source conversation's folder in main. Both chat and terminal consume these paths;
neither accepts a renderer-supplied filesystem root. Terminal drops use xterm's
paste path with POSIX argument quoting and no newline. Late drops cannot type into
a hidden, replaced or exited session.

Chat drops call `ChatService.attach` to snapshot bounded UTF-8 documents/images
under a private conversation-specific attachment directory. The composer retains
removable metadata in its draft, and `chat.send` accepts owned attachment IDs.
Pi receives text contents plus actual image payloads, filenames and file paths.
Bindings to user-message IDs preserve attachments for Retry without a database
schema change. Dropping a file does not attach its parent folder or send it to a
model until submission. A single directory is returned for explicit composer
folder attachment. Snapshots persist independently of folder changes and are
removed with the conversation; preparation/deletion guards suppress late sends.

Browser tabs persist their identity, conversation, title and URL. Restored tabs
start Agent control Off, and their page is created only when the window mounts a
guest for them. Tabs share the persistent `persist:hello-web` browser session;
conversation ownership does not mean separate cookie stores. A hidden pane keeps
its page and its state.

A page is created when the window asks: `mintAttach` issues a one-time nonce,
`approveGuestAttach` resolves the record from it and writes the guest's whole
preference set, and `adoptGuest` binds the guest Electron then attaches and puts
every rule on it. An operation that arrives before the window has mounted a tab
waits for that mount, and gives up with "This page is not open in the app window."
A page adopted because an operation was waiting is loaded by that operation, so a
tab loads once. `detach` names the page it created, so a pane unmounting late
cannot close a page a newer one has already put in its place.

`setWindowOpenHandler` accepts web destinations and answers with a child window
carrying the same preferences and the opener's partition. A `<webview>` cannot
adopt an existing `WebContents`, so a popup is a window rather than a tab; that
keeps `window.opener`, `postMessage` and form posts, which reopening the URL as a
tab would have broken.

The payload-only `hello:browser-lifecycle` subscription adds and selects foreground
children in Tools without switching conversations or stealing focus from another
selected tool. Background links create an unselected pill. A child closing itself
returns selection to its still-open opener. Site-owned about:blank documents are
shown natively, including windows filled by their opener; manually created empty
tabs still show the app's start page. Browser presentation does not tear down on
each HTTP redirect. Reload recovers a discarded view with one explicit navigation.

An explicit agent `browser_open` carries `userRequested: true` in its opened event
so the active conversation selects and reveals the new browser tab even when
Terminal/Files was selected. It never switches to another conversation. This
exception does not change the existing focus policy for site-created popups.

Agent browser operations have bounded waits and receive the response's abort
signal. DOM actions use the current main frame and reject while loading instead
of being queued for a future page. Revoking access, closing a tab or disposing the
manager cancels relevant pending operations. A cancelled pending DOM mutation
destroys that page and retains a recoverable tab requiring Reload — and the tab
stays refused a new page until an explicit navigation asks for one; a read can
discard its result. Cancellation cannot undo an action already performed.

Terminals use `node-pty` in the main process and xterm in the renderer. A session
starts in the chat folder, or the user's home when no folder is attached. Output
is batched and bounded, with sequence-aware replay when a renderer attaches.
Terminal sessions and their replay buffers are in memory, not restored processes
after restart. Exiting the app stops sessions, with a confirmation when sessions
are running.

The CLI catalog launches installed clients, not simulated workers. Claude and
Codex use their own authentication; active-model clients receive adapted endpoint
configuration. Applicable clients get app-private configuration homes. The
launcher exposes `HELLO_RUNBOOK_PATH` and `HELLO_RUNBOOK_TASKS_PATH` as file paths;
these compatibility environment names do not inject an initial prompt. Clients
retain their own permission model and may maintain their own state.

### Shared notebooks in launched CLIs

`terminal/notebook-context.ts` creates one authenticated loopback connection per
supported CLI session and conversation. It reuses the Pi bridge transport with
only `notebook_list` and `notebook_task_status` available. These operate on the
same SQLite entries as the Hello chat; the latter validates the exact task line
before updating its status. Runbook is read-only. The generated Node helper
uses Electron's bundled Node and credentials inherited only by that CLI.

On launch, a small connection guide tells the model that Hello Tasks are not
the repository's `tasks/todo.md`, gives the real launch folder and explains how
to read the current notebooks or update a task status. Read Runbook before
planning/executing the human's next request, including when it is not named
again. No notebook contents or executable assignment are submitted at startup.
Empty notebooks remain valid. Six locally inspected loaders are used:

| CLI | Passive connection guidance |
| --- | --- |
| Pi | `--append-system-prompt` with the private guide path |
| Claude Code | `--append-system-prompt-file` |
| Codex CLI | Session `-c developer_instructions=…` override |
| Qwen Code | `QWEN.md` in the existing private `QWEN_HOME` |
| Kimi Code | `AGENTS.md` in the existing private `KIMI_CODE_HOME` |
| OpenCode | `instructions` file in its existing per-child config |

Codex's session override may replace an independently configured
`developer_instructions` value; project AGENTS loading and global files are not
changed. The installed Aider version has no verified passive loader and gets
no connection claim or automatically submitted message.

Existing PTYs keep their launch folder; selecting another chat folder does not
move or restart them. The worker context row shows the difference and offers a
new CLI in the selected folder. A selection change during async launch rejects
that launch, and later folder changes block status writes from the old
connection. Closing/exiting the CLI revokes its token and removes its generated
helper/guide files. CLI-owned configuration homes/transcripts retain their
existing lifetime. Older already-running CLIs need a fresh launch.

Store notebook changes emit `hello:notebooks-changed`, so a CLI status update
refreshes the open Tasks view. Editor saves carry their persisted
`expectedUpdatedAt` revision. Conflicts preserve drafts and offer recovery;
an old autosave cannot silently undo newer CLI progress. Markdown exports are
derived read-only snapshots, not a write-back channel. Their automatic refresh
does not invalidate a committed database change; explicit path/export requests
still report export failures. This is shared notebook access, not a scheduler,
worker orchestration protocol or automatic task-completion detector.

## Validation boundary

For the Pi migration, no real model/CLI work, automated tests, build, packaging
or app restart has been performed. Non-emitting static checking is separate and
must not be reported as runtime validation. The first live acceptance is the
owner's previously failing prompt with the same model and materials, followed
by Stop, approvals, continuation, restart and compaction checks.

`pnpm test` runs automated tests with the Electron-compatible native runtime.
`pnpm typecheck` and `pnpm build` check the application bundles. The native smoke
script uses a temporary data directory, local HTTP/SSE fixtures and a benign PTY
command to exercise persistence, streaming, browser guest hosting and lifecycle.
These checks do not establish compatibility with every live model provider or
installed CLI version, and do not require real credentials or paid model calls.

The standalone design preview is a separate renderer-only mode. It can keep local
preview state, but rejects operations requiring the desktop backend instead of
pretending to execute models, browser tools or shell sessions.
