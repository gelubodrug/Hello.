# Hello. — mini-roadmap de lucru

Revizia 3, din 9 septembrie 2026. [Revizia 1](archive/MINI-ROADMAP-2026-09-09-r1.md) și [revizia 2](archive/MINI-ROADMAP-2026-09-09-r2.md) sunt păstrate integral. Baza: [research-ul consolidat](feature-research/RESEARCH-2026-09-09.md), [research-ul independent](feature-research/INDEPENDENT-NEXT-FEATURES-2026-09-09.md) și [research-ul pe nouă categorii](feature-research/MOST-WANTED-FEATURES-2026-09-09.md). Auditul local Reddit furnizat de utilizator este integrat ca findings, fără o nouă căutare sau reverificare a scorurilor. Ordinea ține cont și de [comparația cu aplicația-soră](feature-research/INTERNET-RESEARCH-2026-09-09-r1.md) și de codul existent. Această revizie produce documentație și prioritizare; nu pornește implementarea. Checkbox-urile sunt lucru propus.

**Direcție:** Hello. reține deciziile, face vizibil lucrul și poate fi extins fără să devină un IDE aglomerat sau un sistem opac de boți.

**Ce se schimbă în revizia 3:** păstrăm epics H01–H16 și livrăm felii demonstrabile. H04 urcă după search, măsurare și coada agentului principal; H14 pentru plan și diff read-only poate preceda H13. H02 include devreme diagnosticul modelelor locale. H12/H15 se extind la CLI-uri prin adaptoare cu semnale reale. După discuția cu proprietarul, revenirea asupra fișierelor pornește de la Git/CLI; H13 cu istoric propriu per tură devine opțional și iese din prima etapă. Auditul completează resume-ul cu eficiența cache-ului, contextul cu evidența păstrat/rezumat/omis și notificările cu o politică comună. Reutilizarea codului util din aplicația-soră este autorizată explicit de proprietar în conversația din 9 septembrie; [ghidul de preluare](REUSE-GUIDE-2026-09-09.md) indică modulele, adaptările și golurile rămase.

Mărimi relative: **S** = schimbare localizată; **M** = un flux vertical UI/main/store; **L** = subsistem cu persistență și condiții de recuperare. Nu sunt estimări în zile. Etapele au criterii de ieșire, nu termene presupuse. „Dovezi” trimite la research; cifrele sunt voturi, reacții sau puncte la 9 septembrie 2026, nu cote de piață.

## Baza actuală din cod

Lectură statică la 9 septembrie 2026; prezența codului nu înseamnă acceptanță în aplicația rulată. Aceste fundații se extind:

- **Files există:** arbore React Arborist, Preview/Source și citire limitată la folder. Este separat de indexare de conținut, PDF și atașare la model — src/renderer/files/FilesPane.tsx și src/main/files/service.ts.
- **Tools/thinking au grupare cronologică și detalii expandabile**, iar aprobările și erorile deschid activitatea. H02 adaugă date și legături; nu repetăm optimizarea din capturile vechi ca funcție absentă — src/renderer/chat/activity.ts, WebResearch.tsx și ConversationView.tsx.
- **Există streaming, usage input/output și export Markdown.** command_run livrează rezultatul la sfârșit; PTY-urile au deja output incremental — src/main/chat/service.ts, tools.ts și src/main/terminal/service.ts.
- **Discovery /models și browserul cu permisiuni per tab există.** Lipsesc diagnosticul capabilităților și sursele de browser cu ancore în chat — src/main/chat/service.ts și src/main/browser/manager.ts.
- **Conversațiile sunt persistate în SQLite.** Lipsesc backup/import complet și asocierea durabilă worker → sesiune CLI. Search-ul din sidebar filtrează titluri; istoricul trimis modelului nu are buget în tokeni — src/main/data/store.ts, src/main/chat/service.ts și src/renderer/App.tsx.

## Ordinea concreta de implementare

Tabelul este ordinea recomandată de execuție; secțiunile H descriu scopul complet. Sufixele a/b numesc felii ale aceluiași H, fără epics noi. Fiecare felie primește un task cu intrări, fișiere deținute, criteriu de ieșire și dependențe. Referințele de cod și proveniența sunt în [ghidul aplicația-soră](REUSE-GUIDE-2026-09-09.md).

