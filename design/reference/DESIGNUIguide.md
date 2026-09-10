# UI Style Guide

> **Start with [design/LOOK.md](design/LOOK.md).** It is the approved final static
> appearance contract and wins visual conflicts with this guide, old screenshots
> and legacy components. This guide retains anatomy, accessibility and behavior
> requirements; older measurements do not override the approved LOOK. The new
> panel/tab motion study is explicitly a candidate, separate from the approved look.

## Approved visual foundation — 2026-09-08

The user-approved Linear reference now defines the **shared design foundation**,
not a separate ChatPanel theme. Dark means layered charcoal, not pure black.
Use locally bundled Inter Variable, compact neutral pills, gently rounded
surfaces and discreet edges. The left navigation must be visibly darker than
the workspace and panels on its right. Never flatten them into one gray.

The 22:34 sidebar and 22:36 dropdown captures refine the approved 22:04 reference.
Their translated logical design tokens (not screenshot pixel measurements) are:

| Role                      | Token                              | Dark value            | Treatment                                                            |
| ------------------------- | ---------------------------------- | --------------------- | -------------------------------------------------------------------- |
| Left navigation           | `--surface-sidebar`                | `#101112`             | Opaque base with a muted upper-left radial light; no right-hand rule |
| Workspace                 | `--surface-workspace`              | `#131415`             | Soft local radial light, never a diagonal wash                       |
| Inset chat/panel          | `--surface-panel`                  | `#171819`             | 16px `--panel-radius`, fading radial perimeter                       |
| Composer/pills            | `--surface-raised`                 | `#212225`             | Tonal lift, no ornamental outlines                                   |
| Navigation current row    | `--sidebar-current-fill`           | `#191a1c`             | Neutral, never a blue selection block                                |
| Dropdown                  | `--menu-fill`                      | `#212121`             | Solid surface; no gradient or glass                                  |
| Dropdown active row       | `--menu-hover`                     | `#323232`             | One rounded highlighted row                                          |
| Dropdown edge / separator | `--menu-edge` / `--menu-separator` | `#3b3b3b` / `#303030` | One outer edge; separators only between groups                       |
| Dropdown text / icons     | `--menu-ink` / `--menu-muted`      | `#e2e2e2` / `#969696` | Regular text, quieter icons                                          |

`tokens.css` owns paired light/dark foundation values. Compatibility `--color-*`
tokens and scoped `--chat-*` tokens alias these roles; do not copy a second
palette into modules or the design preview. `fonts.css` imports Inter globally
so portalled menus and chat use the same font. `tests/unit/design-system.test.ts`
guards tonal ordering, contrast, theme parity and the shared aliases.

### Approved radial/cloud material — final snapshot in LOOK.md

The user approved the native-CSS cloud refinement. The following material is
no longer a candidate; [LOOK.md](design/LOOK.md) is the authoritative snapshot.
It refines the material, not the layout, type or base palette. The former flat
sidebar and uniform shell borders are replaced by this shared treatment:

- `--surface-navigation-background`: a very subdued elliptical light at the
  upper-left corner, 420 × 560px, fading into the opaque navigation base by 76%.
  It must still read as the darkest region overall, not a spotlight or glass.
- `--surface-workspace-background` and `--surface-panel-background`: separate
  broad radial pools, 680 × 540px and 520 × 420px. Each settles into its own
  opaque base. No linear, diagonal or animated gradient on these surfaces.
- `--surface-rim-layers`: **roughly 80% of the rim remains visible**; the
  remaining corner region fades radially. An ellipse with radii 40% of width
  and height localizes that transition to about 20% of the perimeter. The
  edge must not be almost invisible except for one bright corner.
- Each surface chooses its fade origin with `data-surface-rim`: outer frame
  bottom-left, inset workspace top-right, chat bottom-right. A missing variant
  defaults to top-left. Define the gradient at surface scope so the corner
  variable resolves locally; never replace it with a diagonal linear gradient.
- Paint the opaque surface in `padding-box`, then the radial rims in
  `border-box`, with the existing transparent 1px border and inherited corner
  geometry. No overlay, mask or new stacking context; the content and its
  dropdowns must stay clickable and unclipped.
- The **middle separation is the rounded perimeter of the inset workspace**,
  plus `--surface-surround-shadow` softly extending around it. It is not an
  extra vertical divider drawn on the sidebar. Keep both corner returns visible.
- The preview paints navigation light once, on its surrounding frame; do not
  stack a second glow on its sidebar. The real Sidebar consumes the same
  navigation background token directly. Existing dropdown geometry/behavior
  and its solid menu fill remain unchanged in this refinement.

Keep the base `--surface-*` colors separate from the background-layer tokens:
text contrast, control fills and color aliases still require colors. Do not
retune this approved material without review; keep changes in one token source.

**23:13 shadow correction:** do not reproduce dark bands seen in reference
captures as elevation. The chat uses one ordinary CSS `box-shadow`, with a
28px blur and -8px spread, offset 10px downward (22% black in dark mode).
The surrounding workspace uses one smaller, fainter shadow. No stacked broad
halos, offset rings, gradient shadow overlays or artificial noise. Surface
lighting and the 1px radial rim remain separate from this shadow.

**Approved middle-layer cloud, refined at 23:23:** with three nested surfaces, the
middle workspace (`Research & handoff · Chat`) uses a broad, irregular soft cloud
instead of a single radial light field. Paint three unequal, off-center native
CSS gradients through `--surface-cloud-background`, with Oklab interpolation
and theme-owned `--surface-cloud-peak` / `--surface-cloud-soft` colors close to
the workspace base. The last field ends opaque. Their combined shape must read
as a soft cloud, not a diagonal ramp or concentric spotlight.

The earlier low-opacity SVG mask was rejected for visible tonal steps. Do not
restore it or substitute a PNG/JPG, scaled texture, opacity-reduced white overlay
or blur pass. Render directly at the browser's display resolution, with no image
asset, mask, grain or animation. A single noninteractive paint pseudo-element
keeps the content, focus rings and menus unclipped. The sidebar light, chat
surface, radial corner rim and single CSS shadow stay unchanged. This is the
approved static material, not a claim that the full workspace refactor is done.

