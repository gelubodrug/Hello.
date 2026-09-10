# Hello. — mini-roadmap de lucru

Revizia 2, din 9 septembrie 2026. Revizia 1 din aceeași zi este păstrată în [archive/MINI-ROADMAP-2026-09-09-r1.md](archive/MINI-ROADMAP-2026-09-09-r1.md). Baza de dovezi: [research-ul consolidat](feature-research/RESEARCH-2026-09-09.md), [research-ul independent](feature-research/INDEPENDENT-NEXT-FEATURES-2026-09-09.md) și [research-ul pe nouă categorii, cu voturi verificate](feature-research/MOST-WANTED-FEATURES-2026-09-09.md), completat cu lectura subreddit-urilor aplicațiilor comparabile (secțiunea „Ce spune Reddit” din același document). Nu este o declarație de funcții livrate și nu pornește implementarea. Toate checkbox-urile de mai jos sunt lucru propus.

**Direcție:** Hello. reține deciziile, face vizibil lucrul și poate fi extins fără să devină un IDE aglomerat sau un sistem opac de boți.

**Ce s-a schimbat față de revizia 1:** golurile cu cea mai mare cerere externă s-au dovedit operaționale, nu „AI”. Coada de atenție cu notificări (H12), checkpoint-ul pentru fișiere (H13), diff review-ul (H14) și sesiunile persistente (H15) intră în etapa 1 ca livrabile proprii; H02 se lărgește cu stare vizibilă fără click, buget, cost per worker și observabilitate; H05 pornește de la browserul nativ ca sursă, nu de la PDF; H01 primește criterii de acceptare, worktree și setup hook pentru workers paraleli; aprobările memorate și jurnalul de acțiuni devin livrabil propriu (H16), înaintea conectorilor. Ordinea de start se schimbă: H03 → H02 → H12 → H13 → H14 → H01 → H15 → H04. Lista „în afara roadmap-ului” primește dovezi negative, nu doar lipsa dovezilor.

Mărimi relative: **S** = schimbare localizată; **M** = un flux vertical UI/main/store; **L** = subsistem cu persistență și condiții de recuperare. Nu sunt estimări în zile. Etapele au criterii de ieșire, nu termene presupuse. „Dovezi” trimite la research; cifrele sunt voturi, reacții sau puncte la 9 septembrie 2026, nu cote de piață.

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

Ordinea propusă: **H03 → H02 → H12 → H13 → H14 → H01 → H15 → H04.** Fiecare rând se livrează în felii; primele patru se pot demonstra fără scheduler, memorie sau MCP.

### H03 · Căutare reală și recuperarea sursei · M · P0 · prima livrare

**Dovezi:** șase din nouă categorii plus sondaje; search-ul e așteptat, iar la Claude e paywalled (motiv de plângere); Open WebUI are search prin `LIKE` „multe secunde”; State of AI 2026: lipsa contextului e pain #3; pe Reddit, „1 task = 1 chat” și fișierele de spec sunt felul în care oamenii ocolesc pierderea contextului (workflow cu 541 puncte). [MOST-WANTED #1](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello)

- [ ] Search local în mesaje, Runbook și Tasks, nu doar titluri; snippet, dată și salt la mesaj/intrare.
- [ ] Tool search/read cu rezultate limitate și ancore stabile; scope implicit conversația curentă, alte chat-uri numai când sunt incluse explicit.
- [ ] Căutarea funcționează fără LLM și fără embedding obligatoriu. Ștergerea unei surse invalidează și indexul ei.

**Gata când:** „unde am decis X?” duce la pasajul original, iar agentul îl poate consulta fără să ceară copy/paste. Nu confundăm faptul că două chat-uri folosesc același folder cu permisiunea de a le amesteca.

### H02 · Stare vizibilă, consum, observabilitate și output live · M · P0 · lărgit

**De ce:** opt din nouă categorii cer cost, usage și model vizibile; pe Reddit e cel mai lat și cel mai furios semnal: schimbări ascunse de effort (4 365 puncte), rutare tăcută la un model mai mic facturat ca cel mare (433), „1 400 $ într-o oră” (225), iar statusline-ul cu context, limite, model și cost „fără click” e motivul #1 declarat pentru care power users rămân în terminal (277 / 52 / 49 în thread-ul de 697). Limitele de utilizare sunt plângerea #1 la Claude Code (694 👍) și cererea e continuarea automată la resetare (206 👍); `ccusage` (18,5k stele) și claude-devtools (894 puncte pe Reddit) există pentru că CLI-urile nu arată nici agregarea, nici ce s-a întâmplat într-o tură. Terminalul există; output-ul live al `command_run` în chat este încă un gol. [MOST-WANTED #2](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello)

