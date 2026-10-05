# Security boundaries

Hello. is a local desktop application with user-authorized access to folders,
model endpoints, web pages and child processes. It is **not** an operating-system
sandbox for agent work. UI visibility, permission to read a page, approval of a
single shell command and a CLI client's own permissions are distinct controls.

## App and web content separation

The app renderer has context isolation, Electron sandboxing and no Node
integration. Its preload exposes a fixed typed API, not arbitrary IPC. Main IPC
checks both the sending WebContents and its top-level frame, then validates
arguments. An embedded page or subframe cannot call the app bridge.

App copy actions (chat, code, notebooks and terminal selection) use a write-only
`system.copy` bridge, restricted by the
same sender/main-frame checks. It accepts only plain text and optional HTML, with
a combined 16 MiB UTF-8 limit. It does not read the clipboard or expose clipboard
tools to the model. Browser permission grants remain unchanged. The main process
uses Electron 44's asynchronous [Clipboard API](https://www.electronjs.org/docs/latest/api/clipboard)
so app copying does not require granting websites clipboard access.

One read exists, and only the person triggers it (S209): pasting a picture into
the composer calls `chat.attachClipboard`, and main reads the clipboard's
`image/png` item itself. The bytes never pass through the window and are never
logged; they become a private snapshot through the same checks and limits as a
dropped image (a real image signature, 5 MiB each, 8 MiB together, 8 files).
Pasted words stay ordinary text input, and a file copied in Finder is attached
by its path, as a drop is. "Attach files…" asks main for a native open dialog
over this window, for files only, never a folder; its paths take the same
attach path as a drop. Neither is offered to the model as a tool.

Remote pages run in `<webview>` guests of the app window, with web security
enabled, no Node integration and no app preload. The window may ask for a page,
but it decides nothing about it: `browser.attach` mints a one-time nonce for one
tab, and `will-attach-webview` in main deletes every preference the tag asked for
and writes its own — sandbox, context isolation, no Node, no nested webviews, and
the partition that tab belongs to. A tag presenting an unknown or spent nonce is
refused, and a guest whose host is not this window is closed on sight. The
browser session denies every permission request but one: `fullscreen`, and only
for the page of the tab the window is showing, so a video can fill the screen
while a tab out of sight never takes over the window. The page then covers the
window until it leaves full screen; camera, microphone, notifications, location,
clipboard reads and the rest stay refused.

A page that opens a window gets a tab beside the one it came from, in the same
partition and with the opener's Agent control, never a window outside the app:
the human could not find a native popup and the agent could not see it at all.
The popup's URL is loaded fresh in that tab, so what a child window would have
kept — `window.opener`, `postMessage` to the opener, a prepared POST body — is
given up; a non-web or blank popup is refused. The app does not copy credentials
or emulate authentication callbacks. Non-web navigation, nested webviews, and
new windows from the privileged app renderer remain blocked.

A download lands in the chat's attached folder or, like any browser's, in the
system Downloads folder, under a safe unused name; only a download from no page
of Hello's own is refused. It belongs to the chat, not to a tab: a popup a link
opened only to carry the file is closed again and the file is the opener's. The
chat's list — name, size, state, source origin and path — is kept in the
database (`browser_downloads`), shown on the browser toolbar with Open, Show in
Finder, Copy path, Remove and Clear, and read by the model through
`browser_downloads`. Open and reveal take the path from main's own list, never
from the window. A page's own download control at Full, and `browser_download`
at Full — the document shown in the tab or a file at an HTTP(S) address, fetched
by the page with its own session — end the same way, and the tool result names
the path or the refusal. Nothing here deletes a file; the result is a file in
the person's folder, never a workspace write grant.

**What DOM hosting costs.** The app renderer can now call `<webview>` methods on
a guest it hosts — including `loadURL` and `executeJavaScript` — and main cannot
revoke that. The renderer is therefore trusted code, and it never renders
web- or model-authored HTML into its own document: generated HTML is opened in a
guest with its own isolated partition, and chat Markdown renders without raw
HTML. Main still owns every decision that matters — which partition, which URL,
and whether the agent may read or act on a page — because those run in the main
process, not in the window.

The production renderer's CSP limits resources to the app and specified local
development connections. Markdown is rendered as React elements without raw HTML
execution. Code highlighting renders tokens as elements. Markdown images are
links, not automatically fetched remote images. These measures reduce content
execution and tracking; they are not a guarantee against all dependency or
Chromium vulnerabilities.

