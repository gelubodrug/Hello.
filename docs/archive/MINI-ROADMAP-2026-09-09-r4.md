# Hello. — mini-roadmap de lucru

Revizia 4, din 9 septembrie 2026. Decizia proprietarului: **chatul Hello. folosește Pi headless cu tools; Hello. adaugă interfața și serviciile sale.** Motorul este integrat în sursă; validarea manuală cu modelul și aplicația este încă necesară.

Pașii 3–5 de mai jos au fost livrați în noaptea de 10 septembrie:
[planul](NIGHT-PLAN-2026-09-10.md) și [raportul cu probele rulate](NIGHT-REPORT-2026-09-10.md).
[Verificarea ulterioară](EXTENSIONS-VERIFICATION-2026-09-10.md) documentează
corecțiile, cele 51 de teste de extensions și cele 12 verificări native trecute.
Bibliotecă în Settings, activare per conversație, skills folosite prin Pi, client
MCP propriu pe stdio și exemple livrate cu aplicația. Vision, descoperirea
providerilor și sidecarul rămân amânate de proprietar.

[Revizia 3](archive/MINI-ROADMAP-2026-09-09-r3.md), [revizia 2](archive/MINI-ROADMAP-2026-09-09-r2.md) și [revizia 1](archive/MINI-ROADMAP-2026-09-09-r1.md) sunt păstrate. Secvența veche „search → consum → Queue/Steer → context propriu → review → Tasks → adaptoare CLI → worktrees” este **înlocuită**, nu rămâne un plan paralel.

## Decizia și responsabilitățile

Preluăm din aplicația-soră chatul headless peste Pi și adaptăm integrarea la Electron. Nu reconstruim acum orchestrarea, raportarea, lansarea de workers sau experiența completă a CLI-urilor. Acestea sunt o direcție separată, pentru dezvoltarea ulterioară a Hello.

| Componentă | Responsabilitate |
| --- | --- |
| Pi 0.85.1, fixat ca versiune | Bucla agentului, apeluri de tool-uri, context, compactare, retries și sesiune persistentă |
| Hello. | Chat UI și SQLite, configurarea modelului, permisiuni, browser, Files, notebooks și terminale |
| Extensia de tools Hello. | Expune către Pi operațiile existente printr-un bridge privat; execuția și aprobările rămân în main |
| CLI-urile lansate de utilizator | Propriile funcții de coding, autentificare, sesiuni și permisiuni |
| Extensii, skills și MCP | Bibliotecă în Settings și activare per conversație, livrate și verificate pe fixtures locale |

Pi oferă mecanisme reutilizabile; nu garantează că orice model local va produce răspunsuri corecte. Un feedback loop util verifică un criteriu concret și poate rula secvențial cu același model. Nu presupunem cinci agenți locali simultan.

## Ordinea concreta de implementare

| Pas | Livrare | Criteriu de ieșire |
| --- | --- | --- |
| 1 — integrat în sursă, de validat | **Motor Pi headless în chatul existent.** Proces RPC persistent per conversație, adaptor de evenimente și bridge către tools Hello. | Text/thinking/tools/usage se afișează în ordine; aprobările și permisiunile browserului funcționează; Stop oprește lucrul; terminarea folosește starea Pi reală. |
| 2 | **Validare pe prompturile reale ale proprietarului.** Același model, endpoint, materiale și cerere ca în CLI-ul care a răspuns corect. | Comparăm răspunsul la întrebare, alegerea tool-urilor, erorile și consumul; demonstrăm continuitatea după restart și compactarea pe o sesiune controlată. Nu declarăm paritate pe baza compilării. |
| 3 — livrat | **Extensii activabile din Settings.** Catalog local, sursă, tool-uri adăugate, enable/disable și încărcare explicită. | Agentul poate propune o extensie; omul vede codul/capabilitățile și activează o versiune. O extensie dezactivată nu rămâne activă într-un proces vechi. |
| 4 — livrat | **Skills și pachete de extensii.** Refolosim mecanismele Pi, cu listare și invocare în Hello. | Pot încărca/invoca un skill relevant fără a injecta întreaga bibliotecă în fiecare cerere. Instalarea, citirea și activarea sunt distincte. |
| 5 — livrat | **Un conector MCP util.** Integrare explicită prin adaptor/extensie, cu health, erori și gestionarea secretelor. | Tool-ul ales funcționează în chat, poate fi dezactivat și nu expune chei în transcript. Pi instalat nu este dovadă de suport MCP nativ. |
| 6 | **Servicii Hello. alese din folosirea reală.** Search în istoric, surse din browser și vizibilitate pentru context/consum. | Fiecare livrare rezolvă un caz observat fără să dubleze motorul sau CLI-ul. Queue/Steer, unde sunt expuse în UI, folosesc comenzile Pi. |

Pasul 1 are probe automate locale; pasul 2 rămâne validarea manuală cu modelul
proprietarului. Pașii 3–5 sunt livrați și verificați conform rapoartelor de mai
sus; pasul 6 rămâne propus. Testele, buildul și instanța nativă temporară pentru
extensions au fost aprobate în planul nopții. Aplicația și datele proprietarului
nu au fost folosite în aceste probe.

## Contractul primei integrări