- [ ] Stare vizibilă fără click, în rândul composer-ului unde e deja modelul, nu într-un footer nou: procent de context, fereastra de limită rămasă (5 ore / 7 zile unde e raportată), model și effort efective, folder și branch, cost sau tokeni ai conversației.
- [ ] Model/endpoint efectiv salvate per turn și afișate la fiecare răspuns; input/output/cached tokens dacă sunt raportate; durată și total per conversație.
- [ ] Inspector per tură: tokeni pe categorii (fișiere citite, output de tool-uri, thinking, skills), fișiere citite și editate, subagenți sau workers implicați, ce a aruncat o compactare (împreună cu H04).
- [ ] Cost „raportat” separat de „estimat”; pricing cu dată/sursă și câmp „necunoscut”, nu zero, când nu avem date. CLI extern fără usage disponibil = N/A.
- [ ] Buget per conversație cu avertizare la 75%/90% și oprire înaintea următoarei operații; fără schimbare tacită la un model mai scump sau la un effort mai mic. Limita estimată nu se prezintă ca plafon de facturare garantat.
- [ ] Cost și tokeni per worker, agregate din log-urile locale ale CLI-urilor unde există (pattern-ul `ccusage`); „continuă când se resetează limita” ca opțiune explicită, niciodată implicită.
- [ ] stdout/stderr incremental, limitat ca volum, în tool card; Stop vizibil și stare finală adevărată.

**Gata când:** pot vedea ce rulează, cu ce model, unde s-au dus tokenii, cât mai am și de ce s-a oprit, fără să deschid nimic; iar când deschid inspectorul, văd ce a atins agentul în tura respectivă. Pill-ul rămâne de mărime fixă; detaliile stau în inspector.

### H12 · Coadă de atenție, notificări și Queue/Steer · M · P0 · nou

