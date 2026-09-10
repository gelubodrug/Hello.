# Hello. — ghid de reutilizare din aplicația-soră

9 septembrie 2026. Actualizat pentru [mini-roadmap, revizia 4](MINI-ROADMAP.md#ordinea-concreta-de-implementare). **Decizia proprietarului este preluarea chatului Pi headless cu tools.** Orchestrarea, raportarea și integrarea avansată a workerilor sunt o dezvoltare ulterioară separată.

Ambele aplicații aparțin proprietarului, care a autorizat preluarea codului util. Donorul este `sibling-app`, consultat read-only. HEAD observat în această trecere: `135fb998599b3bcc2a87033ea8376e70b6a297de`; fișierele din working tree pot avea modificări necomise. Nu au fost consultate sau copiate date de utilizator, sesiuni sau credentiale aplicația-soră.

**Stare:** transportul, adaptorul de evenimente, bridge-ul și serviciul chat sunt integrate în sursă; validarea manuală este încă necesară. Nici această listă, nici verificarea statică nu sunt dovadă de funcționare live.

## Ce preluăm acum

| Punct donor | Adaptare Hello. | De ce contează |
| --- | --- | --- |
| [pi_agent.rs](sibling-app/src-tauri/src/cmd/pi_agent.rs), registrul RPC și scrierea JSONL | [PiRpcProcess](../src/main/chat/pi-rpc.ts) | Un proces persistent per chat; argv fără shell; comenzi corelate; timeout și închidere cu procesul deținut explicit. |
| [piAgentRunner.ts](sibling-app/src/runtime/piAgentRunner.ts), reducerea evenimentelor | [PiEventMapper](../src/main/chat/pi-events.ts) | Text, thinking și tool-uri în ordinea reală; evenimentele finale completează deltele; usage raportat rămâne distinct de estimare. |
| [piRpcFlag.ts](sibling-app/src/runtime/piRpcFlag.ts), prompt/steer/follow-up/abort | [pi-rpc.ts](../src/main/chat/pi-rpc.ts) și [ChatService](../src/main/chat/service.ts) | Refolosim protocolul Pi; nu construim încă o coadă/model loop Hello. UI-ul complet de Queue/Steer poate veni ulterior. |
| Pattern-ul extensiilor headless aplicația-soră și tools Hello. deja adaptate | [helloTools](../src/main/chat/pi-extension.ts) + [createPiToolBridge](../src/main/chat/pi-tool-bridge.ts) | Pi cere operația; main-ul Hello. verifică identitatea conversației, aprobarea și permisiunea browserului înainte de execuție. |
| Pi instalat, [docs/rpc.md](sibling-app/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md) | Dependență fixată `@earendil-works/pi-coding-agent@0.85.1` | Contractul efectiv al versiunii folosite, separat de comentarii vechi sau alte versiuni ale donorului. |

Transportul Tauri/Rust devine Node/Electron. Renderer-ul, SQLite, preload-ul și browserul Hello. rămân ale aplicației. Nu importăm shell-ul aplicația-soră, assistant-ui, ledger-ul, bridge-ul de workers sau resursele orchestratorului.

## Contractul de integrare

**Sesiune.** Procesul Pi este cald pe durata folosirii chatului; sesiunea JSONL v3 este în datele proprii Hello. Istoricul existent Hello. se importă o singură dată, cu mesajele SQLite păstrate. La turele următoare trimitem mesajul nou, nu reconstruim mereu istoricul din SQLite. Schimbările de configurație incompatibile cu un proces cald trebuie să-i invalideze identitatea. Refolosirea sesiunii nu înseamnă reluarea automată a efectelor întrerupte.

**Evenimente.** Confirmarea `prompt` înseamnă acceptare. `agent_end` poate preceda retry sau compactare; `agent_settled` încheie efectiv rularea. Thinking-ul este doar cel furnizat de model. Fazele de lucru sunt tranzitorii; consumul input/output raportat se păstrează. Costul necunoscut nu se afișează drept zero. Un răspuns final nu este o verificare independentă a rezultatului.

**Stop.** Serviciul chat închide acum procesul Pi deținut și anulează lucrul din bridge; următoarea cerere redeschide sesiunea persistentă. Metoda de abort grațios din transport, dacă este folosită, trimite `clear_queue` înainte de `abort`, ca mesajele rămase să nu pornească ulterior. Ștergerea conversației și ieșirea aplicației eliberează procesul și bridge-ul, fără să depindă de montarea UI-ului. Ascunderea panoului nu este terminare.

**Tool-uri și resurse.** Pentru Pi 0.85.1, `-nc` oprește încărcarea AGENTS.md/CLAUDE.md; descoperirea extensiilor, skills și prompt templates are flag-uri separate (`-ne`, `-ns`, `-np`). `--no-builtin-tools` dezactivează tool-urile native, iar extensia Hello. se încarcă explicit. `--no-tools` nu este echivalent: ar elimina și tool-urile extensiei. Browserul păstrează Off/Read/Full per tab; fișierele/comenzile păstrează aprobările existente. Nu activăm implicit extensii sau skills globale ale utilizatorului prin simpla instalare a Pi.

**Model și compactare.** Context inițial 32.768, output 4.096 tokeni, configurabile după server; compatibilitate `auto`, `openai` sau `qwen-chat-template`. Rezerva este `max(16384, output + 4096)`. Compactarea Pi pornește peste `context - reserve`: implicit 16.384 tokeni estimați, adică 50% pentru acest profil. `keepRecentTokens = min(20000, floor(context / 4), floor((context - reserve) / 2))`; configurația trebuie să lase istoric suficient. Nu preluăm automat pragurile Context Governor aplicația-soră și nu scriem un compactor paralel. Valorile nu detectează limitele reale ale serverului.

**Chei.** Hello. folosește propriile setări securizate. Cheia modelului și tokenul bridge-ului sunt în mediul procesului copil, nu în argv, renderer, transcript sau fișierul Pi de modele. Nu importăm autentificarea aplicația-soră ori a CLI-urilor independente.

## Demonstrația următoare

Prima verificare este promptul real care a răspuns greșit în Hello. și corect în CLI, cu același model, endpoint și materiale. Se verifică răspunsul la cerere, tool-urile folosite, consumul, aprobările, Stop, continuarea aceleiași sesiuni după restart și compactarea. Nu promitem un rezultat mai bun doar prin schimbarea motorului.

Apoi livrăm activarea extensiilor în Settings, skills și un conector MCP concret. Pi poate furniza mecanisme reutilizabile; UI-ul acestor funcții și adaptorul MCP trebuie încă integrate. O extensie este cod executabil; o bifă de activare nu îi oferă un sandbox. Nu declarăm paritate cu toate CLI-urile.

În fluxul dev curent, utilizatorul face testarea aplicației. Nu au fost pornite teste, build-uri, model calls sau restart-uri pentru portare. Typecheck fără emitere este separat; instalarea dependenței nu este invocarea unui agent.

## Ce rămâne doar referință pentru mai târziu

[Comparația inițială](feature-research/INTERNET-RESEARCH-2026-09-09-r1.md) și [roadmap r3 arhivat](archive/MINI-ROADMAP-2026-09-09-r3.md) păstrează cercetarea care a precedat schimbarea direcției.

| Candidat aplicația-soră | Stare în Hello. |
| --- | --- |
| `contextUsage.ts`, `ContextWindowRing.tsx`, `context-governor.ts` | Referințe pentru indicatori/output recuperabil dacă apare nevoia; fără al doilea compactor peste Pi. |
| `steerPersistence.ts`, UI Queue/Steer | Poate completa interfața Pi după validarea motorului; fără reconstruirea protocolului. |
| Hooks/status, `cliResume.ts`, parsere Claude/Pi | Adaptoare pentru CLI-uri independente, amânate. Resume-ul chatului Pi nu livrează resume pentru toți workerii. |
| `taskLedger.ts`, worktrees, reporting, orchestrator | În afara portării actuale. Lansatoarele și terminalele existente funcționează independent. |
| `DiffFileList.tsx`, browser source capture | Posibile servicii UI suplimentare, alese pe cazuri concrete. Git/CLI păstrează mecanismul de revenire; checkpoint-urile proprii per tură rămân în afara planului. |

Fiecare preluare executată se consemnează în [PROVENANCE](PROVENANCE.md), cu adaptările și validarea efectivă. UI-ul respectă [LOOK.md](../design/LOOK.md); codul donor nu acordă permisiuni noi și nu schimbă politica browserului.
