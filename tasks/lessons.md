# Lessons

## 2026-11-16 — Hello's model is a Pi agent with a shell, not a chat model

**What happened.** While building Sheets I judged a Haiku test run as "cheating"
for deduplicating rows with a Python script, and designed the tools as if the
model could only read and write cells. The owner corrected it: the model runs
in Pi and can run code; data work on a spreadsheet is coder work, the way
Claude's own Excel plugin works by running Python.

**Rule.** For any tool area that handles data in bulk, design for an agent with
a shell: the data reaches a program as a file, never row by row through the
model's context; the tool group brings the coding tools with it
(`ToolGroup.brings`). A script in a test trace is evidence of the right
approach, not a deviation to design around.

**Rule.** When a weak model flails, look first for the operation it is missing
at the level the person asked (group, export, top N) before adding
instructions to the manual.

## 2026-11-16 — Do not rule out the proven approach on the app's behalf

**What happened.** I set aside openpyxl + recalculation (what Claude's own xlsx
skill does) because "the app would depend on Python", and built cell-level
tools on ExcelJS instead. They could not make a chart, and a real chart was the
first thing asked for. The owner sent us back to the first approach.

**Rule.** When a proven method exists for the job, the reason to leave it must
be a constraint the owner set, not a tidiness preference of mine. A dependency
the agent's own shell can satisfy (a private venv in the app's data) is not a
reason. Keep the heavy part only where it earns its place: LibreOffice was the
part worth replacing (IronCalc), Python was not.

**Rule.** Verify a library's read side with the files the write side will
really produce: ExcelJS could not load a workbook with an openpyxl chart at
all, and only an end-to-end run with real openpyxl showed it.

## 2026-11-16 — Name tools what models already call them

**What happened.** The shell tool was named `command_run`; coding models call
`bash` first, so tasks opened with "Tool bash not found". My first fix added
`bash` as an alias and did not work: Pi was launched with `--exclude-tools`
listing `bash`, which drops extension tools of that name too. I had tested the
alias in main only, never through Pi.

**Rule.** A tool whose job has a universal name takes that name; do not invent
one. And a change to what the model can call is verified along the whole path
— definition, Pi's registry and exclusions, execution — not at the layer I
edited.


## 2026-11-16 — A claim about a library goes in a manual only after it was run

**What happened.** I wrote into the sheets manual, the tool notes and an error
message that "openpyxl keeps only the charts the same run created", from
memory of an older openpyxl. openpyxl 3.1 restores charts on load. The model
followed the manual, re-added its chart in every script and ended with
duplicates it could not see; half of a 1.3M-token task went to that.

**Rule.** A behavioural claim about a dependency that the model will act on is
checked by running the dependency (two lines of Python here) before it is
written down. The model's instructions are code: an untested sentence there is
an untested branch.

**Rule.** What a tool leaves in a file that no pane shows must be reported by
the tool (`charts` in sheet_script and sheet_read), or the model verifies it
by hand through the shell — slowly, and wrongly.

## 2026-11-16 — A workbook computes: values where a formula belongs, and a rule lost in a rewrite

**What happened.** In a run the model built a pivot in Python and wrote its
numbers into the cells as values; the user: "au fost puse date text în celule
nu formule! asta aștepți de la un excel, formule". Two causes, both mine. When
I rewrote the sheets manual to fold in the xlsx skill's rules I dropped the
clause "keep formulas as formulas" from the sheet_script line. And the tool
gave no other way: sheet_group could only count, so a list or a sum per group
meant a script.

**Rule.** When a text the model acts on is rewritten, every rule of the old
text is carried over or dropped on purpose — checked line against line, not
from memory of what mattered.

**Rule.** A rule the model must follow in code it writes itself is also
checked by the app where the app can see the result: sheet_script now says
when a sheet it made holds numbers and no formula.

**Rule.** When a model reaches for a script to do what a spreadsheet does with
a formula, the tool is missing an option. Give the tool the option (also: sum,
average, min, max, list — all formulas) before telling the model to try harder.

## 2026-11-16 — The model did not ask, because nothing told it there was something to ask

**What happened.** The user expected a question about labels that look alike
("Bacau" / "Bacău") and got none. The prompt called the task a test, the
manual asked for questions only before the work, and the tool reported nothing
the model could ask about — on that file there were no such labels at all; the
model's remark had been a guess.

**Rule.** A judgement that is the person's is surfaced by the tool as data
(`alike`, the rows without a key by number) with the instruction to ask, at
the point it is found. A model cannot ask about what it was not shown.


## 2026-11-17 — A failure that points nowhere the model can go; a gate per case

