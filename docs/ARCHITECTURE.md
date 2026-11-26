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
| DSH host (utility process) | One DeepSeek Harness profile (`hello`), booted like dsh's own desktop host; hosts the upstream DSH application | [`dsh/host-entry.ts`](../src/main/dsh/host-entry.ts), [`dsh/service.ts`](../src/main/dsh/service.ts) |
| Workbooks | ExcelJS workbooks and IronCalc recalculation in main; the renderer shows a snapshot in Univer and reports typed cells | [`sheets/workbooks.ts`](../src/main/sheets/workbooks.ts), [`renderer/sheets/SheetsPane.tsx`](../src/renderer/sheets/SheetsPane.tsx) |
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

The chat area contains pills without close buttons: Chat, and — only in a chat
that has it on — Workbook (user, 29.09: one button beside Chat, not one per
section). The Workbook is what the person calls the chat's notebook: in code,
in the model's tools and in the stored data it stays `notebook`, and a
"workbook" there is an Excel file of the Sheets pane. It is a switch of the
chat, **off by default** (user, 17.11: a chat is a chat until it needs more),
first in the chat's menu in the sidebar, stored as `chat-notebook:<id>` and
read as `Conversation.notebook`. While it is off the pill and the page are not
there, and every section reads as off whatever is stored for it
(`hydrateConversation`), so the model has no notebook tools, no line about
them in its instructions, and CLI workers get empty exports; switched on
again, the sections are as they were. A chat that used the page before the
switch existed — a section on, or anything written — had it written down as on
(database version 17). The
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

## The gate: Ask first

A model is trained to do something and explain afterwards what it did not
know, never to ask first; people write to it the way frontier models taught
them to write. A local model given such a request guesses, loops and delivers
a fraction (user, 18.11). So Hello closes the gap before the agent sees the
request: [`chat/gate.ts`](../src/main/chat/gate.ts).

