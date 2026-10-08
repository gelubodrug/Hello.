# Tasks: Blaizzy/nativ PR Monitoring for Hello.

## Pass 2026-10-07 — Proposals from Analyst (10 tasks)

### Phase 1 — Actionable Now (no owner decision needed)

- [x] T001 [P] [US3] Elimina new Date() din src/main/chat/pi-instructions.ts — data exista deja in liveContext snapshot (nativ #680; pi-instructions.ts:56)
- [x] T002 [P] [US3] Restrange fingerprint AppSettings in src/main/chat/service.ts la campurile care intra in prompt — exclude appearance/approvals/connections/temperature/reasoningEffort daca nu afecteaza helloSystemPrompt (nativ #680; service.ts:1519-1531)
- [x] T003 [P] [US3] Activeaza tools_find pentru bridge-ul CLI — adauga getCatalog in src/main/terminal/notebook-context.ts (nativ #490; notebook-context.ts:234-240, pi-extension.ts:307-313)
- [ ] T004 [P] [US3] Scrieri atomice safe cu symlink-uri — resolve symlink inainte de renameSync/writeFileSync la: src/main/data/store.ts:1118, src/main/market/service.ts:151, src/main/market/install.ts:148, src/main/terminal/report-channel.ts:208, src/main/terminal/cli-workers.ts:251/340/433, src/main/dsh/service.ts:173/306 (nativ #642)

### Phase 2 — Necesita decizie owner

- [ ] T005 [US3] DECIZIE OWNER: Extinde filtrul secretPath la toate entry point-urile de atasamente (nu doar file_read) — implica refuz .env din composer; src/main/chat/attachments.ts, tools.ts:759/777/1154 (nativ #634)
- [ ] T006 [US3] DECIZIE DEPENDENTA: Layer extragere documente PDF/docx/xlsx/epub/ipynb/odt — subsumeaza todo-ul fetch_url PDF; src/main/chat/attachments.ts:30-31, tools.ts:1174-1183, web-tools.ts:79-81 (nativ #647)
- [ ] T007 [US3] DECIZIE TOKENI: Budget atasamente derivat din contextWindow modelului cu water-filling — cost asteptat ~40% mai multi tokeni de prompt; src/main/chat/attachments.ts:8-11, service.ts:2070 (nativ #639)
- [ ] T008 [US3] GAP SECURITATE: MCP server folder scoping — requiresFolder flag + path policy identica cu native tools; src/main/extensions/mcp.ts:115, docs/SECURITY.md:187-188 (nativ #634)

### Phase 3 — Prioritate redusa

- [ ] T009 [US2] Marker vizual in transcript la punctul de compactare cu numarul de tokeni inainte/dupa — compact RPC returneaza deja tokensBefore/estimatedTokensAfter; ContextMeter.tsx:10-11, pi-session.ts:198-199 (nativ #655)
- [ ] T010 [US2] Drag-reorder tab-uri work-pane — necesita ordine persistata in DB inainte de drag handlers; ToolTabStrip.tsx (nativ #663)

## pass-2026-10-08-001

- [x] T011 [!medium] Bugetul de context: un contextScale invatat poate face un chat salvat sa refuze pornirea (pi-session.ts:147 vs store.ts:905). Valideaza fereastra efectiva si scurteaza raspunsul in loc sa refuzi pornirea (nativ#684).
- [x] T012 [!low] Settings: un Try again pe eroarea de citire a serverului - askAgain exista, butonul lipseste (SettingsDialog.tsx:521). Ca Retry-ul din market (nativ#690).
- [x] T013 [!low] Market: un cod out-of-space pe MarketInstallError - o instalare care moare cu ENOSPC spune acum doar pnpm could not install (pi-install.ts:181) (nativ#689).

## Pass 2026-10-08-004 — Proposals from Analyst (PR #416)

- [x] T014 [!medium] [#high] Subagent context window: a different subagentModel inherits the chat model's learned contextScale and window — declare it with its own limits floor instead (pi-session.ts:135-141,180-194) (nativ#416) <https://github.com/Blaizzy/nativ/pull/416>
- [x] T015 [!low] [#medium] Subagent model validation: a free-text subagentModel id is never checked against the probed list — show inline notice at save and fall back to chat model at launch (SettingsDialog.tsx:613-637, pi-session.ts:191) (nativ#416) <https://github.com/Blaizzy/nativ/pull/416>
- [x] T016 [!minimal] [#low] Pi CLI connection guide: update the HELLO.md tool-availability sentence in notebook-context.ts — the gating change means CLI starts with only tools_find, not notebook/browser tools at startup
- [x] T017 [!low] [#low] Background subagent fan-out: surface pi-subagents extensionUi statuses in the chat while a fan-out runs, or close as nothing-to-surface if none are emitted (service.ts:1765-1800) (nativ#416) <https://github.com/Blaizzy/nativ/pull/416>  <!-- the sibling app: run 01a11cf9-349a-7b10-bd0e-b02f298ee6c2 -->

## Pass 2026-10-08-004 — Voice proposals from Analyst (PR #691)

- [ ] T018 [!medium] [#high] Voice V1 — Dictate into the composer: mic → local STT → draft text inserted at caret (permission handler, IPC voice.transcribe, MediaRecorder Mic button per §Composer, SettingsDialog STT fields, unit tests for permission denial and size cap) (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
- [ ] T019 [!low] [#high] Voice V2 — Discover voice server and keep audio servers out of chat model list: probe GET /v1/audio/voices to separate voice from chat; guard chat listModels against mlx-audio/Kokoro-FastAPI/speaches on port 8000 (local-servers.ts, voice/servers.ts new, service.ts guard, regression test) (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
- [ ] T020 [!medium] [#medium] Voice V3 — Speak the reply: local Piper TTS playback (CSP media-src blob:, voice/speak.ts new supporting both Piper /synthesize and OpenAI /v1/audio/speech shapes, per-message speak/stop control, sentence-chunked streaming, unit tests) (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
- [ ] T021 [!low] [#medium] Voice V4 — Voice on/off and sidebar AudioLines affordance: dictation and spoken replies toggle independently, persist in AppSettings.voice, sidebar footer row per design guide §Sidebar footer (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
- [ ] T022 [!low] [#low] Voice V5 — Microphone usage description for a packaged build: add NSMicrophoneUsageDescription to package.json build.mac.extendInfo; entitlements file only if owner moves off target:dir to signed hardened-runtime (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>

## Pass 2026-10-08-004 — Voice revised (P1–P6, supersedes T018–T022)

- [ ] T023 [!low] [#high] Voice P1 — Audio-only media grant: replace blanket callback(false) in index.ts:162 with audio-only predicate (main frame, audio not video, app origin); setPermissionCheckHandler; askForMediaAccess darwin; media-src blob: in CSP; NSMicrophoneUsageDescription in package.json; SECURITY.md companion sentence; predicate exported and unit-tested (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
- [ ] T024 [!medium] [#high] Voice P2 — Automatic voice turn: voice/translate.ts two-shaped (whisper.cpp multipart translate=true on /inference; OpenAI /v1/audio/translations); IPC hello:voice.translate; Mic button composer idle/listening/working; VAD auto-stop 900 ms silence; bytes to send() not setDraft; nothing-said guard; half-duplex with TTS; unit tests (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
- [ ] T025 [!low] [#high] Voice P3 — Server discovery: two-probe classify port as (a) GET /v1/audio/voices OpenAI-shaped voice, (b) GET /load or OPTIONS /inference whisper.cpp; voice-only excluded from chat LocalServer[]; service.ts listModels guard against Kokoro voice ids; Settings shows found server or none; regression test (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
- [ ] T026 [!low] [#high] Voice P4 — STT model comparison: run Romanian clips through whisper-cli --translate -l ro for ggml-large-v3, ggml-large-v3-turbo and ggml-medium; output table with wall-clock and peak RSS; chosen default + reason in docs/PROVENANCE.md; no model downloaded without owner approval; gates P2 default config (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
- [ ] T027 [!medium] [#medium] Voice P5 — Kokoro TTS reply playback: voice/speak.ts POST /v1/audio/speech two-shaped (mlx-audio vs Kokoro-FastAPI); IPC hello:voice.speak; auto-play on reply complete when Voice on; sentence-chunked playback; stop drains queue; Escape and conversation-switch stop; prose only; mic closed while speaking; unit tests (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
- [ ] T028 [!low] [#medium] Voice P6 — One voice switch: AppSettings.voice { enabled, sttEndpointUrl, sttModel, sourceLanguage, ttsEndpointUrl, ttsVoice }; sidebar AudioLines row rendered when disabled with title reason; SettingsDialog Voice section (P3 server, STT model, language, TTS voice, macOS mic status P1); Mic disabled but rendered when Voice off; persists on restart; clears on connection change (nativ#691) <https://github.com/Blaizzy/nativ/pull/691>