**De ce:** e cel mai puternic semnal nerezolvat pe care Hello. îl poate livra ieftin, pentru că deține PTY-urile. peon-ping (1 006 puncte HN) există pentru că Claude Code nu spune când a terminat; Codex „sunet la final” 195 👍 și „nu răspunde singur la întrebări după 60 s” 205 👍; cmux e un terminal construit în jurul unui sidebar de notificări, iar bug-ul lui cel mai votat e „indicatorii Running/Needs Input sunt nesiguri” (39 👍). Pe Reddit, aprobările așteptate în tăcere costă 10–20 de minute (166 puncte), power users peticesc cu hooks și sunete, iar notificările nedorite sunt urâte (481). Queue/Steer vine din research-ul independent (#3) și e susținut și de OpenCode „unqueue messages” (99). [MOST-WANTED #3](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello)

- [ ] Detectare în PTY a stărilor „așteaptă input / idle / a terminat / eroare” pentru CLI workers, cu „necunoscut” explicit când nu putem decide; fără indicatoare false.
- [ ] Badge pe conversație și pe tab-ul tool-ului; o singură listă „au nevoie de mine” cu salt la sursă; notificare macOS doar când fereastra nu e vizibilă sau chat-ul nu e cel activ; silențios implicit, sunet opțional per conversație, fără notificări de marketing.
- [ ] Pentru agentul principal: „Corectează acum” (steering la următorul punct sigur) și „Fă după ce termini” (coadă vizibilă, editabilă, anulabilă), separate de Stop.
- [ ] Întrebările agentului către om nu expiră și nu primesc răspuns automat; rămân în coadă până răspunde omul.
- [ ] Opțional, după listă: o reprezentare vizuală a stării fiecărui worker (birourile pixel au 1 405 și 1 268 puncte pe Reddit); nu înlocuiește lista.

**Gata când:** cu trei workers și un chat activ, fiecare prompt de permisiune și fiecare final de lucru se văd la timp fără să stai cu ochii pe terminal; o corecție trimisă în timpul lucrului ajunge la agent fără să rescrii cererea.

### H13 · Checkpoint pentru fișiere și restaurare reversibilă · M · P0 · nou

**De ce:** rewind-ul din Claude Code e reperul; utilizatorii Codex îl cer cu cele mai mari voturi din repo (438 + 216 👍), la fel Crush și Qwen; muchiile tăioase sunt la fel de votate (restaurare distructivă S1 în Zed; „undo all” fără confirmare în Cursor; Cowork a șters 11 GB). Reddit nuanțează: power users folosesc git ca undo, dar dezastrele sunt reale (un worktree cerut a montat un volum de 459 GB de 11 ori în YOLO mode, 704 puncte; „credeam că nu mi se poate întâmpla”, 333). Hello. deține folderul și poate oferi asta uniform pentru toate CLI-urile, inclusiv cele fără undo, și pentru foldere fără git. [MOST-WANTED #4](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello)

- [ ] Snapshot al fișierelor înainte de fiecare tură care scrie: agentul principal prin tool-uri, CLI workers prin watcher pe folderul conversației; excluderi pentru `node_modules`, build și fișiere mari; când folderul e un repo git, snapshot-ul folosește git și nu îl dublează.
- [ ] Listă a fișierelor atinse per tură, restaurare per fișier sau per tură, și undo al restaurării (restaurarea nu pierde editările ulterioare fără avertizare).
- [ ] Controalele distructive stau după confirmare și niciodată lângă „aprobă”; undo-ul nu pretinde că anulează efecte externe (comenzi, rețea, montări).
- [ ] Editările preexistente ale omului rămân intacte; snapshot-urile au retenție configurabilă și mărime vizibilă.

**Gata când:** o tură greșită a oricărui worker se anulează din Hello. fără `git` manual, iar o restaurare greșită se poate anula la rândul ei.

### H14 · Review: adnotarea planului și diff-ul cu comentarii pe care agentul le citește · M · P0 · nou · după H13

**De ce:** cinci categorii plus Sonar (38% spun că e mai greu de revizuit codul AI; doar 48% verifică mereu). Bucla „comentez, agentul corectează” e cea mai lăudată la Conductor și Claude Code Desktop; pe Reddit e și mai iubită pentru plan decât pentru cod: editorul vizual de Markdown din Cursor Plan mode „just beautiful” (253), plan cu Mermaid inline (169), Plannotator. Cererile deschise pentru diff sunt despre scope: diff față de altă ramură (139 👍), review în lot înainte de aprobare (52), UI de review (189), diff/aprobare integrate la Codex (230), comentarii pe hunk care ajung la agent la Zed (85), diff inline la fiecare editare (894 puncte pe Reddit). [MOST-WANTED #5](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello)

- [ ] Adnotarea planului înainte de execuție: comentarii, ștergeri și inserții pe planul din Tasks sau din răspunsul agentului, trimise ca următorul mesaj; planul aprobat rămâne în Tasks ca fișier al proiectului.
- [ ] Panou de diff pentru tura curentă, pe snapshot-urile din H13; accept/revert per fișier; diff inline în tool card la fiecare editare.
- [ ] Comentarii pe linii care devin următorul mesaj către agent, cu referința la fișier și linie; aceleași comentarii pot intra în Tasks.
- [ ] Scope selectabil: „de la ultima tură”, „de la începutul task-ului”, „față de ramura X” când folderul e un repo git.
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

### H15 · Sesiuni persistente, resume pentru workers, backup și export · M · P0 · nou (din H10)

**De ce:** pierderea stării e plângere recurentă: Claude Code Desktop a șters sesiuni la un auto-update, sync CLI↔desktop are 134 👍, persistența tab-urilor în cmux 50, „prompt trimis înainte ca CLI-ul să fie gata și pierdut” la Claude Squad; sync și backup sunt primele cereri Chatbox (31, 27). Pe Reddit, sesiunile denumite cu `/rename` și `--resume` sunt „lucrul fără de care nu poți trăi” (134), iar aplicația desktop pierde toate sesiunile la schimbarea contului (14). [MOST-WANTED #11](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello)

- [ ] ID-ul de sesiune al fiecărui worker memorat; la restart, ofertă de `--resume`/`--continue` pentru CLI-urile care o suportă, fără a pretinde că un PTY mort a fost reînviat.
- [ ] Un prompt trimis unui worker care nu e încă gata nu se pierde: se ține în coadă (H12) până apare promptul CLI-ului.
- [ ] Schimbarea endpoint-ului, a modelului sau a contului nu pierde conversații sau sesiuni; sesiunile pot fi denumite și căutate (H03).
- [ ] Backup logic al datelor Hello. (SQLite, notebook-uri, setări fără secrete) cu restaurare verificată; export și import de conversații cu surse.
- [ ] Nicio pierdere de conversații la update; migrările de schemă sunt testate pe date reale înainte de release; log-urile și snapshot-urile au retenție, ca să nu umple discul.

**Gata când:** după restart, update sau schimbare de cont, fiecare conversație și fiecare worker se regăsesc unde erau sau spun explicit ce nu s-a putut relua.

### H04 · Context manager recuperabil · L · P0 · după H02/H03

**Dovezi:** compactarea „prea târziu” la 95% și pierderea contextului mid-task sunt plângerea recurentă în CLI-uri și în app-urile locale; TypingMind: „Continue with Summary” e #1 pe board; Chatbox a livrat compresie automată cu procent de tokeni. Pe Reddit, oamenii vor să vadă ce a aruncat compactarea (273) și spun că 60–90% din umflarea contextului e output de comenzi (120). [MOST-WANTED #1](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello)

- [ ] Budget de context per model, cu sursă sau estimare declarată; avertizare înainte de limită (meter-ul e în H02).
- [ ] Output-ul comenzilor și al tool-urilor intră compact în context și integral pe disc; originalul e recuperabil din tool card și prin H03.
- [ ] Compactare explicită și prag configurabil (implicit sub 90%, nu 95%): rezumat versionat + segment recent + referințe la originale. Evenimentul arată ce s-a compactat și ce s-a păstrat.
- [ ] Cerințe/pasaje fixate explicit; dacă nu încap, oferim alegere, nu trunchiere ascunsă. Perechile tool call/result rămân valide.
- [ ] Întreruperea compactării nu modifică transcriptul canonic; recuperare de mesaje originale prin H03. Costul rezumării intră în H02.
- [ ] „Întrebare pe margine” (`/btw`) care nu intră în istoric; document de handoff generat la cerere pentru continuarea într-o conversație nouă.

**Gata când:** pot continua o conversație lungă, inspecta rezumatul și regăsi originalele inclusiv după restart. Nu promitem „memorie fără pierderi” doar pentru că avem un rezumat.

**Ieșirea etapei 1:** un singur flux research → Tasks → worker → rezultat poate fi urmărit, corectat la timp, anulat dacă a greșit, reluat după restart și înțeles fără context copiat manual sau cost ascuns.

## Etapa 2 — control, research bun și învățare controlată

| ID | Livrabil și checklist | Gata când | Mărime / dependențe |
| --- | --- | --- | --- |
| H16 | **Aprobări v2 și jurnal de acțiuni.** [ ] „Permite mereu exact această operație” cu listă editabilă per conversație, pentru shell, fișiere și browser; [ ] înlănțuirea (`a && b`) e neîncrezută dacă orice segment e neîncrezut; [ ] operațiile periculoase (ștergeri recursive, montări, `push --force`, scrieri în afara folderului) cer confirmare distinctă chiar în mod „auto”; [ ] jurnal per conversație al acțiunilor de browser/shell/fișiere (URL, comandă, nivel de permisiune la momentul respectiv), inspectabil și exportabil, cu alertă la citirea fișierelor sensibile (`.env`, chei); [ ] în Full control, confirmare separată înainte de cumpărare, trimitere, login, download și orice folosire de credențiale, cu motiv afișat; [ ] mod „aprobă manual tot” per conversație. Nou. **Dovezi:** șapte categorii; utilizatorii aprobă 93% din prompturi, dar cer control mai bun, nu mai puțin; Kiro „trusted commands” și bypass prin înlănțuire; Zed sandbox by default; Claude for Chrome 799 pts. Pe Reddit: Grok Build a urcat `.env`-uri cu opt-out ignorat (594), Hermes ruta tăcut traficul la un terț (845), Comet e lăudat pentru „prompturi de aprobare clare” (223); mulți rulează YOLO, deci aprobările trebuie memorate per operație, altfel sunt oprite de tot. [MOST-WANTED #6](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello) | Prompturile repetitive dispar fără să dispară controlul; „ce a făcut agentul în browser” se poate citi după fapt. Sandbox-ul nu e prezentat ca garanție. | M–L; H12 pentru coada de prompturi; înaintea conectorilor sensibili din H08 |
| H05 | **Surse: browser, apoi documente.** [ ] „Folosește acest tab / toate tab-urile” ca sursă cu grant Read, cu ancoră la pasaj și aceeași infrastructură de citări [N]; [ ] „selectează elementul din pagină → chat” pentru feedback pe UI; [ ] selectare explicită de fișiere/PDF, extragere text cu limite și pagini neextrase vizibile; [ ] source ID, URL/path, dată, pasaj și ancoră; [ ] inspector și export cu citări; [ ] folder sync la nevoie, cu „ce e indexat” vizibil și eviction. Imagini doar când modelul le suportă. Reorientat. **Dovezi:** partea de citit a browserelor AI e cea iubită (Comet 4,8/5 din 7,8K; Dia nu dă click în locul tău); pe Reddit, Comet „merge pe orice tab am deschis” (200), browserul din Cursor 2.0 cu selectarea elementului (400), meniul de surse din Open WebUI (273), „Connect Obsidian to Claude Code” (267); NotebookLM pentru răspunsuri ancorate (371 pts); Codex PDF 188 👍; directory sync în Open WebUI 214 reacții. [MOST-WANTED #8](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello) | Fiecare citare poate deschide pasajul folosit, inclusiv dintr-un tab al browserului nativ. Link verificat nu este etichetat automat „afirmație adevărată”. Browserul Off nu este ocolit prin alt tool. | M pentru tab-as-source; L pentru documente și folder sync; H03/H04 |
| H06 | **Memorie explicită, cu review și istoric.** [ ] Fapte/preferințe separate de tasks și Runbook; [ ] scope explicit user/chat/folder; [ ] sursă, dată, edit/delete real; [ ] „salvează asta ca memorie” la cerere înaintea oricărei propuneri automate; [ ] memorie automată numai ca fișiere Markdown vizibile în folderul conversației, cu index și dată, pe care omul le poate citi, edita și șterge; [ ] propunere → diff/edit → approve/reject pentru faptele cross-chat; [ ] detectare stale, grupare și rollback; [ ] toggle separat între „memorii salvate” și „consultă chat-urile vechi”; [ ] tag pentru conținut care nu se memorează niciodată. **Dovezi:** șase categorii; cele mai apreciate thread-uri din forumul OpenAI cer memorii itemizate și toggle separat (34 + 14); la harness-uri memoria e motivul #1 de churn (168 pts, ~67% negativ); Claude a trecut la intrări editabile (iul. 2026). Pe Reddit: „Memory files… note pe care le poți edita” (407), „Auto Memory is so good” (280), Obsidian ca backbone (1 112), dar și memorii dispărute tăcut (29 / 35 c) și un „sistem ultimate” care a dat înapoi (68): Markdown lizibil câștigă, supra-ingineria strică. [MOST-WANTED #9](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello) | O corecție aprobată poate fi regăsită în scope-ul ales; una respinsă, ștearsă sau expirată nu reapare ca fapt. Tot ce e memorat se poate citi ca fișier. Fără graph sau curator autonom în prima versiune. | M–L; H03, reviziile H01 |
| H07 | **Bibliotecă locală de skills.** [ ] Listă/search și invocare cu „/” din composer; [ ] catalog de descrieri, body la cerere, cost în tokeni afișat; [ ] scope proiect/global și sursă; [ ] protejate de editările agentului; [ ] import prin lipire de Markdown, cu preview înainte de import/update și păstrarea editărilor locale. Starter: research cu surse, task planning/handoff, retrospectivă (`/wrap-up`), verificare de completitudine (`/arewedone`). **Dovezi:** șase categorii; LibreChat a livrat după 64 👍; „10k+ tokeni doar ca să listeze skills” și skills modificate de agent sunt plângerile la Hermes; 230+ skills malițioase în 5 zile pe ClawHub. Pe Reddit, skills-urile celebre circulă ca text lipit (2 916 / 618), cel mai intens utilizator Hermes și-a construit toate cele 30+ (546), ritualurile `/wrap-up` (293) și `/arewedone` (348) sunt posturi de top, iar „urăsc să instalez lucruri făcute de alții” (40). [MOST-WANTED #10](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello) | Același workflow poate fi refolosit fără paste și fără încărcarea întregii biblioteci în context. Inspectarea unui skill nu execută scripturi și nu acordă drepturi. Fără marketplace. | M; mecanismul de review H06 |
| H08 | **MCP selectiv și credential handles.** [ ] Conectare explicită a unui server; [ ] tool-uri activate per chat, descrieri/use-when și volum controlat; [ ] permisiuni pe fluxul H16, timeout, health/disable cu eșec vizibil, nu tăcut; [ ] secrete rezolvate în main pentru operația autorizată, nu în transcript; [ ] OAuth loopback pentru servere remote. **Dovezi:** MCP e standard (cel mai votat request în 5 din 7 app-uri locale, toate livrate); cererile din 2026 sunt MCP OAuth (32 👍), elicitation (15), progres (14); conectorii care eșuează tăcut sunt plângerea #1 la Cowork. | Un conector util funcționează fără să expună toate tool-urile tuturor conversațiilor. Un server defect nu blochează chat-ul și nu eșuează în tăcere. Instalarea este distinctă de activare. | L; H02/H04/H16; review de securitate înainte de conectori sensibili |

**Ieșirea etapei 2:** Hello. poate face research cu dovezi din browser și documente, poate reutiliza un workflow aprobat și ține minte ce i-ai spus explicit. Nu avem nevoie încă de marketplace sau de înlocuirea întregului runtime cu plugin-uri.

## Etapa 3 — ramuri și lucru în fundal

| ID | Livrabil și checklist | Limită importantă | Mărime / dependențe |
| --- | --- | --- | --- |
| H09 | **Fork from here.** [ ] Conversație copil cu parent/anchor; [ ] original neschimbat; [ ] proveniența contextului copiat și export. **Dovezi:** ChatGPT a scos săgețile de versiuni și a primit 35 likes în 5 zile; Open WebUI are Fork from response. | Nu reexecutăm tool-uri din istoric și nu duplicăm procesele CLI. Poate intra mai devreme ca livrabil mic după H03. | M; H03 |
| H10 | **Jurnal durabil al rulărilor.** [ ] Run ID și jurnal persistat; [ ] running/waiting/blocked/interrupted/done; [ ] rezultat final livrat o singură dată; [ ] reluare explicită a lucrului întrerupt. Notificările și resume-ul de bază s-au mutat în H12/H15. | Restaurarea UI nu înseamnă că un PTY mort a fost reînviat. Nu reluăm efecte externe fără să știm dacă au avut loc. Fără fan-out autonom în prima versiune. | L; H01/H02/H04/H15 |
| H11 | **Monitorizări programate cu continuitate.** [ ] Un job cu istoric de rulări; [ ] pause/cancel, timezone și politică pentru rulări ratate; [ ] notepad purtat între rulări și memoria ultimului rezultat; [ ] quiet dacă nu s-a schimbat nimic; [ ] rezultatul apare ca o conversație cu badge, nu ca feed; [ ] condiții de oprire și plafon de cost per job, obligatorii; [ ] script simplu fără LLM unde ajunge. **Dovezi:** cron e cea mai densă zonă de issue-uri la harness-uri (OpenClaw 2 596, Hermes 1 008); „cron jobs that remember” a fost titlul Hermes v0.21 (166 reacții); pe Reddit, Open WebUI 0.9.0 cu automatizări programate (288), „28 de cron jobs” (546), dar și „72 de ore 24x7 = mașină de bug-uri” (69); ChatGPT Pulse a fost retras (−96%) pentru că era proactiv fără control. [MOST-WANTED #12](feature-research/MOST-WANTED-FEATURES-2026-09-09.md#top-12-pentru-hello) | Laptop adormit/app închis ≠ execuție garantată. Agent control nu se reactivează automat pentru un job. Read-only implicit, scriere numai cu autoritate explicită. | L; H10, H12 și limitele H02/H16 |

## Backlog cu cifre, după etapa 1

- **Diagnostic de capabilități pentru modele, auto-discovery din endpoint și profil „lean” pentru modele mici** (OpenCode 232 👍; recomandarea #2 din research-ul independent; pe Reddit: switch la Ollama într-o linie 983, „mod local permanent” 292, harness-uri care urcă modele mici de la 19% la 45% cu mai puține tool-uri și context compact): S–M, poate intra oricând ca felie a H02.
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

Începem cu **H03**, apoi **H02** (starea vizibilă și costul sunt cel mai lat și cel mai furios semnal), apoi **H12** și **H13** (ieftine, demonstrabile, fără dependențe), apoi **H14**, **H01**, **H15** și **H04**. Nu lansăm toate epics simultan. La finalul fiecărei etape cerem demonstrarea criteriilor „gata când” în folosire reală, fără a marca un card done doar pentru că există UI.

Urmărim: decizii vechi regăsite fără copy/paste, consum și limită cunoscute fără click, prompturi de permisiune văzute la timp fără să stai cu ochii pe terminal, o tură greșită anulată fără `git` manual, task-uri preluate fără copy/paste, conflicte fără pierdere de date și propuneri de learning care nu se acumulează inutil. Nu sunt ținte numerice inventate; vom stabili baseline-ul după folosire.

Această revizie a produs numai documentație și prioritizare. Nu au fost rulate teste, schimbate setări sau pornite automatizări.