When **Ask first** is on for a chat (the sidebar menu; on by itself for a
model on a server of the person's own, `ownServer`, off for a provider; the
person's choice is stored as `chat-ask-first:<id>`), `ChatService.send` with
`{ gate: true }` — only the IPC `chat.send`, never a queued message or a
worker's report — makes one short call to the chat's model first: no tools, no
history, thinking off where the connection takes the switch, a 1–2K prompt.
The model answers with what it understood, the execution decisions it takes
as assumptions, and at most three questions, only about the problem. With
questions, the reply's bubble ends there with them, the state waits in
`chat-gate:<id>` and the person answers in the composer; the answer goes back
through the gate (at most two rounds, then it decides and lets the work
through). Without questions, the bubble carries on as the agent's reply to a
**work order** — understood, assumed, asked and answered, and the person's own
words last, as reference — and the instructions tell the model to execute the
order in one pass and never reopen what it settled. A failed call lets the
request through as it was; a restart clears what the gate waited on. The
gate is also told the last order it handed this chat (`chat-order:<id>`), so
"now add a sheet" is read against it, and the names of the files attached to
the message. A plain question or a conversation (`work: false`) goes to the
agent as the person wrote it. `tests/gate-eval.test.ts` runs 18 requests through
a live server (`GATE_EVAL=1`) to tune the prompt by reading the verdicts. The
agent assumes at the level of execution, never at the level of the problem.

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
filesystem bridge or automatic content injection is added by the viewer. External
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

The coding group's `file_search` (T064) reuses `WorkspaceFiles` for literal
content and filename searches. Its separate instance uses the same bounds,
adds the automatic tools' secret-path exclusions and follows the turn's Stop
signal without cancelling a human search. It needs an attached folder, not an
approval or a browser grant.

Successful `file_edit`/`file_write` calls emit a main-owned `files-changed` event
(chat, folder and canonical relative path only). Files rereads only the matching
open document, coalesces bursts, and retains its tree selection, mode, scroll and
text-selection positions. Late reads cannot replace a newly selected document.
There is no filesystem watcher, and reads/rendering emit no change event.

## Conversation Sheets tool

A chat can hold Excel workbooks. Three libraries, one job each, all local:

| Job | Library | Where |
| --- | --- | --- |
| The workbook itself: read and write `.xlsx`, cells, formulas, looks | ExcelJS (MIT) | main, [`sheets/workbooks.ts`](../src/main/sheets/workbooks.ts) |
| Computing the formulas | IronCalc, its N-API Node binding (MIT/Apache-2.0) | main, [`sheets/engine.ts`](../src/main/sheets/engine.ts) |
| The grid the person sees and types into | Univer sheets-core preset (Apache-2.0) | renderer, [`sheets/SheetsPane.tsx`](../src/renderer/sheets/SheetsPane.tsx) |

Main owns the workbook. The renderer holds a picture of it (`SheetSnapshot`,
[`shared/sheets.ts`](../src/shared/sheets.ts)) and reports what was typed; it
never names a path and never writes a file.

**Two kinds of workbook.** One Hello made (`sheet_new`, the pane's New, or a
copy of a file picked from outside the folder) lives whole in
`sheets/<sha256 of the chat id>/<uuid>.xlsx` beside a small `<uuid>.json`
record, and is kept after every change. One opened from the chat's folder
(`sheet_open`, or the pane's Open on a file inside the folder) is only pointed
at by its folder-relative path: its changes are held in the same working copy
and reach the file only on a save. Both survive a restart, unsaved changes
included. The previous contents of a file a save replaces are copied to
`sheets/<key>/history/` (the last 10). Deleting a chat removes its `sheets`
folder.

**Computing.** Every write ends in `recalculate`: ExcelJS writes the workbook
to a private scratch file (`sheets/scratch/`, removed at once — the binding
loads xlsx by path), IronCalc evaluates it, and each result is put beside its
formula, so a saved file opens with values. A formula that ends in an error is
returned by sheet, cell, formula and error. When the engine cannot load a
workbook nothing is changed and the answer says the values may be old. The
call is synchronous in the main process; workbooks are capped at 20 MB.

**What is not carried.** ExcelJS does not round-trip charts, pivot tables,
macros, slicers or links to other workbooks. Opening a file notes which of
those its package holds (`lossy`); such a file is never saved over — only to a
new path — and both the model and the pane say what the copy lacks. Only
`.xlsx` opens.

**Model tools** ([`sheets/tools.ts`](../src/main/sheets/tools.ts)), the
`sheets` tool group, loaded with `tools_find` like the others: `sheet_list`,
`sheet_new`, `sheet_open` (only with a folder), `sheet_read`, `sheet_write`
(a block of rows, single cells, a look for a range, column widths; text
starting with `=` is a formula; an unknown sheet name adds the sheet) and
`sheet_save`. One workbook is one working place: the result of work on a
workbook's data is a new sheet of that workbook. The tools hold that line —
`sheet_new` refuses a title the chat already has and says when the chat holds
other workbooks, `sheet_write` refuses to guess a sheet when there are several,
and only a sheet the model added (`added` in the workbook's record) can be
removed again (`removeSheet`). `sheet_read` with `summary` gives each column in
a few numbers, so a large table is not read row by row. `sheet_group` is the
pivot a person asks for, done by main in one call: the distinct values (or
combinations of up to three columns) written once as labels in a new sheet,
each with a `COUNTIFS` on the source, a share, a total and the count of rows
with no key. It exists because a model given only cell reads and writes read
the whole table to find the distinct values (a traced Haiku run: 19 calls and
107,000 characters of results for what is now one call of about 1,200). A formula that returns
a range (SORT, UNIQUE, FILTER…) keeps one value and is reported as `notKept`.
Spreadsheet work is coder work, done with the shell and the file tools every
chat has in view. A table reaches
a script as a file, not through the model: `sheet_read toFile` writes the
sheet's values as CSV to `sheets/<key>/exchange/` in the app's data and
returns the path; the script (python3's `csv`, or node, through `bash`)
writes its result beside it; `sheet_write fromFile` places a CSV from that
folder or from the chat's folder, nothing else. A script never opens the
`.xlsx` itself — main holds the workbook.
**Where the person is looking.** The pane tells main which workbook and sheet
it shows and which cells are selected (`sheets.select`, `Workbooks.setView`;
memory only, cleared when the pane is hidden). The chat's live context carries
it as one line — workbook, sheet, range, never cell contents — taken once per
reply like the clock, so "check the formulas here" has a here. The pane shows
what will go with the next message.

**Charts.** `sheet_chart` puts a real Excel chart (bar, column, pie, line) in
a sheet from a range of labels and a range of numbers. It runs Hello's own
fixed openpyxl program (`chartScript` in `sheets/charts.ts`) through the same
door as `sheet_script`; what the model chose reaches it as data, never as
code, and a chart already at the anchor is replaced rather than joined.
`sheet_save discard` gives up a file workbook's unsaved changes
(`Workbooks.revert`).

**The shell in a chat.** `bash` is in the core tool set wherever a chat has a
folder, and Hello's extension keeps a tool of that name active in every chat
step (`activeNow`, `pi-extension.ts`): tools a group brings exist only from
the step after `tools_find`, and models call the shell in the same message
that loads a group.

**Scripts.** `sheet_script` runs Python with openpyxl on a workbook's own
working file ([`sheets/python.ts`](../src/main/sheets/python.ts),
`Workbooks.runScript`) — the route to what ExcelJS cannot write: real Excel
charts, merged cells, conditional formats, structural edits. This is the
approach of Anthropic's xlsx skill, with IronCalc in place of its LibreOffice
recalculation. The interpreter is a virtual environment in
`sheets/python/venv` in the app's data, built on first use (`python3 -m venv`,
then `pip install openpyxl`, and pandas only where a ready-made build exists);
the system's Python is not changed. A script gets `WORKBOOK` and `OUT`. Before
it runs the file is copied; afterwards main reads it again, computes it in
memory and returns the formula errors, or puts the copy back when what is left
is not a workbook. What a script made that ExcelJS does not carry is recorded
(`scripted`, the same package markers as `lossy`), and export and save hand
over the file's own bytes. Charts are carried through Hello's own writer
([`sheets/carried.ts`](../src/main/sheets/carried.ts)): after `sheet_write`,
`sheet_group` or typing in the pane, the file ExcelJS wrote takes each sheet's
drawing, its charts and what they name from the file that held them, matched
by sheet name, so tables and charts are made in any order. Anything else a
script made that ExcelJS does not carry still makes the file the script's:
those writers are refused with the reason. `sheet_chart` cuts a pie of more
than nine groups to the largest eight and Other (`top` for any chart), from a
small table of formulas it writes beside the chart. `sheet_save` given the path
of the file the workbook was opened from is a save over it, not a copy. The
pane does not draw charts and says so. The
charts a file holds are read from its package
([`sheets/charts.ts`](../src/main/sheets/charts.ts): sheet, kind, title,
anchor, cells) and returned by `sheet_script` and `sheet_read`, with a note
when two charts of a sheet draw the same cells — openpyxl keeps existing
charts on load, so adding one again leaves two. ExcelJS
cannot even load a file whose sheet has a chart, so such a file is read from a
copy with its drawing parts taken out (`readWorkbook`); this also lets a file
that came with charts be opened at all.

The group's manual (`sheetsManual`) carries the working rules: one place,
prepare before writing, formulas rather than computed totals, fix reported
errors, what the tools lack (pivots, charts), say what is unsaved.

**The pane.** One Sheets tab per chat (`sheetsOpen`), holding all the chat's
workbooks with one shown. Univer is imported on first use. Its toolbar, sheet
bar and context menu are off: formats, sheets and rows are not reported to
main, so the pane does not offer to change them; the pane draws its own sheet
tabs. A change by the model rebuilds the grid from a new snapshot; what the
person types arrives as `SheetValueChanged`, is sent as cell edits
(`sheets.edit`) and computed by main, which ignores a report of what it
already holds. A workbook the model makes or opens brings the Sheets tab up
beside the chat without taking focus. IPC is in
[`sheets/ipc.ts`](../src/main/sheets/ipc.ts); `hello:sheets-changed` carries
ids and a revision, never data.

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
  openjev/                      Unclutter: the port and log of an OpenJev helper Hello started
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

**A field the schema does not know loses no call (T196).** Hello's tools are
closed objects (`additionalProperties: false`), so one unexpected field made
Pi refuse the whole call before Hello saw it: a model wrote `description`
beside `command` — the shape another harness's shell takes — and every `bash`
call came back "description: unknown field", with the command never run.
`schemaArguments` now drops a field a closed schema does not know, after the
snake_case mapping, and lets the call through; an open schema still keeps
everything, and a missing required field is still missing. The same reading of
a call by intent that `tools_find` already had.

**Three rules that cost a run its minutes (T194).** Measured on one task: a
12,618-character script re-sent whole to mend one line; six checking scripts,
each reading 29,425 rows again; and a script named `inspect.py`, which Python
loaded in place of the module openpyxl imports — the same name chosen in two
separate runs. The system prompt now says a script is written once and mended
with `file_edit`, never named after a module, and checked in one pass at the
end. They sit in `modeGuidance`, not in `CODING_MANUAL`: the `coding` group is
`core`, and every path in the Pi extension filters `!group.core`, so that
manual is never delivered.

**The script rule names the re-send, not one way of writing a file (T203).**
The first of those three began "A script you will run more than once", which
nobody knows at the first send, and named `cat > file <<EOF` as the thing to
avoid — but that is how a script reaches a file from the shell at all. The run
on 20.11 avoided it and piped the script into the interpreter on stdin,
`python - <<'PY'`; when the model did reach for `file_edit` there was nothing
there: "_build.py does not exist. Create it with file_write." It then sent an
8.4K script four times — 37,381 of its 49,487 command characters. Across eleven
runs of that prompt in the chat store, six re-sent a build script whole at
least twice, in both shapes: `cat > build.py <<'EOF'` twice in one run, the
interpreter's stdin in another. What costs is the re-send; the run that sent
once spent 8,378 characters in all, and writing the file first is not what
makes a run fast (one that did: 11,888 characters, 326 s) — it is what makes
the mend cheap. The rule is now unconditional and names both shapes: a script
of more than a few lines is created once with `file_write`, run by name, and
mended with `file_edit`.

**The run snapshot names the versions, not just the path (T204).** Five bash
calls in four chats print `openpyxl.__version__` from the very interpreter the
snapshot had already named — three of them ask nothing else — and nothing has
ever told a model that pandas is installed in the same environment. The
snapshot line now reads the receipt `prepare()` writes, `ready.json`, through
`sheetPythonLibraries(dataDir)`, and says "A Python with openpyxl 3.1.5 and
pandas 3.1.1 is ready" — pandas only where it actually installed, since it is
left out when there is no ready-made build. With no receipt beside the
interpreter Hello does not know what is in it and says nothing at all, where
before it claimed openpyxl from the file's existence alone. The text stays
constant, so it costs no prefix cache. It names what is there; it does not stop
a model guessing a class name openpyxl has never had.

**Files shows a workbook and a document, not a refusal (T206).** Clicking
`gps_tracking_3months.xlsx` in the file tree gave "This file is larger than
2 MB. Open it in its default app" — the viewer reads UTF-8 text and an .xlsx is
neither text nor small. Two previews now sit in front of that message.

A workbook is drawn by the same grid the Sheets pane uses.
`Workbooks.preview(conversationId, path)` resolves the file through the chat's
own `resolveFile`, reads it with the existing `readWorkbook` — chart-stripping
fallback and all — and returns a `SheetSnapshot` built by `gridsOf`, the sheet
builder lifted out of `snapshot()` so both callers draw identically. It adopts
nothing: no meta is written, no `SheetChange` is announced, the workbook does
not join `list()`, and the model is told nothing. That is the point. An .xlsx
the chat holds added 29,084 characters to every request (a probe, 17.11), and
clicking a file in a tree is not a request for that. `WorkbookPreview` is
therefore read-only, and has to be: what is typed there reaches no one, so
typing and double-click are stopped before the grid sees them while moving,
selecting and copying are not.

The pane says which of two things is true, because only one of them always is.
`preview` looks the file up among the chat's own metas first — the lookup
`openFile` already does — and sets `openInChat`. Without it the notice says
looking here opens nothing and the model has not been told; with it that would
be a lie, so the notice says instead that the chat is working on the file in
Sheets, where any unsaved change is, and that what is drawn here is the file as
saved. The person's 2.1 MB, 412K-cell sheet costs 417 ms and a 2.5 MB snapshot
on the click that opens it, capped at `MAX_SNAPSHOT_CELLS` like any other; the
report it built, 31 ms (a probe, 20.11). Nothing is cached, and nothing is read
again until another file is clicked.

A Word, RTF or ODT document goes through the Mac's own `textutil`, the same
bargain as poppler for PDFs: no library in Hello, and what macOS already reads,
Hello shows. `documentText` in `files/service.ts` spawns it with `execFile`, so
the path is an argument and never passes through a shell, and the file is only
read. textutil is forgiving to a fault — a file holding NUL came back as
`abc\u0000\u0001\u0002def` (a probe, 20.11) — so text with a NUL in it is refused rather
than shown. `FileDocument.converted` marks what came out, and the pane says the
formatting, images and tables are not in it.

**A CLI pane hears about that Python too (T207).** The sentence T193 added went
into the chat model's run snapshot and nowhere else, so a Qwen Code worker
opened in a chat built its own `.venv` inside the human's task folder (20.11).
The worker guide `notebook-context.ts` writes, `HELLO.md`, now carries its own
short section from the same receipt: where the interpreter is, which versions
are in it, and not to pip install them or build a venv for them, least of all
in the human's folder. It appears only when the interpreter is really there.

**OpenCode starts again, and in its own server (T208).** Hello passed
`--model hello-active/<model>` on OpenCode's command line. Its root command has
no such flag any more — v2.2.5 lists `--standalone`, `--server`, `--auto`,
`--continue`, `--session` and `--prompt`, and exits 1 on anything else — so
every OpenCode pane died with "Unrecognized flag: --model in command opencode"
before it drew anything. The flag is gone; `OPENCODE_CONFIG_CONTENT` already
named the model as `model: "hello-active/<model>"`, which is how OpenCode is
meant to be told, and `opencode debug config` confirms it reads that variable.

Removing the flag alone would have replaced one failure with a worse one. The
root command attaches to **one background service shared by every pane**, and
that service keeps whichever `OPENCODE_CONFIG_CONTENT` started it. Measured on
v2.2.5: with a service already running on one config, a second process carrying
a different one still reported the first's model, and the same call with
`--standalone` reported its own. Everything that makes a pane this chat's lives
in that variable — the model, the instructions file, and the `hello` MCP server
with this conversation's bridge token — so a shared service would hand a worker
in one chat another chat's connection. Hello now launches
`opencode --standalone --auto`.

**Aider is handed its folder, because nothing else ever reaches it (T209).** A
run on 20.11 opened Aider in a task folder holding `gps_tracking_3months.xlsx`
and `prompt.doc`, and it answered that it had no files — 620 tokens sent, not
one file name among them. Three facts in the installed 0.86.2 explain it, and
together they decide the design. Aider takes no MCP server, so the connection
every other CLI gets has no channel here. It has no shell either, in Hello:
`io.py` answers `"n"` when `self.yes is True` and the question required an
explicit one, and running a shell command is asked exactly that way, so the
`--yes-always` that makes every pane never-ask is what takes Aider's shell
away. And it cannot fetch a file by naming one, because
`get_addable_relative_files` offers only what git tracks — a task folder tracks
nothing, and Aider had just created the empty repository itself.

So the argv is the whole channel, and `aider-folder.ts` fills it before the PTY
starts. It reads the top of the launch folder through the same `WorkspaceFiles`
the Files pane uses — inside the folder, links not followed, credential files
excluded — and hands back three things: a guide, the text files, and the
documents. The guide goes in as `--read`: it names the folder, says there is no
shell and no connection so the model stops writing commands that will never
run and stops hunting the disk for task files, and lists every entry with its
size and whether it is in the chat. The folder's own UTF-8 text files go in as
`--file`, which Aider edits in place — but only where `git ls-files` finds
nothing, because in a repository Aider is not blind and its own map already
covers them; the test for that is what git tracks, never whether `.git` is
there, since Aider makes an empty one itself. A Word, RTF or ODT document goes
through the same `textutil` the Files pane uses (T206) and in as `--read`,
because what Hello writes is a copy and an edit to a copy reaches no original.
Everything is bounded, since Aider sends its whole chat with every request:
32 KB a file, 64 KB in all, twelve files, 200 entries named, and the budget is
asked before a read as well as after, so a full chat never spends fifteen
seconds of textutil on a document it will leave out. What does not fit is named
in the guide instead, which is the point — a file Aider is told about and
cannot open is one it can say it cannot open, rather than one it invents. There
is no `--message` and no `--load`: this is context, never a task to start.

On the folder that started this, Hello hands over 1,459 bytes of guide and
`prompt.doc` as 2,141 characters of read-only text, names the 2.1 MB
spreadsheet it cannot open, and passes no `--file` at all, because there is no
text file there (a probe, 20.11). That directory is the one private home Hello
fills itself rather than the client, and it holds the human's own words, so
unlike the CLI homes that keep their own transcripts it is removed when the
session ends — not before, since Aider re-reads its `--read` files with every
message. A crash ends no session, so the next start sweeps whatever is left of
an `aider-*` home, and only those.

**The Python Hello keeps is named in the snapshot (T193).** The Mac's own
`python3` need not have openpyxl — on the owner's it is Homebrew 3.15, which
does not — and the only line saying Hello keeps one that does lived in the
sheets manual, which is not loaded unless that group is. A model working in the
shell therefore spent minutes probing interpreters and then built a 16 MB venv
beside the person's data for a library already present. `liveContext` now names
`sheetPythonInterpreter(dataDir)` when that file exists, with the rule not to
pip install or build a venv. The path is constant, so it costs no prefix cache.

**A script is checked before a line of it runs (T202).** The model's code is a
file of its own, `script.py`, line 1 its own line; `run-script.py` beside it
sets `WORKBOOK` and `OUT` and compiles the whole script under the name `your
script` before executing it. A typo is therefore caught with nothing done and
reported where the model wrote it: it used to be three lines lower, pushed
there by the two names Hello put above the code, so the model was sent to look
at a comment. The runner's own frame and the source line Python echoes under
it are taken out of the output, and the script's real path, which carries the
chat's hash, is replaced by `your script`. The idea came from a reader's
suggestion of a pre-flight gate; Hello needed no dependency for it, since the
compile is one line of the runner and costs no extra process.

**A sheet's extent is read once (T185).** ExcelJS's `columnCount` is a getter
that walks every row of the sheet, and `rowCount` reads back over the row
array. Left in a loop condition, either turns one pass over the cells into a
quadratic. `sheet_read toFile` on a 29,426 x 14 sheet took 237,553 ms that way
and 124 ms with the counts read once — and those four minutes were spent inside
the main process with nothing yielding, so the window, the IPC and the Pi tool
bridge stopped with it. Every pass now takes `extentOf(sheet)` first
(`main/sheets/workbooks.ts`) and loops on the numbers; a count never appears in
a loop condition. `tests/sheets-tools.test.ts` builds a 6,000-row sheet and
fails if export, summary or grouping stops being quick.

**Reasoning effort, beside the model (user, 17.11).** The composer has an
effort selector next to the model picker: a Thinking switch and Low, Medium,
High (`shared/reasoning.ts`, `EFFORT_LEVELS`). It is the same
`settings.reasoningEffort` Settings always had, saved through `settings.save`;
it reaches Pi as `--thinking`, so a change applies from the next message, in a
session whose launch says so. Under the switch the menu says what the chat's
connection does with a level (`effortHint`, from `reasoningReach`): the level
itself, only on or off, or nothing at all. Nothing above High is offered: for
a model Hello declares to Pi without a `thinkingLevelMap`, Pi sends the
provider's own value through `high` and treats `xhigh` and `max` as
unsupported.

**One way of working (user, 17.11).** A chat has no mode: the Chat/Coder
switch is gone, and with it every "if" it stood for. Every chat runs on Hello's
own system prompt (`--system-prompt`; Pi's coding prompt, written for tools
Hello does not offer, is never appended to), has `bash` and the file tools in
view from its first step, and reads its folder's root instructions. A reply
also always has a folder: where the person chose none, `ChatService.start`
attaches the folder Hello keeps for the chat (`ensureFolder`, the same
`Chat files` folder a dropped file lands in), so no tool waits for one. To the
person that folder is "none chosen" — the composer and Work path show it as
not set — and what is made there reaches them as a link. A `chat-mode:` row an
older version stored is read by nothing and goes with its chat. What still
asks is what was never a mode: approvals, per-tab Agent control, path scope.

**Engine updates.** The sidebar's footer shows the Pi that runs and, only when
npm's `latest` is newer, `update` (`chat/pi-engine.ts`, asked a moment after
start and every six hours). Updating installs that version with Hello's pnpm
into `<data>/pi/runtime` (a staging folder renamed into place); chats start Pi
from it while it is newer than the bundled one, and the engine is part of the
session fingerprint, so a chat moves at its next message. Going back removes the
folder and the bundled Pi runs again; a Hello that brings a newer Pi of its own
outgrows an older update. The DSH row offers the latest npm release for its
hosted launch, without a bundled-version fallback (see below). The terminal's Pi tab
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
`qwen-chat-template`. Pi owns retries and automatic compaction, and
`contextBudget` in `src/shared/context-budget.ts` is the one arithmetic that
decides what it is told: the scaled window, the output budget, the reserve,
and how much a summary keeps. The launch writes it into Pi's settings and the
meter under the composer draws it, because two copies of this drift and the
person reads the one that is wrong.

Pi compacts when `tokens > window - reserveTokens`, counting with the last
assistant reply's provider-reported usage plus a characters/3.5 estimate of
everything after it (`estimateContextTokens`) — mostly measured, with the
newest tool results guessed. The reserve is
`max(16384, maxTokens + 4096, floor(window × 0.45))`; below a 36,409 window the
flat 16,384 binds, above it the proportion does, and it is there because what
Pi has not counted yet arrives all at once — a page it reads is twelve
thousand tokens, and the check happens before that result exists.
`contextScale` catches a model where even the anchored count ran low. This is
not a universal compaction percentage, a measured server capability, a second
Hello compactor, or a guarantee of correct answers. Same-model/same-prompt
validation is still required.

**An output budget is a ceiling, not a floor (T210).** Saved as 32,768 on a
65,536 window it made the reserve 36,864 — more than half the window — so a
chat summarised itself at 28,672 while the meter, dividing by 65,536, read
37%: two compactions inside one reply, 2m14s apart, and the person asked what
threshold that was meant to be (user, 24.11). The declared output budget is
now capped at a quarter of the window, so it never decides the reserve again
(above 20,480 the proportional term always wins), and the setting itself is
still never rewritten — the same bargain as nativ#684, where a learned scale
shrank the window and a chat that answers shorter beat one that refuses to
start. What a summary keeps went from half of what is usable to a third,
because the summary, the system prompt and the tool schemas sit on top of it,
uncounted: 10.8k of the 25,160 that first compaction left. On that window the
usable context goes 28,672 → 36,045 and the room left after a summary goes
about 3.5k → about 16k.
The first profile requires at least 20,480 actual server context tokens;
the output cap can raise this minimum. Smaller profiles need separate tuning.

The pinned startup contract disables AGENTS.md/CLAUDE.md discovery with Pi's
`-nc`; extension/skill/prompt discovery stays disabled with `-ne`, `-ns` and `-np`.
In every chat, Hello explicitly imports root `AGENTS.md` (or root
`CLAUDE.md` when AGENTS.md is absent) from the chat's folder, capped at 32 KiB.
It does not walk parents or subfolders or follow file links. The contents join
the system instructions and the session fingerprint, so edits take
effect on the next turn. There is no switch for it.
It disables only native tools with `--no-builtin-tools`, while explicitly loading
the Hello tool extension. `--no-tools` would disable extension tools too and is
not an equivalent flag.

Skills, plugins and MCP servers the human imported into the library and activated
for a conversation are added to that contract explicitly: `--skill <folder>` per
skill, `-e <entry>` per plugin extension and `--prompt-template <file>` per
plugin template, with discovery still off. Changing the selection, imported
fingerprint, MCP configuration or tool definitions changes the session
fingerprint, so the child restarts on the same
durable session file. MCP stays out of Pi: `src/main/extensions/mcp.ts` is
Hello's own client — its stdio transport, and for remote servers streamable HTTP
and OAuth through `@earendil-works/pi-mcp` behind the same `McpLink` — and its
tools are offered through the same tool bridge as Hello's built-in ones. Pi 1.4's
built-in MCP extension is off (`-ne`): it would bypass the per-chat `mcp:<server>`
groups and needs the TUI's `/mcp` screen to sign in. `src/main/extensions/library.ts` owns import,
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

A group can also be loaded by Hello before a reply's first step. Main reads
the request (`ChatService.preloadGroups`, once per reply): a spreadsheet file
named or attached, the thing called by its name (`spreadsheetWork`), or the
Sheets pane showing a workbook as the person writes, and the bridge's tool
listing carries `preload: ['sheets']`. The Pi extension answers at
`before_agent_start`: it activates the group and what it brings, and returns
one custom message (`hello-tools-loaded`) with the same text a `tools_find`
result has — the tools in a line each and the manual. That message is in the
durable transcript, so the rules are said once per chat, never per step and
never per tool result; a restarted Pi reads it back as it reads a `tools_find`
result, and a compaction that summarized it away unloads the group so the next
reply that needs it loads it again. Pi places such a message after the request;
the `context` hook shows it ahead of the request on every step alike, so the
rules come first and the person's words last. The sheets manual
(`sheetsManual`) is the only place the rules for workbooks are written: there
is no spreadsheet skill beside it, the system prompt no longer sends the model
to `skills_find` for one, and tool results carry what happened, not the rules
again. With the sheets group the runtime snapshot also names the chat's
workbooks by id and the folder's unopened `.xlsx` files (`sheetState`, taken
once per reply), which is what `sheet_list` returns without the step.

What a result says, it says about that call. A workbook's sheets, what its
file holds besides cells and what that means are given when the file is opened
(`summary(info, true)`), and after that a result carries the fact in a word
(`holds`, `unsavedChanges`) and no sentence: a note repeated in every result
was half of what a model read in a five-call task. For each `.xlsx` of the
folder not opened yet the snapshot also names its sheets and how many charts
it holds, read from the package (`outlineOf`), so a file worked on before is
seen as such before the first step.

`sheet_group` groups by the label a person reads: case and the spaces around
it do not make another group, because the COUNTIFS that counts it ignores case
and does not trim — separate groups counted every row several times, and a
trimmed label missed the rows written with a space. A group written one way is
counted through its own cell; one written several ways, or holding a character
COUNTIFS reads as a pattern or a comparison, by the sum of one exact-text
criterion per way (`"=…"`, `~*`, `~?`). The Total is compared with the rows
counted and a difference is reported instead of the word "checked". A header
two columns share is refused with their letters. The table's own words
(`labels`) and the chart table's rest (`other`) are the caller's, so a
Romanian workbook is not given English headers.

The charts a file came with are carried the same way as a script's: on the
first change Hello's writer makes, they are taken from the file itself
(`persist`), and from then on the workbook is saved over its file like any
other. Where they cannot be carried the old rule holds — a version without
them, saved only to a new path. `sheet_save` with a path and `discard: true`
writes the copy and gives up the changes held against the original in one call.

`sheet_chart` also works straight from the data: `by` names a column, and the
tool counts it with `Workbooks.group` onto a new sheet and draws the chart from
that table — one call for "a chart of how many per …", with the counts, the
rows left out and the look-alike labels in its result. Labels that differ only
by an accent, a hyphen or a dot stay separate groups and are returned as
`alike`; counting them together (`together`) is the person's decision, and the
manual has the model ask for it at the end of its answer rather than choose.

In the chat a link whose destination has a space — `[Raport final.xlsx](Raport
final.xlsx)`, as a model names a file — is given the angle brackets Markdown
needs before it is parsed (`spacedLinks`), and a linked `.xlsx` brings up the
Sheets pane instead of the Files viewer.

A workbook computes, and the tools are made so that a script is not needed to
make it do so. Beside the count `sheet_group` takes `also`: another column per
group summed, averaged, its least or most (SUMIFS, AVERAGEIFS, MINIFS, MAXIFS
on the data) or its values listed. The list is a formula as well — a TEXTJOIN
over an IF on the group's rows, written as an array formula — which Excel
computes and IronCalc answers with `#N/IMPL!`. `recalculate` computes that one
shape itself ([`sheets/listed.ts`](../src/main/sheets/listed.ts): TEXTJOIN over
IF or FILTER, one vector chosen by comparisons of others, summed and
multiplied as "or" and "and"), from the values the engine gave everything
else, and then runs the engine once more with those lists standing as text so
that formulas reading them compute too. A model that met the `#N/IMPL!` had
built a helper sheet of 1,702 formulas to avoid it. Any other formula the
engine does not implement keeps the value it had in the file and is reported
as `notComputed`; with no value to keep it is an error like any other. A
formula that compares a whole range cell by cell anywhere else — `SUM(IF(A2:A90="x",…))`
— gets a number from the engine and no error, from one row of the range where
Excel 365 reads them all; `comparesRange` names those (`unsure`) and the result
tells the model to write them with SUMIFS, COUNTIFS or SUMPRODUCT. `sheet_script` reports each sheet a script made that
holds numbers and no formula, with what to write instead. `sheet_read` with
`find` returns the cells that contain a text, in one sheet or all. A chart
that needs a table of its own and was given no sheet gets one, named after the
chart, so nothing is written into the sheet whose cells it draws.

An `.xlsx` dropped on the chat is not attached as text: `ChatService.attach`
opens it as a workbook of the chat (where it is, when it lies in the chat's
folder; a copy otherwise) and `Workbooks.reveal` brings the Sheets pane up.

Two things a file needs for Excel are the app's business, not the model's.
Functions newer than the file format are kept and shown plain (`=IFS(…)`) and
written into files with their prefix (`_xlfn.IFS(…)`,
[`sheets/future.ts`](../src/main/sheets/future.ts)): without it Excel shows
`#NAME?` although Hello's own engine computes the formula. A chart
`sheet_chart` makes says outright what openpyxl leaves unsaid — square frame,
legend and title beside the plot, axes shown, a pie's labels as the share only.

### A chat with no folder, and a file dropped on it

A PDF or an `.xlsx` dropped on a chat that has no folder of the person's is
copied into a folder Hello keeps for that chat —
`chat-files/<sha256 of the chat id>/Chat files` in the app's data
(`chat/chat-folder.ts`) — and that folder becomes the chat's folder
(`ChatService.attach`). Nothing else is special about it: every file, sheet and
PDF tool, the shell and the Files tab work there as in a folder the person
chose, a dropped workbook is opened as a file of it, and a second file of the
same name gets a number rather than replacing the first. The composer names
the dropped file in the draft, so the message says which file it is about. The
runtime snapshot tells the model that this folder is Hello's, what it holds,
and that the person does not see it: each file made or changed is handed over
as a Markdown link. A click on such a link calls `files.deliver`, which asks
where to save a copy (Downloads by default) and shows it in Finder; in a folder
of the person's the same call only shows the file where it already is. The
folder goes when the chat is deleted. Where a chat has a folder of the
person's, a dropped PDF of that folder is named to the composer by its path.
One from elsewhere follows the model of a workbook from elsewhere (user,
17.11): Hello keeps a copy for the chat — in that same `Chat files` folder,
which is then not the chat's folder — and the person's folder gets nothing it
was not asked to hold. The copy takes a name no file at the top of the folder
has, the runtime snapshot names it, and the PDF tools find it by that name
alone (`keptFile`): the folder is asked first, then the kept files; no path
reaches them, no other tool does, and what `pdf_compress` makes from one is
written into the person's folder like any result. A link to the kept file
itself goes through `files.deliver` and saves a copy where the person chooses.

### PDF — reading one, and making a vector PDF smaller

`src/main/pdf/` is a tool group of its own (`pdf`: `pdf_read`, `pdf_inspect`,
`pdf_compress`), offered where a chat has a folder and loaded before the first
step when a request names a PDF file, or the word with something asked of it —
to read it, to find something in it, to make it smaller (`pdfWork`).

`pdf_read` uses the Mac's poppler and no Python. `pdfinfo` counts the pages;
`pdftotext` writes the text of a page range into a file in the app's data
(`pdf/work`, removed after each call), which is returned page by page in whole
pages up to about 28,000 characters, with `next` naming what is left and
`pagesWithoutText` naming the pages that are pictures. Where every page asked
for has no text — a scan, a drawing — or when pictures are asked for, the
pages are rendered with `pdftoppm` as JPEGs (1,600 px on the long side, 1,000
when one would be too heavy) and returned as the tool's pictures, four a call,
the same way a browser screenshot is: a model that sees reads them, and the
text says they were pictures. `find` returns the pages and lines that contain
a text, without regard to capitals or accents. Hello does not install poppler;
without it the tool says so and how the person installs it.

The compression recipe
is one fixed program, `PDF_PROGRAM` in
[`pdf/program.ts`](../src/main/pdf/program.ts), run with pikepdf in a Python
environment of Hello's own (`pdf/python`, built on first use like the one for
sheets). It keeps a plan or drawing vector: coordinates are written with fewer
decimals, a colour set again to what it already is and a line to its own start
are left out, graphics states that say the same thing become one, and the file
is saved with object streams. Four levels, mildest first; the first that
reaches the target is kept, and with no target only the lossless one runs. The
result is always a new file; the original is never written. Afterwards both
files are rendered (`pdftoppm`, when the Mac has poppler) and compared pixel by
pixel, and the tool's result says what each level came to, whether the target
was reached and whether the two render alike — or that it could not check, and
why. What the model chooses reaches the program as a JSON job in its
environment, never as code, and the program's answer comes back in a file of
its own rather than on its output, which the shell runner filters.