This foundation supersedes older visual reference directions throughout this
guide. It does **not** authorize changing interaction behavior or migrating all
workspace layout at once. `ChatPanel` remains the first floating/pinned module;
the shared Menu, model selector and sidebar consume the same foundation now.

Floating and Pinned are presentations within the existing chat zone for this
first module. They preserve the mounted conversation; minimize hides it without
deleting it. Foot-docked terminals/workers remain outside the card. This is not
yet the full workspace refactor: renderer content must not overlap or freeze
the native browser page just to simulate a floating chat.

The shared transcript and composer accept scoped CSS variables so the card
does not add a second titlebar gap or fork chat/Markdown behavior.

This is the renderer anatomy, accessibility and interaction reference. Appearance
is governed by [LOOK.md](design/LOOK.md); legacy appearance directions below are
historical context wherever they disagree. Executable values live in
`src/renderer/styles/tokens.css`, `motion.css`, `typography.css`. Do not resolve
a conflict by inventing a component-local value or by changing existing behavior.

**The prime rule: nobody invents anything.** If a measurement, color, duration, or behavior is
needed and this guide does not define it, do not improvise — follow §"When this guide is
silent" at the end. Every deviation from this document is a bug.

## Reference

The Linear references in §Approved visual foundation are canonical for the look.
These older ChatGPT/macOS captures retain only their interaction/anatomy context:

- `.agent/attachments/20260903-163322_01a068.png` — full window: chrome, transcript, composer.
- `.agent/attachments/20260903-163352_01a068.png` — composer close-up: the exact target.
- `.agent/attachments/20260903-164122_01a068.png` — sidebar overlay open: the exact target.
- `.agent/attachments/20260824-200627_01a035.png` — earlier full-app reference (sidebar IA).

For appearance, LOOK.md wins over this guide and screenshots. For retained
anatomy/interaction requirements, this guide wins over historical captures.

## Overview

An Electron desktop app for chatting with local models. The visual identity is **monochrome
and quiet**: layered neutral grays carry all chrome, navigation has an opaque dark backing, and
color is reserved for state (focus ring, error, success, verified). The conversation is the
product; the UI recedes and frames it.

When in doubt:

- Reach for **spacing and tonal contrast** before borders.
- Reach for **CSS variables** before hardcoding any value.
- Match the nearest **existing primitive** (`src/renderer/ui/`) before writing custom CSS.

## Source of truth

| Concern                                  | Canonical location                                 |
| ---------------------------------------- | -------------------------------------------------- |
| Approved appearance and review specimen | `design/LOOK.md`                                    |
| Color, spacing, radius, elevation tokens | `src/renderer/styles/tokens.css`                   |
| Motion durations + easings               | `src/renderer/styles/motion.css`                   |
| Type scale, weights                      | `src/renderer/styles/typography.css`               |
| Shared primitives                        | `src/renderer/ui/` (`Button`, `Tooltip`, `Reveal`) |
| Window chrome (native)                   | `src/main/index.ts` (BrowserWindow options)        |

Never hardcode a hex, px, ms, or easing in component code if a variable covers it. If a new
token is needed, add it to the canonical file (light **and** dark), then use it. The legacy
`--dur-fast` duration token is **deprecated**: all transitions use `--motion-fast/base/slow`
with `--ease-out` (enter) / `--ease-in` (exit). Do not add new `--dur-*` call sites.

## Color roles

Tokens come in surface/foreground groups. Always use them together; never mix a foreground
onto a surface it wasn't paired with.

