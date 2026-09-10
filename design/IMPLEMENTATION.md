# Hello. — design implementation

This is the greenfield application in `/Users/q/Documents/Hello.`. It is not a
retrofit of the previous app. Its renderer uses a new React shell and the typed
`HelloAPI`; it does not import the previous app's shell, stores or database.

## Source of truth

The approved appearance remains [LOOK.md](LOOK.md). These are its executable
owners in the new application:

| Concern                                                                     | Current implementation                                                                                               |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Colors, native CSS cloud, radial rims, spacing and geometry                 | [tokens.css](../src/renderer/styles/tokens.css)                                                                      |
| Inter typography and the 11–16px scale                                      | [typography.css](../src/renderer/styles/typography.css), local Inter import in [main.tsx](../src/renderer/main.tsx)  |
| Shared timing and easing                                                    | [motion.css](../src/renderer/styles/motion.css)                                                                      |
| Surface reveal and cancellation                                             | [surface-motion.ts](../src/renderer/ui/surface-motion.ts), [layout-motion.ts](../src/renderer/ui/layout-motion.ts)   |
| Main shell, conversation selection, API events and persisted UI preferences | [App.tsx](../src/renderer/App.tsx)                                                                                   |
| Chat/tool layout, pill ownership and focus-mode controls                    | [Workspace.tsx](../src/renderer/workspace/Workspace.tsx)                                                             |
| Shared menu, dialog, measured truncation and overlay ownership              | [primitives.tsx](../src/renderer/ui/primitives.tsx)                                                                  |
| Chat, settings and notebook geometry                                        | [app.css](../src/renderer/styles/app.css)                                                                            |
| Markdown/GFM, code highlighting and actual message parts                    | [Markdown.tsx](../src/renderer/chat/Markdown.tsx), [ConversationView.tsx](../src/renderer/chat/ConversationView.tsx) |
| Shared Runbook/Tasks list and autosaving editor                             | [Notebook.tsx](../src/renderer/notebook/Notebook.tsx)                                                                |
| Endpoint, model, credential and reasoning controls                          | [SettingsDialog.tsx](../src/renderer/settings/SettingsDialog.tsx)                                                    |
| Browser toolbar, native-view rectangle and Agent control                    | [BrowserPane.tsx](../src/renderer/browser/BrowserPane.tsx), [browser.css](../src/renderer/browser/browser.css)       |
| Renderer bridge, modal/layout holds and spatial menu occlusion              | [api.ts](../src/renderer/api.ts)                                                                                     |

`design/reference/` is the **complete archived mockup**, not merely screenshots
or a description. It preserves its source, styles and configuration for visual
comparison. Its sample responses, fixture stores, simulated tools, legacy path
references and preview-only instructions are historical context, not production
logic. Edit the files above for the live app; do not independently evolve two
active implementations. The archived `LOOK.md` retains the original approval
record. This file maps that record onto the current application.

The approved materials and motion primitives were carried forward from that
reference. Terminal/PTY/CLI reuse is a separate explicitly authorized boundary,
recorded in [PROVENANCE.md](../docs/PROVENANCE.md).

## Layout rules

### Current revision (supersedes earlier geometry below)

`SidebarChrome.tsx` owns the left navigation's pinned/temporary presentation.
It is 272px wide with a 48px header; Settings is at the bottom. App supplies its
controls and saved preference. Hidden navigation is removed from normal flow,
including Search/New/Show-Hide. Its 4px left-edge trigger reveals an overlay with
the shared fade/leftward slide, without changing pane geometry or preferences.
The overlay reserves measured native occlusion through exit; menus and search
remain usable. Show sidebar pins it open. The main frame retains only a 96px
window-controls inset in the first pane header when navigation is hidden.

Hover dismissal measures the complete drawer and its absolute titlebar. A DOM
`pointerleave` while the pointer is still inside those bounds is not a dismissal:
Electron's native drag regions can stop DOM pointer events between the list and
Search/New. That transition also cancels pending delayed closes. Outside clicks,
Escape, native-browser focus and window blur retain their existing behavior;
the titlebar remains draggable.

Workspace no longer portals a global header. Pane tab/action rows are 48px and
touch the window top in Tools mode. The browser toolbar directly below makes
two rows. Reopen controls share the visible pane's row; both closed gets a single
empty-workspace controls row. Solo floating composition and pane lifecycle states
remain as described below. There is no conversation-title row or Ready/model footer.

`ToolTabStrip.tsx` and `.tool-tab` use shrinkable 210px flex bases, 32px minima and
per-tab container queries. Inline close yields at 96px and titles at 52px, leaving
icons as the tab count rises. Names remain in tooltips/accessibility labels.
Right-click, middle-click and keyboard Delete retain closing, including the
existing terminal confirmation. Arrow keys and Home/End select tabs; the selected
icon is scrolled into view only when the minimum icon budget exceeds the strip.
No width animation or tab-content remount is introduced.

