# Hello. — executable design reference

Approved appearance: [LOOK.md](LOOK.md). Reuse that contract and the shared tokens;
do not reinterpret the reference screenshots. Motion is the current test candidate.

## Complete code beside the design

[mockup/](mockup/) contains a self-contained source snapshot, not just a screenshot
or HTML pointer: the fixture, its imported components, styles, motion helpers,
local assets and renderer/shared dependencies. Its own README explains installation,
development and building. It does not require running the old Electron app.

The live source remains under `src/renderer/`; the snapshot is a review checkpoint,
not a second place to edit the design independently. Refresh it after approving
a change with `node design/export-mockup.mjs`. The snapshot manifest records the
copied source hashes. Do not hand-edit the generated source copies.

Implementation decision: [IMPLEMENTATION.md](IMPLEMENTATION.md). The user chose
a fresh application built from this approved design, not a retrofit or a new
shell over the old services. This supersedes the earlier reuse recommendation.
The old app and its data stay untouched; this snapshot is not the new production
app and does not establish that implementation has started.

## Live specimen

Run `pnpm preview:chat`, then open <http://127.0.0.1:4317/design/chat-panel.html>.

This renderer-only fixture uses the same ChatPanel, MessageList, Markdown/Shiki
and Composer as the app, plus the shared Menu/Popover and model selector.
It starts in dark mode. The transcript and endpoint
are sample data; sending appends a local preview reply and never calls a model.
No Electron, preload, user database, terminal or browser-control API is loaded.

Try Floating/Pinned, expand, minimize/restore, typing a draft, the empty-state
toggle and narrow widths. Pin preference is deliberately not persisted by the
fixture (it is persisted in the app). The Light button is a fallback check;
the requested design review is dark-first.

The tabs under the card header are interactive: Chat, Runbook and Tasks stay
mounted while switching. The plus adds mock Browser/Terminal/CLI worker tabs;
their close buttons remove only fixture data after the exit animation. Arrow
keys/Home/End switch tabs and Delete closes the selected utility tab. Runbook
and Tasks share an entry-list/editor module with a small formatting toolbar.
Their drafts are page-local; this is not the app's persistent notebook storage.

**CLI worker…** opens a second chooser with Back and the complete CLI catalog:
Claude Code, Codex CLI, Qwen Code, Kimi Code, OpenCode, Pi and Aider. Only choosing
a specific CLI opens its simulated tab. Choosing it again selects its existing
tab; different CLIs retain separate local drafts. Active-model labels mirror the
catalog, but no installation, model availability or real launch is implied.

Opening Tools temporarily pins Chat on the left and shows one tool at a time
on the right. Closing Chat gives Tools the full available width. Closing Tools
hides the group but keeps its keyed tabs and local state. **Open chat** and
**Open tools** appear beside the workspace title when those areas are closed.
Both controls live in the top header, never over a browser or console viewport.
At narrow widths they wrap within that header; Chat/Tool selects one visible area.
The empty Tools group exposes the + chooser; **Try tools** opens all three fixtures.

Use **Motion: Normal** to cycle through normal speed, Slow ×3, and Reduced.
The OS reduced-motion preference always wins. Minimize/restore, pin/float,
expand/restore, close/open and tab changes share the reveal+fade choreography.
Only opacity and transform animate; layout commits once between exit/enter.
No external session is started or stopped by any of these preview controls.

The left navigation is intentionally darker than the inset workspace and chat,
with a muted upper-left radial light. The 23:02 material study softens the
outlines into nonuniform radial rims following each rounded surface; the middle
separation belongs to the inset workspace, not an extra vertical divider.
The middle workspace tests a big soft cloud made from overlapping native CSS
gradients, interpolated in Oklab with theme-controlled near-surface colors. No
bitmap, low-opacity SVG mask or reduced-resolution intermediate is used. It
does not mask or clip the chat or menus.
Open **Chat actions** in the workspace header to inspect the shared dropdown:
rounded shell and hover row, neutral icons and group separators. Its actions
only change the preview notice; they never rename/export/delete real data.
Palette, typography and menu geometry are the same centralized tokens shipped
by the app, documented in `DESIGNUIguide.md` and guarded by unit contracts.

This workspace remains a renderer-only mockup. Floating means an inset card
within its allocated zone, not a native overlay over a live web page. Existing
production tabs, session ownership and bottom-docked sessions are unchanged.
Native browser visibility/bounds, PTY output and persistent notebooks require
separate integration tests before this can replace the application's layout.