| Token                       | Use it for                                           | Don't use it for                   |
| --------------------------- | ---------------------------------------------------- | ---------------------------------- |
| `--color-bg`                | App canvas fallback                                  | Panels (use material/surface)      |
| `--material-chrome`         | Alias of the darkest navigation surface              | Content areas                      |
| `--material-content`        | Near-opaque conversation backing                     | Chrome                             |
| `--color-surface`           | Lifted surfaces: composer, cards                     | Menus (use `--menu-fill`), canvas  |
| `--color-surface-hover`     | Hover fill for ghost controls and rows; user bubbles | Persistent fills on idle controls  |
| `--color-surface-active`    | Pressed fill; disabled send fill                     | Hover (too heavy)                  |
| `--color-border`            | The rare hairline: dividers, popover edges           | Ordinary structure (use space)     |
| `--color-border-strong`     | Divider hover state only                             | Default borders                    |
| `--color-text-primary`      | Body text; the send-button fill (see §Composer)      | Captions                           |
| `--color-text-secondary`    | Secondary UI text, chip labels                       | Body copy                          |
| `--color-text-tertiary`     | Placeholders, metadata, idle icon-only controls      | Anything the user must read to act |
| `--color-text-disabled`     | Disabled text/icons only                             | De-emphasis (that's tertiary)      |
| `--color-accent`            | Focus ring, selection, verified/active state         | Decoration; the send button        |
| `--color-error` (+subtle)   | Real errors and destructive actions                  | Cancel/Dismiss (never destructive) |
| `--color-success` (+subtle) | Verified successful state only                       | Optimistic "should work" states    |
| `--color-warning` (+subtle) | Plain-HTTP / certificate warnings                    | Generic emphasis                   |

Rules:

- **Monochrome chrome.** No control is blue at rest. Accent appears only on focus rings
  and meaningful state indicators. Selected navigation/menu rows are neutral. The send button is **inverse monochrome**, not
  accent (see §Composer).
- **Tints via `color-mix`**, never new hexes:
  `background: color-mix(in srgb, var(--color-text-primary) 8%, transparent);`
- **Never rely on color alone** for critical information.

### List rows: idle, hover, active

For any list-style row (sidebar conversations, popover options):

- **Idle:** transparent background, no border.
- **Hover:** `--color-surface-hover`, transition `background-color var(--motion-fast) var(--ease-out)`.
- **Pressed:** `--color-surface-active`.
- **Current/selected:** `--sidebar-current-fill` for navigation; `--menu-hover` for
  dropdowns, plus `aria-current="true"` / `aria-selected="true"`. No row border.
- **Don't** invent a selected color or add per-row borders.

## Typography

- **Family:** `Inter Variable` (`--font-ui`), **bundled locally** through
  `@fontsource-variable/inter` in `fonts.css`, including portalled UI. No network font
  fetch. A build that unexpectedly renders the fallback family is a defect.
- **One font in the UI.** `--font-mono` (Geist Mono) is used ONLY inside code content —
  fenced code blocks and inline code spans in messages. Everything else — model IDs,
  endpoint URLs, token statistics, the status bar, paths, metadata — renders in Inter
  (`--font-ui`) like the rest of the interface. No mono in chrome, ever.
- **Truncation is always a fade, never an ellipsis — and ONLY when text actually
  overflows.** Any text that must truncate (sidebar rows, tab titles, chip labels, popover
  rows, the address pill) fades out over its last ~24px via a
  `mask-image: linear-gradient(to right, black calc(100% - 24px), transparent)` style mask
  — applied **conditionally**: a shared observer toggles the mask class only while
  `scrollWidth > clientWidth`; text that fits renders fully opaque edge to edge. A fade on
  a string that fits ("llama.cpp" losing its tail) is a defect. `text-overflow: ellipsis`
  stays forbidden.
- **Scale (exact, no other sizes):**
  - 11px — metadata, timestamps and quiet section labels; sentence case, medium
    weight where needed. Do not restore the old uppercase/letter-spaced treatment.
  - 12px — secondary UI, previews, captions.
  - 13px — compact controls, sidebar rows, chip labels.
  - 14px — standard UI, buttons, inputs.
  - 15px — conversation text and the composer field (line-height 22px).
  - 16px — headings inside content; the maximum interface size.
- **One display exception:** the empty-state greeting is 24px semibold (§Empty state). Nothing
  else may exceed 16px.
- Hierarchy comes from weight and spacing first, size second.

## Spacing & control sizes

Spacing scale (only these): 4, 8, 12, 16, 20, 24, 32 (`--sp-*`).

**Icons** (Lucide only, default stroke): primary chrome and composer icons are **18px** —
the native-macOS weight the reference carries (titlebar cluster, sidebar app row, composer
plus/mic, message actions); list-row and popover icons 16px; dense metadata glyphs 14px.
Never below 14px, never mixed sizes inside one cluster.

Control sizes are their own tokens — do not derive sizes from spacing tokens:

| Token (add to tokens.css) | Value | Used by                                           |
| ------------------------- | ----- | ------------------------------------------------- |
| `--control-sm`            | 24px  | Dense icon buttons (message actions, quote ×)     |
| `--control-md`            | 28px  | Standard icon buttons (chrome, composer plus/mic) |
| `--control-lg`            | 32px  | Send/Stop circle; search pill height              |
| `--titlebar-height`       | 44px  | The single top band (§Window chrome)              |

## Radius

| Token               | Value  | Used by                                            |
| ------------------- | ------ | -------------------------------------------------- |
| `--r-6`             | 6px    | Tiny controls (quote remove)                       |
| `--r-8`             | 8px    | Buttons, inputs, list rows                         |
| `--r-10`            | 10px   | Legacy small surfaces, not the shared dropdown     |
| `--r-12`            | 12px   | Dialogs, panels                                    |
| `--r-18`            | 18px   | User message bubbles (add token)                   |
| `--r-24`            | 24px   | The composer surface (add token)                   |
| `--r-pill`          | 9999px | Chips, status pills, the send circle, search field |
| `--menu-radius`     | 12px   | Shared dropdown shell                              |
| `--menu-row-radius` | 8px    | Dropdown option highlight                          |
| `--panel-radius`    | 16px   | Inset/floating main panel                          |

Match the component's documented radius; never introduce a new one.

## Elevation

Three levels. Do not add a fourth.

1. **Flat** — the default. Content, rows, chrome: no border, no shadow.
2. **Tonal lift** — a surface fill (`--color-surface`) with **no border**: the composer, user
   bubbles. Separation comes from tone, not lines.
3. **Floating** — one discreet edge and one shadow. Menus use `--menu-edge` /
   `--menu-shadow`; the chat card uses the radial `--surface-rim-layers` /
   single-lobe `--panel-shadow` defined in LOOK.md, not a uniform solid outline.
   Other dialogs/tooltips retain `--color-border` / `--shadow-sm`.

## Window chrome

Frameless with native traffic lights: `titleBarStyle: 'hiddenInset'`,
`trafficLightPosition: { x: 12, y: 16 }`, `vibrancy: 'sidebar'` (kept active on blur).

**One top band, exactly `--titlebar-height` (44px) tall, and it is the drag region.** The
conversation extends to the top edge behind it. Contents, left to right:

- **Left cluster** (starts after an 80px traffic-light gutter — no hit targets in that band;
  4px `--sp-4` gap between the controls):
  1. Sidebar toggle — `PanelLeft` icon, 16px, in a `--control-md` ghost button. Tooltip
     "Toggle sidebar ⌘B".
  2. New chat — `SquarePen` icon, 16px, `--control-md` ghost. Tooltip "New chat".
- **Center:** the search affordance — a `--control-lg`-tall pill (`--r-pill`), width
  `min(320px, 32vw)`, `--color-surface-hover` fill, `Search` icon 14px + 13px tertiary
  placeholder "Search" centered as one group inside the pill (it is a button, not an
  input), 8px `--sp-8` icon/label gap, 12px `--sp-12` minimum horizontal padding.
  Absolutely centered on the window; hidden below 720px window width.
- **Right cluster** (inset 12px `--sp-12` from the window's right edge, 4px gap): exactly
  two icon controls, `--control-md` ghost:
  1. Share/export — `Share` icon 16px (exports the conversation; replaces the old download
     icon). Tooltip "Share".
  2. Right-panel toggle — `PanelRight` icon 16px (browser pane, ⌘⇧B). Tooltip states
     open/close + shortcut.

**Nothing else lives in this band.** Endpoint and model selection live in the composer chip
(§Model chip). "Add endpoint" is a row inside the model-chip popover, not a toolbar button.
All buttons in the band carry `-webkit-app-region: no-drag`; the rest of the band drags.
Double-click on the band triggers the OS zoom (free with a real drag region).

The conversation **surface** extends to the window's top edge behind the band, but the
transcript **content** is inset: `padding-top: var(--titlebar-height)` on the scroller's
content plus `scroll-padding-top: var(--titlebar-height)` — message text never sits under
the band's controls, and the surface itself is never inset.

## Sidebar

Reference captures: `.agent/attachments/20260903-164122_01a068.png` (panel anatomy) and the
2026-09-03 19:xx captures (docked behavior: content sits BESIDE the open sidebar). The
sidebar is a **docked column** when open: flush to the window's left edge, full height
under the titlebar band, opaque radial fill `--surface-navigation-background`, without backdrop blur or a
right-hand border — no inset, no radius, no shadow while docked. **The
conversation lays out to the panel's right and reflows when the panel opens or closes** —
content never sits hidden behind the open sidebar (the reference shows the chat column
fitting to the right). Closed means absent. Default width 260px, user-resizable within the
`ipc-contract` clamp. Toggle: ⌘B and the titlebar button (the panel slides in beneath the
fixed titlebar controls, so the toggle never moves). Open state is remembered.

**Reveal animation — exactly two effects on the panel, always together:**

- **Open:** `opacity 0→1` **and** `transform: translateX(-16px→0)`, both `--motion-slow`
  (200ms), `--ease-out`, same start, same end. Never one effect without the other; never a
  full off-screen travel.
- **Close:** the reverse — `opacity 1→0` + `translateX(0→-16px)`, `--motion-slow`,
  `--ease-in`.
- The panel's width never animates. The conversation column's offset animates **in sync**
  with the panel (its `margin-left`/grid inset transitions over the same 200ms and easing)
  — this is the one sanctioned layout transition in the app, because the reference animates
  the content shift; everything else keeps the transform+opacity-only rule.

Structure, top to bottom:

1. **Header row** (`--titlebar-height`, drag region): the native traffic lights render over
   the panel's 80px gutter; the sidebar toggle (`PanelLeft`, `--control-md` ghost) sits
   right after the gutter.
2. **App row** (padding 4px 16px 8px): app label 15px semibold `--color-text-primary` on the
   left; on the right, one `--control-md` ghost icon: `Search`, which must reveal AND focus
   the conversation-search input row — a Search icon that does nothing is a defect. No
   `Bell` until a notifications feature exists: **no control ships without its behavior** —
   placeholder affordances are forbidden app-wide (this supersedes every earlier "disabled
   but rendered" note; the composer's Plus and Mic are the only sanctioned exceptions,
   disabled with honest tooltips, until their features land).
3. **Static actions** — icon rows, 13px medium text, 16px icon, `--control-md`-tall,
   padding 8px 12px, radius `--r-8`, states per §List rows: "New chat" (`SquarePen`) — plus
   future static entries in this same anatomy, nothing else improvised.
4. **Section: Projects** — 12px `--color-text-tertiary` section label (padding
   16px 12px 4px, no uppercase — matches the reference "Projects"), then project groups:
   - **Project row:** `Folder` icon 16px + name, 14px `--color-text-primary`, single line,
     ellipsis. Clicking folds/unfolds the group.
   - **Chat rows** under a project: indented to align with the project name's text (no
     icon), one line each — the conversation title (or, untitled, its first user-message
     text), 14px `--color-text-secondary`, ellipsis. Selected row per §List rows.
   - **Empty project:** one row "No chats", 14px `--color-text-tertiary`, non-interactive.
   - **Show more:** a project shows at most 5 chat rows, then a "Show more" row (14px,
     `--color-text-tertiary`, hover secondary). Expanding reveals the rest in place: new
     rows fade in (`opacity 0→1`, `--motion-base`, `--ease-out`); never animate `height`.
   - Conversations in no project sit in an identical group titled "Conversations".
5. **Scrollbar:** the list scrolls under a slim overlay scrollbar whose thumb is visible
   only while the pointer is over the panel and content overflows; no reserved gutter.
6. **Pinned footer** (48px row on the panel material, no card, spacing-separated): a 24px
   round avatar with the user's initials (11px, 600, `--color-surface-active` fill,
   `--r-pill`), display name 13px medium ellipsized, then trailing: a "Voice" affordance
   (`AudioLines` icon 16px + 13px label, ghost; may be disabled — still rendered) and a
   `Settings` ghost icon (`--control-md`).