`WebResearch.tsx` groups actual web tool/reasoning parts into a collapsible
“Researched…” block. Its source-icon menu uses the shared MenuButton for native
occlusion, placement and keyboard control; rows display hostname and full title.
`citations.ts` turns only known fetched-source markers into links, never code or
existing links. Source URLs persist in structured results and copy/export.

### Files viewer

`files/FilesPane.tsx` adds a single per-conversation Files utility pill to the
existing Tools strip/host. `filesOpen` is independent of group minimize/close;
closing the Files pill never stops a browser or terminal. `files.css` implements
the supplied document-left, filtered-tree-right reference with existing tokens,
40px toolbar, 32px tree rows and the below-600px tree/document switch. Arborist
owns virtualization/keyboard navigation; modification and drag/drop are disabled.
The header shares existing Copy/Open menu controls and Tools owns Expand/Restore.

`Markdown.tsx` keeps web/citation handling and routes recognized local links via
`FileNavigation`. In a file preview it resolves relative links and headings;
Source uses Shiki/plain fallback with line numbers. No raw HTML or local images
are executed. Native browser visibility follows the existing selected-tool gate.
File changes were type-checked only; interactive/native QA remains with the user.

`files/FileTypeIcon.tsx` wraps Symbols' filename/extension resolver, with document
and log fallbacks and an Electron-Vite config alias. Tree rows and the selected
file breadcrumb share the 16px colored glyphs. Folder states and controls remain
Lucide/neutral. SVGs are React elements bundled locally, not remote image URLs.

### Earlier implementation iteration (historical where superseded above)

Settings menus use a layer above their owning dialog; ordinary background menus
stay below dialogs. Model pickers share the searchable menu with the exact hint
`search models try "free"`. Their search header and 400px-capped footprint stay
stable while filtering, with a visible empty-result state. Escape closes the
picker without dismissing Settings. API keys use a fixed saved-mask value in the
password field; clearing/replacing applies only on Save, never by sending the
mask back to the service.

- One 48px global header shares the macOS window-control row: Hello., Search,
  New, the active conversation title, reopening controls and Settings. App owns
  its DOM host; the active Workspace portals its header into that host. Inactive
  workspaces do not render another header. The sidebar is 228px and contains the
  chat list/search only, with no second brand or bottom Settings row.
  Rename, Export and Delete are available only from the respective chat row in
  the sidebar. Workspace has no conversation-actions menu or corresponding callbacks.
  Omit the placeholder title “New chat” in that header (not in the sidebar).
  Keep the directional Show/Hide sidebar icon; display
  an actual conversation title once it has been named.
- The workspace extends directly from below that header to the window bottom.
  Tools mode has edge-filling panes with their own rims and no nested-frame
  gutter. Solo mode restores the original cloud workspace, context at left and
  a 600px chat stage at right with 16px inset. Each pane has one 40px pill/action
  row, not a separate title row. There is no repeated chat title or global footer.
  Remove the entire Ready/model chat footer; the composer owns the model picker.
  Generation still has an accessible live announcement, Send/Stop and errors.
- Chat / Runbook / Tasks are permanent switch tabs without close buttons. Legacy
  `notebookTabs` preferences cannot hide a notebook section; all three remain
  available and selected pages/drafts stay mounted. + opens Browser / Terminal /
  CLI tools rather than a notebook-recovery menu. The far-right Close chat hides
  the whole chat pane; real tool/session close controls retain their lifecycle.
- The global sidebar contains conversations. Browser, terminal and CLI sessions
  belong to their conversation and appear as tool pills, not global rows.
- Without tools, chat starts Floating in its own right-hand stage. Expanded
  means pinned and fills that stage; minimized leaves a short bottom-right control bar.
  Context contains the original workspace explanation and optional working folder,
  stacking above the stage below a 760px workspace width. Expand/Restore toggles
  pinned/floating without a separate mode pill; selecting a minimized tab restores
  it. `chromeVersion: 4` removes the saved independent pin flag, migrating a v3
  solo Pin choice to Expanded without resetting messages, notebooks or sessions.
  With tools open, chat is pinned on the left and one tool is visible
  on the right. The initial split is 35%/65%; narrow layouts show one area at a
  time. A split clamps to 320px chat / 400px tools plus the 8px separator.
  There is no unrestricted tiling or overlapping native viewport.
