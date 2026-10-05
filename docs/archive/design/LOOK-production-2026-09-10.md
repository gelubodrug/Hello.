# Hello. — approved look

Materials approved on 2026-09-08 after the native-CSS cloud refinement. This is
the **appearance contract**, not permission to invent a neighboring style.
The production compact-chrome revision below implements the user's 2026-09-09
ergonomics direction and supersedes the archived specimen's nested spacing.
Its visual acceptance remains with the user; the historical motion study is
preserved separately below.

## Authority and specimen

- This file wins appearance conflicts with [the archived DESIGNUIguide.md](reference/DESIGNUIguide.md),
  older screenshots and legacy components. The guide retains component anatomy,
  accessibility and interaction requirements; a visual refresh does not change
  permissions, ownership, actions or lifecycle behavior.
- Executable values live in [tokens.css](../src/renderer/styles/tokens.css),
  [typography.css](../src/renderer/styles/typography.css) and
  [motion.css](../src/renderer/styles/motion.css). Use their variables. A mismatch
  is something to reconcile, not permission to add local color or timing values.
- The complete renderer-only specimen is preserved in [reference/](reference/README.md),
  including its [ChatPanel](reference/src/renderer/chat/ChatPanel.tsx), composer and menus.
  After installing that archive's dependencies, run `pnpm preview:design` from here.
  It does not launch Electron. See [IMPLEMENTATION.md](IMPLEMENTATION.md) for the
  separate production implementation and native verification requirements.

## Production compact chrome — 2026-09-09

### Current revision — two rows, edge navigation and compressing tool tabs

This revision supersedes conflicting geometry in the earlier iteration below.
Keep the approved materials, typography and existing pane lifecycle features.

- Navigation occupies only the top-left 272px × 48px area: native traffic lights,
  Hello., Search, New and the sidebar toggle. Settings is at the sidebar bottom.
  No conversation title or menu belongs in this header. The pane tab/action rows
  rise to the window top; the browser toolbar sits directly below. No global
  header above them and no duplicate Ready/model footer.
- Hidden navigation hides its header controls too. A quiet 4px left-edge target
  reveals the whole sidebar as an overlay using the shared fade and a 24px slide
  from the left. Leaving, outside click or Escape dismisses it; Pin sidebar
  keeps it docked. The 2026-09-10 header control is explicitly Pin/Unpin, using
  one simple 16px outlined left-panel glyph with a left divider and no arrow.
  Keep the shared 28px icon-button footprint, hover and pressed material;
  expose the pinned state with `aria-pressed` and the next action in its tooltip.
  Unpin restores temporary edge access and saves that preference. Keyboard
  access remains available through the edge trigger.
  Peeking does not resize panes or change their saved state. Only intersecting
  native content is occluded, and the region persists through exit.
  The revealed header and chat list form one continuous hover area: crossing
  upward onto Hello., Search, New or Pin sidebar must not dismiss the drawer.
- File drop targets use the existing hover material and edge token locally in
  the chat composer or terminal. A compact text hint appears only while dragging
  or importing; no full-app overlay may cover the native browser. Draft chat
  attachments use small removable pills with 12px labels, 14px file/image glyphs
  and 24px remove buttons, all from shared tokens. Drops never submit a message
  or execute terminal input automatically.
- Pane tab/action rows are 48px high. The first pane reserves the native 96px
  traffic-light footprint when navigation is hidden. Reopening/compact controls
  share the visible pane row; with both panes closed, Open chat and Open tools
  share one row in the empty workspace. No controls overlay native content.
- Tools tabs divide their available strip width dynamically, up to 210px each
  and down to a 32px icon. Names fade as space contracts; under 96px the inline X
  yields space, and at 52px only the icon remains. Full names stay in tooltips.
  Close remains available by right-click, middle-click or Delete on a focused
  tab, with the existing running-session confirmation. Only after all tabs reach
  icon width may the strip scroll. Add/minimize/expand/close-pane never shrink.
- Chat activity uses one collapsible Research/Activity summary per response,
  with actual search/read counts rather than repeating the question. Original
  commentary stays in order inside the timeline. Successful tools use compact
  rows; status, exact supplied duration and original input/output remain in
  details. Sub-second thinking reads “Thought briefly”. Successful activity
  rolls up on completion unless manually opened; errors, unfinished tools and
  approvals stay explicit. Its viewport is capped at ten compact rows (316px)
  with internal scroll; thinking and tool details open only on user request
  (approval prompts remain actionable). One quiet rail, 4px row gaps, unchanged
  type/materials. Reduced motion disables roll-up animation; closing removes focusability.
  Source icons beside response actions
  open a Sources menu with domain and full page title; selecting one opens it.
  Inline numbered citations refer only to successfully read pages. Favicons
  fall back to a local globe. Use the existing menu material and focus behavior.