Tools are prompt-context driven (`src/main/chat/tool-groups.ts`). A request
carries a core set — `web_search`, `fetch_url`, `tools_find`, `skills_find` /
`skill_load`, `bash`, the file tools (the `coding` group, in view in every
chat) and `plan_write` when the chat turned it on —
and every other area is a group the model loads with `tools_find` when its work
gets there, or that Hello loads by itself when the request plainly is that work
(`ChatService.preloadGroups`: `sheets`, `pdf`, and `browser` when the request
names an address, a site, a link or a tab, or the person handed a tab over). The
browser's sixteen tools and manual weigh more than the rest of a first request
together, which is why they are not in view everywhere; a `web_search` or
`fetch_url` stopped by bot protection loads them in the Pi extension and says
so in the failure, with the search's address ready to open (`stoppedByBots`).
A request for a group already in view is answered as that, not with the list.
And a
failure that sends the model to another group's tools loads that group for the
next step (`groupAfter`): `file_read` given a PDF or a workbook names `pdf_read`
or `sheet_open` and they are there. `file_read` itself gives a document — `.rtf`,
`.doc`, `.docx`, `.odt` — as the text in it (`chat/document-text.ts`, the Mac's
`textutil`), and `fetch_url` given a file of the Mac says that `file_read` reads
it, with the name to give.
The groups: `browser`, `sheets`, `pdf`, `workers`, `notebook`, one per
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
context (`createExtensionUIContext`, `dist/modes/rpc/rpc-mode.js`) emits an
`extension_ui_request` for `select`, `confirm`, `input`, `editor`, `notify`,
`setStatus`, `setWidget`, `setTitle` and `set_editor_text`, and discards
everything that would draw a component: `custom()` is `async custom(){}` — it
resolves `undefined` without sending anything — and so are `setFooter`,
`setHeader`, `setEditorComponent`, `onTerminalInput`, `setWorkingMessage` and
`setHiddenThinkingLabel`. The wire protocol says the same: `RpcExtensionUIRequest`
is a nine-variant union with no component variant, and Pi's own
`docs/rpc-extension-ui.md` states that `custom()` returns `undefined`. Checked
again on **Pi 1.1.0**: `rpc-mode.js`, `rpc-types.d.ts` and that document are
byte-identical to 1.0.4's, so there is no request shape for Hello to answer and
nothing on Hello's side to build.