- The production `.chat-stage` must carry `data-chat-design="true"`, which
  activates the reference's scoped `--chat-floating-width/height` tokens.
  `.chat-card` also retains 560px/760px fallbacks: its inline-size containment
  must never combine with an unresolved width and collapse to an empty sliver.
  Closing Chat is an explicit state, not hiding a zero-width card; its header
  reopening control is independent of Tools and sits beside Open tools when
  both are closed.
- Both Chat and Tools expose Minimize/Restore, Expand/Restore and Close directly
  in the tab row. Chat's `data-pinned` is derived only from `expanded || toolsOpen`;
  the legacy `pinned` preference is never consulted for live layout. There is no
  Floating/Pinned control or label. The layout menu is removed, not the layout features.
- `minimized` / `expanded` belong to Chat; `toolsMinimized` / `toolsExpanded`
  belong to Tools. Expanded states are exclusive. `data-pane-layout="chat-only"`
  uses the original context/stage flex layout whenever Tools is closed.
  With Tools open, it selects `split`, `single`, `chat-minimized`,
  `tools-minimized` or `both-minimized`. A minimized pane occupies an
  automatic-height bottom row while the other
  gets all remaining space. Both minimized leaves both rows available; no
  invisible full-height column is reserved. The splitter exists only in split.
- With Tools open, Expand uses one full-size pane and temporarily suppresses the sidebar. The
  other pane stays mounted; Restore recovers the saved split/sidebar preference.
  Explicitly showing navigation exits expanded mode. Minimize clears that pane's
  expanded state. In solo mode, Expand is local to the chat stage and Minimize
  preserves its expanded size for Restore; neither changes sidebar visibility.
  Choosing a tab restores its minimized content. Normal tab
  changes stay instant. Browser/terminal visibility also depends on Tools not
  being minimized, independently of its mounted/open state.
- Closing chat removes its entire column. Tools fills the freed area. Closing
  the Tools frame hides its group without ending processes. `Open chat` and
  `Open tools` remain in the **global header's normal flow**, never over a
  browser or terminal. Conversation titles shrink before fixed action controls.
  App errors/notices use an optional indicator inside the fixed header, with a
  live announcement and a shared details dialog on click. They never insert an
  extra row that displaces the native viewport outside its layout controller.
- An inactive tool host remains mounted with `visible=false`. Hiding a tool and
  ending a process are different actions. Closing a running terminal/worker tab
  requires the explicit end-session confirmation.
- Choosing `CLI worker…` opens the shared catalog first. Only choosing a concrete
  installed CLI launches a worker. Notebook contents are not silently injected;
  empty notebooks never block launch.
- Runbook and Tasks share one entry-list/editor module. Drafts autosave through
  a serialized queue and have local recovery; switching tabs does not destroy
  the editor state. Actual persistence is owned by the main-process API.

## Fixed geometry, not status-dependent widths

Changing status must never move its neighboring controls. Preserve the outer
footprint while replacing or fading text inside it:

| Status surface              | Fixed footprint                     | Owner                                                                                     |
| --------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| Browser Agent control       | 202px × 32px; inner value slot 65px | `.agent-control-pill`, `.browser-control-anchor`, `.agent-control-value` in `browser.css` |
| Notebook save label         | 45px width                          | `.save-state` in `app.css`                                                                |

Status text remains readable by assistive technology. Off/read/full keep their
grey/yellow/red meanings; a permission color is not a decorative selected-tab
color. Regular tool pills use the approved 28px control height and compact type.
Labels fade only after `Truncated` measures real overflow; never add ellipses or
a permanent fade to fitting text.

The former 150px generation-status pill and duplicate model footer are removed
by the compact-chrome revision. Do not reserve invisible footer height for them.

## Motion and native compositing

Use only the shared 120ms exit and 160ms enter, the approved easing curves, and
opacity plus the 4px reveal translation. A layout action is **exit → one geometry
commit → enter**, not a width/height/margin tween. The coordinator retains the
outgoing frame across React's commit and rejects obsolete completion callbacks.
Toggle intents are computed from the latest requested state, so rapid reversals
do not commit an old minimize/pin/sidebar action.

The cloud, base materials and rim artwork do not animate. Foreground surfaces
reveal, rather than fading a whole window to black. OS reduced motion commits
immediately without an artificial delay.

Normal tab selection commits immediately without a layout-wide fade. The
structural-motion surface selector includes the global header's portalled
restore controls as well as the sidebar and workspace foreground.

Modal dialogs own paired `setAppOverlay(true/false)` holds through their exit
animation. Layout changes and direct split dragging hold the same full-window
gate. These owners are reference-counted.