## Agent authority

| Operation | Gate enforced by the main process |
| --- | --- |
| Search/read public internet directly | Bounded HTTP(S) GET, public-IP/DNS and redirect checks; no browser grant needed |
| Read this conversation's Runbook | Conversation ownership and the Runbook section on; read-only for the main-chat agent |
| Read/create/update this conversation's Tasks | Conversation ownership and the Tasks section on; a task status update must quote the task's exact current source (its line is only where to look first) |
| Write or read the plan (`plan_write`, Plans) | Conversation ownership and Plan on; one plan chapter replaced whole |
| Any notebook chapter, in any tool or CLI connection | The chapter's own switch: one the human switched off is neither listed, updated nor exported, and is answered as not found |
| List/read attached-folder files | Attached folder, resolved-path containment, bounded text reads and common secret-path exclusions |
| Write a file | The same path checks plus **Allow once** for that exact requested path/content |
| Edit part of a file (`file_edit`) | The same path checks and approval; the exact text must occur once (or `all`); refused if the file changed during the approval wait |
| Run a shell command | **Allow once** for the exact command; executes with the chat folder as working directory |
| List owned browser-tab metadata | Conversation ownership, including metadata for Off tabs |
| Read page content | That tab's Agent control **Read** or **Full** grant |
| Mark a page for the person (`browser_mark`) | **Read** or **Full**: it measures elements and draws pins over the page in Hello's isolated world, changing nothing in it; only at **Full** is the first mark scrolled into view. The marks are kept with the tab page by page, until the person reloads that page or clears them (× on one, a double click on the bubble for all); the tab shows a page's own again when it comes back to it (Back, Forward, a restart), whatever its control now: Hello's own layer finds each marked element by its saved CSS path, and nothing of the page reaches the model |
| A launched CLI using Hello's browser | Its session's loopback token and conversation — by shell client, Pi extension or MCP server (Claude Code, Codex), whose files never hold the token: this chat's tabs only, each call through the same Agent control check as the chat's; no pointer, note or download. A CLI runs as the human, so its guide's rule against scripting the human's other browsers is guidance — macOS Automation permission is the wall |
| Open a requested page/dev URL in Hello | Owned conversation; a tab the model opens starts **Full** (user decision, 29.09); that Full is not saved and the tab returns Off after a restart |
| Open a local HTML preview | Attached-folder containment; bounded read-only loopback static route; new sandboxed tab starts **Full** when the model opens it, and drops to Off when it leaves the preview |
| Navigate an existing owned tab to a requested HTTP(S) URL | Conversation ownership; independent of Off/Read/Full; no implicit page read |
| Click/type/scroll through agent tools | That tab's Agent control **Full** grant |
| Load a skill's instructions or reference file | Skill activated for that conversation; real-path containment inside the imported copy; text only, bounded size |
| Find a skill and turn it on (`skills_find`, `skill_load` by id, the composer's `/` menu) | Only ids the catalog handed out: a library row that still verifies, a folder discovery reports, or a skills.sh `owner/repo/skill` that skills.sh itself listed (from a search in the last hour, else asked again) — no segment may be `.`, `..` or hidden. The skill is copied into the library like a manual import and activated for that one conversation; an existing same-name library skill is used instead, never replaced. **No per-call approval**: a skill is text, and it grants no permission |
| Call a tool from an MCP server | Server activated for that conversation, re-checked at call time; Hello's own stdio client; **no per-call approval gate** |
| Run a tool registered by an activated plugin extension | Explicit activation of that plugin; the extension is Node code inside the Pi child and is **not** gated per call |
| Interactive terminal/CLI client | Explicit user launch; subsequent commands follow that process/client's authority |

A write that would drop most of an existing file (over 2,000 characters, the new
content under half of it) is refused unless the model sends `replace: true`, and
every version a write or an edit replaces is kept in the app's own data
(`file-history/<chat>/`, the last 40 per chat), so a bad rewrite can be undone
without a commit to return to. Chat notifications carry the chat's title and
the first line of a reply or of a worker's question; macOS may show them on the
lock screen as it shows any app's.

Approvals are one-use, expire, and are invalidated by Stop or application shutdown.
Pi owns continuation, automatic compaction and transient model retries. Browser
grants do not change the turn budget or model reasoning. A run continues until
Pi settles, the user stops it or an error occurs; there is no token-cost budget
enforcement yet. A Full grant never authorizes an Off/Read tab's mutations or
bypasses file/command approvals.
Approval does not bypass validation of the requested file path. Task edits are
available as shared work-plan operations. Runbook writes are rejected by the
main-chat notebook tools; the human editor retains write access. A notebook is
not a protected instruction channel. This tool-level rule does not turn
independent CLI processes or approved shell commands into an OS read-only sandbox.

### Pi headless process

Each active chat uses an app-owned Pi RPC process and an authenticated loopback
tool bridge. Pi's built-in tools, implicit discovery of extensions, context
files, skills, templates and themes stay disabled; the explicit Hello extension
registers the existing main-process tools. Startup verifies that extension
before sending a model request.

Skills and plugins the human imported and activated for that conversation are
passed as explicit paths (`--skill`, `-e`, `--prompt-template`); nothing else on
disk is discovered.

The Pi binary is the bundled one unless the person updates it from the
sidebar: Hello then asks npm's registry for the package's `latest` (one request,
nothing of the person's in it) and installs exactly that version with its own
pnpm into its data folder, install scripts off. The model never triggers an
update, and going back to the bundled Pi is one click. dsh updates the same way.
**A plugin's extension is Node code running inside the Pi child**, so it shares
that child's environment — which contains the current endpoint's key and the
per-process bridge token — and can call the bridge directly. It is not
sandboxed, and activating a plugin is the trust decision. An extension that
imports npm packages is bundled at import from the folder the person chose;
bundling only parses (no plugin code or install script runs), the packages it
took are listed on the library row, and the bundle is part of the approved copy
that verification recomputes. In a chat with a folder, Hello's own extension
moves the Pi process into that folder before the plugins load (their
`process.cwd()`); Pi's settings and session were already read from the chat's
private directory, so a project's `.pi` files are not loaded, and Pi's own
`ctx.cwd` stays there. Skills carry no code
authority: they are text the model reads through `skill_load`, which is confined
to the imported copy of a skill active in that conversation.

Online skills are someone else's instructions. `skills_find` searches skills.sh
only through the market's restricted HTTP client (HTTPS on port 443 to the
exact origin, pinned DNS that refuses private addresses, size and time caps);
a chosen skill is read from `api.github.com` (its repository tree) and
`raw.githubusercontent.com` the same way, at most 200 files and 5 MB, with no
path that leaves its folder or enters `.git`. Nothing is executed: the files go
through the library's import, which copies text and records a fingerprint. The
tool results and the prompt tell the model to follow a found skill for the
task only, and that it never overrides the person or Hello's rules. The chat
transcript shows each skill the model looked for and loaded.

MCP servers are separate child processes started by Hello's own stdio client,
never by Pi. They receive only platform variables plus the values configured for
that server, never the model key or the bridge token. Their tools are offered
through the same tool host as Hello's own, are re-checked against the
conversation's activation at call time, and are removed with the server. A
server's tool descriptions and results are untrusted data.

One MCP process is shared by the chats that activate that server; activation is
an access gate, not isolation of the server's internal state. Stop cancels the
call locally and sends `notifications/cancelled`; server cooperation and undoing
side effects are not guaranteed. Disconnect and deactivating the last chat end
the process, including a pending handshake. Stopping a pending connection keeps
the process if another active chat still needs it. There is no per-call MCP or
plugin approval gate in this delivery.

Pi runs with the user's OS authority. These resource restrictions are not an OS
sandbox for trusted extension code. Its environment contains only required
platform variables, the current endpoint's key and the per-process bridge token.
Neither secret is passed in argv or written to models.json. The child-only fetch
guard rejects redirects, including model requests and compaction requests.

Stop cancels tools/approvals and closes the Pi process; subsequent use reopens its
durable JSONL. It does not undo completed actions. Retry includes the original
user request and retained observed tool results, so a transport failure before
delivery or persistence does not silently discard that context. Retry remains
a new model request; it is not a deterministic rollback or exactly-once guarantee
for external side effects after a crash.

### Files and shell commands

The human **Files** viewer is separate from automatic agent file tools. Its
`files.*` IPC accepts only the trusted main window/frame and derives the root
from the selected conversation's attached folder. It never accepts a new root
from a document link, follows an escaping symlink, executes Markdown/HTML, or
grants model/browser permissions. Search enumerates filenames, not contents;
reads are bounded UTF-8 regular files. Filenames that may contain credentials
are not hidden from the human, but nothing from this viewer is automatically
sent to the model or saved to message history. Copy is an explicit clipboard
write. The viewer does not add file write/delete/rename APIs.

Local links open only the viewer. Default-app opening and Finder reveal require
separate explicit UI actions and revalidate containment in main. Open prompts
for file types outside the usual document/image allowlist, since OS file
associations can run code. These path checks are not isolation from a hostile
local process racing parent-directory changes.

Automatic file tools resolve paths inside the attached folder and reject paths
escaping it, including resolved symlinks outside the folder. Reads are bounded
UTF-8 text; common credential filenames and key extensions are excluded. File
writes revalidate after approval, require an existing parent, and reject final
symlink, hard-linked or non-regular targets.

These are application-level safeguards, not isolation from a hostile concurrent
local process. The secret-file exclusions are a limited filename filter, not
content-based secret detection. Ordinary source files can still contain secrets.

`command_run` starts `/bin/sh -c` with a timeout and bounded output. **Its working
directory is not a sandbox:** an approved command can access other files, use the
network, launch processes or expose environment values with the user's OS
permissions. It inherits the main process environment. Review the entire command,
not only its apparent repository-relative paths. Stopping a process cannot roll
back file writes or external side effects already completed.

**Tool approvals are a setting, and the default is permissive.** Settings ›
Connection › Tool approvals has three modes:

| Mode | File writes in the chat folder | `command_run` |
| --- | --- | --- |
| Work without asking (**default**) | run | run |
| Ask before commands | run | wait for the human |
| Ask every time | wait for the human | wait for the human |

The default was chosen by the app's owner so that agent work is not interrupted.
It means a model turn can write inside the attached folder and run shell commands
with the user's own OS access without any per-call confirmation — the containment
described above (paths confined to the attached folder) still applies to writes,
but **not** to `command_run`, which is confined to nothing but its working
directory. Choosing "Ask every time" restores the per-call gate for both. The
mode is read at the moment each call is judged, so changing it takes effect on
the next tool call rather than the next chat.

Interactive terminals and CLI workers are separate from this per-call approval
system. Their subprocess environment is deliberately constructed; active-model
workers receive the selected endpoint and credential when required. Hello. does
not intercept every command an independently running CLI decides to execute, and
does not add bypass-permission flags. The client and the person launching it
remain responsible for its own approval and sandbox settings.

### Browser grants

Direct `web_search` / `fetch_url` are separate from browser grants. They cannot
read a signed-in browser session or local endpoints: no browser cookies,
Authorization header, embedded URL credentials or nonstandard ports are used.
Private/reserved addresses are rejected after DNS resolution and on every
redirect; the validated address is pinned for connection. Requests stop at 20s,
2 MiB or five redirects. Returned text is untrusted data, not instructions.
Queries and URLs are sent to the requested public services; the model is told
not to include private content without explicit authorization. This is not a
content-based secret detector. Remote bot protection/JS may prevent extraction.

Source favicons use only `https://icons.duckduckgo.com/ip3/<hostname>.ico` with
no referrer. That service receives the source hostname, not its page path, query,
chat content or model credential. CSP permits this image origin specifically;
arbitrary remote Markdown images still do not render.

The address bar sends words that are not an address to Google search, as
browsers do, and a bare name that no site answers to as well. Never a name that
points at the person's own machines: an address typed with its scheme, a port,
an IP address or a local name (localhost, `.local`, `.lan`, `.internal`,
`.home.arpa` …) fails as typed. No navigation the model makes becomes a search.

A tab the person opens starts **Off** (grey). A tab the model opens with
`browser_open` starts **Full**: the model opens a page to read it and act in it,
not to have it open (user decision, 29.09). That Full is the model's for the
session's work — it is not saved, the tab comes back Off after a restart, and the
person changing the control makes it theirs. Because tabs share one website
session, a model-opened Full tab on a site the person is signed into can act as
that person: clicks and typing there can post, buy or send. The person lowers it
from AI Mode at any time. The mode the person sets on a page is saved
with the tab and comes back with it after a restart; a generated document or
previewed file is the exception and returns Off until it is served again.
Opening a requested page/dev URL or HTML preview is available in every mode. **Read** (orange) permits page
inspection; **Full** (red) additionally permits DOM actions.
Ownership and current access are checked in main, not inferred from a button's
appearance. Ordinary manual browsing is still possible when Agent control is Off.

`browser_open` opens the requested result in a new tab inside Hello and reveals
it in the active conversation. It never calls the OS default browser or inspects
the page. `browser_navigate` can navigate an explicitly targeted owned tab in any
mode. These tools are instructed to follow the user's requested destination;
the main process enforces ownership and URL/path restrictions, not natural-language
intent. Loading a URL can run website scripts and send authenticated requests;
opening is not a guarantee that the destination has no side effects.

Local previews use a lazy HTTP server bound to `127.0.0.1`, with an unguessable
per-preview route and exact Host validation. Only HTML entry files and allowed
static asset types inside the attached folder are served, with resolved-path,
symlink, hidden/secret-path and regular-file checks, GET/HEAD only and an 8 MiB
per-file bound. There are no directory listings, writes, CORS wildcard or file:
navigation grants. Relative assets are supported; root-relative assets need an
ordinary development server. Preview scripts run with the ordinary sandboxed web
page's authority, never Node or the app preload. Preview tabs are session-only;
their URLs can remain in tool history but stop working after route revocation.
routes are revoked on folder change, conversation deletion or app shutdown. They
are local capabilities, not isolation from another process under the same OS user.

Generated HTML has a separate, explicit output capability: `browser_show_html`
writes at most 512 KiB of supplied UTF-8 HTML to a fresh private artifact directory
under this conversation's hashed app-data namespace, then opens that directory's
HTML entry in a sandboxed tab at Full (the model wrote every word of it). It cannot choose a destination path, overwrite
a workspace file or grant access to the rest of app data. UUID handles are resolved
only in the calling conversation; private-directory, symlink and regular-file
checks apply. The artifact persists until conversation deletion; its loopback
route expires on deletion/shutdown, not on attached-folder changes. HTML data URLs
are converted into this same output path at the tool boundary; other `data:`
media types and native data/file navigation remain blocked. Generated scripts
have ordinary web authority and may make network requests; the prompt asks for
self-contained visuals and forbids sending private data to external chart
services without user authorization. Opening does not inspect or verify content.
Local HTML previews use fresh in-memory browser sessions, including inherited
popup sessions; they cannot share cookies/storage with signed-in browser tabs or
other previews. Permission denial and the download rule apply to these sessions
too.

Files explicitly dropped by the human are a separate input capability. Preload
extracts native paths from real File objects; internal Files drags are resolved
under their source conversation's folder in main. Chat imports bounded regular
file snapshots into private storage and accepts only owned IDs on send. Text and
image bytes, names and original/snapshot paths are sent to the selected provider
only when the message is submitted; filenames/content remain untrusted data.
Importing a file does not grant the agent its parent folder. Unsupported binary
formats are rejected. Conversation deletion removes stored attachments; removing
a draft pill excludes it from that message but its snapshot remains until chat
deletion. CLI drops only paste quoted paths; control characters are rejected and
no Enter is sent. The CLI's own file/model permissions govern subsequent use.

Grants are per tab, **not per origin**. A grant the person sets is saved with the
tab; the Full a tab got because the model opened it lasts only for the app
session. A tab with Full access retains that grant when navigating to another
website until it is changed or the app restarts. Full is not a confirmation for each click; clicks
and input events can submit information or trigger authenticated site actions.
Use Off or Read when that authority is not intended.

Tabs share `persist:hello-web`, including persistent cookies and site storage.
Conversation ownership prevents cross-conversation agent tab access; it does not
isolate website accounts or cookies. Off prevents the agent reading/interacting
with a tab, not the loaded website's own scripts or network activity.

DOM action targets must match exactly one visible element; typing excludes
password/file inputs. Page extraction is bounded and does not dump input values.
Visible text can nevertheless contain private information that will become a
tool result and may be sent to the selected model endpoint.

Agent waits are bounded to 15 seconds and wired to response cancellation. Off
revokes pending reads and DOM actions; Read revokes pending DOM mutations. Opening
and navigation are independent of these grants and retain Stop/timeout cancellation. DOM actions bind
to the current main frame and reject while the page loads. Cancelling a pending
DOM mutation destroys that page so a deferred action cannot later run, and the
tab is refused a new one until an explicit navigation asks for it;
the tab remains available for Reload. Reads discard cancelled results; cancelled
navigation is stopped. **None of these mechanisms undoes an action that already
ran or guarantees a remote server did not receive an earlier request.**

Overlapping app menus, modal dialogs and layout transitions hide native web views
instead of drawing interactive app controls over them. Non-modal menus elsewhere
leave the browser visible. This prevents native content covering app chrome; it
is a presentation rule, not an additional agent permission grant. A payload-free
native-focus notification only dismisses app menus when focus enters the browser.

## Credentials and outbound model data

Model keys are encrypted by Electron `safeStorage` through a main-only codec and
stored as encrypted SQLite blobs. The app refuses key operations if encryption is
unavailable; it has no application-level plaintext fallback. The exact OS
protection is platform-dependent; on macOS it uses the system keychain-backed
Electron mechanism. This does not defend against arbitrary code running as the
same unlocked user or compromise of the main process.

Each key is indexed by the exact normalized endpoint URL, including its path.
Switching endpoints does not automatically reuse another endpoint's key. Settings
and bootstrap return only `apiKeySet`, never a saved plaintext key. A newly typed
key necessarily passes from the settings form to main when saved.

A remembered connection stores a name, that endpoint URL and a model id — never
a key. `apiKeySet` per entry is derived from the secrets table at read time.
Forgetting a connection deletes the key stored for its endpoint, and the entry
in use cannot be forgotten while it is active.

The configured endpoint receives the chat request history and tool results used
in that request. Retrieved files, page text and notebook entries can therefore
leave the machine. No notebook contents are silently prepended on startup or
worker launch; explicitly using notebook tools still exposes their returned
content to that model request.

HTTP and HTTPS endpoints are accepted, with embedded credentials, query strings
and fragments rejected. HTTP is useful for local servers but provides no transport
encryption when used remotely. Model requests reject redirects instead of
forwarding credentials to a redirected destination. The implementation supports
OpenAI-compatible Chat Completions and model listing, not native Anthropic
Messages or OpenAI Responses. Endpoint trust and protocol compatibility are
separate questions.

For applicable CLI clients the launcher passes keys in child environment
variables, not command-line arguments or plaintext values in generated config
files. Generated configs reference those variables. A child process can read its
environment, and a third-party client may itself persist credentials or other
state. Hello. does not promise confidentiality against a launched CLI.

### Discovering other tools' configuration

**Settings › Extensions › Find what other agent tools already have** reads a
fixed list of configuration files under the user's home directory — the ones
Claude Code, Claude Desktop, Codex, Kimi, Gemini CLI, Qwen Code, Copilot CLI,
opencode, Crush, Continue, Cursor, Windsurf, VS Code and Zed write — plus the
skill folders those tools keep. It runs only when the user asks for it.

Per-project configuration is read as well: `.mcp.json`, `.vscode/mcp.json`,
`.cursor/mcp.json` and `.claude/skills/` inside the folders Claude Code has
recorded in `~/.claude.json` and the folders this app's own chats are attached
to, bounded to 100 folders. No other directory is walked.

Those files are opened read-only, size-bounded, and never written or executed.
A file that is missing or malformed is skipped rather than failing the scan.
The scan reports what the files declare; it does not verify that a discovered
command is trustworthy, and adding one is the same trust decision as typing it
by hand.

Environment values found in those files stay in the main process. The renderer
receives variable names only, and importing an entry stores its values with the
same encryption as the model key. Entries that are not stdio are listed but
cannot be added. `HELLO_HOME_DIR` overrides the directory scanned; it exists for
the acceptance script and, like `HELLO_DATA_DIR`, is trusted to the same degree
as the user's own environment.

Two more variables exist for the same reason. With `HELLO_TEST_MODE=1`, and only
while no model has been saved yet in that data directory, `HELLO_TEST_ENDPOINT`,
`HELLO_TEST_MODEL` and `HELLO_TEST_API_KEY` seed the connection at launch so a
probe starts already connected instead of retyping one through Settings. Outside
test mode they are ignored, and they never overwrite a connection that exists.

## Local persistence and deletion

The app uses its own data root; see [Architecture](ARCHITECTURE.md#durable-data).
Chat messages, Pi JSONL sessions and prompt files, thinking, tool arguments/results, notebooks, exports and local
draft recovery are **not encrypted databases/documents**. Encrypting the API key
does not encrypt this content. Browser cookies/storage also persist through
Electron's browser session. Use OS account protections and full-disk encryption
as appropriate for the sensitivity of the workspace.

Runbook, Tasks and plan exports stay in the app-private data directory and hold
only the chapters that are on. Compatibility
paths remain in `HELLO_RUNBOOK_PATH` and `HELLO_RUNBOOK_TASKS_PATH`, but exported
Markdown is a one-way snapshot: writing it does not update the app.

Supported CLI launches receive a passive Hello connection guide, not notebook
contents or an executable assignment. The model reads the relevant Runbook
before requested work and uses the live connection for Tasks. Each connection
reuses the authenticated Pi loopback transport with an allowlist limited to
notebook reads and exact-line task status updates. Conversation identity is
bound server-side; callers cannot select another conversation. Runbook writes,
full-entry replacement, shell, browser and credential operations are absent.
The helper uses the child's inherited token; the token is never written into
guide/client files, argv, renderer state or logs. No extra CLI dependency or
provider permission bypass is added. Local processes with access to a CLI's
environment remain inside that CLI's trust boundary.

The bridge is revoked at process exit, close, failed startup or application
shutdown. If the chat folder selection changes, the old session can still read
its conversation's notebooks but cannot mark work complete in the newly selected
folder. CLI status updates validate the exact current task line, while editor
saves check their persisted revision and preserve conflicting drafts. Empty
notebooks do not block launch. Existing CLI permission systems still govern
their own filesystem/shell access; this connection does not sandbox a CLI.

Deleting a conversation also stops its Pi process and removes its private Pi directory. Deleting a conversation removes its database records, owned browser tabs,
sessions and known notebook export files, not the attached repository. It is not
a secure-erasure operation: SQLite/WAL pages, backups, renderer recovery state or
third-party CLI state can retain prior content. Terminal replay is memory-only
within Hello.; independently launched clients may keep their own transcripts.

## DSH surface and third-party plugins

- **The host runs third-party code.** dsh plugins run in the DSH host, an Electron
  utility process, with the person's user permissions: they can read files and use
  the network like any program. Hello's guards are consent and containment, not a
  sandbox. Before every install, the market shows the exact package and version and
  warns about local code; the profile is saved as a restore point first. pnpm 11
  installs nothing published less than a day ago; only the exact version the person
  confirmed is exempted (`--config.minimum-release-age-exclude=<name>@<version>`),
  so its dependencies still wait out that day. The same holds for an update from
  the market's Installed list.
- **What the host gets.** An environment built from an allowlist (path, home,
  locale, proxy settings), plus `DSH_HOME`, `DSH_TELEMETRY_DISABLED=1`,
  `DO_NOT_TRACK=1` and a per-start proxy token. It never gets Hello's model key,
  MCP secrets or other environment variables. Its profile is named `hello`: the
  `desktop` name would switch on DeepSeek's desktop telemetry rows.
- **Loopback only.** The host listens on 127.0.0.1 on a free port. Its one-time
  login token is exchanged by main, in the surface's own partition
  (`persist:hello-dsh`). The page receives an HttpOnly, SameSite=Strict cookie; the
  token never reaches the renderer or a log, and host output is redacted before it is
  written.
- **The surface's page.** It has no preload, Node or popups, and no permissions but
  clipboard writes and full screen. It cannot navigate off the host's origin; web
  links go to a browser tab of the person's (AI Mode Off). Hello's agent has no tool
  that reads or drives it.
- **The model key.** Sessions in the surface reach Hello's active connection
  through a loopback proxy that accepts only the per-start token and adds the real
  key upstream. The key is not in the host's environment, the profile or any file.
- **Plugin tools in chats.** The tool bridge listens on 127.0.0.1 with a token
  minted for each start, which the host entry reads and removes from its
  environment before dsh boots, so a shell a dsh tool spawns does not inherit it.
  It lists and runs only tools a plugin registered globally, never dsh's own or the
  reserved `run_code`, and caps a call's body at 1 MiB and its text at 60,000
  characters. In Hello the tools are the MCP server `dsh-plugins`: a library row
  the person adds from Settings and switches on per chat, whose descriptions and
  results are framed as untrusted content like any MCP server's.
- **The market's network.** HTTPS on 443 only, at most three redirects, every name
  pinned and refused when any address is private, loopback, link-local, multicast or
  a tunnel prefix, 2 MiB per answer, 8/12/30 s deadlines (ported from
  dsh-community-market). Catalog text is data. The one thing taken from a
  displayed install command is an npm package name, from one exact inert shape;
  commands are never run. Icons are fetched by main from three hosts, re-encoded
  as PNG and handed to the page as data. A standard source is added only from an
  https manifest whose endpoint is on the manifest's own origin and ends in
  `/v1/plugins`; its manifest and every page are checked against the market's
  schemas, the list file is checked again on every read, and its pages take the
  same network rules. Only an item's `package` field can make it installable.
- **What is installed.** npm `latest` with the same name, an exact stable version
  and a safe `dsh.bundle.patch`, confirmed by a one-shot token bound to that version
  and to the profile as it was, installed with `pnpm add --save-exact`. The profile
  runs no plugin install scripts (`strictDepBuilds: false` with no allowlist). The
  runtime allows exactly three (`node-pty`, `@deepseek-ai/dsh-subprocess-local`,
  `koffi`).
- **What leaves the machine** when the surface is used: npm registry requests,
  1024Store catalog requests, GitHub avatar images, the model provider's traffic
  through the proxy, and whatever network use a plugin the person installed makes on
  its own.

## What plugins do while Pi runs headless

- **A turn Pi begins on its own** (a plugin wakes it, as pi-subagents does when a
  background run finishes) is followed as a reply of the chat's: it has Hello's
  tools and approvals, Stop, and the waiting list, and is marked "A plugin started
  this reply", with the plugin's own line as it said it.
- **Extension UI over RPC** is shown beside the composer: text widgets, status
  lines, notices, and questions (select, confirm, input, editor). Questions are no
  longer declined automatically: the person answers them, and the answer goes only
  to the Pi process that asked. Everything is the plugin's text, rendered as plain
  text and bounded; a question with a timeout goes when Pi answers it itself; all of
  it goes with the Pi process that drew it. Terminal components never leave Pi.
- **Subagents** a plugin starts are Pi processes of their own, with Pi's built-in
  tools (read, bash, edit, write) in the chat's folder or home, and are **not**
  gated by Hello's approvals. They read the chat's private Pi folder: its
  connection, key and, when set in Settings, the model for subagents.

## Pi package market

The Pi market (user, 29.09) lists pi.dev/packages, the official gallery, by
reading its page through the market's restricted HTTP client (HTTPS on port
443 to that exact origin, pinned DNS, size and time caps). Only data leaves the
page: names, descriptions, authors, counts and links, never markup. When the
gallery cannot be read, npm's search stands in. An install comes from npm alone:

- **Preview.** npm's `latest` for the package must name it, carry an exact stable
  version, mark itself a Pi package, and point to a registry tarball with a sha512
  integrity. Its Pi ranges must admit the Pi Hello runs; Node, platform and size
  (100 MB, 5000 files) are checked; a package with only themes or gallery media is
  refused. The confirmation is a one-shot token bound to that version and, for an
  update or removal, to the library row as it was.
- **Install.** Hello's pnpm installs that version and its production dependencies
  into a staging project of its own: `--ignore-scripts`, the registry pinned, the
  person's `.npmrc` replaced by an empty one, packages copied rather than
  hard-linked, git and tarball dependencies refused. The lockfile must name the
  integrity the preview saw, or nothing is installed. The project then becomes the
  package's folder in Hello's library in one rename.
- **Trust.** The package is a library plugin like any other: off in every chat
  until turned on there, and its extension code is not sandboxed inside that
  chat's Pi. Its fingerprint covers the package's own files and the lockfile that
  pins its dependencies; the dependencies' files are not re-hashed on every run.
- **Update and removal.** From the market's Installed list, or Settings' update,
  which fetches npm's newest version again; removal deletes the folder and every
  chat's activation of it.

## Trust and verification limits

Model responses, tool arguments, websites, repository text and notebooks are
untrusted content. They do not gain authority merely by containing imperative
text. The tool gates above constrain execution, but there is no general prompt
injection detector or comprehensive data-loss-prevention layer.

Automated tests use temporary data, fake/local model streams and bounded native
fixtures; they do not spend real model credits or establish safety of arbitrary
CLI commands, remote websites or third-party providers. Security-sensitive changes
must preserve both main-process gates and lifecycle cancellation, not only their
renderer controls.
