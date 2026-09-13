# What opencode actually does, read from its source

Research note. It exists because two claims made in this project turned out to
be wrong, and both were made confidently.

**Read at:** `github.com/anomalyco/opencode`, commit `95daf90` (2026-09-11),
cross-checked against the compiled binary the user actually ran, Homebrew
`opencode 1.18.30`. Where the two agree I say so; where I only had the binary I
say that too. The repo has two engines — a shipping v1 in `packages/opencode/`
and an unfinished v2 in `packages/core/src/session/runner/`. Everything below
describes **v1**, which is what the HTTP API is wired to.

Nothing was executed. This is a reading of the call graph, not a captured trace.

## Why this was written

A local model died mid-task in Hello. while the same model, same day, finished
the same task in opencode. Two explanations were offered here, in order, and
both were wrong:

1. *"Instructions in a system prompt do not move a model; only a harness stage
   does."* — Wrong. opencode has **no** harness stage that forces planning. Its
   planning is entirely prompt-driven, and it worked.
2. *"Then opencode must have some heavier machinery we are missing."* — Also
   wrong. It has **less** machinery than Hello. in several places that matter.

What follows is what is actually there, split by the only distinction that
matters when copying someone else's design: **enforced by code**, or **asked of
the model in text**.

## The plan / todo mechanism — all text

- `todowrite` is one tool over one SQLite table
  (`packages/opencode/src/session/todo.ts:33`). Every write deletes all rows for
  the session and reinserts the array. No per-item id, no merge, no history.
- The tool result handed back is `JSON.stringify(params.todos)` — an echo of
  what the model just sent (`packages/opencode/src/tool/todo.ts:38`).
- **The list is never re-injected between turns.** Its only reader is the HTTP
  handler that draws the UI dock
  (`.../httpapi/handlers/session.ts:94`). No reminder, no synthetic
  message, no system-prompt section carries todo state forward.
- **Nothing requires a plan.** The single `toolChoice` override in the whole
  loop is `"required"`, and only for structured output
  (`packages/opencode/src/session/prompt.ts:1285`).
- Nothing validates "exactly one `in_progress`". That rule lives in the tool
  description and nowhere else.

So the behaviour is produced by three pieces of writing, and they are worth
copying precisely because they are all we are copying:

