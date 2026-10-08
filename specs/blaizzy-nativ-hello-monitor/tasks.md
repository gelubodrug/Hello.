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
- [ ] T015 [!low] [#medium] Subagent model validation: a free-text subagentModel id is never checked against the probed list — show inline notice at save and fall back to chat model at launch (SettingsDialog.tsx:613-637, pi-session.ts:191) (nativ#416) <https://github.com/Blaizzy/nativ/pull/416>
- [ ] T016 [!minimal] [#low] Pi CLI connection guide: update the HELLO.md tool-availability sentence in notebook-context.ts — the gating change means CLI starts with only tools_find, not notebook/browser tools at startup
- [ ] T017 [!low] [#low] Background subagent fan-out: surface pi-subagents extensionUi statuses in the chat while a fan-out runs, or close as nothing-to-surface if none are emitted (service.ts:1765-1800) (nativ#416) <https://github.com/Blaizzy/nativ/pull/416>
