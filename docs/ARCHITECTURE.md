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
| Chat child | Pi in persistent RPC mode — the version pinned in package.json, or one updated from the sidebar into `<data>/pi/runtime`; agent execution and session context | [`chat/pi-rpc.ts`](../src/main/chat/pi-rpc.ts), [`chat/pi-extension.ts`](../src/main/chat/pi-extension.ts) |
| Terminal children | Interactive shells and explicitly launched CLI clients; separate from the chat engine | [`terminal/`](../src/main/terminal/) |
| DSH host (utility process) | One DeepSeek Harness profile (`hello`), booted like dsh's own desktop host; runs dsh plugins, third-party code | [`dsh/host-entry.ts`](../src/main/dsh/host-entry.ts), [`dsh/service.ts`](../src/main/dsh/service.ts) |
| DSH surface (web content) | dsh's own web client in one `<webview>` of partition `persist:hello-dsh`, no preload; src and every preference from main | [`dsh/surface.ts`](../src/main/dsh/surface.ts), [`renderer/dsh/DshView.tsx`](../src/renderer/dsh/DshView.tsx) |

The main window uses context isolation, Electron sandboxing and no Node
integration. Production app files are served through `hello://app`; development
uses the local renderer server. Main IPC accepts only the main window's top frame
and validates arguments again before delegating to services.

## Conversation workspace

The left sidebar contains conversations. Each conversation owns its messages,
optional working folder, notebook (Runbooks, Tasks and Plans), browser tabs and current
terminal/worker sessions. Settings, including the selected model endpoint, are
application-wide.

The chat area contains two permanent pills without close buttons: Chat and
Notebook (user, 29.09: one button beside Chat, not one per section). The
notebook is one pane: a tree of three sections — Runbooks, Tasks and Plans —
each with its chapters, beside the editor. A section's switch is the chat's own
Runbook, Tasks or Plan setting (Plans holds the plan `plan_write` keeps and is
on while Plan is); each chapter has a switch of its own. All three sections are
off in a new chat (user, 05.10); a chat made while Runbook and Tasks started on
keeps them (database version 15). The model and CLI workers see only the
chapters that are on, in sections that are on; what is off stays visible and
editable, quieter. A saved Runbook or Tasks page opens the
notebook. The tool area
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
The drawer is CSS above the page beneath it: that page stays mounted, and is
never hidden, closed or reloaded to make room.

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
search, a bounded search of the contents (below, A3b) and bounded UTF-8 reads
under the current conversation folder. Every
operation derives its root from the main store; paths are checked lexically and
after realpath, with escaping symlinks rejected. Search does not follow symlink
directories. Directory limits and skipped folders are returned as metadata.
Reads open only regular files, reject a final symlink swapped after validation,
and cap bytes/lines before renderer IPC. This is not an OS sandbox against a
hostile local process changing parent directories concurrently.

`files.list/read/searchContents/cancelSearch/open/reveal` use the trusted main-frame IPC gate. No general
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
    plan.md
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

SQLite is authoritative for notebooks. Saving, deleting or switching an entry
refreshes three separate Markdown exports in the app's data directory, one per
section, holding the chapters that are on; requesting paths refreshes them too.
Each export is replaced atomically. Empty notebooks produce empty files. A
chapter's switch (`notebooks.shared`, schema version 11) changes neither its
words nor its revision, so a draft open on it still saves; version 11 also moved
the Tasks entry titled "Plan" — the one `plan_write` replaced whole — to Plans.
No export is written into the attached repository automatically.

The three sections share one tree and one rich-editor module, based on
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

## Pi chat engine

The replacement for the custom HTTP/tool loop is **Pi headless**,
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

**Engine updates.** The sidebar's footer shows the Pi that runs and, only when
npm's `latest` is newer, `update` (`chat/pi-engine.ts`, asked a moment after
start and every six hours). Updating installs that version with Hello's pnpm
into `<data>/pi/runtime` (a staging folder renamed into place); chats start Pi
from it while it is newer than the bundled one, and the engine is part of the
session fingerprint, so a chat moves at its next message. Going back removes the
folder and the bundled Pi runs again; a Hello that brings a newer Pi of its own
outgrows an older update. The DSH row does the same for dsh: the version chosen
lives in `<data>/dsh/version.json`, the runtime is reinstalled at it and the host
restarted, and a failed install keeps the version that ran. The terminal's Pi tab
runs this same engine (`cli.js` beside the chats' `rpc-entry.js`, by Electron as
Node), not a `pi` found on PATH, so one update moves both; its private agent
folder carries a theme of its own as the current one.

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
request timeouts close a session whose command state is uncertain. A prompt's
timeout does not run while Pi reports compaction (`compaction_start` to
`compaction_end`, fifteen minutes at most). A chat's row menu has Restart and
Reset: both stop the turn (waiting for its tools), close the runtime and delete
the chat's private Pi directory while nothing new may start in it. Restart
stores `chat-fresh:<id>`, so only messages from then on seed the next session
and the transcript shows the line; Reset deletes the messages, queue,
attachments and — when asked — Runbook and Tasks. Tabs, terminals, downloads,
switches and the folder stay in both.
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

