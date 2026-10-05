# Hello.

A new, local-first macOS workspace. A conversation owns its folder, research,
tasks, browser tabs, terminals and CLI workers. The approved chat direction is
**Pi headless as the engine, Hello. as its interface and local services**.
The Pi engine is integrated in source; manual runtime acceptance is pending.

The composer includes a compact **Chat / Coder** switch. Hover or focus reveals
both icons; selecting one collapses it. The selection is saved per conversation
and cannot change during a response. Both modes use Pi: Chat prioritizes discussion,
research and documents; Coder retains Pi's coding prompt with Hello's tools.
Mode changes reuse the conversation history and take effect on the next request.
They do not launch CLI workers or change tool permissions.

## Open the app

The local build is `release/mac-arm64/Hello.app`. Open it normally from Finder.
It is a locally built application, not a notarized public release.

Start a chat, choose its working folder, and use the pills to open Runbook,
Tasks and tools. The sidebar contains conversations only. Files, Browser, Terminal
and CLI worker share the Tools area; one tool is visible at a time. Closing
Chat expands Tools. **Open chat** and **Open tools** stay in the visible pane's
tab row, or together above the empty workspace when both are closed. They never
cover a web page. Closing a tool group does not end its sessions.

Hello., Search, New and the sidebar toggle share the window-control row only
over the left sidebar. Settings lives at its bottom. There is no global header
above the panes: their tabs rise to the window top, with the browser toolbar
directly below, for two rows instead of three. Hiding the sidebar also hides its
header controls. Touch the left edge to reveal the sidebar temporarily over
content, with a fade/slide from the left; its Show sidebar button pins it open.
The temporary drawer does not resize panes or change saved layout preferences.
Without Tools, the original cloud workspace has its explanation and
working folder on the left, with a Floating chat panel on the right. Expand pins
it to fill that chat stage; Restore size returns to Floating. Minimize leaves its short bottom-right bar and
Close leaves **Open chat** in the header. With Tools open, both panes use one
compact tab/action row and fill the window height. Both retain
visible Minimize, Expand/Restore and Close controls, with no redundant Floating/Pinned pill.
In Tools mode, minimized panes keep bottom rows and Expand temporarily focuses
one pane and hides the sidebar. Restore recovers the layout without stopping sessions.
The selected model stays in the composer, with no duplicate
model or Ready footer.

Chat / Runbook / Tasks are permanent switches, not closable tabs. Their content
stays available; + opens Files / Browser / Terminal / CLI tools. Rename, Export and Delete
belong only to each conversation's sidebar-row menu, never the global header.

Tool tabs shrink as more are opened, down to icons before horizontal scrolling.
Full names remain on hover. In compact tabs, use right-click **Close tab**,
middle-click, or Delete on the focused tab; running terminals still ask for
confirmation. The pane-level +/minimize/expand/close controls retain their size.

In **Settings**, enter an OpenAI-compatible endpoint and model. **Save connection
& load models** discovers the endpoint's model IDs. An API key is optional for
local servers; remote keys are encrypted using macOS secure storage. Nothing
imports credentials or databases from the old apps. The initial local endpoint
is `http://127.0.0.1:1234/v1`; run your model server or change this address.

**Providers** fills the form from a known OpenAI-compatible service —
OpenRouter, OpenAI, Groq, DeepSeek, Mistral, Together, Ollama, LM Studio or a
llama.cpp server — including the model-id shape that provider uses and where its
key comes from. A preset is only a starting point: nothing saved records which
one you picked.

**Keep this connection as** remembers the endpoint and model under a name, and
the **Saved** menu switches between them. Each endpoint keeps its own key, so
switching does not carry a key to a different server, and **Forget** deletes the
entry together with the key stored for it. The connection in use cannot be
forgotten; switch first.

**Tool approvals** decides how much a turn may do without stopping to ask:
*Work without asking* (the default) runs file writes and shell commands straight
away, *Ask before commands* holds only `command_run`, and *Ask every time* holds
both. A write is confined to the chat's attached folder; a shell command is not,
so it runs with your own access.

Model menus include a separate search field (`search models try "free"`), so
filtering does not change the selected model. Saved API keys appear masked:
leave untouched to keep, clear and save to remove, or type and save to replace.
The mask is not the real key and is never submitted as a credential.

