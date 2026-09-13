# Chat activity refinement

> **Superseded where it conflicts.** The rules the timeline is held to now live
> in `CHAT-ACTIVITY-RULES.md`, read off the reference the user approved on
> 2026-09-11. This document is the history of how the timeline got here and is
> still worth reading for the reasoning; where the two disagree, the rules win.
> In particular: the "one 1px rail" below is gone — R2 forbids it.

Approved direction: keep Hello.'s materials and type; make the answer the primary
content and the activity a compact, inspectable timeline. No new library or shell
changes. This is the implementation plan for the user's approved proposal.

## Existing tokens, reused

- Panel `#171819`, raised content `#212225`, rail `#2c2e32`.
- Answer ink `#e5e5e7`, activity ink `#b1b3bb`, secondary detail `#92959e`.
- Inter: existing 15px answer text, 12px activity rows, 13px expanded details.
- Existing semantic error/approval colors and keyboard focus treatment; use role
  tokens so light mode follows the same hierarchy.
- 28px disclosure targets, 4px row gaps, one 1px rail, 16px before the answer.

## Layout

One activity group per answer includes the original commentary, thinking and
tools up to the last activity part, in their original order. Trailing answer text
stays outside. A thinking-only answer keeps its single direct disclosure.

```text
v Research   1 search · 2 pages read
|  > Thought briefly
|  > Searched web   vremea București…
|  > Read idevice.ro
|  > Read infocons.ro

Final answer…
```

Activity stays open while running. Its viewport grows
only up to ten compact rows (10 × 28px + 9 × 4px = 316px), then scrolls internally.
Tool/thinking row details open on click, not automatically as reasoning streams.
At completion the group rolls up smoothly, unless explicitly opened by the user.
Reasoning/details never expand or collapse just because streaming changes. Errors, unfinished
work and approvals remain explicit in the summary; approvals retain their actions.
Each tool keeps status, exact supplied duration, input, output and approval
actions in its details. Never count a search snippet as a read source.

## Brief review

The change is intentionally in density and information order, not a new theme.
Use one rail, not nested cards or repeated headings. Preserve source menus, local
file links, message actions and full provider text. User-message actions move
into the existing gap, keeping keyboard/hover access without an extra hidden row.
Only the latest meaningful thinking part can be active; a later tool ends that
phase. Explicit disclosure choices survive streaming and regrouping.

The 21:00 revision addresses the user's observed transcript jump: replace the
unbounded growing/collapsing timeline with this single bounded viewport, using
the same palette/type/rail above. No nested card or animation. Align all steps
left; preserve the complete timeline behind internal scrolling. Follow incoming
steps only while the reader is at the bottom, and stop following when they scroll
up or inspect a disclosure. Never scroll the outer transcript from this region.
This keeps the distinctive compact Hello. activity treatment without a new shell.
The user's follow-up retains automatic completion collapse, with a roll-up using
the existing motion duration/easing and reduced-motion override instead of abrupt
removal. The outer transcript follows the animated height only while pinned below.

Chat selection uses the existing context-menu material and focus behavior: Copy
selection, Copy message as rendered text, Copy message as original Markdown, and
Attach selection as context. Snapshot the selection before menu focus changes it.
Use the existing native clipboard bridge; attach only a quoted draft, never send.

Verification follows the user-led dev workflow: static type checking only; no
build, test execution, model calls or dev restart. Regression cases may be added
for later execution. Visual inspection can read the existing dev UI without
starting a conversation or changing app data.

## Implementation review

Implemented in the renderer. Non-emitting TypeScript checking passed. Passive
inspection of the running Hello. dev app confirmed one Research summary with
actual search/read counts, collapsed completed activity, the retained Sources
menu and “Thought briefly” for a short completed reasoning part. The current
window screenshot shows the compact activity row and a distinct visible error
message without changing the surrounding pane chrome or materials.

Regression cases for grouping, counts, supplied durations, active-thinking
transitions and manual expansion are authored, not run. No build, automated
test, model call or app restart was performed. Full interaction and narrow/light
layout checks remain with the user's dev testing workflow.

The subsequent 21:00–21:02 refinement implements the ten-row scrolling viewport,
manual-only reasoning/tool reveals, smooth automatic group roll-up and chat
selection context menu described above. Static type checks pass; updated
renderer regression cases are authored but not executed. Passive dev inspection
confirms the renderer remains present with completed activity groups; animation,
clipboard integration and narrow/light interaction checks remain user-led.