| Pas | Felie de livrat | Dependență și reutilizare | Demonstrația cerută |
| --- | --- | --- | --- |
| 0 | **H15-a — backup/restaurare logică de bază și versiuni de schemă**, înainte de migrări | SQLite existent; fără importul datelor aplicația-soră. Felie limitată la protejarea datelor pe care le extindem. | O copie izolată a datelor Hello. poate fi restaurată; migrarea întreruptă nu pierde conversații. Fără probe pe baza activă a omului. |
| 1 | **H03-a — search în mesaje, Runbook și Tasks**, cu snippet și salt la sursă | Date/ID-uri existente; index local reconstruibil. Full-text search lipsește și în aplicația-soră. | Găsesc o decizie din corpul mesajului și ajung exact la ea; editarea/ștergerea actualizează rezultatele; fără LLM. |
| 2 | **H02-a — model/usage/stare, context estimat și diagnostic local**; run IDs/evenimente minimale din H10/H16 | Fluxul de evenimente existent; din aplicația-soră, calculul contextului și semantica usage. | Văd modelul cerut separat de cel raportat, consumul raportat/estimat și capabilitățile cunoscute. După restart, identitatea turei rămâne. |
| 3 | **H12-a — Queue/Steer și atenție pentru agentul principal**, notificări de bază | Pasul 2; semantica de coadă aplicația-soră, cu execuția în main-ul Hello. | Corectez la următorul punct sigur sau pun un mesaj după tură; editez/anulez coada; o aprobare în alt chat semnalează o singură dată. |
| 4 | **H03-b + H04-a — recuperare prin tool, output compact și context inspectabil**, apoi compactare explicită versionată | Pașii 1–2. Extragem nucleul Context Governor; persistența și rezumatul se adaptează la Hello. | Originalele sunt citibile pe intervale; văd ce este integral/rezumat/omis din cererea următoare; compactarea păstrează perechile tool/result și sursele după restart. |
| 5 | **H14-a — adnotarea planului și diff Git read-only** | Nu cere H13. Parser/prezentare din aplicația-soră; comentariile și ancorele de revizie sunt noi. | Comentariul ajunge ca mesaj cu versiunea citată; baza Git e explicită. Review-ul planului merge și în folder fără Git. |
| 6 | **H01-a — Tasks cu ID/revizie, owner/run, criterii și rezultat** | Pașii 2–3; modelul ledger/raport din aplicația-soră, adaptat la notebook-urile Hello. | Un worker conectat explicit actualizează task-ul; revizia concurentă produce conflict; raportul trimite la dovezi reale. |
| 7 | **H12-b + H15-b — un adaptor CLI cu status și resume**, apoi ceilalți | Pașii 2–3; pasul 6 pentru legătura la task. Hooks, maparea sesiunii și parserele aplicația-soră. | Workerul compatibil semnalează input/final/eroare și reia aceeași sesiune la cerere; transcriptul nu se dublează. Cache observat dacă este raportat; CLI fără semnale = necunoscut. |
| 8 | **H01-b — worktree/setup; revenire prin Git sau mecanismul CLI disponibil** | Pașii 5–7. Portăm contractele worktree aplicația-soră; setup-ul este completare. Fără arhivă proprie a fiecărei ture. | Workerul izolat pornește cu setup autorizat; baza de comparație și editările preexistente sunt cunoscute. Revenirea este explicită, prin Git/CLI; nu presupunem că un commit acoperă modificările necomise. |

**H13 este în afara acestei secvențe:** revenirea este delegată inițial Git/CLI, cu review și bază clară în Hello. Un istoric propriu de fișiere se reconsideră numai după o nevoie demonstrată, în special pentru scrierile Hello. sau folderele fără Git. Nu stocăm versiuni ale întregului proiect la fiecare mesaj.

**După aceste felii:** H16 complet (reguli de aprobare și jurnal) → H05 (tab citat, apoi documente/PDF) → H07 (skills locale cu review simplu) → H06 (memorie explicită) → H08 (un conector MCP util) → H09 (fork) → H10 complet (recuperarea rulărilor) → H11 (programare). H07 folosește un mecanism comun de propunere/diff/aprobare fără să aștepte întregul H06. Bugetele H02 se extind înainte de reluare automată și scheduler.

**Ce poate merge în paralel:** după 1–2, H05 pentru tab-as-source și H07 pentru catalog manual pot veni mai devreme dacă un flux concret le cere. H14-a funcționează fără un istoric propriu de checkpoint-uri. Adaptoarele CLI pot avansa separat de context, după stabilizarea contractelor comune. Două task-uri nu editează simultan chat/service.ts, store.ts, tipurile IPC sau aceeași componentă. Notificările pe prag/eveniment se adaugă când H02/H16 produc datele reale.

**Primele trei rezultate de folosit zilnic:** regăsesc ce am discutat → văd modelul și contextul/consumul → corectez lucrul în mers. Extensiile pentru toate CLI-urile nu blochează aceste livrări.

## Contract care nu se schimbă

- Designul aprobat rămâne: numai chat-uri în stânga, actori în pills, un tool vizibil, controale în header și nimic peste browserul nativ.
- Runbook rămâne read-only pentru agentul principal; Tasks rămâne read/write. Omul le editează pe ambele. Nu injectăm automat notebook-uri și nu trimitem task-uri automat la launch-ul CLI.
- Sursele, memoria și skills nu pot acorda permisiuni. Agent control rămâne Off implicit și per tab.
- Originalele și rezultatele reale se păstrează. Un rezumat, „done” sau badge nu înlocuiește dovada.
- Local-first; orice conector transmite doar datele autorizate pentru operația respectivă. Modelul mai scump sau autonomia suplimentară nu se activează tacit.
- Nu scoatem și nu redesenăm ce folosesc oamenii fără cale de întoarcere: cele mai votate issue-uri și thread-uri din 2026 sunt despre funcții și planuri eliminate (Buddy 1 178 👍; „Anthropic just ripped off everyone” 1 793 puncte; Canvas, săgețile de versiuni, Custom Modes).
- Fără login obligatoriu, telemetrie doar opt-in și documentată, consum mic la idle, secrete care nu ajung în contextul modelului. Sunt motive declarate de churn la produse comparabile (Superset, Vibe Kanban, Warp, Claude Desktop, Hermes, Grok Build).
- Terminalul nu e degradat de GUI: `!`, shortcut-urile CLI-urilor, randarea TUI pe 4K și în sesiuni lungi, sesiuni denumite și schimbarea contului fără pierderea sesiunilor sunt motivele declarate pentru care power users rămân în terminal.

## Etapa 1 — continuitate și lucru vizibil