- Switch Chat/Coder în composer: restrâns la modul activ, două pictograme la click, selecție memorată per conversație. Ambele moduri folosesc Pi și aceleași aprobări; Coder păstrează promptul de coding Pi, Chat folosește instrucțiunile conversaționale Hello. Nu lansează worker-e.

- Versiune Pi fixată la **0.85.1**; adaptăm persistent RPC și ordinea evenimentelor din aplicația-soră. Răspunsul la comanda prompt înseamnă acceptare; `agent_settled` înseamnă că nu mai există continuare automată.
- O sesiune JSONL Pi per chat, în datele proprii Hello. Istoricul unui chat Hello. existent se importă o singură dată în formatul Pi JSONL v3; mesajele SQLite rămân. Nu citim sesiuni sau chei aplicația-soră și nu cerem migrare a schemei SQLite.
- Context implicit **32.768 tokeni**, output **4.096**, configurabile după server. Configurația trebuie să lase istoric suficient peste rezerva necesară; aceste valori nu detectează fereastra reală.
- Compactarea folosește fereastra configurată minus `reserve = max(16384, output + 4096)` tokeni. Implicit pornește peste 16.384 tokeni estimați de context: 50% pentru acest profil. Contextul recent păstrat este `min(20000, floor(context / 4), floor((context - reserve) / 2))`. Nu copiem un procent universal și nu construim un al doilea compactor Hello.
- Compatibilitate explicită `auto`, `openai`, `qwen-chat-template`; fiecare trebuie verificată cu serverul folosit. Cheile modelului rămân în stocarea securizată Hello. și în mediul procesului copil, nu în fișierul Pi de modele.
- Tools Hello. executate în main; Pi nu primește tool-uri native care ocolesc aprobările existente. Browserul păstrează Off/Read/Full per tab. Tool-urile web publice rămân distincte de controlul browserului.
- UI-ul actual păstrează mesajele, consumul input/output și activitatea; faza runtime este tranzitorie. Nici un indicator de etapă, nici un răspuns „gata” nu dovedesc singure calitatea rezultatului.
- Backup/import complet este un livrabil separat. Prima integrare păstrează istoricul existent și nu introduce schema nouă care motiva vechiul H15-a.

## Ce păstrăm din research ca opțiuni

Research-ul rămâne material de selecție, nu listă de mecanisme de construit din nou. [Research consolidat](feature-research/RESEARCH-2026-09-09.md), [independent](feature-research/INDEPENDENT-NEXT-FEATURES-2026-09-09.md), [nouă categorii și findings Reddit](feature-research/MOST-WANTED-FEATURES-2026-09-09.md), [comparația aplicația-soră](feature-research/INTERNET-RESEARCH-2026-09-09-r1.md).

| Identificatori anteriori | Tratament după această decizie |
| --- | --- |
| H02 — model, context, consum; H04 — context | Pi deține mecanismul; Hello. afișează datele/estimările și lipsurile. Un inspector detaliat poate urma. |
| H03 — search | Serviciu Hello. util ulterior, independent de motor. Nu blochează schimbarea motorului. |
| H07 — skills; H08 — MCP | Urcă după validarea Pi, conform pașilor 3–5. |
| H05 — browser/documente | Tools/browser existente se păstrează; ancore și importuri noi vin la cerere. |
| H12 — Queue/Steer și atenție | Pentru chat se integrează protocolul Pi; lista de atenție/notificările sunt servicii Hello. ulterioare. |
| H06 — memorie; H09 — fork | Extensii sau interfețe peste mecanisme existente, numai după definirea unui caz util. |
| H13 — checkpoint-uri proprii; H14 — plan/diff | Istoricul propriu per tură rămâne în afara planului. Git/CLI păstrează revenirea disponibilă; un viewer comod poate fi ales separat. |
| H01 — Tasks/worktrees; H10 — jurnal de rulări; H15 — workers/resume | Orchestrarea, raportarea și adaptoarele pentru workers sunt amânate explicit. Resume-ul chatului Pi este distinct de resume-ul tuturor CLI-urilor. Backup/export complet se evaluează separat. |
| H16 — aprobări; H11 — programare | Păstrăm aprobările actuale la migrare. Reguli noi și programări cer ulterior un caz clar și capabilități verificate. |

## Reguli de livrare

Interfața păstrează [design/LOOK.md](../design/LOOK.md), iar codul preluat se consemnează în [PROVENANCE](PROVENANCE.md). [Ghidul aplicația-soră](REUSE-GUIDE-2026-09-09.md) indică exact ce preluăm acum și ce rămâne doar referință.

Mai întâi demonstrăm chatul Pi pe cazul care a eșuat în Hello.; apoi deschidem extensibilitatea. Lansarea unui CLI la un click nu implică raportare sau coordonare automată. O bifă de activare a unei extensii nu este un sandbox pentru codul ei.

Corecție punctuală din folosirea reală, 9 septembrie: CLI-urile compatibile primesc
legătura cu Runbook-ul și Tasks ale conversației, plus folderul real de lansare.
Pot citi contextul și actualiza explicit starea unui task în Hello. Aceasta nu
redeschide proiectul de orchestrare: fără distribuire automată de taskuri,
worktrees, scheduler sau detectare automată a rezultatului. Integrarea și limita
Aider sunt descrise în [arhitectură](ARCHITECTURE.md#shared-notebooks-in-launched-clis).