The pinned startup contract disables AGENTS.md/CLAUDE.md discovery with Pi's
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

A plugin extension that imports npm packages is bundled once, at import, by
`src/main/extensions/bundle.ts` (esbuild): its code and exactly the packages it
reaches, from the folder the person chose, into `<entry>.hello-bundle.mjs`
beside the entry, which is what `-e` loads. Modules Pi hands every extension
(`@earendil-works/pi-*`, `typebox`) and Node built-ins stay external. A package
that is not installed in the folder stops the import and is named; the approved
copy never holds a `node_modules`. Any import the copy would not hold — a
package in node_modules, a hoisted or linked one elsewhere on disk, a skipped
folder — makes the entry bundled. A folder with a root `index.ts`/`index.js`
and no `pi` section or other resources is one extension, and a lone `.ts`/`.js`
file is one too: Pi's own rules for its extensions folder. A re-import builds the
new copy beside the old one and swaps it in only once it verifies.

Pi starts in the chat's private directory (`<data>/pi-chat/<hash>/work`), where
it reads its settings and keeps its session, so a project's own `.pi` files never
load. When the chat has a folder, `HELLO_CHAT_FOLDER` carries it and Hello's
extension, which Pi loads first, moves the process into it: `process.cwd()` —
relative paths, and processes an extension spawns without a cwd of its own — is
the project for the extensions a person activated, as it would be if Pi ran
there (OpenViking's memory scopes itself by the folder's git remote). Pi's own
`ctx.cwd` and `pi.exec`'s default stay the private directory; an extension that
wants the folder explicitly reads `HELLO_CHAT_FOLDER`.

Tools are prompt-context driven (`src/main/chat/tool-groups.ts`). A request
carries a core set — `web_search`, `fetch_url`, `tools_find`, `skills_find` /
`skill_load`, and `plan_write` when the chat turned it on; in Coder mode also the coding group —
and every other area is a group the model loads with `tools_find` when its work
gets there: `coding` (files and shell), `browser`, `workers`, `notebook`, one per
MCP server and one per plugin extension (grouped in the Pi child by the
extension that registered each tool). Loading activates the group for the next
step through `pi.setActiveTools()` and returns its manual — the rules that used
to sit in every system prompt (browser, panes, notebooks, MCP). Loaded groups
are read back from the session transcript when Pi restarts, and a group that
appears mid-chat is announced once. Pi appends each tool change to the
transcript, so a loaded group does not throw away the cached prompt prefix.

A turn Pi begins on its own — a plugin woke it, as pi-subagents does when a
background run finishes — is adopted as a reply (`ChatService.watchTurn`): a new
assistant message marked `startedBy`, followed like any reply, and waiting for a
reply of Hello's that is still ending. Pi's extension UI over RPC (text widgets,
statuses, notices, questions) is kept per chat for the Pi process that drew it
and shown beside the composer (`src/renderer/chat/ExtensionPanel.tsx`); the
person answers questions there. Settings' model for subagents is written into
the chat's private Pi folder as a second model of the same provider and as
pi-subagents' `subagents.defaultModel`.