Non-modal `MenuButton` and `ContextMenu` popups instead use `registerAppMenu`.
After positioning, each registers its measured rectangle and 4px reveal path;
resize/style observations and React layout commits keep it current. It remains
registered until the popup exits or unmounts. The bridge checks these regions
against the desired browser bounds on every popup or viewport update. Menus
outside that viewport never hide it. Closing one owner cannot clear another
popup's intersection or a modal/layout hold. The native view's `focus` event is
forwarded through a payload-free preload subscription to dismiss non-modal menus
without stealing focus back. Renderer blur also dismisses them on window changes.

Presentation requests are deduplicated in the renderer. The main process also
preserves the active view while applying changed bounds in place, instead of
hiding all views before re-showing the same one. An overlapping popup or modal
may hide the browser temporarily, but does not close, reload or revoke its tab.

## Content fidelity and checks

Site-created browser windows now become real tool pills: foreground popups select
the child, background links leave the current tool selected, and native self-close
returns to the opener. Chromium's pending WebContents is adopted so redirects,
POSTs and authentication callbacks are not replaced by a second URL load. No new
header row or floating native window is introduced. A page changing URL does not
hide/re-present its native view. Reload also recreates a discarded native frame.

The popup/reload regression cases in `tests/browser-manager.test.ts` are authored
but were not executed in the user-led dev workflow. Non-emitting TypeScript checks
are separate; actual provider login and native opener messaging need the user's
dev check after the updated main process/preload are loaded. A renderer refresh
alone cannot install changes to Electron's main process. No authentication URL
from the user is stored in source or fixtures.

Chat renders provider-supplied text, thinking and structured tool parts; it does
not invent reasoning, tool progress, token counts or elapsed time. Thinking is
an accessible disclosure. Tool rows expose actual input, output, status,
duration and approval actions. JSON results render as highlighted code; file
and console results preserve literal text, including Markdown-looking source.
Markdown uses GFM, safe link handling and Shiki highlighting with a plain-code
fallback. The renderer CSP permits WebAssembly compilation for Shiki without
enabling general JavaScript `unsafe-eval`.

Chat activity now uses one ordered prefix group, even when commentary separates
tools, with the trailing answer outside. `chat/activity.ts` derives real search,
distinct successful page-read and tool counts. Only the latest meaningful
thinking part can be active; a new tool ends that phase. Completed sub-second
thinking is labeled “Thought briefly”; exact supplied milliseconds are in its
details. Successful tool status/duration live in details rather than each row.
The group rolls up after completion by default, preserves manual disclosure
choices, and keeps failures/approvals/unfinished work explicit in its header.
User-message actions occupy the existing inter-message gap instead of reserving
another hidden row. Original parts, source menus and approval actions remain.

The activity viewport is bounded to ten 28px rows with nine 4px gaps. Steps and
full details are retained behind internal scrolling, not truncated. Thinking is
never automatically opened/closed when its active state changes. A CSS grid
roll-up keeps content mounted through completion collapse, uses shared motion
tokens, respects reduced motion and makes closed content inert. A transcript
content ResizeObserver follows that height only while already pinned at the end.

Chat right-click snapshots the selection before the shared ContextMenu focuses.
Copy writes selected plain/rich text; Copy message excludes tool/thinking controls;
Copy message as Markdown preserves original source and read-source links. Attach
selection appends a quoted draft, preserving existing text and never sending.
Clipboard writes use the existing main-only bridge. Errors remain visible; menu
regions retain the existing native-browser occlusion policy. These changes add no
main-process API, new dependency, or renderer-side clipboard permission request.

Activity regression cases are authored in `tests/chat-activity.test.ts` and
`tests/renderer-interactions.test.tsx` but not executed in this user-led dev
workflow. These renderer-only changes require no main-process restart.

Run budgets now derive from live owned browser grants in the main process:
Off/no tab keeps 8 rounds/32 calls, Read triples both to 24/96, and Full removes
the cumulative caps. The budget is re-evaluated before each model request, not
cached from a previous turn. Permission metadata reads now share the cancellable
browser-operation wrapper so Stop also settles if a refresh hangs. Finite-cap
stops still retain tool results and show “Ask to continue”; per-tab action gates,
approvals, payload bounds and the 32-call cap within a single model response
remain unchanged. Authored service fixtures cover long Full runs, Read budgets,
explicit continuation, mixed ownership, changing/unavailable grants and Stop.
Non-emitting type checking passed; fixtures were not executed. This main-process
change requires the user to relaunch dev to load it; no build or restart was run.

Regression checks live in `tests/renderer-interactions.test.tsx`,
`tests/layout-motion.test.ts` and `tests/surface-motion.test.ts`. They cover real
React input events, send/stop, model/effort selection, explicit approvals,
notebook save-on-switch, menu keyboard behavior and interrupted motion.
Renderer tests do not replace packaged Electron checks for native browser
bounds, clipboard, filesystem dialogs, PTY lifecycles or the real Shiki engine.