**What happened.** A blocked `web_search` told the model to "configure
HELLO_SEARXNG_URL" — a setting only the person can change — and never named
the browser it had; the browser's tools were a group to go and find. The model
tried twice, failed, and answered from memory. The user's reading: the model
must know what it has from the first second, and the app had grown one gate per
case (no folder → no shell, not Coder → no file tools).

**Rule.** A tool's failure names a way the model can take in its next step,
and that way is in reach when the failure is read — loaded by Hello, not left
to be found. A capability is not gated by a mode or by a missing folder: one
way of working, with a default that makes the tool run (the chat's own
folder). What asks stays what protects — approvals, Agent control, path scope.

## 2026-11-17 — A getter in a loop condition, and a freeze nobody could place

**What happened.** Hello froze twice on the same step, `sheet_read toFile` over
a 29,426-row sheet. The person read it as two faults — "the app is frozen, and
the server is frozen too" — and said it never happened in the other apps.
There was one fault. ExcelJS's `columnCount` walks every row of the sheet, and
it sat in the inner loop's condition, so one pass over 412,000 cells became
quadratic: 237,553 ms, synchronous, in the main process. The window, the IPC
and the Pi tool bridge are all in that process, so the model server simply had
nothing to answer and looked frozen as well.

**Rule.** Read a library's size getter ONCE, into a local, before the loop —
`columnCount`, `rowCount`, `length` on anything computed. A count in a loop
condition is a loop over a loop. And when the person reports two things frozen
at once, look for the one process that holds both before believing in two
faults.

**How it was found.** Not by reading the code: by timing the real file. The
same loop with the counts hoisted ran in 49 ms. Measure before explaining.

## 2026-11-17 — A rule I wrote from one example, applied to every case

**What happened.** On 16.11 the person said an Excel is formulas, not typed-in
text. I put that in the sheets manual as "the arithmetic stays in the
workbook". On 17.11 the same task ran in Hello and in another agent. The other
finished in 2 min 40 s with 565 values and two native charts, 15.5 KB. Hello
took 18 min 44 s and produced 1.9 MB: the 29,426-row source copied into the
report so the COUNTIFS could reach it, a helper sheet of 1,335 formulas, and
nine minutes spent bending those formulas until Hello's engine stopped
returning 0 on a text date. Every number had already been computed correctly,
in Python, three minutes in.

**Rule.** A rule taken from one example is scoped to that example before it
goes in a manual. "Formulas" was right for a small table whose inputs the
person edits; it was wrong for a figure aggregated over thousands of rows that
live in another file. State the boundary in the rule itself — here, whether
the workbook holds the cells the number comes from.

**And:** when a tool's result keeps pushing the model one way, read it as part
of the loop. The 13 minutes were not the model's idea; the `sheet_script`
result told it, every time, that a table of values should have been formulas.

## 2026-11-17 — Fast and right about the arithmetic, wrong about the answer

**What happened.** With the narrowed rule in place the same task ran in 76
seconds and every figure I could check was correct: 15 of 15 car rows, 8 of 8
summary values, verified against an independent count of the source. The
report's headline — the most active car, at 57.7% — rests on 1,017 repeated
rows, 763 of them the same timestamp to the second. Count those as real
readings and that car leads; treat them as the telemetry burst they very
likely are and it falls to 15.3%, behind another car at 16.9%. Every run
reported the first figure, ours and the one we were comparing against, and
none said the answer turned on those rows.

**Rule.** Verifying a deliverable means recomputing its headline from the
source under a definition you chose yourself, not only checking that its
arithmetic is self-consistent. A figure can be a faithful count of rows that
should probably not all have been counted — and which rows those are is the
person's call, not one to make quietly.

**And:** the signal was already in the first tool result. `sheet_read summary`
reported 27,591 distinct values in 29,425 filled rows and listed the repeated
timestamp with its count of 763. The tool was not missing anything; no rule
told the model to read it. When a model misses something, look first at what
it was already handed.

## 2026-11-17 — Un semnal luat de unde nu trebuia, și o revenire

**Ce s-a întâmplat.** Omul a cerut: dacă el preîncarcă Excelul în panou lucrăm
prin panou, dacă nu, lucrăm direct pe fișier cu scripturi. Am citit semnalul
din „chatul are un registru deschis". Dar un registru deschis de o rulare
anterioară rămâne deschis, iar omul testa în același chat — deci panoul se
încărca în continuare. Mi-a cerut să revin la starea de dimineață.

**Regula.** Când cineva spune „dacă omul face X", semnalul e acțiunea lui
acum, nu o stare pe care o poate fi lăsat-o orice altceva în urmă. Starea
acumulată într-un chat nu e consimțământ.

**Și:** înainte de a propune o revenire la un comit, uită-te când e ultimul.
Aici era de acum cinci săptămâni, iar „revenim la commitul de dimineață" ar fi
șters module întregi. Copia de siguranță se face înainte de orice, nu după.