1. **A tool whose description is a policy** (`tool/todowrite.txt`): when to use
   it (3+ distinct steps), *when not to* (single task, informational, "tracking
   adds no organizational value"), the states, and the rules — "update status in
   real time; don't batch completions", "mark `completed` only after the
   required work is actually done, including any required verification. Never
   based on intent."
2. **An imperative system-prompt section**: "Use these tools VERY frequently…
   If you do not use this tool when planning, you may forget to do important
   tasks — **and that is unacceptable.**"
3. **Two worked transcript examples** showing the shape of the turn: write the
   list → mark one `in_progress` → work → mark `completed` → next.

The lesson is not "text works" or "text doesn't". It is that a model reaches for
a **tool** far more readily than it obeys a paragraph, and that few-shot examples
of the *shape of a turn* do what an instruction about behaviour does not. Our
attempt failed because the request lived in prose, with no tool to reach for and
no example.

## Plan mode — an agent, and thinner than it looks

Plan mode is not a mode flag; it is an agent the user selects, whose enforcement
is a permission ruleset (`packages/opencode/src/agent/agent.ts:156`): `edit`
denied except the plan-file globs, the `general` subagent denied, `plan_exit`
allowed.

Two things it does **not** do, worth knowing before copying it:

- **`bash` is not denied.** The plan prompt says "Do NOT use sed, tee, echo, cat,
  or ANY other bash command to manipulate files"; nothing enforces it. `bash`
  keeps the inherited `"*": "allow"` (`tool/shell.ts:283`, defaults at
  `agent.ts:120`).
- **The edit tools are still advertised to the model.** A tool is stripped from
  the request only when its *last* matching rule is `"*"` + `deny`
  (`permission/index.ts:204`); the plan agent's last `edit` rule is a
  plans-glob allow. So the model is offered a tool it is mostly forbidden to
  use, and learns so from a denial at execute time.

Leaving plan mode is real code: `plan_exit` asks the human Yes/No and, on Yes,
appends a synthetic user message carrying `agent: "build"`.

## Context — two mechanisms, one of them better than ours

There is **no tokenizer anywhere in the repository**. Every budget decision is
`length / 4` (`packages/core/src/util/token.ts:3`) — the same naive estimate Pi
uses, and the same one that undercounts code by 1.5–2×.

But the trigger is better than ours:

- **Compaction fires on the provider's own reported usage from the previous
  turn**, not on an estimate (`session/overflow.ts:22`,
  `session/prompt.ts:1160`). The reserve is an absolute count,
  `min(20_000, min(model.limit.output, 32_000))`, subtracted from the published
  window. When it overflows, a compaction turn runs *before* the user's turn
  reaches the model.
- Compaction summarises against a fixed template and keeps a verbatim recent
  tail — 25% of usable context, clamped to 2,000–15,000 tokens. Older messages
  are excluded from the request and stay in the database.

And one mechanism we do not have at all:

- **Tool output is truncated at execution**, 2,000 lines / 50 KB
  (`tool/truncate.ts:14-15`), the full text written to a file, and the model is
  handed a pointer plus an instruction to delegate reading it to a subagent
  rather than pulling it back into context.

## What opencode does *not* have, and we do

- **Tool call inputs are never truncated.** `write` takes the whole file body as
  a `content` string (`tool/write.ts:20`); `apply_patch` takes the whole patch,
  new-file bodies included, as one `patchText` string (`tool/apply_patch.ts:18`).
  There is no chunked or append protocol. Hello.'s `browser_show_html` with
  `more: true` has no counterpart there.
- **`finish_reason: length` is handled by nothing.** Each protocol adapter
  normalises it to the literal `"length"`, and that string is never compared
  against anywhere in the tree. A turn cut off by the output cap ends the agent
  loop silently, as though the model had finished. Hello. at least says so.
- **Step-limit enforcement is a text appeal.** On the last allowed step the
  harness appends an assistant message saying "Tools are disabled until next
  user input" while still sending the full tool array with `toolChoice`
  undefined (`session/prompt.ts:1281`). Nothing prevents a tool call.

## Adaptation to a small or local model: none

Grepping the tree for `ollama`, `lmstudio`, `llama.cpp` and port `11434` returns
nothing. Local endpoints are ordinary OpenAI-compatible providers.

- The system prompt file is chosen by **substring match on the model's API id** —
  `gpt`, `gemini`, `claude`, `kimi`, `muse` — falling through to `default.txt`
  (`session/system.ts:28`). Not by size, not by capability.
- The only model-conditional tool swap gives `gpt-*` models `apply_patch` in
  place of `edit`/`write` (`tool/registry.ts:296`).
- `capabilities.toolcall` is parsed from the model catalog and **never read** in
  the request path. A model flagged as not supporting tool calls is still sent
  the full tool array.
- `small: true` exists but is used only by the forked title-generation call, and
  changes provider options, never the prompt or the tool list.

## The turn itself

One HTTP call, one model request. `handle.process(...)` at
`session/prompt.ts:1272` is the only call that leaves the loop toward the model.
No classifier, no router, no intent detector, no pre-summariser. Everything
before it is deterministic: history from SQLite, a git `write-tree` snapshot,
tool assembly, instruction files re-read from disk on **every** step, string
concatenation.

Two other model calls can exist around it, both narrow: a **forked** title
generation on step 1 (small model, no tools, never feeds the main request), and
the compaction turn described above when the previous turn overflowed.

`@file` mentions are expanded before the model sees anything, by executing the
read tool in-process and inlining its output as synthetic parts. Slash commands
are expanded server-side, including executing any `` !`cmd` `` backticks and
splicing stdout into the template.

## So what actually saved the run

Not a planning stage — there isn't one. Three things, in order of weight:

1. **The model chose to write a generator script.** It had `bash` and `write`,
   so it produced a 167-line Python file that emitted the 36 KB of HTML, instead
   of emitting 36 KB through the completion stream. That is the whole
   difference, and it is a *capability* the model had, not a feature of the
   harness.
2. **Tool output truncation** kept the reads it did from filling the window.
3. **Compaction on reported usage** would have fired on real numbers rather than
   an estimate that runs half low.

## What to take, and what not to

Take:

- The **tool-with-a-policy** shape for planning, with the "when NOT to use"
  half, and two worked examples of the turn. Cheap, and it is the whole of their
  planning mechanism.
- **Truncate tool output at execution**, write the full text to a file, hand
  back a pointer. We have no equivalent.
- **Trigger compaction on the provider's reported usage**, not on an estimate.
  We already display those numbers; we do not act on them.
- Give the model a way to **produce a large artifact without streaming it** —
  which for us means a folder, a scratch space, or the parts mechanism.

Do not take:

- Plan mode as implemented. The prohibitions that matter are text over a `bash`
  tool that is still allowed, and the denied tools are still advertised.
- Silence on `finish_reason: length`.
- The assumption that a published context window is a budget. Their estimate is
  as naive as Pi's; only the reported-usage trigger saves it.