- Right-click chat text uses the shared context menu: Copy selected text (⌘C),
  Copy message as rendered text, Copy message as original Markdown, and Attach
  selection as context. Preserve the selection snapshot while the menu has focus;
  attachment adds a quoted draft without sending. No extra toolbar row.

### Chat disclosures — 2026-09-09 refinement

The 2026-09-10 header refinement adds a quiet, static **24px top fade** to the
chat transcript below the Chat/Coder, Runbook and Tasks row. The alpha-gradient
mask belongs to the scrolling viewport, so content softens into the existing
panel material as it reaches the header. Use `--chat-transcript-top-fade` and
`--chat-transcript-mask`; no extra colored surface, divider, blur or shadow.
The header controls, composer and notebook pages stay outside the mask. Keep
existing spacing and selection behavior, match top scroll padding to the fade,
and disable the mask in forced-colors mode. This is a local content-edge
treatment, not a replacement for the native cloud material.

The user's latest reference makes thinking and activity headers text-only, with
a trailing rotating chevron and no decorative brain, spinner or tool glyph.
Active reasoning reads “Thinking” with a restrained monochrome gradient moving
through the text; completion reads “Thought”, “Thought briefly” or “Thought 2s”
using only the supplied duration. The exact thinking duration is a tooltip, not
an extra metadata row. Reasoning text aligns with its header and has no separate
border. The activity group retains its single quiet rail and bounded viewport.
The follow-up type reference uses the same Inter regular 15px as the response
for the Thinking/Thought label and its revealed text. Its trailing chevron is
16px with a restrained 1.75 stroke; keep the existing 8px gap and hit height.

Thinking, tool details and the activity group share a downward expand/fade and
upward collapse: the existing 4px reveal offset, 160ms enter and 120ms exit with
the shared curves. Keep opened content mounted through closing and rapid
reversals; closed details are inert and hidden from accessibility immediately.
Restore focus to their trigger when a disclosure closes around focused content.
The 2.2s text shimmer is a status-only motion exception in `motion.css`; its
gradient uses existing ink roles in both themes. System and app reduced-motion
preferences disable shimmer and disclosure animation. Source icons, original
tool results, approvals and session behavior remain unchanged.

### Browser AI Mode pill — 2026-09-10 address-bar refinement

The browser pill reads “AI Mode”, with the supplied 16px magnifier/sparkle
glyph and Inter medium 13px. The user's latest reference supersedes the detached
202px control: use a compact **104px × 24px pill inside the right end of the
32px address bar**, inset 4px from its right, top and bottom edges. Keep the
address and permission control on the same toolbar row; the address text flexes
and truncates while the pill keeps its size. Use the shared 4px icon/label gap,
8px horizontal padding and fully rounded shape in every state. Use a solid grey
fill for Off, warm orange for Read only and red for Full access, with the shared `--browser-ai-*`
roles derived from the existing themed palette. No robot, extra visible mode
suffix or border around the address bar. The current mode remains explicit in
the tooltip, accessible name and checked menu item; the menu is titled AI Mode.
Only presentation changes: default Off, per-tab permissions, menu visibility
gates and actual browser actions keep their existing behavior.

### CLI notebook and folder context — 2026-09-09

CLI worker panes show one compact context row above xterm, using the existing
panel material, 12px Inter and shared spacing. Show the launch-folder name with
its full path in the tooltip; do not imply tracking later shell `cd` commands.
Connected, running sessions show “Runbook · Tasks connected”; older/unsupported
sessions say notebooks are not connected, and exited sessions show no live
connection claim. If the chat’s folder differs, explain that this CLI keeps its
launch folder and offer “Open in <folder>” with the shared pill. That action
opens another CLI without stopping the original. No overlay over the terminal,
automatic restart or terminal theme changes.

Notebook edits which conflict with newer saved content keep the local draft and
show a compact inline notice with “Save draft as new” and “Reload latest…”.
Discard/reload uses the existing confirmation dialog and preserves its native
browser visibility gate. No silent overwrite, new palette or animation.