**Collapsed state:** no rail — the panel is simply absent (closed); the titlebar toggle and
⌘B bring it back with the two-effect reveal.

**Dismissal:** the docked panel stays open across conversation switches (the reference
does not close on select). ⌘B / the titlebar toggle close it; the conversation column
animates back to full width in sync with the exit.

## Chat transcript

The conversation column has a maximum reading width of 720px, centered.

- **Date separator:** a centered line above the first message of each day — "Today 19:02" /
  "Yesterday" / "Jan 12" plus the first message's time, 12px `--color-text-tertiary`,
  padding 16px 0 8px, no rule lines, non-interactive.
- **User messages:** right-aligned bubbles. Fill `--color-surface-hover`, radius `--r-18`,
  padding 8px 14px, max-width 68% of the column, 15px/22px text. No border, no shadow.
- **Assistant messages:** plain left-aligned text on the content material — no bubble, no
  card. 15px/22px. Markdown per §Markdown.
- **User-message hover controls** (reference capture 20260904-075601): a row of
  `--control-sm` ghost icons under the user bubble, right-aligned, revealed on message
  hover (opacity, `--motion-fast`, space reserved): `Copy`, share/export (`Share`), and
  `Pencil` edit (opens the existing inline editor). Same anatomy as the assistant row.