Ordinea pe felii este în [tabelul de implementare](#ordinea-concreta-de-implementare): **H03-a → H02-a → H12-a → H04-a → H14-a → H01-a**, apoi Tasks și extensiile pentru workers. H15-a precedă migrările; H15-b vine cu primul adaptor CLI. H04 nu așteaptă întregul H01/H15. H13 rămâne opțional.

### H03 · Căutare reală și recuperarea sursei · M · P0 · prima livrare

**Dovezi:** șase din nouă categorii plus sondaje; search-ul e așteptat, iar la Claude e paywalled (motiv de plângere); Open WebUI are search prin `LIKE` „multe secunde”; State of AI 2026: lipsa contextului e pain #3; pe Reddit, „1 task = 1 chat” și fișierele de spec sunt felul în care oamenii ocolesc pierderea contextului (workflow cu 541 puncte). [MOST-WANTED #1](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello)

- [ ] Search local în mesaje, Runbook și Tasks, nu doar titluri; snippet, dată și salt la mesaj/intrare.
- [ ] Tool search/read cu rezultate limitate și ancore stabile; scope implicit conversația curentă, alte chat-uri numai când sunt incluse explicit.
- [ ] Căutarea funcționează fără LLM și fără embedding obligatoriu. Ștergerea unei surse invalidează și indexul ei.

**Gata când:** „unde am decis X?” duce la pasajul original, iar agentul îl poate consulta fără să ceară copy/paste. Nu confundăm faptul că două chat-uri folosesc același folder cu permisiunea de a le amesteca.

### H02 · Stare vizibilă, consum, observabilitate și output live · M–L în felii · P0

**De ce:** opt din nouă categorii cer cost, usage și model vizibile; pe Reddit e cel mai lat și cel mai furios semnal: schimbări ascunse de effort (4 365 puncte), rutare tăcută la un model mai mic facturat ca cel mare (433), „1 400 $ într-o oră” (225), iar statusline-ul cu context, limite, model și cost „fără click” e motivul #1 declarat pentru care power users rămân în terminal (277 / 52 / 49 în thread-ul de 697). Limitele de utilizare sunt plângerea #1 la Claude Code (694 👍) și cererea e continuarea automată la resetare (206 👍); `ccusage` (18,5k stele) și claude-devtools (894 puncte pe Reddit) există pentru că CLI-urile nu arată nici agregarea, nici ce s-a întâmplat într-o tură. Terminalul există; output-ul live al `command_run` în chat este încă un gol. [MOST-WANTED #2](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello)

- [ ] Stare vizibilă fără click, în rândul composer-ului unde e deja modelul, nu într-un footer nou: procent de context, fereastra de limită rămasă (5 ore / 7 zile unde e raportată), model și effort efective, folder și branch, cost sau tokeni ai conversației.
- [ ] Model/endpoint/effort cerute salvate per rundă, distinct de identitatea raportată de provider; nu pretindem că un endpoint opac dezvăluie modelul real. Input/output/cached tokens când sunt raportate; durată și total per conversație. Mesajele vechi fără date rămân „necunoscut”.
- [ ] Diagnostic endpoint/model: streaming, tool calling, reasoning furnizat și fereastră de context, cu sursă/estimare și profil redus de tool-uri unde este necesar. Discovery-ul existent nu dovedește capabilitățile. Probe explicite, fără fallback sau retry facturabil automat.
- [ ] Inspector per tură: context trimis separat de consum facturat; sistem, istoric, definiții/rezultate de tool-uri, surse și skills, cu estimări declarate și volum neatribuit unde e cazul. Thinking doar cât furnizează providerul; nu reconstruim raționamente ascunse.
- [ ] Cronologie tool → rezultat → modificare și worker → run unde există semnale; source IDs și legături la original. Rezumat compact implicit, detalii la deschidere, aprobări/erori vizibile și alegerea manuală de expandare păstrată. Extindem gruparea deja existentă.
- [ ] Cost „raportat” separat de „estimat”; pricing cu dată/sursă și câmp „necunoscut”, nu zero, când nu avem date. CLI extern fără usage disponibil = N/A.
- [ ] Buget per conversație cu avertizare la 75%/90% și oprire înaintea următoarei operații; fără schimbare tacită la un model mai scump sau la un effort mai mic. Limita estimată nu se prezintă ca plafon de facturare garantat.
- [ ] Cost și tokeni per worker, agregate din log-urile locale ale CLI-urilor unde există (pattern-ul `ccusage`); „continuă când se resetează limita” ca opțiune explicită, niciodată implicită.
- [ ] stdout/stderr incremental, limitat ca volum, în tool card; Stop vizibil și stare finală adevărată.

**Gata când:** văd fără click starea, modelul declarat și indicatorii disponibili; inspectorul explică sursele, estimările, lipsurile și ce a atins agentul. Necunoscut nu înseamnă zero. Pill-ul rămâne de mărime fixă. H02-a livrează măsurarea; bugetele și agregarea CLI vin după datele necesare.

### H12 · Coadă de atenție, notificări și Queue/Steer · M pentru chat, L cu adaptoare · P0

**De ce:** este un semnal util de produs; deținerea PTY-urilor oferă transportul, dar nu dovedește semantic starea fiecărui CLI. peon-ping (1 006 puncte HN) există pentru că Claude Code nu spune când a terminat; Codex „sunet la final” 195 👍 și „nu răspunde singur la întrebări după 60 s” 205 👍; cmux e un terminal construit în jurul unui sidebar de notificări, iar bug-ul lui cel mai votat e „indicatorii Running/Needs Input sunt nesiguri” (39 👍). Pe Reddit, aprobările așteptate în tăcere costă 10–20 de minute (166 puncte), power users peticesc cu hooks și sunete, iar notificările nedorite sunt urâte (481). Queue/Steer vine din research-ul independent (#3) și e susținut și de OpenCode „unqueue messages” (99). [MOST-WANTED #3](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello)

- [ ] Agentul principal folosește evenimentele proprii. CLI workers folosesc protocol/hooks validate per adaptor, cu „necunoscut” când nu avem semnal. Tăcerea PTY, ieșirea procesului și task-ul reușit sunt stări diferite. Hook instalat nu înseamnă hook funcțional; canalul trebuie să fi livrat evenimente pentru sesiunea curentă.
- [ ] Badge pe conversație și pe tab-ul tool-ului; o singură listă „au nevoie de mine” cu salt la sursă; notificare macOS doar când fereastra nu e vizibilă sau chat-ul nu e cel activ; silențios implicit, sunet opțional per conversație, fără notificări de marketing.
- [ ] Pentru agentul principal: „Corectează acum” (steering la următorul punct sigur) și „Fă după ce termini” (coadă vizibilă, editabilă, anulabilă), separate de Stop.
- [ ] Întrebările agentului către om nu primesc răspuns automat; expirarea unei operații nu șterge întrebarea. Coada are ID-uri, stări queued/delivered/failed/cancelled și confirmare de livrare; nu deduplicăm doar după text.
- [ ] Politică comună pentru notificări: evenimente selectabile (input, final, eroare, prag de consum, acces sensibil observat), prag configurabil, deduplicare, salt la eveniment și silențios implicit. Accesul unui CLI la fișiere se semnalează numai dacă adaptorul îl observă efectiv.
- [ ] Opțional, după listă: o reprezentare vizuală a stării fiecărui worker (birourile pixel au 1 405 și 1 268 puncte pe Reddit); nu înlocuiește lista.

**Gata când:** pentru agentul principal și workers cu adaptor verificat, prompturile de permisiune și finalurile raportate apar în coada de atenție; workerii fără semnale rămân explicit „necunoscut”. O corecție trimisă în timpul lucrului ajunge la agent cu confirmare de livrare, fără să rescrii cererea.

### H13 · Istoric propriu de fișiere / checkpoint per tură · opțional · în afara primei etape

**Revizia 3, după discuția cu proprietarul:** nevoia de revenire rămâne, dar prima soluție este Git sau mecanismul de rewind al CLI-ului, unde există. Hello. oferă review, baza comparației și legătura la sesiunea corectă. Nu construim acum un istoric paralel al fișierelor pentru fiecare mesaj de chat.

**De ce se amână:** checkpoint per tură lipsește și în aplicația-soră; preluarea worktree-urilor nu îl rezolvă. Suportul uniform pentru CLI-uri, scrieri concurente și foldere fără Git adaugă un subsistem de stocare, retenție și restaurare. Cererea din research justifică reversibilitatea, nu impune implementarea ei în aplicație.

**Dacă folosirea reală îl justifică ulterior:**

- [ ] Începem numai cu scrierile prin tool-ul de fișiere Hello.: copie anterioară înainte de scriere, inclusiv inexistența fișierului la creare.
- [ ] Păstrăm doar versiunile necesare ale fișierelor schimbate, cu limite de spațiu/retenție și excluderi vizibile; nu copii ale întregului proiect per mesaj.
- [ ] Restaurarea detectează editările ulterioare și se poate anula. Shell și CLI extern sunt în afara acoperirii până există baseline/control corespunzător.
- [ ] Un watcher nu recuperează conținutul deja suprascris; Git nu păstrează automat dirty/untracked/ignored. Nu folosim stash/reset ori indexul omului ca mecanism implicit de snapshot.

**Criteriu de reintroducere:** utilizarea Git/CLI lasă un caz important de pierdere nerecuperabilă în fluxul zilnic Hello., iar costul stocării poate fi măsurat pe acel caz. Până atunci, H13 nu blochează niciun alt epic.

### H14 · Review: adnotarea planului și diff-ul cu comentarii pe care agentul le citește · M · P0

**De ce:** cinci categorii plus Sonar (38% spun că e mai greu de revizuit codul AI; doar 48% verifică mereu). Bucla „comentez, agentul corectează” e cea mai lăudată la Conductor și Claude Code Desktop; pe Reddit e și mai iubită pentru plan decât pentru cod: editorul vizual de Markdown din Cursor Plan mode „just beautiful” (253), plan cu Mermaid inline (169), Plannotator. Cererile deschise pentru diff sunt despre scope: diff față de altă ramură (139 👍), review în lot înainte de aprobare (52), UI de review (189), diff/aprobare integrate la Codex (230), comentarii pe hunk care ajung la agent la Zed (85), diff inline la fiecare editare (894 puncte pe Reddit). [MOST-WANTED #5](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello)

- [ ] Adnotarea planului înainte de execuție: comentarii, ștergeri și inserții pe planul din Tasks sau din răspunsul agentului, trimise ca următorul mesaj; planul aprobat rămâne în Tasks ca fișier al proiectului.
- [ ] H14-a: diff read-only față de o bază Git identificată, independent de H13; adnotarea planului funcționează și fără Git.
- [ ] Prima revenire folosește Git sau mecanismul disponibil al CLI-ului, cu bază și scope explicite. Nu etichetăm un diff Git „ultima tură” dacă nu avem dovada acelei limite. H14-b cu restaurare din istoric propriu rămâne opțional, numai dacă H13 revine în plan.
- [ ] Comentarii care devin următorul mesaj către agent, cu path, revizie/bază, parte a diff-ului, linie și fragment. Schimbarea fișierului marchează ancora ca veche; aceleași comentarii pot intra în Tasks.
- [ ] Scope selectabil numai pe baze reale: commit/ramură Git explicită; „de la începutul task-ului” dacă baza a fost înregistrată; „ultima tură” numai când CLI-ul furnizează acea limită verificabilă. Simplul fapt că folderul este Git nu oferă limite per tură.
- [ ] Fără editor complet: navigare, highlight și copy; editarea rămâne în IDE-ul omului.

**Gata când:** pot revizui planul înainte să pornească lucrul și ce a schimbat un worker după, fără să deschid alt tool, iar o observație pe o linie ajunge la agent fără copy/paste.

### H01 · Shared Tasks și handoff complet · M–L · P0 · reformulat

**De ce:** este fluxul central Hello. și corespunde cererii de „plan sau goal ca fișier de proiect” din cinci categorii (Cursor: planuri salvate în proiect, Goal Mode cu contract de oprire; OpenCode `/goal` 142 👍; Vibe Kanban: utilizatorii au cerut înapoi Kanban-ul). Pe Reddit, workflow-ul cu 541 puncte e exact acesta: mereu worktrees, 1 task = 1 chat, un chat „creier” care dispecerizează chat-uri worker; pattern-ul „listă de feature-uri marcate failing + progress log + git per sesiune” are 587, orchestratorul de bucle 1 498. Pentru workers paraleli, izolarea în worktree e biletul de intrare și plângerea #1 e worktree-ul gol: fără `.env`, dependențe și porturi (Claude Squad, Conductor, Emdash). Review-ul uman plafonează paralelismul la ~4 sesiuni per repo. [MOST-WANTED #7](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello)

- [ ] ID stabil pentru task/subtask, status explicit (inclusiv „needs input”, alimentat de H12), revizie și autorul modificării, fără dependență exclusivă de numărul liniei Markdown.
- [ ] Criterii de acceptare și motiv de oprire pe task; legătura task → worker/run → rezultat, cu dovezi (diff din H14, log, capturi). Lansarea simplă a unui CLI nu îl desemnează automat owner și nu îi trimite lucru.
- [ ] Bridge local, limitat la chat, pentru citire Runbook și actualizare Tasks de către un worker conectat explicit. Exporturile rămân documente lizibile, nu două surse concurente de adevăr.
- [ ] Conflict vizibil dacă omul și agentul modifică aceeași revizie; nu suprascriem automat. Istoric și restaurare a unei modificări.
- [ ] Worktree opțional per worker când folderul e un repo git, cu script de setup per proiect (copiere fișiere ignorate, instalare dependențe, port alocat) și curățare explicită după merge; setup-ul e determinist, nu improvizat de agent.

**Gata când:** un task creat în chat poate fi preluat explicit de un worker compatibil, lucrat izolat, actualizat și văzut imediat în Tasks cu rezultatul legat; un conflict nu pierde textul omului. Pentru CLI fără bridge, UI spune clar „file handoff”, fără promisiune de sync sau sandbox.

### H15 · Resume pentru workers, backup și import/export · M–L în felii · P0

**De ce:** pierderea stării e plângere recurentă: Claude Code Desktop a șters sesiuni la un auto-update, sync CLI↔desktop are 134 👍, persistența tab-urilor în cmux 50, „prompt trimis înainte ca CLI-ul să fie gata și pierdut” la Claude Squad; sync și backup sunt primele cereri Chatbox (31, 27). Pe Reddit, sesiunile denumite cu `/rename` și `--resume` sunt „lucrul fără de care nu poți trăi” (134), iar aplicația desktop pierde toate sesiunile la schimbarea contului (14). [MOST-WANTED #11](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello)

- [ ] H15-a: backup/restaurare logică de bază înaintea migrărilor. Persistența conversațiilor și exportul Markdown există deja; nu le reconstruim.
- [ ] H15-b: ID sesiune, provider, model, folder și config privat persistate pentru workerii compatibili; resume nativ oferit explicit la restart, fără a pretinde că un PTY mort a fost reînviat. Transcript recovery este separat de reluarea execuției.
- [ ] Refolosim aceeași sesiune/configurație și evităm rescrierea/injectarea inutilă a prefixului. Cached tokens observați dacă sunt raportați; TTL, cache hit și economii nu pot fi garantate. Schimbarea furnizorului sau contextului poate invalida cache-ul.
- [ ] Un prompt trimis unui worker care nu e gata rămâne în coadă (H12) până la confirmarea readiness prin adaptor; fără trimitere bazată numai pe tăcerea terminalului. Recuperarea transcriptului folosește ID-uri pentru a evita dublarea mesajelor.
- [ ] Schimbarea endpoint-ului, a modelului sau a contului nu pierde conversații sau sesiuni; sesiunile pot fi denumite și căutate (H03).
- [ ] Backup logic al datelor Hello. (SQLite, notebook-uri, setări fără secrete) cu restaurare verificată; export și import de conversații cu surse.
- [ ] Nicio pierdere de conversații la update; migrările de schemă sunt testate pe date reale înainte de release; log-urile și snapshot-urile au retenție, ca să nu umple discul.

**Gata când:** după restart, update sau schimbare de cont, fiecare conversație și fiecare worker se regăsesc unde erau sau spun explicit ce nu s-a putut relua.

### H04 · Context manager recuperabil · L · P0 · după H02/H03

**Dovezi:** compactarea „prea târziu” la 95% și pierderea contextului mid-task sunt plângerea recurentă în CLI-uri și în app-urile locale; TypingMind: „Continue with Summary” e #1 pe board; Chatbox a livrat compresie automată cu procent de tokeni. Pe Reddit, oamenii vor să vadă ce a aruncat compactarea (273) și spun că 60–90% din umflarea contextului e output de comenzi (120). [MOST-WANTED #1](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello)

- [ ] Budget de context per model, cu sursă sau estimare declarată; avertizare înainte de limită (meter-ul e în H02).
- [ ] Output-ul comenzilor/tool-urilor intră compact în context și integral în stocarea Hello.; citire paginată cu ID opac și scope per conversație. Extragem logica Context Governor fără directoarele, TTL-ul și transportul Pi. Retenția nu șterge originalele încă referite; limitele sunt vizibile.
- [ ] Compactare explicită și prag configurabil pe procent plus rezervă absolută pentru răspuns/tool-uri, potrivit modelului; rezumat versionat + segment recent + referințe la originale. Evidență distinctă: păstrat integral, reprezentat prin rezumat, omis din contextul trimis dar recuperabil. Nu copiem implicit rezumatul determinist sau pragurile aplicația-soră.
- [ ] Cerințe/pasaje fixate explicit; dacă nu încap, oferim alegere, nu trunchiere ascunsă. Perechile tool call/result rămân valide.
- [ ] Întreruperea compactării nu modifică transcriptul canonic; recuperare de mesaje originale prin H03. Costul rezumării intră în H02.
- [ ] „Întrebare pe margine” (`/btw`) care nu intră în istoric; document de handoff generat la cerere pentru continuarea într-o conversație nouă.

**Gata când:** pot continua o conversație lungă, inspecta rezumatul și regăsi originalele inclusiv după restart. Nu promitem „memorie fără pierderi” doar pentru că avem un rezumat.

**Ieșirea etapei 1:** fluxul research → Tasks → worker → rezultat poate fi urmărit, corectat și reluat pentru integrările suportate; schimbările pot fi revizuite față de o bază cunoscută. Revenirea folosește Git/CLI unde există; nu promitem undo universal pentru fișiere sau efecte externe.

## Etapa 2 — control, research bun și învățare controlată

| ID | Livrabil și checklist | Gata când | Mărime / dependențe |
| --- | --- | --- | --- |
| H16 | **Aprobări v2 și jurnal de acțiuni.** [ ] „Permite mereu exact această operație” cu listă editabilă per conversație, pentru shell, fișiere și browser; [ ] înlănțuirea (`a && b`) e neîncrezută dacă orice segment e neîncrezut; [ ] operațiile periculoase (ștergeri recursive, montări, `push --force`, scrieri în afara folderului) cer confirmare distinctă chiar în mod „auto”; [ ] jurnal per conversație al acțiunilor de browser/shell/fișiere (URL, comandă, nivel de permisiune la momentul respectiv), inspectabil și exportabil, cu alertă la citirea fișierelor sensibile (`.env`, chei); [ ] în Full control, confirmare separată înainte de cumpărare, trimitere, login, download și orice folosire de credențiale, cu motiv afișat; [ ] mod „aprobă manual tot” per conversație. Nou. **Dovezi:** șapte categorii; utilizatorii aprobă 93% din prompturi, dar cer control mai bun, nu mai puțin; Kiro „trusted commands” și bypass prin înlănțuire; Zed sandbox by default; Claude for Chrome 799 pts. Pe Reddit: Grok Build a urcat `.env`-uri cu opt-out ignorat (594), Hermes ruta tăcut traficul la un terț (845), Comet e lăudat pentru „prompturi de aprobare clare” (223); mulți rulează YOLO, deci aprobările trebuie memorate per operație, altfel sunt oprite de tot. [MOST-WANTED #6](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello) | Prompturile repetitive dispar fără să dispară controlul; „ce a făcut agentul în browser” se poate citi după fapt. Sandbox-ul nu e prezentat ca garanție. | M–L; H12 pentru coada de prompturi; înaintea conectorilor sensibili din H08 |
| H05 | **Surse: browser, apoi documente.** [ ] „Folosește acest tab / toate tab-urile” ca sursă cu grant Read, cu ancoră la pasaj și aceeași infrastructură de citări [N]; [ ] „selectează elementul din pagină → chat” pentru feedback pe UI; [ ] selectare explicită de fișiere/PDF, extragere text cu limite și pagini neextrase vizibile; [ ] source ID, URL/path, dată, pasaj și ancoră; [ ] inspector și export cu citări; [ ] folder sync la nevoie, cu „ce e indexat” vizibil și eviction. Imagini doar când modelul le suportă. Reorientat. **Dovezi:** partea de citit a browserelor AI e cea iubită (Comet 4,8/5 din 7,8K; Dia nu dă click în locul tău); pe Reddit, Comet „merge pe orice tab am deschis” (200), browserul din Cursor 2.0 cu selectarea elementului (400), meniul de surse din Open WebUI (273), „Connect Obsidian to Claude Code” (267); NotebookLM pentru răspunsuri ancorate (371 pts); Codex PDF 188 👍; directory sync în Open WebUI 214 reacții. [MOST-WANTED #8](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello) | Fiecare citare poate deschide pasajul folosit, inclusiv dintr-un tab al browserului nativ. Link verificat nu este etichetat automat „afirmație adevărată”. Browserul Off nu este ocolit prin alt tool. | M pentru tab-as-source; L pentru documente și folder sync; H03/H04 |
| H06 | **Memorie explicită, cu review și istoric.** [ ] Fapte/preferințe separate de tasks și Runbook; [ ] scope explicit user/chat/folder; [ ] sursă, dată, edit/delete real; [ ] „salvează asta ca memorie” la cerere înaintea oricărei propuneri automate; [ ] memorie automată numai ca fișiere Markdown vizibile în folderul conversației, cu index și dată, pe care omul le poate citi, edita și șterge; [ ] propunere → diff/edit → approve/reject pentru faptele cross-chat; [ ] detectare stale, grupare și rollback; [ ] toggle separat între „memorii salvate” și „consultă chat-urile vechi”; [ ] tag pentru conținut care nu se memorează niciodată. **Dovezi:** șase categorii; cele mai apreciate thread-uri din forumul OpenAI cer memorii itemizate și toggle separat (34 + 14); la harness-uri memoria e motivul #1 de churn (168 pts, ~67% negativ); Claude a trecut la intrări editabile (iul. 2026). Pe Reddit: „Memory files… note pe care le poți edita” (407), „Auto Memory is so good” (280), Obsidian ca backbone (1 112), dar și memorii dispărute tăcut (29 / 35 c) și un „sistem ultimate” care a dat înapoi (68): Markdown lizibil câștigă, supra-ingineria strică. [MOST-WANTED #9](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello) | O corecție aprobată poate fi regăsită în scope-ul ales; una respinsă, ștearsă sau expirată nu reapare ca fapt. Tot ce e memorat se poate citi ca fișier. Fără graph sau curator autonom în prima versiune. | M–L; H03, reviziile H01 |
| H07 | **Bibliotecă locală de skills.** [ ] Listă/search și invocare cu „/” din composer; [ ] catalog de descrieri, body la cerere, cost în tokeni afișat; [ ] scope proiect/global și sursă; [ ] agentul propune diff, omul aprobă o versiune; fără suprascriere directă prin tool-urile Hello.; [ ] CLI cu acces liber la folder nu este declarat protejat prin simpla setare UI; [ ] import prin lipire de Markdown, cu preview înainte de import/update și păstrarea editărilor locale. Starter: research cu surse, task planning/handoff, retrospectivă (`/wrap-up`), verificare de completitudine (`/arewedone`). **Dovezi:** șase categorii; LibreChat a livrat după 64 👍; „10k+ tokeni doar ca să listeze skills” și skills modificate de agent sunt plângerile la Hermes; 230+ skills malițioase în 5 zile pe ClawHub. Pe Reddit, skills-urile celebre circulă ca text lipit (2 916 / 618), cel mai intens utilizator Hermes și-a construit toate cele 30+ (546), ritualurile `/wrap-up` (293) și `/arewedone` (348) sunt posturi de top, iar „urăsc să instalez lucruri făcute de alții” (40). [MOST-WANTED #10](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello) | Același workflow poate fi refolosit fără paste și fără încărcarea întregii biblioteci în context. Inspectarea unui skill nu execută scripturi și nu acordă drepturi. Fără marketplace. | M; review simplu comun cu H06, fără dependență de memoria completă |
| H08 | **MCP selectiv și credential handles.** [ ] Conectare explicită a unui server; [ ] tool-uri activate per chat, descrieri/use-when și volum controlat; [ ] permisiuni pe fluxul H16, timeout, health/disable cu eșec vizibil, nu tăcut; [ ] secrete rezolvate în main pentru operația autorizată, nu în transcript; [ ] OAuth loopback pentru servere remote. **Dovezi:** MCP e standard (cel mai votat request în 5 din 7 app-uri locale, toate livrate); cererile din 2026 sunt MCP OAuth (32 👍), elicitation (15), progres (14); conectorii care eșuează tăcut sunt plângerea #1 la Cowork. | Un conector util funcționează fără să expună toate tool-urile tuturor conversațiilor. Un server defect nu blochează chat-ul și nu eșuează în tăcere. Instalarea este distinctă de activare. | L; H02/H04/H16; review de securitate înainte de conectori sensibili |

**Ieșirea etapei 2:** Hello. poate face research cu dovezi din browser și documente, poate reutiliza un workflow aprobat și ține minte ce i-ai spus explicit. Nu avem nevoie încă de marketplace sau de înlocuirea întregului runtime cu plugin-uri.

## Etapa 3 — ramuri și lucru în fundal

| ID | Livrabil și checklist | Limită importantă | Mărime / dependențe |
| --- | --- | --- | --- |
| H09 | **Fork from here.** [ ] Conversație copil cu parent/anchor; [ ] original neschimbat; [ ] proveniența contextului copiat și export. **Dovezi:** ChatGPT a scos săgețile de versiuni și a primit 35 likes în 5 zile; Open WebUI are Fork from response. | Nu reexecutăm tool-uri din istoric și nu duplicăm procesele CLI. Poate intra mai devreme ca livrabil mic după H03. | M; H03 |
| H10 | **Jurnal durabil al rulărilor.** [ ] Run ID și jurnal persistat; [ ] running/waiting/blocked/interrupted/done; [ ] rezultat final livrat o singură dată; [ ] reluare explicită a lucrului întrerupt. ID-urile și evenimentele minimale se introduc cu H02-a; această etapă adaugă recovery-ul complet. Notificările și resume-ul de bază sunt în H12/H15. | Restaurarea UI nu înseamnă că un PTY mort a fost reînviat. Nu reluăm efecte externe fără să știm dacă au avut loc. Fără fan-out autonom în prima versiune. | L; H01/H02/H04/H15 |
| H11 | **Monitorizări programate cu continuitate.** [ ] Un job cu istoric de rulări; [ ] pause/cancel, timezone și politică pentru rulări ratate; [ ] notepad purtat între rulări și memoria ultimului rezultat; [ ] quiet dacă nu s-a schimbat nimic; [ ] rezultatul apare ca o conversație cu badge, nu ca feed; [ ] condiții de oprire și plafon de cost per job, obligatorii; [ ] script simplu fără LLM unde ajunge. **Dovezi:** cron e cea mai densă zonă de issue-uri la harness-uri (OpenClaw 2 596, Hermes 1 008); „cron jobs that remember” a fost titlul Hermes v0.21 (166 reacții); pe Reddit, Open WebUI 0.9.0 cu automatizări programate (288), „28 de cron jobs” (546), dar și „72 de ore 24x7 = mașină de bug-uri” (69); ChatGPT Pulse a fost retras (−96%) pentru că era proactiv fără control. [MOST-WANTED #12](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello) | Laptop adormit/app închis ≠ execuție garantată. Agent control nu se reactivează automat pentru un job. Read-only implicit, scriere numai cu autoritate explicită. | L; H10, H12 și limitele H02/H16 |

## Backlog cu cifre, după etapa 1

- **Extinderea diagnosticului local:** baza intră deja în H02-a. Manager de modele, download GGUF, benchmark și profiluri pentru multe backend-uri rămân ulterior. Aplicația-soră este donor pentru calcule/probe; nu importăm toată stiva locală pentru a diagnostica endpoint-ul deja configurat.
- **ACP pentru CLI workers**, ca tool calls și prompturile lor de permisiune să fie randate în Hello., nu ca text brut de terminal (Zed: 536 de agenți prin ACP; Crush 79 👍; Warp 71/78): L, după H12/H14.
- **Reply de pe telefon și notificări externe** (aprecierea #1 la harness-uri; pe Reddit SSH/tmux 90, Hermes Mobile 512, client iOS Open WebUI 121; Kimi remote control 32 👍): după H10/H11, cu pairing, revocare și permission tiers; primul pas e doar notificarea.
- **Voce** ca dictare sau walkie-talkie (Codex 224 👍; cel mai votat post al anului din r/ClaudeCode, 1 381, e un add-on vocal): cerere reală, dar add-on; macOS oferă dictare de sistem; backlog.
- **Ferestre multiple / detașabile** (Claude Code Desktop 232 👍): de validat cu designul aprobat.

## În afara primului roadmap, cu dovezi

- **Bot societies, chat-uri de grup între agenți, orchestrare autonomă cu mulți agenți:** „verificarea e blocajul, nu codarea” (278 pts); practicienii plafonează la 3–5 sesiuni per mașină; pe Reddit, „fii foarte atent cu Codex 5.5, revizuiește adânc” (664) și 72 de ore de rulare 24x7 au produs „o mașină de bug-uri” (69). Începem cu Tasks, owner/run clar și coadă de atenție.
- **Marketplace general / everything-is-a-plugin:** DeepSeek Harness a primit 7 000 de plugin-uri în 3 zile și spam în două săptămâni; 230+ skills malițioase pe ClawHub în 5 zile; Vibe Kanban, Crystal și opcode au murit; pe Reddit skills-urile bune circulă ca Markdown lipit și „urăsc să instalez lucruri făcute de alții” (40). Amânat până când skills locale și câțiva conectori au valoare demonstrată.
- **Feed-uri proactive:** ChatGPT Pulse a fost retras la 17 iunie 2026; pe Reddit, conținutul împins nesolicitat e urât (481; 129). Nu construim „agentul îți spune ce ar trebui să faci”.
- **Reutilizarea abonamentelor Claude/ChatGPT ca provider:** cerere mare (Hermes 55 👍, DSH 149, Reddit 108), dar cele mai mari thread-uri din 2026 sunt despre conturi restricționate și planuri devalorizate pentru exact asta (1 793; 1 099 HN). De notat, nu de construit.
- **Agent de browser care cumpără și rezervă:** „mai lent decât dacă o fac eu”, loop-uri, CAPTCHA; Amazon a trimis cease-and-desist pentru Comet (356); Atlas a fost retras după 292 de zile. Browserul e sursă și verificator, nu cumpărător.
- **Memorie automată opacă:** oamenii o opresc („context rot”), reclamă ștergeri care nu șterg și scurgeri între conversații; acceptă memoria automată doar ca fișiere lizibile (280). H06 e explicit, ca fișiere, cu aprobare.
- **Embeddings ca primă soluție pentru documente și note:** costul și fragilitatea sunt în topul plângerilor; search obișnuit cu ancore stabile mai întâi.
- **Vault complet pentru parole/TOTP/SSH:** nu construim un password manager. H16/H08 acoperă strict credentialele necesare operațiilor autorizate.
- **Gmail cleanup, homelab, SEO, RSS:** exemple de skills/conectori, nu patru platforme noi în core.

## Cum alegem următorul lucru

Începem cu fundația de backup pentru migrări și cu **H03-a**, apoi **H02-a → H12-a → H04-a**. Urmează review-ul planului/diff-ului și integrarea graduală a workerilor, cu revenire prin Git/CLI, conform [tabelului de execuție](#ordinea-concreta-de-implementare). La finalul fiecărei felii demonstrăm criteriul în folosire reală; simpla existență a UI-ului nu închide task-ul.

Urmărim: decizii vechi regăsite fără copy/paste, consum și limită cunoscute fără click, prompturi de permisiune văzute la timp fără să stai cu ochii pe terminal, schimbări revizuite și revenire prin mecanismul Git/CLI disponibil, task-uri preluate fără copy/paste, conflicte fără pierdere de date și propuneri de learning care nu se acumulează inutil. Nu sunt ținte numerice inventate; vom stabili baseline-ul după folosire.

Această revizie a produs numai documentație și prioritizare. Au fost citite sursele Hello. și aplicația-soră pentru punctele de integrare; codul donor nu a fost copiat încă. Nu au fost rulate teste/build-uri, schimbate setări, citite date de runtime aplicația-soră sau pornite automatizări.
