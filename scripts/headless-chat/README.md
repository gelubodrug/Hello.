# A headless Hello chat turn

Runs one whole chat turn with no window, through the application's real path:
`ChatService` → the Pi child process → Hello's Pi extension and tool bridge →
the real tools (sheets, shell, files). Only the model server is replaced: every
request Pi would send to a model waits in a file for its answer, so any model —
an agent, another program, or a person — can sit in the model's chair.

It exists because integration faults do not show in unit tests: a tool that is
defined but not routed, a name Pi excludes, a tool called in the same message
that loads its group. Each of those was found by a person using the app before
this was written.

## Run

    mkdir -p /tmp/hello-run/folder
    cp some.xlsx /tmp/hello-run/folder/
    echo "what the person asks" > /tmp/hello-run/prompt.txt
    node scripts/headless-chat/start.mjs /tmp/hello-run [--pi <rpc-entry.js of another Pi>]

Then, as the model:

    node /tmp/hello-run/turn.mjs                      # prints the first model input
    node /tmp/hello-run/turn.mjs /tmp/hello-run/replies/1.json   # answers it, prints the next

A reply is `{"content": "…", "tool_calls": [{"name": "…", "arguments": {…}}]}`;
either key may be left out, and a reply with no tool calls ends the turn. Each
model input shows the tools callable in that step, exactly as Pi sends them —
a tool that is not listed is not callable, as for a real model.

## A real server, and the gate

With `HEADLESS_ENDPOINT` and `HEADLESS_MODEL` set, the model's chair is a real
OpenAI-compatible server (a Kapitsa on this Mac, say) and nothing waits in
`io/`; `HEADLESS_EFFORT` is the chat's reasoning setting (default `off`).
With `HEADLESS_GATE=1` the chat has Ask first on and every message goes through
the gate as a person's would. `prompt.txt` may hold several messages separated
by a line of three dashes; each is sent once the turn before it has ended, so a
gate's questions can be answered and a follow-up tried. `result.json` then
lists the turns, each with its steps, its time and what the gate kept.

    HEADLESS_ENDPOINT=http://127.0.0.1:8000/v1 HEADLESS_MODEL=<id> HEADLESS_GATE=1 \
      node scripts/headless-chat/start.mjs /tmp/hello-run

## What it leaves

- `trace.jsonl` — every model request (message count, tools, size), every reply,
  every tool call with its status, input and the start of its output.
- `result.json` — the final message's steps and the chat's workbooks.
- `folder/` — whatever the tools wrote there. `data/` — the app data of the run.

With neither `folder/` nor `drop/` the chat has no folder of the person's and
works in the one Hello keeps for it, as every such chat does. With `drop/` in
place of `folder/` the chat starts with no folder and the files
in `drop/` are dropped on it, as a person drops them on the composer: a PDF or a
workbook then lands in the folder Hello keeps for the chat, under
`data/chat-files/`, and that is where the tools write. With both, the chat has
the folder and the files of `drop/` are dropped on it from outside: a workbook
becomes a copy among the chat's workbooks, a PDF a copy Hello keeps, which the
PDF tools take by its name and whose results are written into `folder/`.

## What it is not

It has no window: the Sheets pane, the chat's layout and the browser are not
exercised. Approvals are the default (`all`: nothing asks). It uses a data
directory of its own, never the person's database or keys. The Python the sheet
tools run scripts in is built on first use (a pip download) and kept in
`data/sheets/python` between runs.