It is worth being exact about why that closes a question, because the plugin is
not actually missing a fallback. `pi-subagents` 0.73.1 ships one
(`src/slash/subagents-admin.js`, `selectFromList`): when a component screen is
unavailable it flattens the choice into `ui.select`, which Hello already
answers. The test it guards that with is `typeof ctx.ui.custom === 'function'`
— and Pi's RPC context *does* define `custom`, as a no-op. So the component
branch is taken, `custom()` resolves `undefined`, `result?.confirmed` is
`undefined`, `chooseModel`/`chooseThinking` return nothing and the admin screen
returns silently. The same test defeats `/subagents-fleet` (`src/tui/fleet.js`)
and `/subagents-stop` (`src/slash/slash-commands.js`), which have no fallback at
all; `slash-commands.js` guards its text fallback on `!ctx.hasUI`, and `hasUI`
is `true` in RPC mode.

Either side fixes it in one line, and both are upstream: Pi can leave `custom`
off the RPC context instead of stubbing it, which makes every extension's
capability test tell the truth; or the plugin can gate on `ctx.mode === 'tui'`,
which is what Pi's document tells extension authors to do. Hello cannot carry a
local patch for it either: `pi-subagents` is not a Hello dependency but a
plugin the person installs into their own library folder, so there is no
lockfile entry to patch and the folder is rewritten on the next install.

