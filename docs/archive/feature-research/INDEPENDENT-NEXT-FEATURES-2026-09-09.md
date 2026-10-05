# Hello. — ce features merită construite în continuare

Research independent, verificat la **9 septembrie 2026**, asupra noului proiect `/Users/q/Documents/Hello.`. Completează [research-ul existent](RESEARCH-2026-09-09.md) și propune ajustări la [mini-roadmap](../MINI-ROADMAP.md); nu înlocuiește o decizie de produs și nu pornește implementarea. Un tur ulterior, pe nouă categorii de produse și cu voturi verificate, este în [MOST-WANTED-FEATURES-2026-09-09](MOST-WANTED-FEATURES-2026-09-09.md).

**Recomandarea mea:** următoarea investiție mare ar trebui să fie **regăsirea deciziilor și continuarea conversațiilor lungi**. În apropierea ei: compatibilitate verificată cu modele locale, mesaje care pot corecta agentul în timpul lucrului, apoi memorie explicită și skills reutilizabile. Pentru Hello, acestea au o justificare mai solidă în eșantion decât un marketplace general sau o orchestrare autonomă cu mulți boți.

## Ce am verificat și ce înseamnă „cele mai căutate”

Am citit README, arhitectura, limitele de securitate, proveniența, mini-roadmap-ul și research-ul din noul Hello.; am consultat și contextul istoric din vechiul repo. Am verificat în cod golurile care influențează prioritizarea. Documentele atașate au fost tratate ca material de analiză: planurile și instrucțiunile lor nu au fost executate.

Research-ul web a acoperit **Hermes Agent, DeepSeek Harness, Pi, OpenCode, OpenClaw, Aider și Open WebUI**. Primele șase oferă repere pentru agenți/harness-uri; Open WebUI este relevant mai ales pentru experiența de chat, documente și modele locale.

Există două tipuri de dovezi: relatări/cereri directe ale utilizatorilor și documentație oficială care confirmă cum funcționează o capabilitate. Numai primul tip indică apreciere sau nevoie. Un feature documentat, un issue închis, numărul de comentarii ori stars nu constituie un sondaj de popularitate.

Ordinea de mai jos combină repetarea semnalului între comunități, impactul problemei, potrivirea cu Hello. și costul relativ al livrării. **Este o prioritizare calitativă, nu un clasament statistic al pieței.** „Semnal repetat” înseamnă apariții în surse distincte din acest eșantion, nu utilizatori unici numărați sau adopție măsurată. Relatările utilizatorilor nu au fost reproduse experimental. Unele descriu versiuni vechi sau configurații personalizate.

## Ce apreciază oamenii, în termeni concreți