### Files tool — 2026-09-09

The supplied Files reference adds a read-only document-left/tree-right tool,
not another global sidebar. Keep the current charcoal roles (#131415 workspace,
#171819 panel, #212225 raised, #e5e5e7 primary and #b1b3bb secondary), paired light
tokens, Inter, shared pills and existing Tools lifecycle controls. The second
row is a compact 40px path/Preview/Source/Copy/Open/tree-toggle toolbar; do not
add a document title row. The right tree occupies 32% (200–320px) with 32px rows,
16px indents and one quiet divider. Path/filter/control text uses 12–13px;
document Markdown and code reuse the existing renderers. Below 600px the tree
and document switch rather than squeezing two unreadable columns. No new
animation or nested card material; tree rows use neutral selection and visible
keyboard focus. Open uses the shared measured menu, not a custom popup.

File-type icons use the locally bundled Symbols family (`@react-symbols/icons`):
16px colored SVG glyphs for file extensions and recognized config names. This is
the user's requested color exception, limited to type identity in the tree and
selected-file breadcrumb. Text, folder icons, row selection and toolbar actions
stay on the existing neutral palette; no colored row backgrounds or added motion.
Unknown types keep a generic glyph and symlinks retain a small link badge.

### Earlier compact-chrome iteration (historical)

Keep the approved palette, Inter, cloud, radial rims, pills and menus. Reclaim
space through layout, not through smaller text or a new visual language:

- One **48px global header** shares the macOS traffic-light row. Reserve 96px
  for the window controls, then Hello., Search and New. The active conversation's
  single title, sidebar toggle, Open chat / Open tools and Settings occupy the
  same row. Rename, Export and Delete belong only to the corresponding chat row
  in the sidebar, not to a header menu. Settings stays at the far right. The workspace
  header is portalled here; it is
  not repeated inside the middle card. Header controls remain outside native
  tool content and interactive controls are excluded from the window drag area.
- The **228px sidebar contains only the chat list** and its optional search
  field. There is no second brand/action row or bottom Settings row. A conversation
  name in the navigation list is a list label, not another pane heading.
- The workspace begins immediately below the header and reaches the bottom of
  the window. No global footer, outer-frame gutter, inset workspace title row or
  repeated conversation title. With Tools open, each actual pane keeps its own
  rounded rim without an additional surrounding box. Without Tools, restore the
  original cloud workspace panel: contextual text on the left, an inset chat
  stage on the right. It says “One conversation. A shared place to work.”, explains
  the tool/panel controls and shows the conversation's working folder when set.
  The cloud stays behind the panels, never overlaid on their content.
- Each pane has **one 40px tab/action row**. Chat / Runbook / Tasks are permanent
  switch tabs, always present and without individual close buttons. A previously
  closed notebook tab reappears without changing its saved entries or draft.
  They share their row with the + tool launcher and **visible**
  Minimize/Restore, Expand/Restore and Close controls. Tools has visible +,
  Minimize/Restore, Expand/Restore and Close controls on its tab row too. These
  actions must not be hidden in a menu to save space. There is no separate
  Floating/Pinned pill: Expand/Restore is the single control for that distinction.
  Do not restore a separate chat-name row,
  Chat badge, Tools heading or One at a time caption. Overflowing tabs scroll
  horizontally without allocating a second scrollbar row; controls stay fixed.
- Without Tools, Chat starts **Floating in its right-hand stage**, with the
  original 560px/760px floating limits and 16px stage inset. Expanded means pinned
  and fills that stage, not the entire workspace. Restore size returns to Floating.
  A legacy standalone Pin choice migrates to Expanded; no independent pin flag
  may keep a restored card full-size.
  Below a 760px workspace width, the context stacks above the chat stage.
  Expand and minimize remain directly available on the panel. With Tools open,
  chat stays pinned automatically because native content cannot accept overlap.
- **Minimize is not Close.** Without Tools, the three lifecycle states are an
  open panel, its short minimized bar at the bottom-right of its own stage, and
  closed. Minimizing preserves the previous solo expanded size for Restore.
  With Tools open, a minimized panel retains its tab/control row at the bottom
  in a separate layout row, never over native content; the other panel gets the
  full area above. If both are minimized, both bottom rows remain.
  Selecting a minimized tab or its Restore control restores its content.
  Closing a pane instead hides its entire frame and exposes Open… in the header.
- **Expand with Tools open** fills the workspace with the chosen panel and temporarily hides
  the other panel and sidebar. Restore returns the saved split and sidebar
  preference; no OS-window resize or session restart. Explicitly showing the
  sidebar exits expanded mode. A native tool hidden or minimized by these states
  remains mounted but has `visible=false`; it cannot cover the app controls.
- With tools, retain the non-overlapping split and one visible tool. Respect
  the 320px chat / 400px tools minimums plus the 8px separator; below that budget,
  show one area at a time. Closing Chat gives Tools all available space; closing
  Tools returns to the original solo-chat workspace. Reopening controls stay
  in the global header, never over the browser.
- Remove the **entire Ready/model row beneath the composer** and the global
  model footer. The selected model appears only in the composer's model control.
  Send/Stop, errors, approvals and accessible generation announcements remain.
  The browser's fixed-size Agent control pill is unchanged.
- Meaningful app errors/notices use an indicator **inside the fixed header**,
  with an accessible live announcement and full details/dismissal on click.
  They never insert another row or displace a live native viewport. The shared
  details dialog participates in the existing native-browser hide gate.
- Ordinary Chat / Runbook / Tasks and tool-tab switches remain instant. Keep
  the existing coordinated reveal for structural open/close/layout actions and
  its native-browser hide gate. Hidden hosts stay mounted; compacting chrome
  must not terminate sessions, remount editors or reset drafts.

### Native browser visibility — 2026-09-09 correction

Opening a non-modal menu in the sidebar or chat must **not** make a browser in
another part of the window disappear. Compare the positioned popup's actual
rectangle (including its reveal path) against the selected native viewport.
Only an intersection holds that browser hidden; no global hide for unrelated
context menus, dropdowns or their dismissal. Re-evaluate when either rectangle
changes and retain the popup's region through its exit animation. Multiple
popups own separate regions; closing one must not reveal a browser still covered
by another. Modal backdrops and structural layout changes keep full-window holds.
Repeated presentation of the same browser updates bounds in place, without a
hide/show cycle. These rules affect visibility, not tab lifetime or Agent control.

These are production rules, including the later solo-workspace restoration.
Archived specimen statements below about nested workspace headers or header
wrapping do not override this revision. The historical source stays intact in
`design/reference/`.

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

In the archived specimen, middle separation is the inset workspace's **rounded
perimeter and soft surround**, not a straight sidebar divider. The production
Tools layout gives that perimeter to the actual panes without another inset
frame. The restored solo layout uses the original workspace perimeter and inset
chat stage, still directly below the global header. Top and bottom corner returns
remain visible. Main surfaces use
`--panel-radius` = 16px.

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
states explicit. The production fixed Chat / Runbook / Tasks switch tabs do
not close; session tool tabs retain their real close/lifecycle behavior.

### Chat-centered navigation

The selected direction is **chats only in the global left sidebar**. Runbook,
Tasks, Browser, Terminal and CLI workers belong to their chat's workspace and
appear as pills, never global sidebar rows. Chat / Runbook / Tasks are fixed
switches, not closable documents; there is no notebook-recovery action hidden
under +. The + at the end of the row opens that chat's Browser / Terminal / CLI
launcher. The two-column study below separates notebook pills and tool pills
without creating another global navigation tree.

Runbook and Tasks share one quiet notebook layout: a narrow entry list with a
**+ New entry** row on the left, the selected entry's title and editor on the
right, and just one subtle divider. No nested card outlines, Save/Cancel footer
or separate editor design. Keep formatting controls minimal and retain the
chat's typography, code styling and spacing. Switching entries, tabs or
minimizing retains drafts.

The production notebook interaction is **rich-text editing by default**
(2026-09-09). Markdown is the storage/interchange format, not the default writing
surface. Do not bring back a pencil/eye Edit/Preview toggle. Headings, emphasis,
lists and task checkboxes are edited where they are rendered. A formatting
command applies to the entire selection, including every selected paragraph;
toolbar interaction must not discard that selection. Undo/redo belongs to the
entry, not the whole notebook.

Right-click exposes **Copy** and **Copy Markdown** using the shared menu surface.
Copy preserves formatted clipboard content with a plain-text alternative; Copy
Markdown copies source syntax. Both operate on the selection, or explicitly
identify the whole-entry scope when nothing is selected. Preserve unsupported
source rather than silently dropping or normalizing it just by opening an entry.
In the read-only fallback for unsupported syntax, Copy still follows the rendered
selection; Copy Markdown explicitly says **Entire entry source**, since mapping a
partial rendered selection back to unsupported source would be lossy.

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

### Composer selector hover — approved refinement, 2026-09-10

The model selector, and any future effort selector in the composer, use a
discreet grey **oval on hover**, matching the user's Select effort reference.
The resting surface is transparent. Hover and an open menu use
`--composer-selector-hover-fill`; keyboard focus uses the stronger
`--composer-selector-focus-fill` and primary ink. Both roles resolve through
the shared themed palette. There is no blue rectangular outline, border or
shadow on this control; keyboard focus remains visible through tonal fill.

Use `--r-pill`, 12px horizontal padding and an 8px label/chevron gap. Preserve
the existing 28px control height, typography and truncation; the oval includes
both label and chevron. Idle, hover, focus and open states keep the same bounds,
with only the shared fast color transition. This rule changes the selector
trigger, not the dropdown surface or text-input focus treatment.

## Motion candidate — test before approval

### Chat/Coder switch — explicit local exception, 2026-09-09

The user-requested mode control is always the first composer action, before
Folder. It keeps the active mode visible at rest and reveals two icon-only
Chat/Coder segments on click or tap, not on hover or focus alone. Use the same rounded MessageCircle
as the Chat tab, alongside CodeXml, at 16px with the normal icon stroke.
Labels remain accessible and available as tooltips. Selecting a segment
collapses the control; the next click or tap opens it again. Enter or Space
opens the focused control, then confirms a selection. Arrow keys select;
Escape, clicking outside or moving focus outside dismisses it.

The first panel-header pill reflects the conversation's saved mode: **Chat**
with MessageCircle, or **Coder** with CodeXml. It stays synchronized with the
composer switch, including the compact panel selector and reopen action. Keep
the existing pill geometry and icon sizing. Runbook and Tasks remain the other
two pages; the first page retains its identity and content when its label changes.

This small control may animate its inline width and inner horizontal
position, using the shared 160ms enter / 120ms exit timings and shared easing.
The user's 22:56 refinement supersedes the opaque dark rail and tall 40px shell:
use a 28px-high glass control, 2px inset and 28×24px segments. Its width is 32px
at rest and 60px expanded, with the active icon retained in the visible slot.
The shared `--mode-switch-*` roles provide translucent fill, a restrained vertical
sheen and backdrop blur. The user's 2026-09-10 refinement removes all outer and
selected-segment outlines, borders and inset edge shadows. Selection uses tonal
fill; keyboard focus uses a stronger shared tonal fill, also without an outline.
There is no opaque black track or outer elevation shadow. Outer/inner radii use 8px/6px roles. This glass
material is a user-authorized exception for this control only; other pills and
menus keep their materials. Reduced motion makes the change instant;
hidden options lose focusability. This exception does not authorize animated
pane geometry, runtime switching, or any change to browser/session ownership.

### Chat page label reveal — explicit the sibling app reference, 2026-09-10

The selected Chat/Coder, Runbook or Tasks pill keeps its icon and title visible.
Inactive pills show only their icon. Hover or keyboard focus reveals that pill's
title with a compact horizontal expansion and opacity fade; selection retains
the title, and leaving an inactive pill collapses it again. Icons stay in place.
Keep the existing pill material, 28px height, 14px icons and typography.

The owner selected the sibling app’s `SessionBranchAddRow` resource-action animation:
`--motion-tab-label: 80ms` and `--ease-tab-label: ease`, with no translate,
bounce or delay. In Hello the title is the expanding part, not the reference's
plus icon. Its intrinsic-width track expands from zero to its content width;
the 4px icon/title gap opens with it. Accessible names remain available when
titles are visually collapsed. OS and app reduced motion make the reveal instant.
This local pill exception does not animate pane geometry or page contents;
normal tab selection and saved drafts/scroll positions retain their behavior.

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
- Tab switch: instant, with no fade, reveal or whole-workspace animation. This
  applies to Chat/Runbook/Tasks, Browser/Terminal/CLI and the compact Chat/Tools
  switch. Retain keyed content and its draft/scroll state; only the active panel
  accepts focus/input. Open/close, minimize/restore and geometry changes retain
  their coordinated motion. Never remount a session merely to switch its tab.
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
