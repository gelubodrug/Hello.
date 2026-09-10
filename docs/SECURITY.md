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

Remote pages run in `<webview>` guests of the app window, with web security
enabled, no Node integration and no app preload. The window may ask for a page,
but it decides nothing about it: `browser.attach` mints a one-time nonce for one
tab, and `will-attach-webview` in main deletes every preference the tag asked for
and writes its own — sandbox, context isolation, no Node, no nested webviews, and
the partition that tab belongs to. A tag presenting an unknown or spent nonce is
refused, and a guest whose host is not this window is closed on sight. The
browser session denies OS permission requests and downloads.

A page that opens a window gets a real child window with those same preferences
and the opener's partition, not a tab: a `<webview>` cannot adopt an existing
`WebContents`, so the alternative would have been to reopen the URL as a fresh
GET and break `window.opener`, `postMessage` and form posts. Chromium retains
opener/noopener, origin checks, referrer and form submission semantics; the app
does not copy credentials or emulate authentication callbacks. Page resize/move
requests cannot move the host app. Non-web navigation, nested webviews, and new
windows from the privileged app renderer remain blocked.

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
| Read this conversation's Runbook | Conversation ownership; read-only for the main-chat agent |
| Read/create/update this conversation's Tasks | Conversation ownership; task status updates validate the exact previously read line |
| List/read attached-folder files | Attached folder, resolved-path containment, bounded text reads and common secret-path exclusions |
| Write a file | The same path checks plus **Allow once** for that exact requested path/content |
| Run a shell command | **Allow once** for the exact command; executes with the chat folder as working directory |
| List owned browser-tab metadata | Conversation ownership, including metadata for Off tabs |
| Read page content | That tab's Agent control **Read** or **Full** grant |
| Open a requested page/dev URL in Hello | Owned conversation; new tab starts **Off**, no implicit read or control grant |
| Open a local HTML preview | Attached-folder containment; bounded read-only loopback static route; new sandboxed tab starts **Off** |
| Navigate an existing owned tab to a requested HTTP(S) URL | Conversation ownership; independent of Off/Read/Full; no implicit page read |
| Click/type/scroll through agent tools | That tab's Agent control **Full** grant |
| Load a skill's instructions or reference file | Skill activated for that conversation; real-path containment inside the imported copy; text only, bounded size |
| Call a tool from an MCP server | Server activated for that conversation, re-checked at call time; Hello's own stdio client; **no per-call approval gate** |
| Run a tool registered by an activated plugin extension | Explicit activation of that plugin; the extension is Node code inside the Pi child and is **not** gated per call |
| Interactive terminal/CLI client | Explicit user launch; subsequent commands follow that process/client's authority |

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
**A plugin's extension is Node code running inside the Pi child**, so it shares
that child's environment — which contains the current endpoint's key and the
per-process bridge token — and can call the bridge directly. It is not
sandboxed, and activating a plugin is the trust decision. Skills carry no code
authority: they are text the model reads through `skill_load`, which is confined
to the imported copy of a skill active in that conversation.

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

Every new or restored tab starts **Off** (grey). Opening a requested page/dev URL
or HTML preview is available in every mode. **Read** (orange) permits page
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
HTML entry in a sandboxed Off tab. It cannot choose a destination path, overwrite
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
other previews. Permission/download denial applies to these sessions too.

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

Grants are per tab, **not per origin**, and last only for the app session. A tab
with Full access retains that grant when navigating to another website until it
is changed or the app restarts. Full is not a confirmation for each click; clicks
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

Runbook and Tasks exports stay in the app-private data directory. Compatibility
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
