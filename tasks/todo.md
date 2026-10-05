# Hello. — ce e deschis (05.10.2026)

Doar ce e încă deschis. Istoricul — planul DSH pe faze, jurnalele, reparațiile, auditurile
și reviziile — e în `docs/archive/tasks-todo-2026-10-05.md`: e istorie, nu sarcini. Ce face
aplicația acum: `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/PROVENANCE.md`.

## De decis (utilizatorul)

- [ ] Publicarea pe npm a `hello-dsh` (tema Hello pentru DSH Desktop) și a șablonului de plugin: contul tău.
- [ ] Subagenții pi-subagents rulează cu uneltele Pi (bash, edit, write) fără aprobările Hello. Îi
      restrânge Hello (de exemplu `subagents.agentOverrides` cu tools)?
- [ ] Butonul primar e albastru în repaus: așa e în referința aprobată, revizia S202 l-a semnalat.
- [ ] Checkpoint-urile aplicația-soră (`the tooling’s checkpoint refs`): păstrate sau șterse.
- [ ] O cheie OpenRouter (`HELLO_QA_API_KEY`) e comisă în primele rânduri din `.gitignore`, din 10.09:
      de rotit la OpenRouter și de mutat în `.env` (ignorat); istoricul git o păstrează.
- [ ] Fluxurile aplicația-soră „hello feature hunt and implement” (a698845e) și cercetarea continuă (b90744fd)
      citesc `docs/MINI-ROADMAP.md`, `docs/feature-research/` și `docs/research-flow/`, mutate în
      `docs/archive/` la 05.10: briefurile lor trebuie schimbate în aplicația-soră.
- [ ] Istoricul unui chat cu browsing pe calea Pi: opțiunile A–D din
      `docs/archive/research-flow/PI-PATH-2026-09-28.md` sunt nedecise (e făcută doar scurtarea la seed).

## Tehnic

- [ ] Împachetarea (`pnpm package:mac`) e neverificată: `extraResources` `dsh/`, pnpm și esbuild
      despachetate din asar (`ESBUILD_BINARY_PATH`). La ultima încercare electron-builder nu găsea
      `@mariozechner/clipboard`; probabil trebuie un `pnpm install` curat după urcările Pi.
- [ ] `PI_VERSION` din market (`src/main/market/pi-install.ts`) e 0.87.1, deși Hello rulează Pi 1.0.x.
- [ ] Hook-urile de sesiune dsh peste Pi: recall-ul și captura dsh-memory-plugin în chaturile Hello,
      cu opțiunea per chat „nu captura acest chat”.
- [ ] Marketul DSH: căutare pe mai multe categorii deodată, reordonarea surselor, scanarea completă dshfind.
- [ ] Suprafața DSH ca tab în panoul de unelte, pe lângă vederea din sidebar.
- [ ] dsh 0.2.x stabil: pini exacți, procedura de upgrade, pluginurile de top reverificate (tema Hello
      și shim-ul sunt făcute pentru 0.1.7-rc.2).
- [ ] Bugetul de memorie și CPU al gazdei DSH.
- [ ] Extensii Pi: un `require()` CommonJS al modulelor date de Pi într-un pachet împachetat; „Found on
      this Mac” poate lista o extensie pe care importul o refuză.
- [ ] `fetch_url` nu citește PDF-uri.
- [ ] WebGPU în tab-urile Hello (`navigator.gpu`): manualul de browser, embeddings locale.
- [ ] `/review` al unui șablon de prompt poate fi luat de meniul `/` când un skill conține cuvântul.
- [ ] Întrebările pi-subagents cu pas următor (Change model / thinking) se închid fără continuare:
      Pi nu trimite acel ecran prin RPC.
- [ ] Opțional: un layout Hello pentru clientul dsh și o descărcare mai mică (motorul office, 147 MB).

## Limitări cunoscute

- Low/Medium/High ajung la MTPLX doar ca „gândire pornită”; `reasoning_effort` nu e trimis (Kimi la fel).
- Extensia OpenViking publicată nu se importă: nu are `pi` în package.json; merge doar împachetată.
- Files › Contents caută literal: un text scris cu diacritice descompuse (NFD) nu se potrivește cu unul tastat
  compus (NFC), iar o linie a cărei literă mică își schimbă lungimea (de exemplu „İ”) e căutată doar așa cum e scrisă.

## De verificat în aplicație (utilizatorul)

- [ ] Auditul UI din 05.10 (toate șase sunt implementate, testate unitar, neverificate în aplicație):
      „Needs your attention” cu două aprobări în chaturi diferite și o întrebare de plugin cât Notebook sau
      DSH acoperă chatul, apoi „Open request”; diff-ul la o aprobare `file_edit`; Settings › App › Appearance;
      ⌘⇧P „Go to…”; `@nume` în composer; Files › Contents (Match case, click pe un rezultat), apoi
      „Add selection to chat” din bara Files și din click dreapta, inclusiv cu Chat minimizat.
- [ ] Modelul per chat: două chaturi pe modele diferite, unul pornit în timp ce celălalt răspunde.
- [ ] 05.10: meniurile, rezumarea, overlay-ul ⌘/, focusul după Edit, dialogurile, „Open tools”,
      secțiunile Notebook oprite într-un chat nou, tabul „Chat”, click dreapta în browser.
- [ ] 04.10: timpul de lucru, „Summarise now”, tastele, Save to Runbook, Usage în Settings › App.
- [ ] DSH: update la 0.2.0-rc.2 și înapoi, Settings › Appearance în DSH, chatul extins și înapoi.
- [ ] Pi: update și înapoi, tabul Pi (tema aplicația-soră), un plugin care pune o întrebare, o instalare reală
      din Pi market.
- [ ] CLI-uri: Claude Code și Codex văd uneltele `hello`; Qwen Code, OpenCode și Pi CLI pe modelul
      local; un CLI care citește și apasă într-un tab; repornirea cu un CLI ca tab de chat.
- [ ] Browser: marks după repornire; „smarbill.ro” în bara de adrese, apoi Back.
- [ ] Meniul `/` și o descărcare reală de pe skills.sh.
- [ ] S209: ↑/↓ în composer; ⌘1–9, ⌘⇧] / ⌘⇧[ și ⌘J (și cu terminalul sau o pagină în focus); căutarea
      din Notebook; ⌘V cu o captură de ecran și cu un fișier din Finder, „Attach files…”; ⌘F în terminal,
      inclusiv cu output care curge și într-un program pe tot ecranul (vim, less).
