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
- [ ] T029 [!high] [#high] Voice P7 — Hello manages Whisper model and server: downloads ggml-large-v3-turbo on consent (size shown), sha256-pinned, symlink-refused via the atomic-write helper; spawns whisper-server on loopback-minted port, supervised backoff+give-up, killed on before-quit; found server reused not touched; IPC hello:voice.prepare; Settings 3-state row; amends SECURITY.md and NSMicrophoneUsageDescription; unit tests for model-store and server supervisor (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>

## Din tasks/todo.md (09.10) — Tehnic

- [ ] T030 [!medium] [#high] Împachetarea pnpm package:mac neverificată: extraResources dsh/, pnpm și esbuild despachetate din asar (ESBUILD_BINARY_PATH); electron-builder nu găsea @mariozechner/clipboard — probabil pnpm install curat după urcările Pi
- [ ] T031 [!low] [#high] PI_VERSION din src/main/market/pi-install.ts e 0.87.1, deși Hello rulează Pi 1.0.x — aliniază-l
- [ ] T032 [!high] [#medium] Hook-urile de sesiune dsh peste Pi: recall și captură dsh-memory-plugin în chaturile Hello, cu opțiunea per chat „nu captura acest chat”
- [ ] T033 [!medium] [#low] Marketul DSH: căutare pe mai multe categorii deodată, reordonarea surselor, scanarea completă dshfind
- [ ] T034 [!medium] [#low] Suprafața DSH ca tab în panoul de unelte, pe lângă vederea din sidebar
- [ ] T035 [!medium] [#medium] dsh 0.2.x stabil: pini exacți, procedura de upgrade, pluginurile de top reverificate (tema Hello și shim-ul sunt pentru 0.1.7-rc.2)
- [ ] T036 [!medium] [#low] Bugetul de memorie și CPU al gazdei DSH
- [ ] T037 [!medium] [#medium] Extensii Pi: require() CommonJS al modulelor date de Pi într-un pachet împachetat; „Found on this Mac” poate lista o extensie pe care importul o refuză
- [ ] T038 [!medium] [#low] WebGPU în tab-urile Hello (navigator.gpu): manualul de browser, embeddings locale
- [ ] T039 [!low] [#medium] /review al unui șablon de prompt poate fi luat de meniul / când un skill conține cuvântul
- [ ] T040 [!medium] [#low] Întrebările pi-subagents cu pas următor (Change model / thinking) se închid fără continuare: Pi nu trimite acel ecran prin RPC
- [ ] T041 [!medium] [#low] Opțional: un layout Hello pentru clientul dsh și o descărcare mai mică (motorul office, 147 MB)
- [ ] T042 [!low] [#low] Limitare: Low/Medium/High ajung la MTPLX (și Kimi) doar ca „gândire pornită”; reasoning_effort nu e trimis
- [ ] T043 [!low] [#low] Limitare: extensia OpenViking publicată nu se importă (nu are pi în package.json); merge doar împachetată
- [ ] T044 [!medium] [#low] Limitare: Files › Contents caută literal — normalizează NFC + case fold cu İ↔i și offseturi mapate înapoi, ca ⌘F din chat

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