- **Conversation row menu** (reference capture 20260904-075651): each sidebar chat row
  gets a `⋯` trigger on hover (and right-click context menu) opening a §Menus popover with
  ONLY the actions that exist: "Rename" (inline title edit), "Export as Markdown", and
  "Delete…" (destructive style, confirm per §Buttons). More entries (Pin, Archive,
  Projects) appear only when their features land — no placeholder rows.
- **Message action row** (assistant messages): a row of `--control-sm` ghost icon buttons
  directly under the message, 16px icons, `--color-text-tertiary`, gap 4px: `Copy`,
  `RefreshCw` (regenerate). On the **last** assistant message the row is always visible; on
  older messages it appears on message hover (`opacity 0→1`, `--motion-fast`,
  `--ease-out`). Space for the row is always reserved (opacity, not display) so hover never
  shifts layout. Every icon has a tooltip.
- Speakers are distinguished by structure only — never by bright colors.

**Click-in-chat (exact behavior):** a `pointerdown` on transcript whitespace or the empty
state — i.e. not on a message's text, a link, a button, or an active text selection —
focuses the composer textarea and places the caret at the end of the draft. Additionally, a
printable keypress while nothing editable is focused routes the character into the composer
and focuses it. Focusing this way shows the caret only — it must **not** trigger the
keyboard `:focus-visible` ring.

## Composer

The exact target is `.agent/attachments/20260903-163352_01a068.png`. The composer is docked
at the bottom of the conversation column at all times — including the empty state — aligned
to the column (max-width 720px, centered), margin 12px auto 16px.

**Surface:** fill `--color-surface`, radius `--r-24`, **no border, no shadow** (tonal lift
only). Padding 14px 16px 12px. Mouse focus shows no ring on the surface — the caret is the
focus indicator. Keyboard focus (`:focus-visible` reaching the field via Tab) shows the
standard ring on the surface.

**Two rows:**

1. **Field row:** the autosizing textarea. 15px/22px, transparent, borderless, placeholder
   "Ask anything" in `--color-text-tertiary`. Grows 1→8 rows, then scrolls internally.
2. **Controls row** — height `--control-lg` (32px), margin-top 8px, single row, never wraps:
   - **Leading (left edge):** attach — `Plus` icon 18px in a `--control-md` ghost button,
     `--color-text-tertiary`, hover `--color-surface-hover`. Tooltip "Add files". (May be
     disabled until attachments ship; still rendered.)
   - **Trailing group (right edge, gap 12px, in order):**
     1. **Model chip** (§Model chip).
     2. **Mic** — `Mic` icon 18px, `--control-md` ghost, tertiary. Tooltip "Voice input".
        (May be disabled; still rendered.)
     3. **Send/Stop** — a `--control-lg` (32px) **circle** (`--r-pill`), **inverse
        monochrome**: fill `--color-text-primary`, icon `--color-bg` (`ArrowUp` 16px).
        States:
        - hover: fill `color-mix(in srgb, var(--color-text-primary) 85%, var(--color-bg))`
        - active: `…75%…`
        - disabled (empty field): fill `--color-surface-active`, icon
          `--color-text-disabled`, cursor default
        - streaming: same circle, icon swaps to `Square` 14px (Stop); the swap is a 120ms
          cross-fade (`--motion-fast`, `--ease-out`), the circle itself never moves or
          resizes
        - starting/stopping: icon swaps to the standard spinner, same rules

**Behavior (all existing behavior is normative and kept):** Enter sends, Shift+Enter
newlines, IME-safe; per-conversation draft persistence; ArrowUp/ArrowDown/Escape prompt
history with the quiet 12px history hint above the surface; the T110 page-quote card stacks
above the field row inside the surface. The controls row keeps its footprint during every
state change — nothing shifts while generating.

## Model chip

The single model/endpoint control in the app. Lives in the composer controls row.

- **Trigger:** a ghost pill (`--r-pill`, `--control-md` tall, padding 0 10px): model display
  label, 14px `--color-text-secondary`, + `ChevronDown` 14px. No border, no fill at rest;
  hover `--color-surface-hover`. The label is the model's short name — its `displayName`
  when present, otherwise the final path segment of the model id (e.g.
  "minimax/minimax-m3:free" → "minimax-m3:free"); the full mono id lives in `title`/aria
  and the popover. With no endpoint: label "No model", opens the popover.
- **Popover** (floating, `--r-10`, `--shadow-sm`, 1px border, opens **upward** above the
  chip, §Motion "Popover"): its search field is **borderless** — no box, no fill, no
  outline in any state; placeholder + caret on the popover surface with only a hairline
  `--color-border` divider below it (this is the rule for every text field inside a
  popover or menu). Otherwise the existing searchable model list unchanged (search field,
  "N of M models" count, keyboard nav, mono ids with `title`), grouped by endpoint with the
  endpoint name + verified state (`CircleCheck` accent / "unverified" 11px tag) as 11px
  uppercase group headers. Selecting another endpoint keeps the popover OPEN: the group
  header updates in place, the neutral "Loading models…" line shows while its models load
  (§Loading), focus stays in the search input and the query clears; the popover closes only
  on model choice, Escape, or outside click. Footer row: "Add endpoint…" (opens the
  endpoint dialog). This
  replaces the old toolbar EndpointSelector + ModelSelector pair entirely — the model-ish
  label appears exactly once on screen.
- Never label an endpoint Connected/Ready/Available unless verified (FR-003); neutral text
  while verification runs.

## Browser pane chrome

The host UI of the browser split (reference: the 2026-09-03 23:35 dark captures — tab
strip, nav row, address pill, overflow menu). It must read as native browser chrome, not a
web page:

