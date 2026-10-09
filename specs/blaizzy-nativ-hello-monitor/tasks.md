# Tasks: Blaizzy/nativ PR Monitoring for Hello.

## Pass 2026-10-07 — Proposals from Analyst (10 tasks)

### Phase 1 — Actionable Now (no owner decision needed)

- [x] T001 [P] [US3] Elimina new Date() din src/main/chat/pi-instructions.ts — data exista deja in liveContext snapshot (nativ #680; pi-instructions.ts:56)
- [x] T002 [P] [US3] Restrange fingerprint AppSettings in src/main/chat/service.ts la campurile care intra in prompt — exclude appearance/approvals/connections/temperature/reasoningEffort daca nu afecteaza helloSystemPrompt (nativ #680; service.ts:1519-1531)
- [x] T003 [P] [US3] Activeaza tools_find pentru bridge-ul CLI — adauga getCatalog in src/main/terminal/notebook-context.ts (nativ #490; notebook-context.ts:234-240, pi-extension.ts:307-313)
- [x] T004 [P] [US3] Scrieri atomice safe cu symlink-uri — resolve symlink inainte de renameSync/writeFileSync la: src/main/data/store.ts:1118, src/main/market/service.ts:151, src/main/market/install.ts:148, src/main/terminal/report-channel.ts:208, src/main/terminal/cli-workers.ts:251/340/433, src/main/dsh/service.ts:173/306 (nativ #642)

### Phase 2 — Necesita decizie owner

- [ ] T005 [US3] DECIZIE OWNER: Extinde filtrul secretPath la toate entry point-urile de atasamente (nu doar file_read) — implica refuz .env din composer; src/main/chat/attachments.ts, tools.ts:759/777/1154 (nativ #634)
- [ ] T006 [US3] DECIZIE DEPENDENTA: Layer extragere documente PDF/docx/xlsx/epub/ipynb/odt — subsumeaza todo-ul fetch_url PDF; src/main/chat/attachments.ts:30-31, tools.ts:1174-1183, web-tools.ts:79-81 (nativ #647)
- [ ] T007 [US3] DECIZIE TOKENI: Budget atasamente derivat din contextWindow modelului cu water-filling — cost asteptat ~40% mai multi tokeni de prompt; src/main/chat/attachments.ts:8-11, service.ts:2070 (nativ #639)
- [ ] T008 [US3] GAP SECURITATE: MCP server folder scoping — requiresFolder flag + path policy identica cu native tools; src/main/extensions/mcp.ts:115, docs/SECURITY.md:187-188 (nativ #634)

### Phase 3 — Prioritate redusa

- [x] T009 [US2] Marker vizual in transcript la punctul de compactare cu numarul de tokeni inainte/dupa — compact RPC returneaza deja tokensBefore/estimatedTokensAfter; ContextMeter.tsx:10-11, pi-session.ts:198-199 (nativ #655)
- [x] T010 [US2] Drag-reorder tab-uri work-pane — necesita ordine persistata in DB inainte de drag handlers; ToolTabStrip.tsx (nativ #663)

## pass-2026-10-08-001

- [x] T011 [!medium] Bugetul de context: un contextScale invatat poate face un chat salvat sa refuze pornirea (pi-session.ts:147 vs store.ts:905). Valideaza fereastra efectiva si scurteaza raspunsul in loc sa refuzi pornirea (nativ#684).
- [x] T012 [!low] Settings: un Try again pe eroarea de citire a serverului - askAgain exista, butonul lipseste (SettingsDialog.tsx:521). Ca Retry-ul din market (nativ#690).
- [x] T013 [!low] Market: un cod out-of-space pe MarketInstallError - o instalare care moare cu ENOSPC spune acum doar pnpm could not install (pi-install.ts:181) (nativ#689).

## Pass 2026-10-08-004 — Proposals from Analyst (PR #416)

- [x] T014 [!medium] [#high] Subagent context window: a different subagentModel inherits the chat model's learned contextScale and window — declare it with its own limits floor instead (pi-session.ts:135-141,180-194) (nativ#416) <https://github.com/Blaizzy/nativ/pull/416>
- [x] T015 [!low] [#medium] Subagent model validation: a free-text subagentModel id is never checked against the probed list — show inline notice at save and fall back to chat model at launch (SettingsDialog.tsx:613-637, pi-session.ts:191) (nativ#416) <https://github.com/Blaizzy/nativ/pull/416>
- [x] T016 [!minimal] [#low] Pi CLI connection guide: update the HELLO.md tool-availability sentence in notebook-context.ts — the gating change means CLI starts with only tools_find, not notebook/browser tools at startup
- [x] T017 [!low] [#low] Background subagent fan-out: surface pi-subagents extensionUi statuses in the chat while a fan-out runs, or close as nothing-to-surface if none are emitted (service.ts:1765-1800) (nativ#416) <https://github.com/Blaizzy/nativ/pull/416>  <!-- aplicația-soră: run 01a11cf9-349a-7b10-bd0e-b02f298ee6c2 -->

## Pass 2026-10-08-004 — Voice proposals from Analyst (PR #691)

- [ ] T018 [!medium] [#high] Voice V1 — Dictate into the composer: mic → local STT → draft text inserted at caret (permission handler, IPC voice.transcribe, MediaRecorder Mic button per §Composer, SettingsDialog STT fields, unit tests for permission denial and size cap) (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
- [ ] T019 [!low] [#high] Voice V2 — Discover voice server and keep audio servers out of chat model list: probe GET /v1/audio/voices to separate voice from chat; guard chat listModels against mlx-audio/Kokoro-FastAPI/speaches on port 8000 (local-servers.ts, voice/servers.ts new, service.ts guard, regression test) (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
- [ ] T020 [!medium] [#medium] Voice V3 — Speak the reply: local Piper TTS playback (CSP media-src blob:, voice/speak.ts new supporting both Piper /synthesize and OpenAI /v1/audio/speech shapes, per-message speak/stop control, sentence-chunked streaming, unit tests) (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
- [ ] T021 [!low] [#medium] Voice V4 — Voice on/off and sidebar AudioLines affordance: dictation and spoken replies toggle independently, persist in AppSettings.voice, sidebar footer row per design guide §Sidebar footer (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
- [ ] T022 [!low] [#low] Voice V5 — Microphone usage description for a packaged build: add NSMicrophoneUsageDescription to package.json build.mac.extendInfo; entitlements file only if owner moves off target:dir to signed hardened-runtime (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>

## Pass 2026-10-08-004 — Voice revised (P1–P6, supersedes T018–T022)

- [x] T023 [!low] [#high] Voice P1 — Audio-only media grant: replace blanket callback(false) in index.ts:162 with audio-only predicate (main frame, audio not video, app origin); setPermissionCheckHandler; askForMediaAccess darwin; media-src blob: in CSP; NSMicrophoneUsageDescription in package.json; SECURITY.md companion sentence; predicate exported and unit-tested (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
- [x] T024 [!medium] [#high] Voice P2 — Automatic voice turn: voice/translate.ts two-shaped (whisper.cpp multipart translate=true on /inference; OpenAI /v1/audio/translations); IPC hello:voice.translate; Mic button composer idle/listening/working; VAD auto-stop 900 ms silence; bytes to send() not setDraft; nothing-said guard; half-duplex with TTS; unit tests (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
- [x] T025 [!low] [#high] Voice P3 — Server discovery: two-probe classify port as (a) GET /v1/audio/voices OpenAI-shaped voice, (b) GET /load or OPTIONS /inference whisper.cpp; voice-only excluded from chat LocalServer[]; service.ts listModels guard against Kokoro voice ids; Settings shows found server or none; regression test (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
- [ ] T026 [!low] [#high] Voice P4 — STT model comparison: run Romanian clips through whisper-cli --translate -l ro for ggml-large-v3, ggml-large-v3-turbo and ggml-medium; output table with wall-clock and peak RSS; chosen default + reason in docs/PROVENANCE.md; no model downloaded without owner approval; gates P2 default config (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
- [x] T027 [!medium] [#medium] Voice P5 — Kokoro TTS reply playback: voice/speak.ts POST /v1/audio/speech two-shaped (mlx-audio vs Kokoro-FastAPI); IPC hello:voice.speak; auto-play on reply complete when Voice on; sentence-chunked playback; stop drains queue; Escape and conversation-switch stop; prose only; mic closed while speaking; unit tests (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
- [x] T028 [!low] [#medium] Voice P6 — One voice switch: AppSettings.voice { enabled, sttEndpointUrl, sttModel, sourceLanguage, ttsEndpointUrl, ttsVoice }; sidebar AudioLines row rendered when disabled with title reason; SettingsDialog Voice section (P3 server, STT model, language, TTS voice, macOS mic status P1); Mic disabled but rendered when Voice off; persists on restart; clears on connection change (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
- [x] T029 [!high] [#high] Voice P7 — Hello manages Whisper model and server: downloads ggml-large-v3-turbo on consent (size shown), sha256-pinned, symlink-refused via the atomic-write helper; spawns whisper-server on loopback-minted port, supervised backoff+give-up, killed on before-quit; found server reused not touched; IPC hello:voice.prepare; Settings 3-state row; amends SECURITY.md and NSMicrophoneUsageDescription; unit tests for model-store and server supervisor (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>

## Din tasks/todo.md (09.10) — Tehnic

- [x] T030 [!medium] [#high] Împachetarea pnpm package:mac neverificată: extraResources dsh/, pnpm și esbuild despachetate din asar (ESBUILD_BINARY_PATH); electron-builder nu găsea @mariozechner/clipboard — probabil pnpm install curat după urcările Pi
- [x] T031 [!low] [#high] PI_VERSION din src/main/market/pi-install.ts e 0.87.1, deși Hello rulează Pi 1.0.x — aliniază-l
- [ ] T032 [!high] [#medium] Hook-urile de sesiune dsh peste Pi: recall și captură dsh-memory-plugin în chaturile Hello, cu opțiunea per chat „nu captura acest chat”
- [x] T033 [!medium] [#low] Marketul DSH: căutare pe mai multe categorii deodată, reordonarea surselor, scanarea completă dshfind
- [ ] T034 [!medium] [#low] Suprafața DSH ca tab în panoul de unelte, pe lângă vederea din sidebar
- [ ] T035 [!medium] [#medium] dsh 0.2.x stabil: pini exacți, procedura de upgrade, pluginurile de top reverificate (tema Hello și shim-ul sunt pentru 0.1.7-rc.2)
- [x] T036 [!medium] [#low] Bugetul de memorie și CPU al gazdei DSH
- [x] T037 [!medium] [#medium] Extensii Pi: require() CommonJS al modulelor date de Pi într-un pachet împachetat; „Found on this Mac” poate lista o extensie pe care importul o refuză
- [x] T038 [!medium] [#low] WebGPU în tab-urile Hello (navigator.gpu): manualul de browser, embeddings locale
- [x] T039 [!low] [#medium] /review al unui șablon de prompt poate fi luat de meniul / când un skill conține cuvântul
- [ ] T040 [!medium] [#low] Întrebările pi-subagents cu pas următor (Change model / thinking) se închid fără continuare: Pi nu trimite acel ecran prin RPC
- [ ] T041 [!medium] [#low] Opțional: un layout Hello pentru clientul dsh și o descărcare mai mică (motorul office, 147 MB)
- [x] T042 [!low] [#low] Limitare: Low/Medium/High ajung la MTPLX (și Kimi) doar ca „gândire pornită”; reasoning_effort nu e trimis
- [x] T043 [!low] [#low] Limitare: extensia OpenViking publicată nu se importă (nu are pi în package.json); merge doar împachetată
- [x] T044 [!medium] [#low] Limitare: Files › Contents caută literal — normalizează NFC + case fold cu İ↔i și offseturi mapate înapoi, ca ⌘F din chat

## Din tasks/todo.md (09.10) — De decis (owner)

- [ ] T045 [!low] [#critical] DECIZIE OWNER: cheia OpenRouter HELLO_QA_API_KEY e comisă în primele rânduri din .gitignore din 10.09 — de rotit la OpenRouter și mutat în .env ignorat; istoricul git o păstrează
- [ ] T046 [!low] [#low] DECIZIE OWNER: publicarea pe npm a hello-dsh (tema Hello pentru DSH Desktop) și a șablonului de plugin — contul tău
- [ ] T047 [!medium] [#high] DECIZIE OWNER: subagenții pi-subagents rulează cu uneltele Pi (bash, edit, write) fără aprobările Hello — îi restrânge Hello (subagents.agentOverrides cu tools)?
- [ ] T048 [!low] [#low] DECIZIE OWNER: butonul primar e albastru în repaus — așa e în referința aprobată, revizia S202 l-a semnalat
- [ ] T049 [!low] [#low] DECIZIE OWNER: checkpoint-urile aplicația-soră (the tooling’s checkpoint refs) păstrate sau șterse
- [ ] T050 [!low] [#medium] DECIZIE OWNER: fluxurile aplicația-soră „hello feature hunt and implement” (a698845e) și cercetarea continuă (b90744fd) citesc docs/MINI-ROADMAP.md, docs/feature-research/, docs/research-flow/, mutate în docs/archive/ la 05.10 — briefurile trebuie schimbate în aplicația-soră
- [ ] T051 [!medium] [#medium] DECIZIE OWNER: istoricul unui chat cu browsing pe calea Pi — opțiunile A–D din docs/archive/research-flow/PI-PATH-2026-09-28.md nedecise (e făcută doar scurtarea la seed)

## Din tasks/todo.md (09.10) — De verificat în aplicație (owner)

- [ ] T052 [!low] [#medium] DECIZIE OWNER — verificare în aplicație: auditul UI din 05.10 — Needs your attention (două aprobări în chaturi diferite + întrebare de plugin cât Notebook/DSH acoperă chatul, Open request); diff la aprobare file_edit; Settings › App › Appearance; ⌘⇧P Go to…; @nume în composer; Files › Contents (Match case, click pe rezultat); Add selection to chat din bara Files și click dreapta, și cu Chat minimizat
- [ ] T053 [!low] [#medium] DECIZIE OWNER — verificare în aplicație: modelul per chat — două chaturi pe modele diferite, unul pornit în timp ce celălalt răspunde
- [ ] T054 [!low] [#medium] DECIZIE OWNER — verificare în aplicație (05.10): meniurile, rezumarea, overlay-ul ⌘/, focusul după Edit, dialogurile, Open tools, secțiunile Notebook oprite într-un chat nou, tabul Chat, click dreapta în browser
- [ ] T055 [!low] [#low] DECIZIE OWNER — verificare în aplicație (04.10): timpul de lucru, Summarise now, tastele, Save to Runbook, Usage în Settings › App
- [ ] T056 [!low] [#low] DECIZIE OWNER — verificare în aplicație: DSH update la 0.2.0-rc.2 și înapoi, Settings › Appearance în DSH, chatul extins și înapoi
- [ ] T057 [!low] [#low] DECIZIE OWNER — verificare în aplicație: Pi update și înapoi, tabul Pi (tema aplicația-soră), un plugin care pune o întrebare, o instalare reală din Pi market
- [ ] T058 [!low] [#medium] DECIZIE OWNER — verificare în aplicație: Claude Code și Codex văd uneltele hello; Qwen Code, OpenCode și Pi CLI pe modelul local; un CLI care citește și apasă într-un tab; repornirea cu un CLI ca tab de chat
- [ ] T059 [!low] [#low] DECIZIE OWNER — verificare în aplicație: browser marks după repornire; smarbill.ro în bara de adrese, apoi Back
- [ ] T060 [!low] [#low] DECIZIE OWNER — verificare în aplicație: meniul / și o descărcare reală de pe skills.sh
- [ ] T061 [!low] [#medium] DECIZIE OWNER — verificare în aplicație (S209): ↑/↓ în composer; ⌘1–9, ⌘⇧] / ⌘⇧[ și ⌘J (și cu terminal sau pagină în focus); căutarea din Notebook; ⌘V cu captură și fișier din Finder, Attach files…; ⌘F în terminal, cu output care curge și în vim/less

## Decizie owner 09.10 — DSH doar găzduit

- [x] T062 [!high] [#high] Redu DSH la lansare găzduită: păstrează gazda, butonul de lansare și upgrade la ultima versiune; scoate tema/layoutul Hello, shim-ul, puntea de unelte DSH în chaturile Hello, marketul DSH și orice integrare de pluginuri DSH; actualizează docs/ARCHITECTURE.md și docs/PROVENANCE.md

## DSH Backward Gap — Group A (Quick Wins, pass-dsh-gap-2026-10-09)

- [x] T063 [!low] [#high] A1: Login-shell environment for apps launched from Finder or Dock: shell-env.ts reads $SHELL -l -i at startup, allowlist PATH/LANG/PROXY vars; used by command_run, Pi launch, MCP servers; fallback to augmentedPath on failure; unit tests (dsh-v0.2.0-rc.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2>
- [ ] T064 [!low] [#high] A2: file_search tool in the coding group: model searches the attached folder by content or names (no approval; confined to folder; reuses files/service.ts search; limits match Files > Contents; unit tests) (dsh pre-release) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.7>
- [ ] T065 [!low] [#high] A3: command_run: optional timeoutSeconds (default 30, max 600), output ring buffer (head 16 KB + rolling last 48 KB + omitted count), optional full log file saved to userData; approval card shows timeout; unit tests (dsh-v0.1.7-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
- [ ] T066 [!low] [#high] A4: file_read: range reads for files up to 50 MB (startLine/lineCount, max 2000 lines or 128 KB returned); large files without range return head + totalLines + hint; binary and symlink refusals unchanged; unit tests (dsh-v0.1.5-alpha.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-alpha.1>
- [ ] T067 [!medium] [#high] A5: Close button hides the window on macOS; app and all work continue; quit warns when something is running and names it (replies, workers/terminals, downloads, Voice install); HELLO_TEST_MODE unchanged; unit test for running-count text (dsh-v0.1.7-rc.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2>
- [ ] T068 [!low] [#medium] A6: Coding rules added to CODING_MANUAL: verify resolved target before rm/mv/cp-R/git-clean/git-reset; check effect after an interrupted or timed-out step; tool-definition snapshot updated; approvals unchanged (dsh-v0.2.0-rc.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2>
- [ ] T069 [!low] [#medium] A7: Files pane auto-refreshes when the model edits the open file: debounce 300 ms, only while pane is visible, scroll position and selection kept; optional fs.watch; no refresh loop; unit tests (dsh-v0.1.7-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
- [ ] T070 [!low] [#medium] A8: ask_person tool: model poses a question with 2-6 options or free text, optional timeout; appears in Needs your attention and sends a notification; Stop cancels; transcript shows question and answer after reload (dsh-v0.2.0-rc.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2>
- [ ] T071 [!low] [#high] OWNER DECISION — A9: Coder reads the folder AGENTS.md or CLAUDE.md as project instructions (Pi runs -nc today); per-chat switch; 32 KB cap; hash in session fingerprint; never in Chat mode; SECURITY.md paragraph; unit tests (dsh-v0.1.5-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1>

## DSH Backward Gap — Group B (Big Bets, pass-dsh-gap-2026-10-09)

- [ ] T072 [!medium] [#high] B1: Edit and resend a message, branch from a message, duplicate a chat: Pi fork/clone/get_fork_messages RPC; new chat on edit; Branch from here message menu; Duplicate chat row action; original chat unchanged; unit tests (dsh-v0.1.6-alpha.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.1>
- [ ] T073 [!high] [#medium] B2: Scheduled prompts (Automations): SQLite schedules table, once/every/cron with tz, chip in chat header, Schedules page, /schedule in composer, model tools schedule_create/list/cancel; depends on A5 close-hides-window (dsh-v0.1.7-rc.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2>
- [ ] T074 [!high] [#high] B3: Background jobs for long commands: command_run {background:true} returns {jobId,pane} immediately; live output in a labelled tool pane; job wakes the chat when it exits (exit code, last lines); job registry; unit tests (dsh-v0.1.7-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
- [ ] T075 [!medium] [#medium] B4: Changed-files card after each Coder reply: diff +/− counts per file, diff view in Files pane, restore previous version with confirmation, optional git-status summary; unit tests (dsh-v0.1.6-alpha.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2>
- [ ] T076 [!high] [#medium] B5: Seatbelt sandbox for command_run on macOS: writes confined to chat folder, TMPDIR and tool caches; reads everywhere except secrets; denial message with per-call escape hatch that always asks; settings toggle; SECURITY.md (dsh-v0.1.1-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.1-rc.1>
- [ ] T077 [!medium] [#medium] OWNER DECISION — B6: Auto review approval mode: reviewer model risk-classifies each action (low auto-approved with reason shown, medium/high escalated to person); hard-deny list; SECURITY.md (dsh-v0.1.6-alpha.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.1>
- [ ] T078 [!high] [#medium] B7: MCP streamable HTTP transport with bearer token; negotiate newer protocol versions; resources as three read-only tools; server instructions in group manual; evaluate Pi 1.1 built-in MCP first before implementing (dsh-v0.1.6-alpha.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.1>
- [ ] T079 [!medium] [#medium] B8: Vision capability per model read from the provider listing (OpenRouter/LM Studio/Ollama/llama.cpp) with a manual switch; text-only models get input ['text'], composer warns, screenshot skips image; resize attachments to max 2048 px; unit tests (dsh-v0.1.6-alpha.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2>
- [ ] T080 [!low] [#low] N1: Title-bar double-click zooms or minimizes the window per macOS System Preferences AppleActionOnDoubleClick (check in the app first; close as no-op if it already works) (nativ#692) <https://github.com/Blaizzy/nativ/pull/692>

## DSH Backward Gap — Group C (Low Priority, pass-dsh-gap-2026-10-09)

- [ ] T081 [!low] [#low] C09: read_image tool in the coding group: model views image files in the attached folder (downscaled to 512 px, scale reported in result) (dsh-v0.1.1-rc.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.1-rc.2>
- [ ] T082 [!low] [#low] C12: Approval reason: the model writes why it is requesting this action on the approval card, in the person's language (dsh-v0.1.7-rc.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2>
- [ ] T083 [!medium] [#low] C13: Goal mode: /goal command keeps the model working toward a stated goal across turns; person pauses or resumes; goal bar in the chat header (dsh-v0.1.5-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1>
- [ ] T084 [!medium] [#low] C14: Plan review gate: model submits a plan and the person approves or edits it before any tool that changes files runs (dsh-v0.1.6-alpha.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2>
- [ ] T085 [!medium] [#low] C15: Persistent shell session between command_run calls: cwd and env carry over across calls in the same chat (dsh-v0.1.2-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1>
- [ ] T086 [!medium] [#low] C16: Codemode/PTC: model runs scripts that call several tools and return only the reduced result via Pi's built-in codemode (dsh-v0.1.7-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
- [ ] T087 [!medium] [#low] C17: Agent presets beyond Chat/Coder: own system prompt, default tool groups, a guide and example tasks per mode (dsh-v0.1.7-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
- [ ] T088 [!low] [#low] C18: Make a skill with the agent entry in Settings > Extensions: opens a new chat with skill-creator loaded and a drafted request (dsh-v0.2.1-alpha.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.1>
- [ ] T089 [!high] [#low] C19: Agent Teams: a lead chat with named teammate chats, a team panel and a shared task board (dsh-v0.1.7-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
- [ ] T090 [!high] [#low] C20: Computer use: desktop screenshots and input events driven through an MCP computer-use driver (dsh-v0.1.7-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
- [ ] T091 [!high] [#low] C21: Remote workspace over SSH: file_read, file_edit and command_run tools operating on a remote host (dsh-v0.1.7-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
- [ ] T092 [!medium] [#low] C22: Run a Hello chat headless from the command line: task on stdin, --session flag, NDJSON event stream output (dsh-v0.1.6-alpha.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.1>
- [ ] T093 [!high] [#low] C23: ACP (Agent Client Protocol) support for Hello chat sessions (dsh-v0.1.2-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1>
- [ ] T094 [!medium] [#low] C24: GitHub webhook events create a chat: a PR or issue opened/updated triggers a new conversation (dsh-v0.1.2-alpha.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.1>
- [ ] T095 [!medium] [#low] C28: Images inline in chat: local images from folder/attachments/absolute paths shown with a lightbox; remote images shown only on explicit click to guard against exfiltration (dsh-v0.1.7-rc.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2>
- [ ] T096 [!low] [#low] C29: TeX/LaTeX math in Markdown via remark-math and KaTeX with fonts bundled under the CSP (dsh pre-release) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.7>
- [ ] T097 [!medium] [#low] C30: Diagram code blocks rendered in chat: Mermaid, Graphviz and SVG with fullscreen and zoom controls (dsh-v0.1.6-alpha.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.1>
- [ ] T098 [!medium] [#low] C31: Turn navigation rail for long chats: jump to any turn with previews; always visible in long transcripts (dsh-v0.1.2-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1>
- [ ] T099 [!low] [#low] C32: Wrap toggle on code blocks (copy button already exists; adds a wrap/no-wrap toggle) (dsh-v0.1.7-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
- [ ] T100 [!low] [#low] C33: Work-detail density setting: compact / detailed / always-expanded tool steps; persists in AppSettings (dsh-v0.1.7-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
- [ ] T101 [!low] [#low] C34: Per-reply tokens/s and cache-read share shown on the usage line from Pi session stats; a setting for how much is shown (dsh-v0.1.7-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
- [ ] T102 [!medium] [#low] C35: Readable cards instead of raw JSON for notebook/plan/browser/worker tool results in the transcript (dsh-v0.1.7-alpha.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-alpha.1>
- [ ] T103 [!low] [#low] C36: Progressive detail while a tool call's arguments are still streaming: show path or command name before the full JSON arrives (dsh-v0.1.7-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
- [ ] T104 [!low] [#low] C37: Reasoning and compaction section headers stay pinned at the top while their content is scrolled (dsh-v0.1.6-alpha.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.1>
- [ ] T105 [!low] [#low] C38: Link marks in the transcript: favicons for known sites; distinct visual styles for file, web and artifact links (dsh-v0.1.6-alpha.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2>
- [ ] T106 [!low] [#low] C39: A skill invoked with / shows as a collapsible card in the transcript, not a raw prefix string (dsh-v0.1.3-alpha.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1>
- [ ] T107 [!medium] [#low] C40: @-reference another chat in the composer: the model reads that chat's transcript when answering (dsh-v0.1.3-alpha.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.2>
- [ ] T108 [!low] [#low] C41: Attachments on queued and steer messages (chat.queue carries only text today; add file support) (dsh-v0.1.2-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1>
- [ ] T109 [!medium] [#low] C42: Attach any file type as a saved copy the model reads by path (generic attachment; overlaps document-layer owner decision for docs) (dsh-v0.1.5-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1>
- [ ] T110 [!medium] [#low] C43: File-delivery cards: model presents files it produced with open, reveal in Finder and preview actions under its answer (dsh-v0.1.7-alpha.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-alpha.1>
- [ ] T111 [!low] [#low] C44: Chat titles written automatically by the model; a person's manual rename overrides and is preserved (dsh-v0.2.0-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1>
- [ ] T112 [!low] [#low] C45: Export with images: Markdown export includes attached and generated media, or Pi export_html (dsh pre-release) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.7>
- [ ] T113 [!low] [#low] C46: Pin chats to the top of the sidebar; pinned chats survive reorder (dsh-v0.1.7-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
- [ ] T114 [!medium] [#low] C47: Archive chats: sidebar filter (hide archived / show all / archived only); restore; running work stopped before archive with confirmation (dsh-v0.1.7-rc.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2>
- [ ] T115 [!low] [#low] C48: Group chats by folder in the sidebar with collapsible sections (dsh-v0.1.6-alpha.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2>
- [ ] T116 [!low] [#low] C49: Clipped chat title shows in full on hover (tooltip) in the sidebar (dsh-v0.1.7-alpha.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-alpha.1>
- [ ] T117 [!low] [#low] C50: Order chats by hand (drag-to-reorder) in the sidebar; persisted in the database (dsh pre-release) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.7>
- [ ] T118 [!low] [#low] C52: Image and PDF preview in the Files pane: images with pan and zoom; PDF through Chromium's viewer; no extra download (dsh-v0.1.7-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
- [ ] T119 [!high] [#low] C53: Office and CSV/TSV previews in the Files pane: Word, Excel (sheets, cells, formulas), PowerPoint, CSV as a sortable table; builds on document-layer decision (dsh-v0.1.7-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
- [ ] T120 [!low] [#low] C54: YAML front matter shown as a list of fields in the Markdown file preview (dsh-v0.2.1-alpha.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.1>
- [ ] T121 [!low] [#low] C55: Open in…: open the chat folder in a detected editor, IDE, terminal or Finder; last chosen app remembered (dsh-v0.2.0-rc.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2>
- [ ] T122 [!low] [#low] C56: Open With another app for a file in the Files pane or downloads list (dsh-v0.1.7-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
- [ ] T123 [!medium] [#low] C58: Anthropic Messages protocol for a connection: native Messages API, model lists, URL examples per protocol; Pi models.json api anthropic-messages (dsh-v0.1.7-alpha.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-alpha.1>
- [ ] T124 [!low] [#low] C59: Proxy variables honoured for all outbound requests: HTTP(S)_PROXY/ALL_PROXY/NO_PROXY passed to Pi child, market, npm installs and Voice model downloads (dsh-v0.1.5-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1>
- [ ] T125 [!low] [#low] C60: Readable model display names in discovered model lists; raw id shown on hover (dsh-v0.1.7-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
- [ ] T126 [!medium] [#low] C61: Customize and reset keyboard shortcuts in Settings (Hello's shortcut list is read-only today) (dsh-v0.1.7-rc.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2>
- [ ] T127 [!low] [#low] C62: Keyboard shortcuts for Stop and for Allow/Deny on a pending approval card (dsh-v0.1.7-alpha.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-alpha.1>
- [ ] T128 [!low] [#low] C63: Diagnostics: redacted rotated log file in userData; Reveal logs in Settings > App; recovery dialog when the renderer process crashes (render-process-gone has no handler today) (dsh-v0.1.7-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
- [ ] T129 [!low] [#low] C64: Developer: reveal and inspect a chat's Pi session JSONL log and its raw event stream from the chat row menu (dsh-v0.2.1-alpha.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.1>
- [ ] T130 [!low] [#low] C65: First-run guide: pick a connection, choose Chat or Coder mode, see example tasks; guide can be resumed from Settings (dsh-v0.1.7-rc.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2>
- [ ] T131 [!low] [#low] C66: Chat links and Sources open in Hello's browser as a new Off-control tab; setting to prefer system browser vs in-app (today all go to openExternal) (dsh-v0.1.7-rc.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2>
- [ ] T132 [!low] [#low] C67: Choose the terminal shell per terminal tab; shell choice remembered per tab (dsh-v0.2.0-rc.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2>
- [ ] T133 [!high] [#low] C68: Split tools pane: two tool surfaces displayed side by side within one chat (dsh-v0.1.5-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1>
- [ ] T134 [!high] [#low] C69: Interface language selection in Settings (dsh-v0.1.2-rc.1) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1>
- [ ] T135 [!low] [#low] C70: hello launcher on the command line: opens a folder as a new chat directly from the terminal (dsh-v0.2.0-rc.2) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2>
- [ ] T136 [!low] [#low] C71: Confirmation dialog before switching approval mode to Work without asking (dsh pre-release) <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.7>

## Decizii owner 09.10 — variante reduse (înlocuiesc T067, T069, T071, T072, T079)

- [x] T137 [!medium] [#high] B8 bază: capabilitatea vision per model citită din listarea pe care Hello o parsează deja pentru context window (OpenRouter, LM Studio); modelele text-only primesc input ['text'] și composerul avertizează la imagini/screenshot; fără comutator manual, fără redimensionare la 2048 px; unit tests <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2>
- [ ] T138 [!low] [#medium] A5 mic: avertismentul la închidere numără și răspunsurile în curs, nu doar terminalele, și le numește; închiderea care ascunde fereastra NU se face acum; HELLO_TEST_MODE neschimbat; unit tests <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2>
- [ ] T139 [!low] [#medium] A7 mic: Files pane reîncarcă fișierul deschis doar la evenimentele file_edit/file_write ale modelului pe acel fișier; fără fs.watch; scroll și selecția păstrate; fără buclă de refresh; unit tests <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1>
- [ ] T140 [!low] [#medium] B1 cinstit: scoate butonul cosmetic Edit de pe mesaj (schimbă doar ecranul, revine după reload, modelul nu vede editarea); Use as draft rămâne calea; fără branching prin fork-ul Pi; teste actualizate <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.1>
- [ ] T141 [!medium] [#medium] A9 minimal: în modul Coder, Pi primește ca instrucțiuni de proiect AGENTS.md sau CLAUDE.md doar din rădăcina folderului atașat, maxim 32 KB; niciodată în Chat (modul Chat e switch-ul, fără switch separat); SECURITY.md notează riscul: instrucțiunile unui repo străin devin ale modelului, iar aprobările sunt permisive implicit; unit tests <https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1>