The main chat makes real streaming requests; it has no simulated response path.
It renders Markdown, highlighted code, tables, task lists, supplied reasoning,
incremental tool calls/results, approval requests, errors and token usage. Stop,
retry, copying and restoring a message as a draft are wired to real state.
The endpoint must support the capabilities you use. “Thinking” is shown only
when the provider supplies it, never fabricated.

## Chat engine migration — 9 September 2026

The source now uses pinned Pi **0.85.1** in place of the custom Hello model/tool loop, in
persistent RPC mode, adapting the existing headless chat from the owner's the sibling app
app. Pi owns agent execution, session context, retries and compaction. Hello.
keeps its SQLite conversation UI, encrypted settings and existing tool gates;
browser, notebook, file and command tools reach the same main-process services
through a private per-chat bridge. This does not add the sibling app orchestration,
reporting or another CLI-worker system. Existing terminal clients stay separate.

The integration contract starts with **32,768 context tokens / 4,096 output
tokens**, configurable to match the actual server. The compaction reserve is
`max(16384, output + 4096)` tokens: these defaults trigger compaction above
16,384 estimated context tokens (50% here), not one universal percentage.
Compatibility can be selected as `auto`, `openai` or `qwen-chat-template`.
These values do not detect the server's true limits or guarantee better answers.
This initial reserve profile requires at least 20,480 context tokens; a larger
output budget may need more. Enter the server's actual loaded context, not an
invented larger value to bypass validation.

