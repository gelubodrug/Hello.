# Chat timeline — rules

These are rules, not a plan. They were read off a transcript the user approved as
the target on 2026-09-11, next to Hello.'s own, which the user rejected in the
same breath: *"arată ca un app de pe internet, nu ca un app osx nativ."* Anything
in `CHAT-ACTIVITY.md` that contradicts a rule here is superseded — that document
is the history of how we got here, this one is what we hold to.

Read this before touching the timeline. A change that breaks a rule is a
regression even when someone asked for it in the moment; say so and propose the
change to the rule instead.

## What the timeline is

An account of what happened, written the way a person would say it, between the
question and the answer. It is not a log, not a table, and not a component with
a frame around it. The reader should be able to skim it without stopping, and
stop on any line to see more.

## R1 — One tier

Every step is a row of the same height, type size, weight and ink. A thought, a
tool and a remark are the same kind of thing here, so they are set the same way.

The failure this rule exists for: commentary rendered at full height beside
one-line rows, so a printed file occupied as much space as twenty steps. If a
step cannot be said in a row, it folds to a row and opens on click.

## R2 — No rail

The list is set off by whitespace alone. No left border, no card, no nested
surface, no second background. Indentation is the only thing that says "this
belongs to that".

## R3 — Human names

A step is named for what happened, in sentence case, as a person would say it:
*Thought 2s*, *Explored 1 search*, *Read example.com*, *Created visual*. In
progress it is the plain verb — *Create visual*, *Search web* — and finished it
is the past tense.

A raw tool identifier is never shown. `skill_load` is not a name; *Read skill*
is. Every tool Hello can call needs both forms before it ships, and a tool with
no human name is a bug, not a default.

## R4 — Counts follow the label

Durations and counts sit immediately after the label, in muted ink, at the same
size: *Explored 1 search*, *Thought 2s*. They never become a right-hand column,
because a column turns an account into a table.

The one exception is state that needs the reader — *Failed*, *Needs approval*,
*Running* — which may sit at the end of the summary row and carries its colour.

## R5 — Repeats merge

Consecutive identical steps are one row carrying a count. Three `skill_load`
calls are *Read 3 skills*, not three rows. Opening the merged row shows each
call in turn.

What counts as identical: the same tool, one immediately after another, with
nothing between them.

## R6 — One chevron

One chevron size in the whole timeline (14px), one rotation rule, aligned to its
label. A row that cannot be opened has no chevron and no space reserved for one.

## R7 — Two inks

Muted for the timeline, primary for the answer. Inside the list there is no
third ink: a step's detail, its count and its label are the same weight of grey,
and emphasis comes from position, not from a new colour. Error and approval
colours are states, not inks, and appear only on the row they describe.

## R8 — One scroll

The transcript scrolls. The timeline does not introduce a scrollbar of its own;
neither does a group inside it. A code block is the only thing allowed its own
box and its own overflow, because a file is not prose.

## R9 — The tail

While a reply is still arriving, the summary stays folded and only the work in
hand shows beneath it: the last group of steps, and the group before it when it
is a different kind of work. At most four rows. Opening the summary replaces the
tail with the whole run — one list at a time, never both.

Anything that needs the reader — a failure, an approval — opens the whole list
by itself and stays open.

## R10 — Explicit choices survive

A disclosure the reader opened or closed stays that way through streaming,
regrouping and completion. Nothing opens or closes because tokens arrived.

## Type and ink, concretely

| | |
|---|---|
| Step row | 12px, muted ink, 28px target |
| Step detail, once opened | 12px, muted ink — the row's own size |
| Answer | 15px, primary ink |
| Chevron | 14px, muted ink |
| Row gap | 4px |
| Gap before the answer | 16px |

These sizes come from the existing tokens; use the tokens, not the numbers.

## R11 — Its own work, and only its own

A document the model generated opens with Agent control at Full, so it can look
at what it made. Nothing else does. The grant is attached to the document: the
moment that tab shows anything else — navigated by the model, by the reader, or
by the page sending itself away — it is Off again.

The reasoning, so it is not re-litigated every evening: reading back a page the
model itself wrote, served from an isolated local session with no cookies and
nothing signed in, reveals nothing it did not already know. Not being able to
look at it is how a page ships unchecked.

## Where the rules live in code

- Naming and merging: `src/renderer/chat/activity.ts` — `NAMES`, `stepLabel`,
  `activityRows`, `liveTail`. One table; a tool with no entry never shows its
  identifier.
- The rows: `ThinkingPart`, `ToolPart`, `MergedStep`, `ActivityNote` in
  `ConversationView.tsx`; the group in `WebResearch.tsx`.
- The type and the absence of rails: `app.css`, `.disclosure-button` and the
  `.activity-*` rules.

Two tests hold the rules that are easy to break by accident: every tool name
declared in `src/main/chat/tools.ts` must have a human name, and no label may
look like an identifier. Add a tool, add its words.