- **Tab strip** (36px, on the pane's chrome material): each tab is a soft shape — active
  tab `--color-surface` fill, radius `--r-8`, favicon 14px + 13px title ellipsized + a ×
  close glyph visible on hover/active; inactive tabs transparent with `--color-surface-hover`
  on hover; a `Plus` ghost after the tabs. Right cluster: expand and panel-close ghost
  icons (`--control-md`). **No separate "Browser" label row — delete it**; the tab strip
  IS the header.
- **Nav row** (44px): back / forward / reload-or-stop ghosts (18px icons, disabled states
  real); then the **address pill** — `--r-pill`, `--color-surface-hover` fill, borderless,
  no outline in any state (§Focus), 13px, URL centered while unfocused and editable
  plain-left on focus (caret only), the T109 lock/warning indicator leading, an
  open-in-system-browser `↗` trailing; then the pane's product actions as ghosts: send
  page to chat (T110), screenshot to chat (T111), and a `⋮` overflow menu.
- **Overflow menu** (per §Menus, grouped with hairline separators): Find in page (when
  implemented), a Zoom row (− 100% +) when implemented, Send page to chat, Take a
  screenshot, Open in system browser, and the devtools toggle when the developer setting
  is on. Never expose actions that do not exist yet.
- **Omnibox dropdown** (reference: Chrome's omnibox, 2026-09-03 23:3x capture): focusing
  the address pill opens a floating suggestion panel (per §Menus: `--menu-radius`, `--menu-shadow`,
  opens downward) listing recent history entries — a history glyph 16px + the query/title
  in Inter, fade-truncated — with keyboard navigation, and an **"Agent control" soft pill chip**
  pinned at the panel's top-right (`--r-pill`, `--color-accent-subtle` fill, accent text,
  sparkle glyph). Enter navigates; choosing AI Mode routes the query to the agent instead
  of the URL bar.
- **AI Mode — agent-driven pages** (product direction, not decoration): with AI Mode
  active, the query goes to the active local model armed with the pane's browsing tools
  (navigate, read page, act on it); the agent's steps surface in the chat as it drives the
  page. The browser exists to be the model's controlled surface — every AI-Mode affordance
  must make that legible (who is driving, what it just did, how to stop it).
- Empty state per §Empty states ("Start browsing" + one-line hint), pills/buttons/accents
  all from the token system — nothing default-web styled.

## Status bar

The StatusBar (health dot, latency, model, tok/s — `src/renderer/layout/StatusBar.tsx`) is
**mounted** under the composer: a 24px-tall centered line, 11px mono, `--color-text-tertiary`,
transparent background, no border. Readout changes cross-fade (`--motion-fast`). It is the
only always-on runtime status surface; all values derive from real state.

## State pills

A **state pill** tags one object with one fact about that object: "Key stored", "No key
stored", "unverified", "no key". It is a label, not a control — never clickable, never an
icon alone.

- **Anatomy:** `--r-pill`, 11px (`--fs-11`), weight `--fw-medium`, horizontal padding
  `--sp-8`, no border, no shadow, no icon. Height follows the line it sits on: 20px
  (`calc(var(--sp-16) + var(--sp-4))`) on a form label row, 16px (`var(--sp-16)`) inline in a
  dense list row. One shape for every state; tone is a modifier on it (`.es-badge` with
  `.es-badge-on` / `.es-badge-off`), never a second shape.
- **Placement:** on the label row of the field it describes, or in the main line of the row it
  describes. A pill never floats away from its subject.

Tones — three, and each one claims something different:

| Fill / text                                        | Claims                                                    |
| -------------------------------------------------- | --------------------------------------------------------- |
| `--color-success-subtle` / `--color-success`       | Confirmed by something real: a stored key, a passed probe |
| `--color-surface-active` / `--color-text-tertiary` | A plain fact, with no verdict attached                    |
| `--color-error-subtle` / `--color-error`           | Broken, and this component knows it                       |

Rules:

- **The pill carries the word; tone only reinforces it.** "Key stored" and "No key stored"
  must read as different sentences with the colour stripped out (§Color roles).
- **Absence is not a statement.** A missing pill can only mean "nothing to say", so it may
  only ever mean that. Any state fetched over IPC, from the keychain, or from the network has
  **three** values, not two — known true, known false, and not answered yet, which includes
  the check having failed. Draw a pill for the first two; draw nothing for the third.
  Collapsing "no" into "not yet" leaves the user an empty surface to interpret, and they read
  emptiness as loss: an API key field that is blank in every state, with nothing beside it,
  reads as "my key is gone" — and the user goes and adds the endpoint a second time.
- **Never assert a negative you did not hear.** A failed check stays in the not-answered state
  and renders nothing. It must never fall through to the "no" pill: telling someone a stored
  credential is gone when the lookup merely failed is worse than saying nothing.
- **Draw both sides of a pair.** If a fact deserves a pill when true, it deserves one when
  false. Otherwise the true state is once again distinguished only by absence.
- **Do not colour a state you cannot judge.** Error and warning tones are for conditions this
  component knows are wrong. "No key stored" is neutral: a local server needs no key, and the
  pill cannot know whether this endpoint's server wants one. `--color-warning-subtle` is for a
  condition that is wrong wherever it appears (plain HTTP, a bad certificate), not for a fact
  that merely looks alarming.
- **A tag that is always lit informs no one.** In a list, a state pill earns its place only
  where it tells rows apart. If every row would carry it, drop it.

## Choosing a primitive

Reach for the right one before styling one to behave like another. The focus semantics
differ, and a component styled against its own semantics misleads whoever reads it next.

| You want…                                         | Reach for                     | Not                          |
| ------------------------------------------------- | ----------------------------- | ---------------------------- |
| A name for an icon-only control                   | `Tooltip`                     | a `title` attribute          |
| A click-revealed list of actions                  | `Menu` inside `Popover`       | a hand-rolled list           |
| Right-click actions on page content               | native `Menu.popup()` in main | a DOM menu over the pane     |
| A click-revealed surface holding a form or picker | `Popover`                     | `Dialog` (it traps and dims) |
| A decision the user must make before continuing   | `Dialog`                      | `Popover`                    |
| A surface that must outlive a route change        | a docked pane                 | `Dialog`                     |
| One choice from a known short list                | `Menu`                        | a custom listbox             |
| Transient confirmation ("Saved conversation.md")  | toast                         | `Dialog`, inline banner      |
| Persistent status the user must act on            | inline error card             | toast (toasts leave)         |

Anything that must paint over the browser pane is not a DOM question — see §Window chrome
for the native-view rule and the overlay lock.

## Menus, popovers, dialogs

- **Shared dropdown anatomy:** `--menu-fill`, 12px `--menu-radius`, 1px `--menu-edge`,
  and one `--menu-shadow`. A hosting `Popover` must not double the edge/shadow.
  Align to the trigger, 4px offset, clamp within the viewport; scroll long menus.
- **Rows:** 32px minimum height (`--menu-row-height`), 6px shell inset
  (`--menu-padding`), 12px horizontal row padding, 8px icon/label gap. Inter 14px
  regular, 16px icons. Highlight uses `--menu-hover` and 8px `--menu-row-radius`;
  pressed uses `--menu-active`. No per-row outlines or blue selection fill.
- **Groups:** use `MenuItemDef.separatorBefore` on the first item of each new
  action group. One full-width `--menu-separator` hairline, 6px space above/below.
  No leading/trailing rule. Separators are noninteractive `role="separator"`;
  keyboard navigation skips them and disabled items.
- **Focus:** one roving active row; pointer movement updates that same row.
  Arrow keys, Home/End and Escape remain supported. Keep the visible keyboard
  focus indicator; pointer clicks should not leave a keyboard ring on every row.
- **Destructive entry:** the menu's Delete label/icon stays neutral at rest,
  isolated in its final group. The existing confirmation retains an explicit red
  destructive action. Never remove confirmation as part of styling.
- **Model picker:** same menu surface, typography, row radius and neutral selected
  fill; retains its search, grouping, metadata and keyboard behavior.
- Dialogs (endpoint settings): `--r-12`, `--shadow-sm`, dimmed backdrop, focus-trapped, Esc
  closes. Default focus lands on the field the user most likely edits; Enter submits.
- Tooltips: name icon-only controls; 400ms delay; side top, offset 4; never contain critical
  errors; shortcut text appended after the label, never baked in as a literal — build it with
  `shortcutLabel` / `withShortcut` from `ui/shortcut.ts`, which renders `⌘⇧B` on macOS and
  `Ctrl+Shift+B` elsewhere. A label naming a key that platform does not bind is worse than no
  label at all.
- A tooltip names a control; it does not teach, persuade or warn. Anything the user must read
  while acting belongs in the visible UI. Never tooltip a control that already has a label.
- Cancel/Dismiss/Close are quiet ghost buttons — never destructive-colored, never decorated.

## Errors, toasts, empty states

- **Inline errors** (stream failure banner): content-width card (not full column), 1px
  `--color-error` border, `--color-error-subtle` fill, `--r-8`. Copy: a mapped human line
  ("The endpoint rejected the request.") first; the raw upstream message demoted to a 12px
  mono secondary line. Actions: Retry + Edit endpoint (secondary buttons) + a "Switch
  model…" action that opens the model-chip popover — never a second embedded selector.
  Persistent until resolved or dismissed.
- **Toasts:** transient events only ("Saved conversation.md"), 2.5s, fade per §Motion.
- **Empty state** (no active conversation, or an active conversation with zero messages —
  both render identically): the composer stays docked. Above it, vertically
  centered in the remaining space: "Hello." — or "Hello, {firstName}." when a display name
  exists in settings — 24px semibold, one line, nothing else except the existing quiet
  endpoint-status line (dot + 12px text) 12px below it. No wordmark block, no lede, no
  card. Every empty state's primary next action must be reachable (here: the composer and
  the model chip).