Next: validate the same real prompts/model/materials in Hello. and the working
CLI. Settings-based extensions, skills and local MCP integration are implemented
and verified with local fixtures; real-model quality remains a separate check.
See the
[implementation order](docs/MINI-ROADMAP.md#ordinea-concreta-de-implementare).

## Research and execution

- **Files:** choose **+ → Files** in this conversation's tools. The document is
  on the left, a filterable React Arborist tree on the right. Choose a folder if
  this conversation has none. Folders load on demand; filtering searches names
  and paths, not file contents, and skips dependency/build/.git directories.
  **Preview / Source** switches Markdown rendering and highlighted source;
  Copy copies the original content. **Open** offers the default app, Show in
  Finder and Copy path. Markdown file links, relative document links, heading
  anchors and `file.ts:42` references open in this viewer. It is read-only, not a
  CodeMirror editor. No files are sent to the model by opening the viewer.
  Narrow panels switch between tree and document with the tree button; Expand
  uses the existing Tools control. Hidden tabs keep their selection and content.
  Refresh rereads disk. Files outside the conversation folder are rejected,
  including escaping symlinks. Previews support UTF-8 text up to 2 MB / 20,000
  lines; unsupported files get an explicit external-open option, not a truncated
  preview. Markdown over 200,000 characters falls back to source. Listing/search
  caps at 10,000 entries or four seconds and reports incomplete results.
- **Direct web research:** `web_search` finds public pages and `fetch_url` reads
  them without a visible browser, attached folder or Agent control grant. The
  tool sequence collapses into **Researched “…”**; click it to inspect searches,
  page text and any errors. Successfully read pages receive clickable **[N]**
  citations. Source icons beside the response actions open a **Sources** menu
  with the domain and full title; selecting a row opens that page. Copy/export
  retain the source URLs. Search previews and failed reads are not cited sources.
  DuckDuckGo HTML search is the default; optional `HELLO_SEARXNG_URL` selects a
  public SearXNG JSON endpoint on a standard HTTP(S) port. Bot walls, binary
  documents and JavaScript-only pages can prevent a read and are reported.
- **Runbook / Tasks:** one shared rich-text editor with autosave; Markdown stays
  behind the editing surface and in the exported `.md` files. Format selected
  paragraphs together, use real task checkboxes, and right-click for **Copy**
  (formatted/plain text) or **Copy Markdown**. Without a selection these actions
  copy the entry. Unsupported Markdown is preserved with an explicit source
  editing fallback, never silently discarded on opening. Each chat starts with
  valid empty notebooks.
- **Terminal:** native PTY and xterm renderer, launched in the chat's folder.
  Background sessions continue producing output. Closing a running session asks
  for confirmation; quitting the app stops its sessions.
- **CLI worker:** installed Claude Code, Codex CLI, Qwen Code, Kimi Code,
  OpenCode, Pi and Aider are detected in the nested launcher. Each CLI uses its
  own authentication/permission flow; model-bound clients use the selected
  compatible endpoint. No task is sent automatically.
- **Notebook handoff:** workers receive `HELLO_RUNBOOK_PATH` and
  `HELLO_RUNBOOK_TASKS_PATH` as environment variables. Ask a worker to read them
  when you want it to execute the work. No notebook is injected into its prompt.
- **Browser:** a real isolated Chromium page, sandboxed in its own session and
  hosted inside the window, so menus and dialogs simply draw over it instead of
  hiding it. Every tab starts
  with **Agent control Off** (grey). Read only is orange; Full control is red.
  Grants belong to that tab and reset Off on app restart. Human navigation
  works independently of these agent grants. The chat can also open a requested
  page/dev URL or attached HTML preview directly in Hello with Off retained;
  reading needs Read/Full and page interaction needs Full. Before each model round the agent
  gets fresh owned-tab IDs, visibility and permissions, so it can choose a
  relevant accessible pane among multiple open tabs. It cannot silently raise
  permissions or substitute a different explicitly requested tab.
- **HTML visuals:** `browser_show_html` saves a self-contained HTML document and
  opens it inside Hello in one call, including in chats without an attached folder.
  Outputs are limited to 512 KiB and stay with the conversation; the returned
  `artifact:<id>` can reopen them after restart. Opening does not verify chart
  data, JavaScript execution or rendered correctness. Existing file previews
  continue to require the file's attached folder.
- **Main-chat tools:** notebooks, scoped file listing/reading, file writes,
  shell commands and browser actions. File writes and shell commands require
  explicit approval. Shell approval is not an OS sandbox; inspect the command.
- **Drag and drop:** Finder files and Hello's Files rows can be dropped onto chat
  or an embedded CLI/terminal. Chat stages removable text/image attachments and
  sends their contents through Pi when you send the message. A single dropped
  folder becomes the working folder. CLI drops paste quoted file paths and wait
  for Enter. Chat supports UTF-8 text/code plus PNG/JPEG/WebP/GIF, up to 8 files;
  text is bounded to 128 KiB/file and 400 KiB total, images to 5 MiB/file and
  8 MiB total. Unsupported binary formats, including PDF, return an explicit
  error. Image input requires a model/provider that accepts images.

Web-tool changes run in Electron's main process. If an existing dev session was
started without main-process watching, restarting `pnpm dev` is required to load
them; a renderer-only hot update cannot add tools to an already-running backend.
The Pi migration has not been exercised against a model or the running app;
the user is doing dev testing. No tests, build or app restart were performed for
this migration. Static type checking is tracked separately from runtime checks.

The main agent knows Runbook and Tasks are shared knowledge. It can read Runbook
but cannot change it through notebook tools. It can create/edit Tasks and update
individual checklist items as pending, in progress, done, canceled or blocked.
The human can still edit both notebooks. Agent changes refresh the Tasks panel
without overwriting locally unsaved edits. Contents are read through tools when
relevant, not silently injected into prompts. This is the main-chat tool policy;
independently launched CLIs retain their own filesystem/permission behavior.

## Extensions: skills, plugins and MCP servers

**Settings › Extensions** holds one library for the whole app: **Skills**
(instructions plus reference files), **Plugins** (Pi packages that add
extensions, skills or prompt templates) and **MCP servers** (local programs
started over stdio). Importing copies the files into Hello's own data folder
and records a fingerprint of that approved copy; it never runs the imported
code, installs dependencies or reaches the network. A package that declares npm
dependencies is imported with a warning, not an install.

**Find what other agent tools already have** reads the configuration files that
Claude Code, Claude Desktop, Codex, Kimi, Gemini CLI, Qwen Code, Copilot CLI,
opencode, Crush, Continue, Cursor, Windsurf, VS Code and Zed write on this Mac,
and lists the MCP servers and skill folders they describe so you can add one
without retyping it. Per-project configuration is read too — `.mcp.json`,
`.vscode/mcp.json`, `.cursor/mcp.json` and `.claude/skills/` inside the folders
those tools have recorded, plus the folders this app's own chats are attached to. Those files are read, never written or executed, and their
environment values stay in the main process — the window sees variable names
only. Servers that are not stdio are shown but cannot be added, with the reason.

Nothing is active until you turn it on for a specific chat, from the
**Extensions** control in the composer. Activation belongs to that conversation
only. Changing the selection applies from your next message: Hello restarts the
chat runtime with exactly that set and keeps the conversation history.

- **Skills** are passed to Pi as explicit paths, with discovery still disabled.
  Their names and descriptions reach the model; `skill_load` returns the full
  `SKILL.md`, or one of its reference files, for skills active in that chat.
  Typing `/skill:name` expands the skill through Pi.
- **Plugins** contribute their Pi extensions to the same child process. Extension
  code is Node, not a sandbox; review a package before importing it. Their
  bundled skills join the same list, and prompt templates load explicitly into
  Pi (`/concise` in the bundled example). Explicit `pi` manifest entries control
  selection; conventional folders are used only when that manifest is absent.
- **MCP servers** are Hello's own stdio client: Pi 0.85.1 has no built-in MCP.
  Hello connects, lists the server's tools and offers them as `mcp_…` tools in
  the chats where you activated that server. Environment values are stored with
  the same encryption as the model key and passed only to that server's process.
  Turning a server off removes access from that chat; its process stops when no
  chat keeps it active. Settings also provides Connect/Disconnect and an editor
  that preserves separate arguments, working folder and stored environment.
  A Settings connection starts the server to inspect its tools without granting
  chat access. Stop sends cancellation for a running call, but cannot undo work
  already performed by the server.

If the approved copy of a skill or plugin changes on disk, the next message in a
chat using it stops with the extension named, instead of loading files you did
not approve. Update or turn it off in Settings.

Two example skills (**hello-visuals**, **hello-research**) and one example
plugin (**hello-text-tools**) ship with the app and import from the same screen.

Current validation and limits: [extensions verification](docs/EXTENSIONS-VERIFICATION-2026-09-10.md).

## Data and design

The application owns `~/Library/Application Support/Hello Workspace/`:
SQLite, exported notebooks, encrypted settings and browser session state.
The Pi integration adds private per-chat JSONL sessions in this same app-data
root, with a one-time import of an existing Hello chat's history. It does not
read the sibling app sessions. Model keys are passed through the child environment, not
written into Pi model configuration files.
The old repositories and their user data are untouched. An absolute
`HELLO_DATA_DIR` overrides the location for isolated development/testing.

The visual contract is [design/LOOK.md](design/LOOK.md). Executable ownership and
layout/motion rules are in [design/IMPLEMENTATION.md](design/IMPLEMENTATION.md).
The **complete approved mockup source**, not just the design document, is
preserved alongside them in [design/reference/](design/reference/README.md).
That archive is a historical specimen; production changes belong in `src/`.

The browser's Agent control footprint stays fixed at **202 × 32 px**. Only its
content fades; adjacent UI never reflows when the permission label changes.

## Develop and verify

Use Node.js **22.19+** and pnpm **9.15** on macOS (Pi 0.85.1 requires 22.19+). Native modules must be compiled
for Electron, not the system Node ABI.

```sh
pnpm install --frozen-lockfile
pnpm rebuild:native
pnpm dev
```

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:native
pnpm package:mac
```

`pnpm test` deliberately runs Vitest under Electron-as-Node so SQLite has the
correct native ABI. `test:native` launches the real app with a new temporary data
directory and a loopback fixture server; it does not contact a paid model.
Optional `HELLO_QA_WORKER=codex` verifies an installed CLI's startup without
submitting a task. `HELLO_TEST_APP` can point to the packaged executable for the
same acceptance suite. Generated results/screenshots live in `test-results/`.

To inspect the archived mockup independently, install its own locked dependencies
inside `design/reference/` and run `pnpm dev` there (port 4318). The real app needs
Electron's bridge; a browser-only preview does not replace native testing.

See [architecture](docs/ARCHITECTURE.md), [security boundaries](docs/SECURITY.md),
[provenance](docs/PROVENANCE.md) and [acceptance evidence](docs/ACCEPTANCE.md).

Planned product work is tracked in the [mini-roadmap](docs/MINI-ROADMAP.md),
with its [research and source audit](docs/feature-research/RESEARCH-2026-09-09.md)
and the cross-category demand research on
[what users of comparable apps love, ask for and expect](docs/feature-research/MOST-WANTED-FEATURES-2026-09-09.md).
Roadmap items are proposals, not shipped features.
