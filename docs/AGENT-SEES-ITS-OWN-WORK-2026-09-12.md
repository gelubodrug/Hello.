# Letting an agent look at its own work

> **One claim in here was corrected the next day.** The section "What did not
> work" concludes that instructions cannot change what a model does. Reading
> opencode's source showed that its own planning is *entirely* prompt-driven and
> works — the difference is that it prompts through a tool with a policy in its
> description, plus worked examples, rather than a paragraph in a system prompt.
> See `RESEARCH-OPENCODE-HARNESS-2026-09-13.md`. Everything else here stands.

Written for whoever implements this in the sibling app. It is the technique, not a patch:
the file names here are Hello.'s, the mechanism is not.

## The failure

An agent asked to build an HTML page generates it, opens it in the app's
browser, and then *describes* it — confidently, without having seen it. When the
file came out truncated or syntactically broken, it said the page was fine.

In Hello. the reason was explicit, and it is likely the same wherever a browser
pane is permission-gated: every tab opens with agent control **Off**, and full
control needs a human grant. So the one page the agent itself had just written
was also a page it was forbidden to read. Its own words back:

> "Pagina s-a deschis în browser. Tabul este în modul Off, deci nu pot citi
> DOM-ul, dar conținutul a fost scris direct și nu are erori de sintaxă."

That is a claim, not a check, and it is the harness that forced it.

## The change that worked

**A document the agent generated opens with full control. Nothing else does.**

The argument for why this is safe, and it is worth keeping with the code because
it will be questioned:

- Every word in the page came from the model. Reading it back reveals nothing it
  did not already know.
- It is served from an isolated ephemeral session — no cookies, nothing signed
  in, its own local origin. It is not the user's web.
- Interaction grants nothing new either: the page's own JavaScript already runs
  freely. Control gates *the agent's* access, not the page's behaviour.
- Against that: a page nobody can look at is a page nobody checked.

**The grant belongs to the document, not to the tab.** This is the part that is
easy to get wrong and the part that matters. A tab gets reused — a second
version of the document, a later `navigate` to a real site — and a grant pinned
to the tab would follow it onto somebody else's page. So:

- Stamp the tab with the address the document is actually served at.
- On every navigation, and on every navigation the *page itself* performs
  (a generated page can set `location`), compare: if the tab is no longer at that
  address, control drops back to Off and the stamp is cleared.
- A preview of a file the **person** wrote is not the agent's own work. It comes
  back Off. Reading their files is a grant only they can give — do not let
  "it is served locally" become the test.

In Hello.: `grantOwnWork` / `endOwnWork` in `src/main/browser/manager.ts`, called
from the show path, from `navigate`, and from the page's own navigation events.
Two tests pin it: the grant survives a second version of the document, and dies
the moment the tab moves, whoever moved it.

## The second change: one tab, not one per revision

Iterating on a design opened a new tab per attempt — eighteen tabs named alike,
and the reader's place lost each time. A generated document should replace the
one the chat is already showing. Same slot, same tab id, new page. Different
chats keep different slots.

This also makes the grant coherent: there is one document per chat to grant
against, not a growing pile.

## What did not work, so you do not spend the effort

Two things were tried first, and the evidence says they are not enough.

**Telling the model in the tool description** to build long documents in parts,
and adding a mechanism for it (`more: true`, parts held in memory, nothing
written until the closing call). Across a real run: **zero** calls used it. It
emitted three complete 10–12 KB documents instead, rewriting from scratch each
time.

**Telling the model in the system prompt** to break a multi-step request down
first and write the plan to a shared task list. Across the same run: **zero**
entries written. The list stayed empty.

Both are still in place — they cost nothing and a stronger model may use them —
but neither changed this model's behaviour. A line of instruction is a request.
If decomposition matters, it has to be a stage the harness runs and the model
cannot skip: a bounded planning pass whose output the harness writes down, then
the real turn started from that plan. That is unbuilt here.

## How to tell whether it is working

Do not judge by whether the run survives; judge by whether the tools were
actually called. In Hello.'s case the transcript went:

> created visual → *read open page* → "the file was truncated" → created visual
> → "syntax error, the code is incomplete" → created visual → *checked open
> tabs* → *read open page* → "the page runs, now testing the interaction" →
> *clicked on page*

The three reads and the click are the evidence. Before the change, all three
were refused. Whether it rescues any particular run is a separate question and
one run does not answer it.

## One honest gap

The agent can read and click its own page, but it cannot drag: there is no drag
action among the browser tools. So a prompt asking it to "verify dragging" is
asking for a claim it cannot support. Either add the action, or have it say what
it could not verify — Hello.'s system prompt now asks for the latter.