What that UI cannot carry is Pi's own, not Hello's: Pi's RPC extension-UI
context (`createExtensionUIContext` in `pi-coding-agent`'s bundle) emits an
`extension_ui_request` for `select`, `confirm`, `input`, `editor`, `notify`,
`setStatus`, `setWidget`, `setTitle` and `set_editor_text`, and discards
everything that would draw a component: `custom()` is `async custom(){}` — it
resolves `undefined` without sending anything — and so are `setFooter`,
`setHeader`, `setEditorComponent`, `onTerminalInput`, `setWorkingMessage` and
`setHiddenThinkingLabel`. This is why a pi-subagents question whose answer leads
to another screen (Change model, thinking) closes and goes no further: the
plugin's next call is `ui.custom()`, Pi sends nothing over RPC, the plugin's
await resolves with nothing and it drops the flow. Hello never receives a
request it could answer or report, so there is nothing here to repair; it needs
Pi to send those screens (or the plugin to fall back to `select`).

Stopping a chat's Pi aborts the reply in progress, ends its input and waits up
to 1.5 s: that is Pi's own shutdown, which runs extensions' `session_shutdown`
handlers (a memory plugin's final commit) before it exits. SIGTERM, then SIGKILL, follow only for a Pi that
is still there. A Pi that cannot load an activated extension is reported with
the plugin's library name and Pi's reason; a plugin handler that throws during a
reply is shown as a warning naming the plugin and no longer ends the reply —
only Hello's own tool extension failing does.

Skills are found the same way (`src/main/extensions/skill-catalog.ts`). One
catalog holds Hello's library, every skill another agent on this Mac keeps
(discovery below, plus Pi's `~/.pi/agent/skills` and dsh plugins' skills) and,
on request, the skills.sh registry, which also lists Anthropic's own skills.
The model calls `skills_find` with a few words about the task and
`skill_load` with an id it returned; the person types `/` in the composer
(`src/renderer/chat/SkillCommands.tsx`) to pick a skill by name, or
`/find-skills <task>` to search. Either way the skill is copied into the
library when it is not there — a same-name library skill is always the one
used, and a same-name skill already on in the chat (a plugin's) answers
instead — turned on for that chat, and, from the composer, written as
`/skill:<name>` at the start of the message. Hello expands that prefix into
the skill's instructions itself, before the text reaches Pi, for a new
message, a steer, a wrapped follow-up and a Retry alike; the transcript keeps
what the person typed. Uses run one at a time. A skills.sh skill is read from
its GitHub repository — the folder named after it in the repository tree, else
the one whose `SKILL.md` carries its name; for a repository too large to list,
`skills/<id>`, `<id>` or `.claude/skills/<id>` listed alone — into a staging
folder removed after the import; a skill GitHub will not list is an error,
never a partial copy. Re-importing such a skill downloads it again
(`ResourceLibrary.remote`).

`src/main/extensions/discovery.ts` reads the configuration other agent tools
write (JSON, TOML and YAML shapes), the skill folders they keep and the
extensions installed for Pi itself (`~/.pi/agent/extensions`, where installers
such as OpenViking's put theirs), so a server, skill or Pi extension can be
adopted without retyping it; it returns entries to the renderer
without their environment values, and importing goes through the same library
paths as a manual add.

The library uses explicit Pi manifest paths/directories/globs/exclusions when
present and conventional discovery otherwise. YAML front matter supplies skill
names and descriptions. MCP keeps one process per configured server, shared by
activated chats; access is checked at both discovery and call time. Pending
starts are owned and stopped on disconnect/dispose too. Its stdio client validates
the protocol version and tools capability, follows bounded tool pagination and
refreshes a changed tool catalog between turns. Its trust boundaries and limits
are in [SECURITY.md](SECURITY.md); the 10.09 verification report is archived
([archive](archive/EXTENSIONS-VERIFICATION-2026-09-10.md)).

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
creates a new tab in Hello for a requested HTTP(S) URL (including a running
local dev server) or an HTML file in the attached folder, at Full: the model
opens a page to work in it (user, 29.09). That Full is not saved and the tab
returns Off after a restart; a tab the person opens starts Off. `browser_navigate`
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

## The two design audits (04.10)

What the audits asked for and the code lacked, done in Hello's own terms:

- **Work time.** A reply keeps how long it worked (`messages.workedMs`,
  database version 14), added up across its retries, never the pause before
  one; the activity header shows it, live while the reply runs. A running step
  says how long it has run, and "Waiting for response…" how long it has waited
  (the number stays out of the live region's words).
- **Summarise now.** From amber, the context meter offers Pi's own compaction
  (`ChatService.compact`, RPC `compact`), on the chat's warm Pi or one started
  for it; nothing is sent into the chat meanwhile, and the meter then reads what
  the summary freed until the next reply reads the window again.
- **Keys.** The app menu holds ⌘N (New Chat) and ⌘B (Toggle Sidebar), so they
  work with a page or a terminal focused; a page that takes ⌘B for itself (bold
  in an editor) keeps it. In the transcript, ↑/↓/Home/End move between messages
  and ⌘C on a focused message with nothing selected copies it.
- **States.** Every control that answers hover answers press with one deeper
  fill — no lifts, no shadows; a message reached by keyboard carries the app's
  ring; fields that dropped their outline have it on the pill around them.
- **Keeping and spending.** A finished reply can become a Runbook chapter (its
  heading the title, its sources kept). Settings › App adds up every reply's
  usage: in all, by model and by the costliest chats.

Not done, and why: hover lifts and divider lines (the approved look has
neither), ⌘W (macOS closes windows with it), and a duration *estimate* and a
next-turn cost (nothing can know them honestly).

**A model per chat** (user, 04.10: "remember the last model used in that chat
… nothing fancy"), in place of the audit's per-folder model. A chat keeps
`{ endpointUrl, id }` in `settings` under `chat-model:<id>`, beside its other
switches: written when a turn starts (the model it runs on) and when the
composer's picker is used in it. A pick also stays the selection in Settings,
which a new chat — or one with no model yet — runs on, and which DSH and the CLI
workers use. `ChatService.chatSettings` puts the chat's endpoint and model over
the selection, with the key filed under that endpoint; the selection's learned
context scale and its subagent model do not carry to another model or
connection, and `launchLimits` takes the chat's model's published window from
the listing the picker read. Summarising and a turn Pi starts by itself use the
same model, so neither replaces the chat's session. Forgetting a connection
clears the chats on it, and deleting a chat clears its row.

## Keys, search and attachments (S209, 05.10)

- **The composer's history.** ↑ in an empty composer brings back what was sent
  in this chat, newest first; ↑ and ↓ walk through it (a recalled message's own
  lines first), Esc clears it, and any other change to the words leaves the walk.
  The `/` menu keeps its arrows.
- **Between chats.** The app menu's Go holds ⌘⇧] / ⌘⇧[ (next and previous in the
  list as shown, round the end), ⌘J (the next chat waiting, after the open one)
  and ⌘1–9 (by place). Menu accelerators reach the window from a page or a
  terminal; the terminal lets these keys through (`terminal/keys.ts`), and the
  mapping is `renderer/menu-chats.ts`.
- **Notebook search.** A field above the tree searches every chapter's title and
  words, drafts and switched-off sections included, with a snippet; the results
  stand in for the tree, Enter opens the first, Escape clears and then returns to
  the editor. ⌘F or ⌘K reaches it while the notebook is the page on screen, as
  find in chat does while the transcript is.
- **Attach by paste and picker.** A file copied in Finder pastes as a drop does,
  by its path; a picture alone (a screenshot) is read by main from the clipboard
  (`chat.attachClipboard`) and kept like a dropped image; words paste as words.
  "Attach files…" opens a native picker for files, never folders. All three go
  through one import path in the composer: one at a time, at most eight.
- **Find in a terminal.** ⌘F (Ctrl+Shift+F elsewhere) with the terminal focused
  opens a field over it: matches across soft wraps, wide characters and emoji
  mapped to their cells (`terminal/find.ts`), the newest first, Enter older and
  Shift+Enter newer, kept current as output arrives or the terminal reflows. A
  full-screen program has no scrollback to search, and says so.

## The UI audit (05.10)

`docs/ui-audit-2026-10-05.md` proposed six features; all six are in.

- **Needs your attention (A1).** Main keeps what waits for the person — a tool
  approval, a plugin's question — in registers that announce their own changes
  (`approvals`, `extensionAsks` in `ChatService`) and sends a snapshot with a
  rising revision whenever one is added or settled (`chat.pendingInput`,
  `hello:chat-pending`). The renderer subscribes before it asks, ignores an older
  revision, and lists the requests by chat, oldest first (`ui/AttentionDialog.tsx`);
  "Open request" shows that chat's transcript and focuses the waiting control
  (`data-request-id`). Looking at a chat clears a finished reply's dot, never a
  request; each request notifies once. Nothing is persisted: after a restart
  there is nothing left to approve.
- **Readable code steps (B1).** `file_edit` shows a line diff (`chat/diff.ts`,
  LCS, at most 500 lines a side, otherwise Old and New), `file_write` the file's
  code, `command_run` a shell block (`chat/ToolCode.tsx`); any other tool, or input
  that does not parse, stays JSON. The − and + are text, not only colour.
- **Appearance (B2).** Settings › App › Appearance: System, Light or Dark sets
  `data-theme` on the document root (absent for System), and main sets
  `nativeTheme.themeSource` and the window's ground (`main/appearance.ts`).
- **Go to… (A2).** ⌘⇧P lists commands, chats, open tabs and, from two
  characters, matching messages, ranked by `go-to.ts`; typing only filters, Enter
  or a click acts (`ui/CommandPalette.tsx`).
- **@ a file (A3).** `@words` in the composer lists the files of the chat's
  folder whose path holds them (`files.list`); Enter attaches one through the
  same snapshot path as a drop and takes the token out (`chat/FileMention.tsx`).
- **Find in files, add a selection (A3b).** Files › Contents searches inside the
  files of the chat's folder, in main (`WorkspaceFiles.searchContents`): literal,
  Match case on request, one search per chat — a newer one, a hidden pane, a left
  Contents or another folder stops the older (`files.cancelSearch`), and the
  renderer drops any answer that is not the latest. It reads regular UTF-8 files
  of at most 2 MiB and 20,000 lines, opened without following links; links,
  binary files and dependency/build/.git folders are passed over; it stops at
  200 lines, 10,000 entries, 20 MiB or 4 seconds and says which. It returns paths,
  lines and short snippets, keeps nothing, and a result opens its line in Source.
  "Add selection to chat" (the toolbar, or the viewer's menu, which takes the
  selection before it has focus) adds the words to this chat's draft with their
  path and, in Source, their exact lines, taken from the file rather than the
  page (`files/selection.ts`). At most 20,000 characters, never past the 200,000
  a message may hold; nothing is sent until the person sends it.

## Chat awareness: context, attention, search

A reply records the model that wrote it (`messages.model`, database version 7)
and its usage: `input`/`output` add every call of the reply — each tool step
sends the context again — and `context` is the prompt of its latest call, the
size of the model's window now; `cost` is kept when the provider reports one.
The composer's meter (`ContextMeter.tsx`) reads the latest `context` against the
chat's window, amber from 75% and red from 90%, and names the latest reply's
model when it is not the one selected. The window calibration compares one
call's peak prompt with the window, never the reply's total.

`attention.ts` turns a reply's change into what the person owes it — an approval
that appeared, a worker question queued, a reply that failed or finished — for
a chat that is not on screen or while the window lacks the OS focus
(`hello:window-focus`). The sidebar row keeps a steady dot until the chat is
looked at, the Dock shows how many chats wait (`system.badge`), and a native
notification (`system.notify`) brings its chat forward when clicked.

`store.searchMessages` finds words in every chat's messages (SQLite `LIKE`,
newest first, three per chat) with the words around the first match; the sidebar
search lists chats by title or content and opens a content match on its message.
`ChatFind.tsx` is find in the open chat (Cmd/Ctrl+F or Cmd/Ctrl+K): it paints
matches with the CSS Custom Highlight API, so React's DOM is never wrapped or
mutated, and remembers the words per chat.

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

Browser tabs persist their identity, conversation, title, URL and Agent control
mode (`browser_tabs.control`, database version 5). A restored web tab keeps the
mode the person chose; an artifact or previewed-file tab is stored Off and gets
its grant back only when served again. A restored page is created only when
the window mounts a guest for it. A chat's downloads live in `browser_downloads`
(database version 6): main registers every `will-download` on the chat, saves
into the chat folder or the system Downloads folder, reports progress to the
window (`hello:browser-download`), closes a popup that only carried a file, and
marks a download still saving at startup as failed. A page's controls are
read with refs (`e1`, `e2` …), role, words, state and centre, kept on the
page until it changes (`agent-target.ts`); `browser_click` takes a ref, words
or a selector, asks the page only where the control is, and main sends real
mouse input at that point — or, when something covers it, the page clicks the
control itself and the result says what covers it; `browser_press` sends one
key as from the keyboard. A read scans the page's frames too — each visible
`<iframe>`, placed by its box in its parent, up to twelve and three deep —
with refs running on across frames and centres moved to page coordinates, so
a control in a payment frame is clicked by ref like any other; `browser_wait`
polls for words, a control, an address (substring or `*` pattern), the load or
a time; `browser_screenshot annotate: true` writes each ref on the page before
the picture and erases it after, returning the list with the image. Visible
means what the person sees: an element clipped away by an ancestor (a
screen-reader-only block, `clip-path: inset(50%)`, a menu or accordion closed
to nothing under `overflow: hidden`) is not, and an inline link wrapping a
whole card is measured by its content's box; a control inside a looping
animation is read as "moves by itself", and `browser_mark` refuses it. A read is what a
person could use now, as an accessibility tree has it: with a modal dialog open
(`dialog:modal` or `aria-modal`) only its words and controls are listed, a
background marked `aria-hidden`/`inert` is left out, controls on screen come
before those off screen and those covered or transparent until hover, and what
did not fit is counted. A ref from before a dialog opened, or one naming another
control than the label given with it, gives way to the label; a click on
something behind the dialog is refused with what to do. `browser_pointer` asks
the page what is at its point before sending and says so in its result. Tabs share the persistent `persist:hello-web` browser session;
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

`setWindowOpenHandler` refuses the native window a page asks for and opens a tab
beside its opener instead (user, 22.09: an invoice's "View" opened a window the
person had to hunt for and the agent could not see). The tab takes the opener's
partition and its grant — it is the opener's page carrying on — and only http(s)
destinations are opened; a blank popup is refused. What a child window would
have kept — `window.opener`, `postMessage`, a prepared POST body — is given up.

A right-click on a page opens a native menu that main builds
(`browser/context-menu.ts`, user 05.10): Look Up, Copy and Select All for
selected words, Cut, Copy and Paste in a field, a link's address, and an
image's Copy, Save (a download of the chat, like any other) and address.
Chromium asks for it only when the page did not draw a menu of its own.

The payload-only `hello:browser-lifecycle` subscription adds and selects foreground
children in Tools without switching conversations or stealing focus from another
selected tool. Background links create an unselected pill. A child closing itself
returns selection to its still-open opener. Site-owned about:blank documents are
shown natively, including windows filled by their opener; manually created empty
tabs still show the app's start page. Browser presentation does not tear down on
each HTTP redirect. Reload recovers a discarded view with one explicit navigation.

What the address bar is given becomes an address or a Google search
(`browserURL`). A bare name the person typed that no site answers to
(`ERR_NAME_NOT_RESOLVED`) becomes the search for it (`searchInstead`): the load
`navigate()` started reports its own failure, so no error shows on the way, and
the failed name's history entry goes once the results load, so Back returns where
the person was. An address typed with its scheme, a port, an IP or a name of the
person's own network (localhost, `.local`, `.lan`, `.internal` …) fails as typed,
and so does every navigation the model makes: that address is what it asked for.

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
only `notebook_list` and `notebook_task_status` available, plus Hello's browser
for this conversation's tabs (below). The notebook tools operate on the
same SQLite entries as the Hello chat; the latter validates the exact task line
before updating its status. Runbook is read-only. The generated Node helper
uses Electron's bundled Node and credentials inherited only by that CLI.

The browser (user, 30.09: a CLI that could not see Hello's browser read the
human's own Chrome through osascript instead) is the chat's own tool code and
`BrowserHooks`: `browser_tabs`, `open`, `show_html`, `read`, `screenshot`,
`navigate`, `click`, `type`, `press`, `scroll` and `wait`, run from the helper as
`browser <action> '<json>'`. Every call passes the same per-tab Agent control
check as the chat's. A screenshot is saved in the session's private folder (the
newest 20 kept, all removed with the session) and its path is printed for the
CLI's own image reader. The guide names Hello's browser as the only one and
tells the CLI not to script the human's other browsers — guidance, not a wall:
an unsandboxed CLI runs as the human.

A terminal moved into the chat pane ("Set as chat tab") is saved in the window's
workspace preferences as which CLI it is and, for Claude Code and Pi, the id of
its conversation: every launch of those two starts one with an id of Hello's
(`--session-id`; Pi's in `cli-sessions/pi`, which outlives the app). After a
restart, the chat shown is given its CLIs again and they continue: Pi by the same
id, Claude Code by `--resume` once it has written the conversation. Other CLIs
come back in the same place with a new conversation.

Settings' Reasoning reaches a local Qwen server from the CLIs on Hello's
connection as it does from the chat (`chat/qwen-thinking.ts`: chosen in
Settings, or on Auto a Qwen model on the person's own server): Qwen Code by
`generationConfig.extra_body`, OpenCode by the model's `options` (the request
body of `@ai-sdk/openai-compatible`), Pi by `thinkingFormat: qwen-chat-template`
and `--thinking`, Aider by a model settings file's `extra_body`. Kimi sends no
extra fields to an OpenAI server, so it thinks at the server's own level.

Claude Code and Codex get the same connection as a stdio MCP server
(`hello-mcp.cjs`, beside the shell client, run with Electron's Node): it relays
`tools/list` and `tools/call` to the bridge, screenshots as MCP image content,
and a refused call as the tool's `isError` answer. Claude Code loads it with
`--mcp-config hello-mcp.json`, Codex with `-c mcp_servers.hello.*`, Kimi from
`mcp.json` in its private home, Qwen Code from its private `settings.json`,
OpenCode from the `mcp` of the config Hello hands it. No file holds the token:
Claude expands `${HELLO_NOTEBOOK_BRIDGE_TOKEN}` in `--mcp-config` from its own
environment, Codex forwards it by name (`env_vars`), and Kimi, Qwen Code and
OpenCode give a stdio server their whole environment. The guide adds that
another MCP server's browser tools (another app's bridge) are not this chat's.

A Pi CLI loads Hello's own extension (`-e out/main/pi-extension.js`) on this same
connection, with `HELLO_PI_EXTENSION_ROLE=cli`: the notebook and browser tools
become Pi's own, and a screenshot comes back as a picture as well as a path. In
that role the extension adds tools only — it does not change the process's
folder, wrap its `fetch` or add Hello's runtime snapshot to its context.

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

## DSH surface and the plugin market

Hello. runs DeepSeek Harness (dsh) plugins without becoming dsh. dsh's interface
plugins and themes need dsh's own web shell (its module loader, shared React and
Cordis modules, about twenty infrastructure plugins and the slot declarers), so
they run in the **DSH surface**: dsh's client, hosted by Hello.

```
Hello main ──utilityProcess──▶ DSH host   (runProfile, profile "hello", DSH_HOME = <data>/dsh/home)
  │  one-time token → cookie: net.request in partition persist:hello-dsh    │ 127.0.0.1:<free port>
  ├── <webview> "DSH" (src minted by main, no preload) ◀───────────────────┘ dsh client + UI plugins + Hello theme
  ├── model proxy 127.0.0.1 (per-start token) ◀── dsh-llm-pi-ai route "hello"
  ├── tool bridge 127.0.0.1 (per-start token) ──▶ dsh ToolRegistry, global view ◀── McpManager link "dsh-plugins"
  └── Community Plugin Market: npm latest preview → confirm → pnpm add --save-exact → restart the host
```

The **Pi package market** is the same window over another backend
(`src/main/market/pi-service.ts`): the list and its filters are pi.dev/packages'
own (`pi-gallery.ts`, npm's search as fallback in `pi-catalog.ts`); an install is
Hello's pnpm into a staging project that becomes a library plugin
(`pi-install.ts`, `ResourceLibrary.installPackage`), turned on per chat. The
sidebar's Plugin Market row opens a menu with both markets; each market's
Installed list updates and removes what it installed.

- **Install.** `@deepseek-ai/dsh@0.1.7-rc.2` (exact, or a newer version the person
  updated to from the sidebar, kept in `<data>/dsh/version.json`) goes into `<data>/dsh/runtime`
  with Hello's bundled pnpm (11.8.0, run by Electron as Node), hoisted, on first
  use: about 0.5 GB. `node-addon-require-builtin`, which reads Node's internal
  module loader through a native addon that recognises only exact Electron
  builds, is replaced by Hello's shim (`assets/dsh/shims/`), which answers the same
  calls through `--expose-internals` (the spike that found it is archived:
  [`DSH-SPIKE-2026-09-28.md`](archive/DSH-SPIKE-2026-09-28.md)).
  The install panel is live: counters against pnpm's `Packages: +N`, elapsed time,
  pnpm's latest line in plain words (a retry, a slow download, a build) and, past
  twenty seconds of silence, how long it has been quiet. Every pnpm run is taken
  at its word 20 s after it says `Done` (pnpm 11.8 once hung for hours retrying
  other platforms' tarballs after finishing) and stopped after five minutes with
  no output, with the reason.
- **Profile.** `<data>/dsh/home/profiles/hello`: dsh's web template bundles plus
  Hello's own `hello-dsh` bundle, linked from the app's files. Hello writes a patch
  layer on every start (`hello.patch.yml`): no browser to open, no URL printed, and
  with a model connection, the `llm-pi-ai` route `hello` and the default model.
  The last three healthy profiles and a point before every change are kept.
- **Theme.** `assets/dsh/hello-dsh/lib/client.js` is generated by
  `scripts/dsh-theme.mjs` from `src/renderer/styles/tokens.css`: every dsh token
  (`--dsw-*`), light and dark, through `ctx.theme.overrideTokens('hello', …)`, plus
  Inter and Hello's mark and name in dsh's brand slots. A test fails when the pinned
  dsh gains a token without a Hello value. The bundle's patch starts the appearance
  dark, as Hello's window is; dsh's Settings › Appearance changes it in the
  profile's own layer. Hello's overlay never sets it: dsh refuses a Settings change
  that an overlay would override.
- **Budget.** The host is a second harness inside a chat app, so it runs with a
  V8 heap ceiling given to the process at start (`--max-old-space-size`, 1 GB:
  `dsh/budget.ts`), and Hello samples what it really uses from Electron's own
  process metrics every ten seconds. Past 1 GB resident or 150% of a core for
  thirty seconds — long enough that a boot or an install is not it — the DSH log
  says so, once, and again when it comes back under. Nothing is killed: a
  surface the person is working in is not closed behind their back, and the log
  is where the host's account of itself already is.
- **Surface.** One guest, positioned like a browser tab's page over the DSH view,
  parked while the view is closed, never reparented or reloaded for chrome. It stays
  on the host's origin; web links open in a browser tab of the chat on screen.
- **A place of its own.** The DSH view is a destination, like the chat it covers: the
  chats sidebar stays beside it whatever that chat's layout (an expanded pane, tools
  open in a narrower window), and asking for a chat — its row, New chat, a
  notification — leaves the surface for it. With the sidebar hidden (unpinned, or a
  window under 720 px), the view's header keeps clear of the window's own buttons
  and starts with the button that pins the sidebar back; its × closes the surface.
- **Model.** Sessions in the surface talk to Hello's active connection through
  `dsh/model-proxy.ts`; the real key is added only on the way to the provider. The
  connection is read on every request — address, key and model: dsh names the model
  Hello had when the surface started, and the proxy puts Hello's current one in its
  place, so a model changed in Hello never reaches a server that does not have it.
- **Market.** `renderer/market/` and `main/market/` port dsh-community-market's
  views, stylesheet, 1024Store adapter, network rules and install preview. The page
  never names a package: it installs items main listed under opaque keys, or a
  package the person typed in Settings. Hello adds a compatibility gate: a package
  whose dsh peers exclude the pinned dsh is not installed. Sources: DSH 1024Store
  (the default), dshfind, and standard sources added by manifest URL; one is in
  use at a time, kept in `<data>/dsh/market-sources.json` in the order the person
  puts it in (Move up/down; which source is used is still the selected one, not
  the first). A standard source's
  paging cursor stays in main, behind a token bound to that source and search.
  A source's own search is one page and one category at a time, so the person
  can have Hello read a catalogue through once — the same pages and cursors,
  bounded at 600 pages and 20,000 entries, a repeated cursor ending the walk
  (`market/scan.ts`). Every search of that source is then answered from what
  came back: exact counts, and any number of categories at once (an item in any
  of them). Refresh drops it and reads the source again. Without a scan, one
  category still goes to the source and several are narrowed page by page.
- **Skills and tools in Hello chats.** The skills of installed dsh plugins appear
  in Extensions › Found on this Mac, to import like any skill. Their tools cross
  through the tool bridge (`dsh/tool-bridge.ts`), which the host entry starts next
  to dsh's registry: `GET /tools` lists the global view (dsh's own tools register
  per agent, so this is what plugins brought, less the reserved `run_code`), and
  `POST /call` runs one through dsh's policy and guards with no dsh session. In
  Hello it is one library row, `dsh-plugins` (Settings › DSH surface switches it),
  which the MCP manager reaches in-process through `dsh/tool-link.ts` instead of
  spawning a server. It is off in every chat until turned on there, starts a
  stopped surface when a chat needs it, never installs one, and lists again after
  a host restart.
- **Upgrading dsh.** `DSH_VERSION` (`dsh/layout.ts`) is the version this build
  comes with; the person can run a newer one from the sidebar, kept in
  `<data>/dsh/version.json`, and `selectedVersion()` — never `DSH_VERSION` — is
  what the running app judges by. Moving the pin means re-checking, in this
  order, everything that was measured against the old line:
  1. `DSH_ALLOWED_BUILDS` (`dsh/layout.ts`): pnpm 11 refuses an install whose
     dependencies ask for install scripts it was not told about, so the list has
     to name every one in the new tree. Read it off an installed runtime — every
     `preinstall`/`install`/`postinstall` in `<data>/dsh/runtime/node_modules` —
     not off a changelog.
  2. The `node-addon-require-builtin` shim (`assets/dsh/shims/`): its version
     must still satisfy the range the new dsh asks for, and its API must still
     answer what `@deepseek-ai/cordis-plugin-loader` calls.
  3. `DSH_PRODUCT_TOOLS` (`dsh/tool-bridge.ts`): which tools the new dsh
     registers in the global view. This one is a runtime measurement — start the
     surface on a profile with no plugins and list `GET /tools`.
  4. `assets/dsh/hello-dsh/official-tokens.json` and the Hello theme:
     `scripts/dsh-theme.mjs --check` fails when the new dsh has a `--dsw-*`
     token with no Hello value.
  5. The market's compatibility gate: a plugin is accepted when its
     `@deepseek-ai/dsh*` peer ranges and its declared `dsh.compatibility.dsh`
     include the running version (`market/install.ts`, `market.test.ts`). A
     plugin pinned to the old line is refused on the new one, which is the point.
  6. The patch layer (`hello.patch.yml`) and the profile template name.
  7. The host's budget (`dsh/budget.ts`): what a profile loads at boot is dsh's
     business, so the numbers Hello is willing to spend on it are re-measured
     with the surface open and idle.

  Checked against **dsh 0.2.0-rc.2**, installed through the sidebar: steps 1 and
  2 pass unchanged — the five install-script packages in its tree are exactly the
  five `DSH_ALLOWED_BUILDS` names (`node-pty`,
  `@deepseek-ai/dsh-subprocess-local`, `koffi`, `protobufjs`, `@google/genai`),
  and it still asks for `node-addon-require-builtin@^0.1.6`, which the shim's
  `0.1.6-hello.0` satisfies. Steps 3–6 are unverified here: 3 needs the surface
  running, and the pin itself waits on a stable 0.2.x being published.

## Validation boundary

Every change is checked with the unit tests and the type check; what the app
looks like and does live is checked by the owner, in the app (AGENTS.md). No
test does real model or CLI work, spends credits or needs credentials, and a
static check is never reported as runtime validation.

`pnpm test` runs automated tests with the Electron-compatible native runtime.
`pnpm typecheck` and `pnpm build` check the application bundles. The native smoke
script uses a temporary data directory, local HTTP/SSE fixtures and a benign PTY
command to exercise persistence, streaming, browser guest hosting and lifecycle.
These checks do not establish compatibility with every live model provider or
installed CLI version, and do not require real credentials or paid model calls.

The standalone design preview is a separate renderer-only mode. It can keep local
preview state, but rejects operations requiring the desktop backend instead of
pretending to execute models, browser tools or shell sessions.
