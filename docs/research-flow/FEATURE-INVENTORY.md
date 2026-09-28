# Hello. — inventar de funcționalități (persistent)

Creat 14 septembrie 2026, pentru fluxul de cercetare continuă. Se actualizează
când produsul se schimbă. Distinge ce e **confirmat în cod** (fișier sursă
verificat) de ce e **doar documentat** sau **doar planificat**.

## Existente — confirmate în cod

| Funcționalitate | Sursă confirmată |
| --- | --- |
| Motor chat Pi 0.85.1 headless, RPC persistent per conversație, compactare/retry deținute de Pi | `src/main/chat/pi-rpc.ts`, `pi-events.ts`, `service.ts` |
| Switch Chat/Coder în composer, persistat per conversație | `service.ts`, README |
| Tools main-process prin bridge privat: notebooks, fișiere scoped, scrieri aprobate, shell aprobat, browser | `src/main/chat/pi-tool-bridge.ts`, `tools.ts` |
| Web research independent: `web_search` (DuckDuckGo/SearXNG) + `fetch_url`, citări [N], meniu Sources | `src/main/chat/web-tools.ts` |
| Browser `<webview>` izolat, granturi Off/Read/Full per tab, reset la restart | `src/main/browser/manager.ts`, `policy.ts` |
| `browser_show_html` — artefacte HTML persistente `artifact:<id>`, preview loopback | `src/main/browser/html-artifacts.ts`, `local-preview.ts` |
| `browser_pointer` + `browser_screenshot` (verificare canvas) | commit 5e0ec4d |
| Files: arbore Arborist read-only, preview Markdown/sursă, limite explicite | `src/main/files/service.ts` |
| Runbook/Tasks: Tiptap peste Markdown, autosave, statusuri per task, export `.md` | `src/main/chat/tasks.ts`, ARCHITECTURE |
| Terminal PTY nativ + xterm; CLI launcher (Claude Code, Codex, Qwen, Kimi, OpenCode, Pi, Aider) | `src/main/terminal/` |
| Notebook handoff către CLI-uri: ghid pasiv + `notebook_list`/`notebook_task_status` pe loopback | `terminal/notebook-context.ts` |
| Extensions: Skills, Plugins Pi, client MCP stdio propriu; import cu fingerprint, activare per chat | `src/main/extensions/` |
| Discovery configurări MCP/skills ale altor tool-uri de pe Mac | `src/main/extensions/discovery.ts` |
| SQLite propriu în `Hello Workspace/`, chei criptate, sesiuni Pi JSONL private | `src/main/data/store.ts` |
| Drag & drop fișiere/imagini în chat cu limite explicite; folder unic per conversație | ARCHITECTURE, `chat/attachments.ts` |
| Endpoint OpenAI-compatibil + presets Providers + conexiuni salvate cu chei per endpoint | `src/renderer/settings/` |

## Parțiale — în lucru (necomise pe main, 14 sept.)

| Funcționalitate | Stare |
| --- | --- |
| Descoperire automată a serverelor locale de modele (scan porturi lsof + porturi cunoscute, listă modele OpenAI-style) | `src/main/chat/local-servers.ts` — nou, necomis |
| Țintire elemente browser prin cuvinte vizibile (label), nu doar CSS | `src/main/browser/agent-target.ts` — nou, necomis |
| Validarea manuală runtime a migrării Pi (pasul 2 din roadmap) | doar documentată ca pending; nu e dovadă în cod |

## Planificate — backlog aprobat (nu există în cod)

Din `docs/MINI-ROADMAP.md` (pasul 6 propus) și
`docs/feature-research/MOST-WANTED-FEATURES-2026-09-09.md` (Top 12):

1. Search în mesaje/Runbook/Tasks + meter de context + compactare recuperabilă (H03+H04)
2. Inspector de consum: model per răspuns, tokeni, cost, buget (H02)
3. Coadă de atenție și notificări „cine are nevoie de mine" (parțial H10)
4. Checkpoint/restaurare pe bază Git (decizie: fără istoric propriu per tură)
5. Diff review cu comentarii citite de agent
6. Aprobări v2: allowlists memorate, log de acțiuni, secrete în afara contextului
7. Tasks ca obiect de lucru: owner/run, worktrees pentru workers paraleli (H01)
8. Browserul ca sursă: tab-as-context, citări la pasaj, PDF (H05)
9. Memorie explicită cu control (H06)
10. Bibliotecă de skills invocabile cu „/" (H07 — parțial acoperit de Extensions livrate)
11. Sesiuni persistente + resume CLI workers + backup/export (H10 parțial)
12. Automatizări programate care țin minte (H11)

Amânate explicit de proprietar: vision, provider discovery UI, sidecar,
orchestrare de workers cu raportare (H15), scheduler propriu.

## Reguli de întreținere

- O intrare trece în „Existente" numai cu fișierul sursă confirmat.
- Rulările zilnice ale fluxului de cercetare compară materialul nou cu acest
  inventar; propunerile care dublează o funcționalitate existentă se resping
  cu trimitere la rândul de aici.