Într-o discuție Hermes despre funcțiile preferate, oamenii descriu proceduri care cunosc deja serverul lor, retrospective salvate pentru a evita aceleași greșeli, citări utile cercetării și compactare care păstrează firul proiectului. Sunt exemple de valoare prin reutilizare și continuitate. Nu toate vin din funcțiile standard: un participant folosește și memorie semantică de la terți. [Discuția Hermes](https://www.reddit.com/r/hermesagent/comments/1w88n0e/what_are_your_favorite_hermes_skills_capabilities/)

Într-o discuție LocalLLaMA despre alegerea harness-ului, motivele invocate includ libertatea de a schimba furnizorul/modelul, personalizarea simplă și contextul care nu se umflă inutil. Un participant laudă compactarea DeepSeek Harness, dar admite că a schimbat și modelul: comparația nu izolează contribuția harness-ului. Folosesc aceste relatări drept preferințe exprimate, fără să preiau cifrele de performanță sau verdictul că un produs este superior. [Discuția LocalLLaMA](https://www.reddit.com/r/LocalLLaMA/comments/1w8f7bp/which_agent_harness_do_you_use_and_why/)

## Prioritățile recomandate pentru Hello.

Mărimi: **M** = un flux funcțional limitat; **L** = subsistem cu persistență, recuperare și mai multe condiții de funcționare. Sunt mărimi relative, nu estimări în zile. Un rând poate fi livrat în mai multe felii.

| Ordine | Feature și beneficiu | Semnal verificat | Prima versiune utilă pentru Hello. |
| --- | --- | --- | --- |
| **1** | **Căutare în conversații + context recuperabil.** „Unde am decis asta?” și „continuă de unde am rămas” devin acțiuni reale. | Repetat. Hermes raportează context umflat, compresie fragilă și recuperare manuală; DSH are cereri explicite de continuare după întrerupere. [Hermes #32156](https://github.com/NousResearch/hermes-agent/issues/32156), [DSH #511](https://github.com/deepseek-ai/deepseek-harness/discussions/511), [#2197](https://github.com/deepseek-ai/deepseek-harness/discussions/2197) | Search în mesaje/Runbook/Tasks, salt la original, apoi context disponibil și rezumat versionat cu scop/constrângeri/decizii. Istoricul rămâne recuperabil. **M pentru search, L pentru întregul flux.** |
| **2** | **Modele locale care funcționează verificabil + consum vizibil.** Utilizatorul știe ce funcționează cu endpoint-ul ales și de unde vine un eșec. | Repetat. Hermes și OpenClaw au rapoarte independente de istoric pierdut prin integrarea Ollama; DSH are un raport recent de ID-uri de tool reutilizate care afectează sesiunea. [Hermes #105892](https://github.com/NousResearch/hermes-agent/issues/105892), [OpenClaw #50894](https://github.com/openclaw/openclaw/issues/50894), [DSH #5909](https://github.com/deepseek-ai/deepseek-harness/discussions/5909) | Verificare la cerere: streaming, două ture cu istoric, tool call și continuare; model/endpoint salvat per răspuns, tokeni/context și cost estimat unde există date. Profil de capabilități și diagnostic clar; testul poate consuma tokeni și trebuie prezentat astfel. **M; adaptoare suplimentare separat.** |
| **3** | **„Corectează acum” / „Fă după ce termini” + output live.** Poți conduce lucrul fără să-l abandonezi și să rescrii cererea. | Repetat în trei ecosisteme. OpenCode cere revenirea cozii; Pi distinge explicit queue de steering; DSH cere corectarea subagenților înainte să termine. [OpenCode #44108](https://github.com/anomalyco/opencode/issues/44108), [Pi #403](https://github.com/earendil-works/pi/issues/403), [DSH #1968](https://github.com/deepseek-ai/deepseek-harness/discussions/1968) | Două acțiuni explicite, coadă vizibilă/editabilă/anulabilă, confirmare de livrare și Stop separat. Steering intră la următorul punct sigur; nu promite oprirea instantanee a unui tool. Mai întâi agentul principal; CLI-urile cer adaptoare proprii. **M.** |
| **4** | **Memorie explicită, editabilă.** „Ține minte preferința asta pentru proiectul X.” | Apreciere directă, dar și cerere de control: un utilizator reclamă salvări anunțate care nu avuseseră loc și cere scrieri explicite, limite și avertizări. [Hermes #96795](https://github.com/NousResearch/hermes-agent/issues/96795) | Salvează la cerere, sursă/dată/scope, vezi ce s-a salvat, edit/delete și istoric. Separă preferințele de task-uri și de rezumatul temporar al conversației. **M; propunerile automate și gestionarea conflictelor sunt o extindere.** |
| **5** | **Skills locale reutilizabile.** „Salvează metoda care a mers și folosește-o data viitoare.” | Apreciere directă pentru proceduri și retrospective; există și reacție împotriva modificării automate a unor skills aprobate. [Hermes favorites](https://www.reddit.com/r/hermesagent/comments/1w88n0e/what_are_your_favorite_hermes_skills_capabilities/), [Hermes #64926](https://github.com/NousResearch/hermes-agent/issues/64926) | Catalog mic cu descrieri, corp încărcat la nevoie, preview/edit, versiuni și invocare explicită. Starter: research cu surse, plan/handoff, retrospectivă. Încărcarea progresivă este documentată și în Pi. [Pi README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) **M.** |
| **6** | **Checkpoint pentru fișiere + backup/restaurare.** Poți experimenta și păstra ceea ce a învățat aplicația. | Cereri explicite pentru undo real în Pi și OpenCode; Hermes cere backup pentru istoric/memorie/skills. Sunt nevoi apropiate, cu implementări diferite. [Pi #1223](https://github.com/earendil-works/pi/discussions/1223), [OpenCode #375](https://github.com/anomalyco/opencode/issues/375), [Hermes #12238](https://github.com/NousResearch/hermes-agent/issues/12238) | Două livrabile: backup logic Hello. cu restaurare verificată; separat diff/checkpoint înaintea modificărilor de fișiere controlate de aplicație. Păstrează editările preexistente. Undo nu anulează efecte externe. **M–L fiecare, în funcție de scope.** |
| **7** | **Documente atașate cu citare până la pagină/pasaj.** „Compară aceste PDF-uri” fără ambiguitate despre ce a citit agentul. | Cereri concrete în Open WebUI: păstrarea fișierului lângă mesajul original și trimiterea documentului original către furnizorii care îl acceptă. Semnal mai îngust decât pentru continuitate. [OWUI #26045](https://github.com/open-webui/open-webui/discussions/26045), [#28434](https://github.com/open-webui/open-webui/discussions/28434) | PDF/text selectat explicit, extragere cu status și pagini neextrase vizibile; sursa legată de mesaj și pasaj; imagini doar cu modele capabile. Refolosește infrastructura web existentă. **L; un subset text/PDF poate veni mai devreme.** |
| **8** | **Rulări programate cu rezultate clare și notificări utile.** „Verifică periodic și spune-mi numai dacă s-a schimbat ceva.” | Există folosire reală, dar și cereri pentru rulări ratate după restart. [OpenClaw #10389](https://github.com/openclaw/openclaw/issues/10389) Un plugin DSH pentru notificări confirmă un caz de utilizare, nu popularitate largă. [DSH #4646](https://github.com/deepseek-ai/deepseek-harness/discussions/4646) | Mai întâi jurnal durabil al rulărilor și notificări la rezultat/eroare/nevoie de om. Scheduler ulterior: timezone, pause, ultima/următoarea rulare, politică la sleep/restart și deduplicare. **L.** |

**Conectorii/MCP** rămân o investiție utilă, dar aș alege prima integrare după un workflow concret al utilizatorilor Hello. Din acest tur nu rezultă că „suport pentru toate integrările” ar trebui să fie primul feature. Instalarea selectivă și încărcarea la nevoie sunt preferabile unei extinderi generale înainte să știm ce se folosește.

## Ce există deja și ce schimbă asta în roadmap

Inspecție statică, fără rularea aplicației sau a testelor. Liniile indică snapshot-ul consultat; repo-ul poate continua să se schimbe.

| Zonă | Starea reală identificată | Implicație |
| --- | --- | --- |
| Web research și citări | `web_search`/`fetch_url` există în [tools.ts](/Users/q/Documents/Hello./src/main/chat/tools.ts:82). Sunt salvate ID, URL, dată, text extras și trunchiere în [web-tools.ts](/Users/q/Documents/Hello./src/main/chat/web-tools.ts:157); [UI-ul](/Users/q/Documents/Hello./src/renderer/chat/WebResearch.tsx:35) afișează extrasul, iar [exportul](/Users/q/Documents/Hello./src/main/data/store.ts:468) include surse. | H05 este **parțial acoperit**. Urmează documentele și ancorele exacte afirmație→pasaj. Nu reconstruim căutarea web. Un link către o sursă citită nu verifică automat fiecare afirmație. |
| Search/context | [Sidebar](/Users/q/Documents/Hello./src/renderer/App.tsx:578) filtrează titluri. [Chat service](/Users/q/Documents/Hello./src/main/chat/service.ts:439) reconstruiește istoricul; limita de cerere este de 8 MB, fără compactare adaptată ferestrei modelului. | H03/H04 au justificare directă și generală. 8 MB nu reprezintă bugetul de context în tokeni al modelului. |
| Control în timpul lucrului | Există Stop/Retry; [service.ts](/Users/q/Documents/Hello./src/main/chat/service.ts:325) respinge o trimitere nouă cât timp răspunsul este activ. | Queue/Steer este un gol separat, insuficient reprezentat în roadmap. |
| Consum/limite | Există usage input/output și durate. Sunt deja limite fixe de runde și tool calls în [service.ts](/Users/q/Documents/Hello./src/main/chat/service.ts:188). [command_run](/Users/q/Documents/Hello./src/main/chat/tools.ts:601) livrează output acumulat la final. | H02 trebuie extins cu model efectiv, cache/cost cunoscut sau necunoscut, bugete configurabile și stdout/stderr incremental. Nu pornim de la zero. |
| Recuperare | La restart, [store.ts](/Users/q/Documents/Hello./src/main/data/store.ts:100) marchează operații întrerupte. [Retry](/Users/q/Documents/Hello./src/main/chat/service.ts:254) păstrează rezultate ale tool-urilor pentru a evita repetarea unor efecte. Run-urile active sunt în memorie. | Există o bază de recuperare. Lipsesc jurnalul durabil complet, reluarea structurată și schedulerul. |
| Modele/furnizori | O configurație globală de endpoint/model în [types.ts](/Users/q/Documents/Hello./src/shared/types.ts:11); încărcarea listei de modele nu este test de tool calling. | Adaugă diagnostic de capabilități și alegere/model istoric per conversație înaintea rutării automate între modele. |
| Tasks și CLI | [CLI launcher](/Users/q/Documents/Hello./src/main/terminal/cli-workers.ts:106) transmite căile notebook-urilor; [store.ts](/Users/q/Documents/Hello./src/main/data/store.ts:425) exportă SQLite→Markdown. Task status folosește linie/text verificat în [tasks.ts](/Users/q/Documents/Hello./src/main/chat/tasks.ts:29). | H01 rămâne un diferențiator Hello.; exportul nu înseamnă sincronizare bidirecțională. Este necesar un bridge explicit, cu task IDs/revizii și rezultat legat de run. |
| Memorie/skills/atașamente | Runbook/Tasks persistă, dar API-ul nu are memorie cross-chat, catalog de skills sau atașamente structurate; [chat.send](/Users/q/Documents/Hello./src/shared/types.ts:36) primește text. | Memoria, skills și ingestia de documente sunt goluri distincte, nu denumiri noi pentru notebook-uri. |
| Backup/fork | Există export Markdown; API-ul conversațiilor din [types.ts](/Users/q/Documents/Hello./src/shared/types.ts:26) nu oferă reimport/restaurare sau fork. | Backup logic și checkpoint de fișiere trebuie urmărite separat de H09 „Fork from here”. |

## Ce aș schimba față de mini-roadmap

1. **Aș pune H03 înaintea unui H01 complet**, dacă scopul este utilitatea pentru un public larg. Căutarea în istoric ajută și research-ul, și chat-ul, și coding-ul. Aș păstra H01 primul dacă fluxul dominant observat este delegarea zilnică către CLI-uri. Aceasta este o alegere de produs, nu un rezultat de sondaj.
2. **Aș împărți H02**: mai întâi model/usage/context și diagnostic; apoi output live și limite configurabile. Costul absent rămâne „necunoscut”; o estimare nu este plafon garantat de facturare. Pentru un model local, tokenii și viteza rămân utile chiar fără tarif API.
3. **Aș introduce Queue/Steer ca livrabil propriu**, înainte de multi-agent. Nu are nevoie de un scheduler sau de memorie automată.
4. **Aș livra varianta explicită a H06/H07 mai devreme**: „salvează această preferință/procedură”, editare și versiuni. Catalogul local de skills nu trebuie blocat de construirea unui sistem complet de learning automat sau de H01 în întregime. Propunerile automate vin după ce există review și gestionarea versiunilor depășite.
5. **Aș rescrie numai scope-ul propus pentru H05** în jurul documentelor și pasajelor, deoarece web search/fetch/citările de bază au intrat deja în cod. În acest tur am consemnat corecția aici, fără a modifica roadmap-ul original.
6. **Aș adăuga backup/restaurare și undo de fișiere**. Fork păstrează o ramură de conversație; nu restaurează automat starea proiectului. Aider oferă un reper concret prin commituri, diff și undo. [Documentația Aider](https://aider.chat/docs/git.html)
7. **Aș păstra H10/H11 după continuitate**, cu stări și rezultat verificabile. Într-un desktop local, un job programat trebuie să explice ce se întâmplă când laptopul doarme sau aplicația este închisă.

## Prima livrare pe care aș alege-o

**Search local în mesaje, Runbook și Tasks, cu salt la sursă și un tool de recuperare pentru agent.** Este o felie suficient de mică pentru a fi demonstrată și creează baza pentru compactare și memorie. Căutarea omului poate acoperi toate conversațiile sale; recuperarea automată a agentului trebuie să aibă scope explicit, fără amestecarea tacită a chat-urilor care folosesc același folder.

Criterii de acceptare propuse:

- O decizie aflată în corpul unui mesaj, absentă din titlu, este găsită cu fragment și deschidere la original.
- Rezultatele din Runbook/Tasks indică intrarea corectă și se actualizează după editare/ștergere.
- Funcția merge fără apel LLM sau embeddings obligatorii; agentul poate citi rezultatele autorizate printr-un tool limitat.
- După restart, rezultatele și ancorele rămân corecte.

**Următoarele felii:** diagnostic pentru model/context și Queue/Steer; apoi compactare recuperabilă și „salvează ca memorie/skill”. Aș evalua adoptarea în Hello. prin decizii regăsite fără copy/paste, corecții livrate la momentul ales, conversații continuate după întrerupere și proceduri refolosite. Nu avem încă baseline pentru ținte procentuale.

## Ce merită studiat la celelalte produse

| Produs | Lecția utilă pentru Hello. |
| --- | --- |
| **Hermes Agent** | Cunoștințe acumulate și proceduri reutilizabile, cu control asupra salvării și schimbărilor. Backup-ul este documentat acum în FAQ; cererea istorică #12238 nu dovedește absența lui curentă. [FAQ](https://hermes-agent.nousresearch.com/docs/reference/faq/) |
| **DeepSeek Harness** | Jurnalul de execuție inspectabil și relația dintre resume/fork/search/replay. Oficial este încă developer preview; arhitectura „everything is a plugin” este o opțiune tehnică, nu un mandat să rescriem Hello. [Pagina oficială](https://www.deepseek.com/harness/en/) |
| **Pi** | Separarea steering/follow-up, context compact, sesiuni portabile și skills la cerere. README-ul curent documentează deja queue, export HTML/JSONL și import JSONL. [README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) |
| **OpenCode** | Așteptările utilizatorilor privind controlul execuției și alegerea modelelor; cererea Queue rămâne foarte specifică. [#44108](https://github.com/anomalyco/opencode/issues/44108) |
| **OpenClaw** | Problemele practice ale unui agent folosit pentru rutine recurente: stare după restart, rulări ratate și context păstrat prin furnizori locali. [#10389](https://github.com/openclaw/openclaw/issues/10389), [#50894](https://github.com/openclaw/openclaw/issues/50894) |
| **Aider** | Modificări vizibile, diferențe și undo asociate lucrului agentului. [Git integration](https://aider.chat/docs/git.html) |
| **Open WebUI** | Search în conversații și documente asociate clar mesajelor. Documentația confirmă și tool-uri de căutare/recuperare a chat-urilor. [History & Search](https://docs.openwebui.com/features/chat-conversations/chat-features/history-search/) |

## Datele surselor și limite de interpretare

Toate sursele citate au fost consultate live în acest tur, individual sau în cercetarea paralelă. Mai jos sunt datele afișate pentru principalele dovezi de cerere; paginile oficiale fără dată editorială sunt tratate drept „curente la accesare”. Pentru Reddit, snapshot-ul returnează timpi relativi inconsecvenți cu data indexării, deci nu îi convertim într-o zi exactă. Statusurile issue-urilor sunt snapshot-uri, nu promisiuni privind starea produsului.

| Dovezi | Data afișată / interpretare |
| --- | --- |
| Hermes #32156 | 25 mai 2026; raport din instalare locală personalizată, open la verificare. |
| Hermes #105892; OpenClaw #50894 | 8 septembrie / 20 martie 2026; ambele closed la verificare. Confirmă clase de probleme raportate, nu bug-uri curente garantate. |
| DSH #511; #2197; #5909 | 13 august; 16 august cu confirmare macOS 19 august; 8 septembrie 2026. Ultimul este un raport recent individual. |
| OpenCode #44108; Pi #403; DSH #1968 | 22 august; 2 ianuarie; 15 august 2026. Cereri care disting queue de steering. Pi documentează acum ambele mecanisme. |
| Hermes #96795; #64926 | 28 august / 15 iulie 2026. Primul open; al doilea closed la verificare. Cereri pentru controlul memoriei/skills. |
| Pi #1223; OpenCode #375 | 3 februarie 2026, cu răspunsuri ulterioare și extensie comunitară; 24 iunie 2025, closed. Cereri pentru restaurarea fișierelor. |
| Hermes #12238 | 18 aprilie 2026. Cerere de backup și versionare; FAQ-ul actual documentează backup/export. Nu echivalăm întregul scope cerut cu ce este livrat. |
| OWUI #26045; #28434 | 14 iunie / 29 iulie 2026. Propuneri despre contextul atașamentelor și capabilitățile furnizorilor, nu voturi majoritare. |
| OpenClaw #10389; DSH #4646 | 6 februarie, closed / 26 august 2026. Raport despre rutine ratate, respectiv prezentarea unui plugin propriu. |

Eșantionul favorizează utilizatori tehnici și intensivi; GitHub scoate în față problemele, iar Reddit are experiențe autoselectate, uneori promoționale. Nu am însumat reacții/comentarii, nu am numărat răspunsuri automate drept oameni și nu am importat benchmark-uri neverificate. Cererea pentru voice, gateway-uri mobile, marketplace și grupuri de boți nu a fost măsurată exhaustiv; poziția lor mai târzie este o decizie de scope pentru Hello., nu dovada că nu sunt apreciate.

Acest tur a produs numai acest raport. Nu a modificat codul, designul, setările, bazele de date sau roadmap-ul existent și nu a rulat teste ori instalat harness-uri.