Stopping a chat's Pi aborts the reply in progress, ends its input and waits up
to 1.5 s: that is Pi's own shutdown, which runs extensions' `session_shutdown`
handlers (a memory plugin's final commit) before it exits. SIGTERM, then SIGKILL, follow only for a Pi that
is still there. A Pi that cannot load an activated extension is reported with
the plugin's library name and Pi's reason; a plugin handler that throws during a
reply is shown as a warning naming the plugin and no longer ends the reply —
only Hello's own tool extension failing does.

Skills are found the same way (`src/main/extensions/skill-catalog.ts`). One
catalog holds Hello's library, every skill another agent on this Mac keeps
(discovery below, plus Pi's `~/.pi/agent/skills`) and,
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
refreshes a changed tool catalog between turns. An HTTP server (`transport:
'http'`, `url`, header names in `envNames`) is a `McpHttpConnection`: the same
tool limits, a session the server forgot reopened once, and a 401 surfaced as
`needsSignIn` for Settings' Sign in (`McpManager.signIn`, the MCP authorization
flow with a loopback callback). Its trust boundaries and limits
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

Both preview servers answer on `127.0.0.1`, which Chromium treats as a secure
origin, so a page in a Hello tab has what a secure context gets — `navigator.gpu`
among it. A generated document can therefore compute in the tab: local
embeddings, a similarity search over text the person gave the model, work that
would otherwise need a server. Hello pins a guest's preferences
(`browser/manager.ts`) and none of them turns the GPU off; `navigator.gpu` is
still absent on a Mac whose Chromium has no adapter, so the browser manual
(`chat/pi-instructions.ts`) tells the model to feature-detect it and keep a CPU
path. Neither server sends `Cross-Origin-Opener-Policy` or
`Cross-Origin-Embedder-Policy`, so a preview is not cross-origin isolated and
`SharedArrayBuffer` is unavailable: a wasm runtime in a tab runs
single-threaded. `require-corp` would buy those threads by breaking every
cross-origin subresource a page legitimately loads, which is the worse trade.

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
  the summary freed until the next reply reads the window again. The meter's
  denominator is `contextBudget().usable`, what the conversation may fill, not
  the window the model holds — amber at three quarters of that and red at nine
  tenths mean the summary is actually near. It is close, not exact: the bar is
  the provider's count of the last finished call, while Pi adds that reply's
  own output and estimates the tool results since, so it can cross the line
  first. Hovering names both numbers.
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
which a new chat — or one with no model yet — runs on, and which the CLI
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
  code, `bash` a shell block (`chat/ToolCode.tsx`); any other tool, or input
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

A terminal tab can hold several terminals side by side (Split right / Split
down: the tab's menu or the pane's header buttons). The arrangement is a binary
tree in the workspace preferences (`terminalSplits`, keyed by the tab's own
terminal; `workspace/terminal-splits.ts`) and goes wherever its tab goes, Tools
or the chat pane. A split adds a plain shell, never a CLI. Each terminal keeps
its one node and is moved into its place, never built again. A pane's X ends
that terminal; closing the tab's own terminal hands the tab to the next one in
it; the tab's X ends them all, confirmed once. Only the tab's own CLI comes back
after a restart; the terminals split beside it do not.

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
changed. Aider takes none of this: it has no loader and no shell to reach a
connection with, so it is given its launch folder in the argv instead (T209) —
still no connection claim and no automatically submitted message.

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

## Unclutter — the browser pane's ad and slop blocker (26.11)

The person's own cleaner for web pages (user, 26.11, after kitze/unclutter):
ads, cookie/consent banners, upsells, newsletter and social nags are hidden by
rules learned once per *page type* of a site, classified by OpenJev on this Mac.

- **Page side** ([`unclutter/page.ts`](../src/main/unclutter/page.ts)): one
  self-contained function main injects with `executeJavaScriptInIsolatedWorld`
  into world 1209 (page modes are 1207, agent input 1208). It computes the page type (origin,
  page kind and a hash of the route family and main shell), lists up to 60
  candidate blocks with their text redacted, and hides the blocks a rule names
  with a scoped attribute and inline `display:none !important`, reversibly. A
  `MutationObserver` re-applies the rules it holds; an address that is another
  page type drops them until main sends that type's own.
- **Main** ([`unclutter/service.ts`](../src/main/unclutter/service.ts)) observes
  the browser's pages and, a moment after each change, installs the cleaner and
  hands it the saved rules (none when Unclutter or the type is off). Analysing
  lists the page's candidates and asks OpenJev in batches of six; each request's
  state holds only that batch's elements, because OpenJev's MLX helper answers
  one question at a time with no prefix cache and re-reads the whole state for
  every question. One analysis runs at a time, app-wide. Rules need OpenJev's
  probability and confidence both at 0.9 or more; an incomplete answer keeps the
  old rules. Auto (off by default) analyses a page type of the tab on screen the
  first time it is seen in a run.
- **OpenJev** ([`unclutter/openjev.ts`](../src/main/unclutter/openjev.ts)): a
  helper already answering `/v1/version` (on 3000 or the port Hello saved) is
  used as it is and never stopped. Otherwise Hello starts one from the helper
  environment in `openjev/` of its data folder (its `mlx` and `api` folders, or
  links to them) over the `openjev-MLX` folder (oMLX's model
  folders, then `~/Models/MLX`), with the model card's calibration, on 127.0.0.1
  and a free port from 3000, logging to `openjev/helper.log` in Hello's data
  folder, and stops it with the app or from the menu. Nothing is installed.
- **Storage**: `unclutter_profiles` (schema 18) keeps one row per page type — the
  person's browsing, so app-wide rather than per chat; the switches are the
  `unclutter` settings row.
- **Window**: an Eraser button on the browser toolbar counts the blocks hidden
  and opens the menu (analyse, this type on/off, forget, Unclutter on/off, Auto,
  OpenJev's state and Stop). Generated documents, previewed files and local
  servers are never cleaned.

## DSH hosted launch

Owner decision, 2026-10-09: Hello hosts DSH and offers its existing sidebar
launch entry and upgrades. Plugins and add-ons belong to Hello/Pi. There is no
Hello theme, layout plugin, DSH market, model proxy, DSH skill discovery or
DSH tool bridge into Hello chats. DSH has no tools-pane tab.

- **Host and launch.** `src/main/dsh/host-entry.ts` boots upstream `runProfile`
  in an Electron utility process. Its profile is `hello`, from DSH's `web`
  template, under `<data>/dsh/home`. The `desktop` profile is deliberately
  avoided; `DSH_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` remain set.
- **Installation and upgrades.** First install and the sidebar Update action
  resolve the official npm `latest` release of `@deepseek-ai/dsh`, then install
  that exact resolved version into `<data>/dsh/runtime`. No stale rc pin or
  bundled-version rollback remains. An existing installed runtime, including a
  version previously chosen in `dsh/version.json`, stays usable offline. Hello
  records a successful update in that file for compatibility with older releases;
  it does not use an old selection as the default for a new install. Updating a
  running host stops it, installs the release and starts it again. Install
  failures are shown; an interrupted in-place pnpm install may need a retry.
- **Host compatibility and budget.** The packaged `node-addon-require-builtin`
  shim and pnpm override remain necessary for Electron's `--expose-internals`
  boot path. `DSH_ALLOWED_BUILDS` permits the native host builds (`node-pty`,
  `@deepseek-ai/dsh-subprocess-local`, `koffi`) and declines the informational
  scripts (`protobufjs`, `@google/genai`). The existing optional LibreOffice
  engine exclusions remain an installation footprint limit; Office conversion
  in DSH is unavailable without that engine. The heap, process memory and CPU
  limits in `dsh/budget.ts` remain enforced.
- **Profile.** DSH owns its settings and model selection. On start Hello writes
  only the `web-runtime` launch patch in `<data>/dsh/hello.patch.yml`: do not open
  an external browser or print the authentication URL. `llm-pi-ai` and
  `agent-default-model` are no longer overridden. Existing profiles receive only
  a narrow removal of the retired `hello-dsh` dependency and bundle reference;
  other manifest fields and the person's patch file are untouched. There is no
  profile checkpoint, plugin reconciliation or plugin installation service.
- **Surface.** Main exchanges the one-time login token for a cookie in the
  `persist:hello-dsh` partition and mints the guest's URL. The renderer places
  one persistent `<webview>` over the sidebar destination's slot, parking it
  behind the window when that destination is closed. Opening and closing app
  chrome neither detaches nor reloads the page. Guest preferences, permissions
  and navigation remain main's responsibility; the guest has no Hello preload.
- **Pi packages.** `src/main/market/pi-service.ts`, `pi-install.ts`, the shared
  network and npm validation helpers, and `renderer/market/` continue to serve
  the Pi package market. Installs enter Hello's library and are enabled per chat.
  The former built-in DSH MCP library row is retired with its chat activations;
  ordinary MCP servers and Pi plugins are unchanged.

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
