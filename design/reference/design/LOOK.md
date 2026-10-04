# Hello. — approved look

Approved on 2026-09-08 after the native-CSS cloud refinement. This is the final
**static appearance contract**, not another design proposal. Reuse it for every
new surface; do not reinterpret the references or invent a neighboring style.
The motion study below is separate and still awaits user testing.

## Authority and specimen

- This file wins appearance conflicts with [DESIGNUIguide.md](../DESIGNUIguide.md),
  older screenshots and legacy components. The guide retains component anatomy,
  accessibility and interaction requirements; a visual refresh does not change
  permissions, ownership, actions or lifecycle behavior.
- Executable values live in [tokens.css](../src/renderer/styles/tokens.css),
  [typography.css](../src/renderer/styles/typography.css) and
  [motion.css](../src/renderer/styles/motion.css). Use their variables. A mismatch
  is something to reconcile, not permission to add local color or timing values.
- The renderer-only [live specimen](http://127.0.0.1:4317/design/chat-panel.html)
  uses the real [ChatPanel](../src/renderer/chat/ChatPanel.tsx), composer and menus.
  Run `pnpm preview:chat` if the local preview is not running. It does not launch
  Electron. The fixture composition is not proof of a completed workspace refactor.

## Character, type and density

Quiet, layered charcoal; a darker left navigation; a softly lit inset workspace;
a close, rounded chat card. No pure-black app chrome, glass, neon accent wash or
VS Code-style ruled panel grid. True black remains specific to terminal content.

Use locally bundled **Inter Variable** through `--font-ui`, including portalled
menus. Regular 400 for body/menus, medium 500 for compact titles/pills, semibold
600 sparingly for headings. Use the existing 11–16px scale: 11 metadata, 12
secondary labels, 13 compact controls, 14 standard UI, 15 conversation text,
16 content headings. Section labels use sentence case. The existing empty-state
greeting is the only 24px display exception. Mono belongs to code or terminal
content, never to paths, model labels or ordinary chrome.

Spacing is `--sp-4/8/12/16/20/24/32`; control footprints are independently
`--control-sm/md/lg` = 24/28/32px. Retain clear full-button hit areas, visible
keyboard focus and accessible labels. Overflowing labels fade only when they
actually overflow; do not add ellipses or permanently faded label tails.

## Surface hierarchy

These are base tones, not instructions to flatten the corresponding materials.
The dark reference governs the look; light mode uses the paired theme tokens.

| Role                     | Token                               | Approved dark base    |
| ------------------------ | ----------------------------------- | --------------------- |
| Left navigation          | `--surface-sidebar`                 | `#101112`             |
| Workspace                | `--surface-workspace`               | `#131415`             |
| Chat/panel               | `--surface-panel`                   | `#171819`             |
| Raised composer/pill     | `--surface-raised`                  | `#212225`             |
| Current navigation row   | `--sidebar-current-fill`            | `#191a1c`             |
| Primary / secondary text | `--ink-primary` / `--ink-secondary` | `#e5e5e7` / `#b1b3bb` |
| Quiet text               | `--ink-tertiary`                    | `#92959e`             |

Keep color tokens as colors. Material background tokens contain gradients; do
not put a gradient into a token consumed by `color` or a contrast calculation.
The `--color-*` and `--chat-*` compatibility roles alias the foundation rather
than defining a second palette. Meaningful warning/error/success states retain
their semantic colors; selection does not become a large blue block.

### Navigation and cloud

- Navigation uses `--surface-navigation-background`: a muted 420 × 560px
  upper-left ellipse, settling into its opaque base by 76%. It reads as the
  darkest region overall, not a flat slab or a bright spotlight. Paint it once:
  the specimen's outer frame owns it; the real Sidebar paints it directly.
- **Approved cloud refinement — 23:50:**
  `--surface-cloud-background` starts from a single broad light source at the
  exact upper-left corner (`0% 0%`). Its 80% × 60% basis is widened by
  `--surface-cloud-spread: 1.4` to 112% × 84% radii. This interprets the requested
  wider radius as **+40%**, not a circle covering only 40% of the panel.
  Three unequal native CSS fields shape the falloff with Oklab interpolation:
  **20% × 31% at 108% 13%**, **80% × 48% at -24% 110%**, and
  **50% × 74% at 116% 83%**. These secondary radii are literal percentages,
  without the primary source's 1.4 multiplier. All centers sit off-canvas;
  there is no shared central convergence or repeating ring pattern.
  The first two fields use the soft tone, the third uses the shade, each fading
  continuously to transparent at 100%. Only the corner source reaches the peak.
  The dark peak is `#1d1e1f`, the quieter secondary light is `#161718`, and
  `--surface-cloud-shade` is `#111213`. Light mode shares the exact geometry
  with paired near-surface tones `#f0f1f3`, `#f6f7f8` and `#fafafb` respectively.
  The corner source is the last, opaque field and ends at the workspace base.
  Keep the static, asymmetric geometry in shared tokens: apparent randomness
  comes from the fixed intersections, never equal blobs or per-render randomness.
  This four-field composition replaces the rejected seven-field central pattern.
  All other approved materials remain unchanged.
- Use the cloud at full layer opacity. Do not replace it with an SVG alpha mask,
  PNG/JPG texture, opacity-reduced white overlay, blur filter, grain or noise.
  The rejected mask treatment produced visible tonal steps. Native gradients
  render directly at display resolution; the cloud does not animate.
- One `pointer-events: none` paint pseudo-element is permitted for the middle
  cloud, behind content in an isolated surface, with the inner corner radius.
  Do not clip the content, focus rings or dropdowns to paint the background.
- The chat keeps `--surface-panel-background`: its own quieter 520 × 420px
  upper-left radial light, ending at its opaque panel base. The cloud does not
  spread onto every child card, composer, pill or menu.

### Rounded rim and elevation

The middle separation is the inset workspace's **rounded perimeter and soft
surround**, not a straight sidebar divider. Its top and bottom corner returns
must remain visible. Main inset/floating surfaces use `--panel-radius` = 16px.

The radial rim is visually about **80% present, 20% faded near one corner**.
It is not an almost-invisible outline with a single bright corner. Attach
`data-surface-rim` to each surface and reuse its scoped `--surface-rim-layers`:

| Surface                 | Fade origin    |
| ----------------------- | -------------- |
| Outer specimen frame    | `bottom-left`  |
| Middle workspace        | `top-right`    |
| Chat card               | `bottom-right` |
| Unspecified rim variant | Top-left       |

The existing ellipse has 40% horizontal/vertical radii and settles to 9% rim
ink outside its corner falloff; dark rim ink is white. Preserve that geometry
and theme-owned ink. Paint an opaque surface inside a transparent 1px border,
and the rim in `border-box`. No diagonal gradient, duplicate solid outline,
extra vertical divider or pointer-intercepting rim overlay.

The floating chat has **one native CSS shadow lobe**:
`--panel-shadow` = `0 10px 28px -8px rgb(0 0 0 / 22%)` in dark mode. The middle
surround is smaller: `--surface-surround-shadow` =
`0 4px 16px -6px rgb(0 0 0 / 12%)`. Pinned chat has no floating shadow. Do not
stack broad halos, offset rings or gradient shadow layers. Lighting, rim and
shadow are three separate treatments, not one decorative blur.

## Chat, pills and dropdowns

The current floating card is capped by `--chat-floating-width/height` =
560/760px and still belongs to its existing chat zone. Pinned fills that zone;
this does not authorize overlapping or freezing a native browser view.
The compact chat uses a 12px composer radius, 10px user-bubble radius, 13px
header title and 28px header controls with 4px gaps. Reuse ChatPanel's scoped
geometry instead of copying the older full-window composer measurements.

Pills are neutral, compact and borderless, using `--r-pill` and tonal lift.
Text pills use 11px medium text and 8px horizontal padding; interactive mode
pills keep the 28px control footprint. Tabs follow the same restrained neutral
language: rounded shapes, inactive darker/quieter, no ornamental rail rules,
stacked outlines or colored selected slabs. Keep functional selected/close
states explicit. Restyling does not create new tab ownership or behavior.

### Chat-centered navigation

The selected direction is **chats only in the global left sidebar**. Runbook,
Tasks, Browser, Terminal and CLI workers belong to their chat's workspace and
appear as pills, never global sidebar rows. The + at the end of the pill row
is the entry point for that chat's tools. The fixed Chat pill returns to its
conversation. The two-column study below separates notebook pills and tool pills
without creating another global navigation tree.

Runbook and Tasks share one quiet notebook layout: a narrow entry list with a
**+ New entry** row on the left, the selected entry's title and editor on the
right, and just one subtle divider. No nested card outlines, Save/Cancel footer
or separate editor design. Keep formatting controls minimal and reuse the chat's
Markdown/Shiki rendering. Switching entries, tabs or minimizing retains drafts.

**User decision, 29.09.2026 — one notebook.** Beside Chat there is one Notebook
pill, not a pill per section. Its entry list becomes a quiet tree of three
sections — Runbooks, Tasks and Plans (the plan the model keeps) — each row with
a folder glyph, a + for a new chapter and a switch at its end; each chapter has
a switch before its title. What is off stays in the tree, quieter. The editor
side is unchanged. The app implements this (`src/renderer/notebook/`); the
specimen here predates it.

This is implemented in the renderer specimen only. Real actor ownership,
session launch/termination and persistence need an explicit app integration;
the visual grouping does not silently change any of those behaviors.

### Workspace study — chat plus one tool (2026-09-09)

This interaction layout is being tested in the mockup; the approved materials
above remain unchanged. The deliberate limit is **one chat area plus one visible
tool**. No tool tiling, stacked overlays or arbitrary additional panes.

- With no tools, ChatPanel keeps its floating/pinned/minimized arrangement.
- Opening the first tool fades the current layout out, temporarily pins the same
  chat on the left, then reveals two non-overlapping columns. Chat/Runbook/Tasks
  stay on the left; Browser/Terminal/CLI pills select one host on the right.
- The initial split is 35%/65%, adjustable by pointer or arrow keys on the quiet
  separator. Minimum allotted widths are 320px for chat and 400px for tools;
  very narrow workspaces show one area at a time through Chat/Tool controls.
- Closing chat removes its column and separator entirely: Tools fills the
  available content width and height. **Open chat** belongs in the workspace's
  top header beside the conversation title, in normal layout flow and outside
  the tool viewport. Never float it over Browser, Terminal or CLI content.
  Selecting/adding a tool does not reopen chat. Explicitly reopening chat
  restores the saved split (or the Chat view at compact widths) without
  remounting tools or discarding their local state.
- Tools follows the same rule: its frame's close control hides the whole group
  without closing individual tabs. **Open tools** sits beside **Open chat** in
  the same top-header action area whenever its group is hidden. Opening an empty
  group exposes the + chooser, not an automatic session launch. Closing the last
  individual tool still collapses the group. At narrow widths, header actions
  wrap onto their own in-flow row; they never cover tool content.
- Tool changes hide the outgoing content immediately before revealing the next;
  never crossfade two simulated native viewports over one another. Inactive
  keyed hosts stay mounted and retain drafts/history, but cannot receive input.
- This specimen permits one Browser, one Terminal and one instance per selected
  CLI identity. **CLI worker…** first opens the shared menu with Back and the
  full catalog: Claude Code, Codex CLI, Qwen Code, Kimi Code, OpenCode, Pi and
  Aider. No worker is opened until a concrete choice is made. Choosing the same
  CLI selects its existing tab; different choices retain their own local state.
  The generic worker in **Try tools** remains a separate compatibility fixture.
  Catalog active-model labels do not imply installed tools or a connected model.
  Closing the last tool restores the
  previous chat arrangement and sidebar preference without remounting the chat.
- Sidebar visibility is automatic at sufficient width, with an explicit override.
  Showing it reallocates layout space; it never overlays a tool. No automatic
  app-window maximize. At phone widths the shown chat list pushes content down.
- Browser address controls belong only to Browser. Agent control starts grey/off
  and is explicitly a simulated indicator, not a permission change.
- Browser pages, console commands and worker replies are local fixtures only.
  Native browser bounds/compositing, PTY lifecycle and IPC require later Electron
  verification; passing this study does not establish native integration safety.

Use the shared `Menu` inside `Popover`, not a newly drawn menu:

| Dropdown role    | Contract                                                              |
| ---------------- | --------------------------------------------------------------------- |
| Surface          | Solid `--menu-fill` = `#212121`; no cloud, glass or gradient          |
| Outer geometry   | 12px radius, 1px `--menu-edge` = `#3b3b3b`, 6px inset                 |
| Row              | At least 32px tall, 12px horizontal padding, 8px icon/label gap       |
| Type / icon      | Inter 14px regular / 16px icon; `#e2e2e2` text, `#969696` muted icon  |
| Active / pressed | One 8px-rounded `#323232` row / `#3b3b3b` pressed fill                |
| Groups           | `separatorBefore`, full-width `#303030` hairline, 6px above/below     |
| Elevation        | One owner of `--menu-shadow`; the Popover must not add another shadow |

Pointer and keyboard use the same roving active row; never light two rows at
once. Disabled rows and separators are not keyboard stops. Delete stays neutral
in its final menu group; destructive confirmation stays explicit and red.
The model picker shares this dropdown surface without losing search or metadata.

## Motion candidate — test before approval

Static materials above are approved. The following interaction choreography is
the next experiment, not a claim that every app panel already implements it.
Do not broaden this into a workspace lifecycle refactor or automatic animation.

- Enter: 160ms `--motion-base`, `--ease-out`
  (`cubic-bezier(0.32, 0.72, 0, 1)`), opacity 0→1 and translateY(+4px→0).
- Exit: 120ms `--motion-fast`, `--ease-in`
  (`cubic-bezier(0.4, 0, 1, 1)`), opacity 1→0 and translateY(0→+4px).
- Layout/pin/minimize: exit → commit geometry/state once → enter. No width,
  height, margin or position tween. Retain the same mounted content; hide
  minimized content from paint, focus and input rather than deleting it.
- Sidebar and workspace open/close geometry use one coordinator: exit the old
  foreground, commit the requested layout once, then reveal in a layout effect
  before paint. The cloud and canvas material stay still. Header Open controls
  stay in normal flow and available during a transition. A rapid reversal uses
  the latest requested state, not stale displayed geometry. Chat's own close
  fade finishes before its column is removed; this does not add persistence
  across a chat unmount. Hidden tool hosts remain mounted.
- Rapid actions cancel stale transitions; the last intent wins. An old timeout
  must not commit a previous layout, close a restored panel or steal focus.
- Tab switch: retain keyed panel content and its draft/scroll state; crossfade
  with the short reveal. Only the active panel accepts focus/input. No duplicate
  mount or repeated work caused by an animation.
- Utility-tab close: complete its exit before removal, then select an available
  neighbor. Chat is fixed in the specimen and closes only through the frame's X.
  Visual close is not new authority to terminate unrelated sessions or data.
- Reduced motion: commit immediately, with no transform, fade or artificial
  delay. The OS preference and the specimen's reduced-motion control both apply.
- No ambient or hover-triggered cloud movement. Existing control color feedback
  remains small and separate from panel motion; menus retain their directional
  placement-aware reveal.

## Validation recipe

The study starts with Chat, Runbook and Tasks inside ChatPanel. Its plus menu
opens Browser, Terminal or CLI worker in the adjacent tools area. **Try tools**
opens all three fixtures for comparison, with only Browser visible initially.
These are **mock tabs only**: no browser process, terminal or worker is launched. The
toolbar's Motion control cycles Normal → Slow (3×) → Reduced; OS reduced motion
always wins. Closing/reopening the frame restores focus to a sensible control.

1. Open the renderer specimen in dark mode at a normal desktop size. Compare
   the left navigation, irregular middle cloud and quieter chat surface together.
   Check that all three rim origins differ and the middle corner returns show.
2. Inspect the menu open and closed, then the model picker. Check one highlighted
   row, keyboard navigation/focus, unclipped edges and full-button hit targets.
3. Resize through a narrow layout and back. No page-level horizontal overflow,
   clipped composer controls, text fade on fitting labels or stretched texture.
4. Test floating/pinned, minimize/restore, expand/restore, tab switch and tab close.
   Type a draft and scroll before switching; confirm both survive. Repeatedly
   reverse an action while it is transitioning; the final state must match the
   last click, with no hidden panel accepting input.
   In Runbook and Tasks, add an entry with +, edit its title/body, select another
   entry and return; confirm the same draft survives tab switch and minimize.
   Notebook drafts are page-local in this specimen, not saved to the app or disk;
   closing/reloading the whole fixture is not a persistence guarantee.
5. Use Motion → Slow (3×) to inspect exit → commit → enter and
   close-before-remove. Return to normal speed to judge the real feel. Slow
   motion is a diagnostic override, not a new production duration.
6. Use Motion → Reduced, then verify the OS reduced-motion path.
   State changes must be immediate, accessible and otherwise identical. Restore
   normal controls afterward; do not change the approved static material.
7. Run relevant unit tests, TypeScript, lint and build. Renderer-preview checks
   are not Electron/native-browser integration coverage; report that boundary.
8. Try tools from both a minimized and a full chat. Switch each right-hand pill;
   confirm only one tool viewport paints, terminal/worker never show an address
   bar, and local inputs survive switching. Close all tools and confirm the
   previous chat geometry/draft and sidebar preference return. Check separator
   keyboard resizing, manual sidebar reveal and the narrow Chat/Tool switch.

Any new visual value or exception requires explicit review and an update here
and in the shared source tokens. “Close enough” local copies are not a new style.