## Markdown, code, streaming, scrolling

- Markdown integrates with app typography: paragraphs, headings (≤16px), lists, blockquotes,
  tables, links (accent), inline code and code blocks (mono), consistent vertical rhythm.
- Code blocks: mono, syntax highlighting via the bundled **Shiki** (already a dependency)
  with theme-aware light/dark tokens, covering at minimum bash/shell/zsh, json, yaml,
  ts/js/tsx, python, html/css, sql, and diff — an unknown language renders plain mono with
  its language label, never unstyled-with-no-label. Internal horizontal scroll, copy action
  with a `--motion-fast` cross-fade to the "copied" state. Never overflow the column.
- Streaming: token output is the progress indicator. No flashing, no full-message redraws,
  no layout jumps, no per-character animation effects.
- Auto-scroll only while the user is near the bottom; an upward scroll suspends it; a "jump
  to latest" chip (pill, floating level) fades in per §Motion.

## Motion

The new panel/tab choreography in [LOOK.md](design/LOOK.md#motion-candidate--test-before-approval)
is a **candidate for user testing**, not yet an app-wide mandate. Its immediate
reduced-motion behavior overrides the legacy opacity-fade allowance for that
study. The catalog below retains existing component behavior; do not add new
motion to static clouds, rims or surfaces while applying the approved look.

Motion is first-class: every reveal, dismissal, menu, popover, sidebar slide, panel toggle,
and dialog **must** animate — no instantaneous state flips. All motion uses exactly these
tokens (`motion.css`):

- `--motion-fast: 120ms` · `--motion-base: 160ms` · `--motion-slow: 200ms`
- Enter: `--ease-out: cubic-bezier(0.32, 0.72, 0, 1)` · Exit: `--ease-in: cubic-bezier(0.4, 0, 1, 1)`

**Only `transform` and `opacity` animate for reveal/hide** (plus `background-color`/`color`
for control state). Never animate `width`, `height`, `top`, `left`, `margin`, or `padding`.

The complete animation catalog — implement these and only these:

| Surface / event                         | Properties                            | Duration        | Easing in/out |
| --------------------------------------- | ------------------------------------- | --------------- | ------------- |
| Control hover/active/focus              | background-color, color               | `--motion-fast` | `--ease-out`  |
| Sidebar open/close (2 effects together) | opacity 0↔1 **+** translateX(-16px↔0) | `--motion-slow` | out / in      |
| Project fold/unfold, Show-more rows     | opacity 0→1                           | `--motion-base` | `--ease-out`  |
| Popover / menu open                     | opacity 0→1 + translateY(-4px→0)\*    | `--motion-base` | `--ease-out`  |
| Popover / menu close                    | opacity 1→0 + translateY(0→-4px)\*    | `--motion-fast` | `--ease-in`   |
| Dialog present/dismiss                  | opacity + translateY(8px→0)           | `--motion-slow` | out / in      |
| Tooltip show/hide                       | opacity                               | `--motion-fast` | out / in      |
| Message append                          | opacity + translateY(4px→0)           | `--motion-base` | `--ease-out`  |
| Message action row hover                | opacity                               | `--motion-fast` | out / in      |
| Send↔Stop↔spinner icon swap             | opacity cross-fade, fixed footprint   | `--motion-fast` | `--ease-out`  |
| Status-bar readout change               | opacity cross-fade                    | `--motion-fast` | out / in      |
| Toast in/out                            | opacity + translateY(4px→0)           | `--motion-base` | out / in      |
| Jump-to-latest chip                     | opacity + translateY(4px→0)           | `--motion-fast` | out / in      |
| Empty-state greeting mount              | opacity + translateY(4px→0)           | `--motion-slow` | `--ease-out`  |

\* Popovers opening **upward** (the model chip) translate from +4px→0 instead. Menus never
scale from 0.

**Reduced motion** (`prefers-reduced-motion`): durations drop to 0ms and transform reveals
are skipped, but opacity fades stay at ≤80ms so state changes remain visible. The spinner
slows (`--dur-spin-reduced`) instead of freezing.

Motion communicates state transitions, never attention, and never compensates for missing
hierarchy.

## Focus & keyboard

- **Pointer interaction NEVER draws an outline.** Clicking any control, row, input,
  textarea, or select shows no ring, no border flash, no box-shadow — text fields indicate
  focus with the caret alone (see the reference composer). Chromium matches
  `:focus-visible` on text fields even for mouse clicks, so text inputs/textareas must
  explicitly suppress the outline and rely on the caret; the EndpointSettings inputs' fat
  blue click-ring is the canonical defect.
- The one focus ring — `outline: 2px solid var(--color-focus-ring); outline-offset: 2px` —
  appears ONLY for keyboard (Tab) navigation on non-text controls. **No component may
  override it with a weaker treatment** — the low-contrast `--color-accent-subtle` shadow
  variants are forbidden.
- Shortcuts (labels must match the real binding; ⌘ on macOS, Ctrl elsewhere):
  ⌘B sidebar · ⌘⇧B browser panel · Enter send · Shift+Enter newline · ↑/↓/Esc prompt
  history · Esc closes popovers/dialogs.
- Dialogs and popovers land default focus on the most likely control; Enter triggers the
  primary action from there.
- Icon-only controls always carry an accessible label and a tooltip.

## UX rules

1. **Feedback matches perceived duration.** 0–100ms: nothing. 100ms–1s: disabled state only.
   1–3s: disabled + spinner or label swap. 3s+: stage labels ("Checking endpoint…",
   "Loading models…", "Waiting for model…"). Never an indefinite spinner when a specific
   state exists. Pre-reserve any space a state change will occupy (fixed `width`, not
   `min-width`) — a control that resizes mid-action looks broken. When the same action is
   fast locally and slow remotely — a model on this machine versus one behind an API — bind
   the **disabled** state immediately so a double-click cannot double-submit, and defer the
   **visible** state by ~200ms. Local users then see nothing at all; remote users still get
   the feedback.
2. **Copy must not overclaim.** Neutral process language while pending; result verbs
   ("verified", "saved", "deleted") only for actual results. Errors say what failed and what
   to do next. No "please", "simply", "just".
3. **Don't overload the back-out path.** Cancel/Dismiss/Close stay quiet; visual weight
   belongs to the affirmative action.
4. **Siblings read as one design.** Adjacent components (the two selectors' popovers, the
   composer's icon buttons) share icons, sizes, and semantics. Diverging needs a reason.
5. **Progressive disclosure.** High-frequency actions visible (send, model chip, new chat);
   low-frequency ones in menus (add endpoint, export). Advanced settings never sit in the
   conversation flow.

## Cross-platform & desktop behavior

- macOS: traffic lights native; 80px left gutter in the top band with no hit targets.
  Other platforms: equivalent frameless setup, same band, no gutter.
- Never hardcode `metaKey`; detect platform and bind + label accordingly.
- Minimum window 640×480; no horizontal scrolling of the main layout; wide content (code,
  tables) scrolls internally. High-DPI clean, reliable selection/copy/paste, external links
  open in the system browser.

## Visual QA

Validate every UI change in: first launch · no endpoint · endpoint discovered · endpoint
error · one model · many models · empty conversation · active conversation · generating ·
stopped generation · long Markdown · long code · narrow window · wide window · settings open
· dropdown open · keyboard focus.

Check for: clipping, overflow, spacing drift, misalignment, contrast, unstable resizing,
inconsistent icon sizes, wrong hover/disabled states, scroll misbehavior. Fix visible
defects before considering UI work complete.

**Priority when requirements conflict:** usability → readability → consistency →
accessibility → information hierarchy → visual polish.

## When this guide is silent

1. Read `design/LOOK.md` first. Then use the closest sibling component only if
   it follows that approved appearance; legacy styling is not a new precedent.
2. Check `src/renderer/ui/` for a primitive that already encodes the pattern.
3. For a token question, `tokens.css`/`motion.css`/`typography.css` are canonical — use what
   exists, or add a pair (light + dark) there first.
4. If none of those resolve it, **ask before inventing**. Then add the answer to this file so
   the next person doesn't have to ask.
