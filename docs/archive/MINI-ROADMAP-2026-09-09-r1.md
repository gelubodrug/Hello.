# Hello. — mini-roadmap de lucru

Propunere din 9 septembrie 2026, bazată pe [research-ul consolidat și surse](feature-research/RESEARCH-2026-09-09.md) și pe inspecția noului repo. Ajustările propuse de research-ul pe nouă categorii, cu voturi verificate, sunt în [MOST-WANTED-FEATURES-2026-09-09](feature-research/MOST-WANTED-FEATURES-2026-09-09.md), secțiunea „Ce s-a schimbat”. Nu este o declarație de funcții livrate și nu pornește implementarea. Toate checkbox-urile de mai jos sunt lucru propus.

**Direcție:** Hello. reține deciziile, face vizibil lucrul și poate fi extins fără să devină un IDE aglomerat sau un sistem opac de boți.

Mărimi relative: **S** = schimbare localizată; **M** = un flux vertical UI/main/store; **L** = subsistem cu persistență și condiții de recuperare. Nu sunt estimări în zile. Etapele au criterii de ieșire, nu termene presupuse.

## Contract care nu se schimbă

- Designul aprobat rămâne: numai chat-uri în stânga, actori în pills, un tool vizibil, controale în header și nimic peste browserul nativ.
- Runbook rămâne read-only pentru agentul principal; Tasks rămâne read/write. Omul le editează pe ambele. Nu injectăm automat notebook-uri și nu trimitem task-uri automat la launch-ul CLI.
- Sursele, memoria și skills nu pot acorda permisiuni. Agent control rămâne Off implicit și per tab.
- Originalele și rezultatele reale se păstrează. Un rezumat, „done” sau badge nu înlocuiește dovada.
- Local-first; orice conector transmite doar datele autorizate pentru operația respectivă. Modelul mai scump sau autonomia suplimentară nu se activează tacit.

## Etapa 1 — continuitate și lucru vizibil

### H01 · Shared Tasks și handoff complet · M · prioritate P0

**De ce:** este fluxul central Hello. și o cerință directă, susținută de aprecierea pentru Runbook-uri utile. Exporturile actuale nu oferă write-back de la worker.

- [ ] ID stabil pentru task/subtask, status explicit, revizie și autorul modificării, fără dependență exclusivă de numărul liniei Markdown.
- [ ] Bridge local, limitat la chat, pentru citire Runbook și actualizare Tasks de către un worker conectat explicit. Exporturile rămân documente lizibile, nu două surse concurente de adevăr.
- [ ] Conflict vizibil dacă omul și agentul modifică aceeași revizie; nu suprascriem automat. Istoric și restaurare a unei modificări.
- [ ] Legătură task → worker/run → rezultat; lansarea simplă a unui CLI nu îl desemnează automat owner și nu îi trimite lucru.

**Gata când:** un task creat în chat poate fi preluat explicit de un worker compatibil, actualizat și văzut imediat în Tasks; un conflict nu pierde textul omului. Pentru CLI fără bridge, UI spune clar „file handoff”, fără promisiune de sync sau sandbox.

### H02 · Inspector de rulare, consum și output live · M · P0

**De ce:** costul observabil și controlul asupra execuției au semnale directe în mai multe comunități. Terminalul există; output-ul live al `command_run` în chat este încă un gol.

- [ ] Model/endpoint efectiv salvate per turn, input/output/cached tokens dacă sunt raportate, durată și total per conversație.
- [ ] Cost „raportat” separat de „estimat”; pricing cu dată/sursă și câmp „necunoscut”, nu zero, când nu avem date. CLI extern fără usage disponibil = N/A.
- [ ] Limită de pași și buget înaintea următoarei operații; fără schimbare tacită la un model mai scump. Limita estimată nu se prezintă ca plafon de facturare garantat.
- [ ] stdout/stderr incremental, limitat ca volum, în tool card; Stop vizibil și stare finală adevărată.

**Gata când:** pot vedea ce rulează, cu ce model, unde s-au dus tokenii și de ce s-a oprit. Pill-ul rămâne de mărime fixă; detaliile stau într-un inspector.

### H03 · Căutare reală și recuperarea sursei · M · P0

- [ ] Search local în mesaje, Runbook și Tasks, nu doar titluri; snippet, dată și salt la mesaj/intrare.
- [ ] Tool search/read cu rezultate limitate și ancore stabile; scope implicit conversația curentă, alte chat-uri numai când sunt incluse explicit.
- [ ] Căutarea funcționează fără LLM și fără embedding obligatoriu. Ștergerea unei surse invalidează și indexul ei.

**Gata când:** „unde am decis X?” duce la pasajul original, iar agentul îl poate consulta fără să ceară copy/paste. Nu confundăm faptul că două chat-uri folosesc același folder cu permisiunea de a le amesteca.

### H04 · Context manager recuperabil · L · P0 · după H02/H03

- [ ] Budget de context per model, cu sursă sau estimare declarată; avertizare înainte de limită.
- [ ] Compactare explicită și prag configurabil: rezumat versionat + segment recent + referințe la originale. Evenimentul arată ce s-a compactat.
- [ ] Cerințe/pasaje fixate explicit; dacă nu încap, oferim alegere, nu trunchiere ascunsă. Perechile tool call/result rămân valide.
- [ ] Întreruperea compactării nu modifică transcriptul canonic; recuperare de mesaje originale prin H03. Costul rezumării intră în H02.

**Gata când:** pot continua o conversație lungă, inspecta rezumatul și regăsi originalele inclusiv după restart. Nu promitem „memorie fără pierderi” doar pentru că avem un rezumat.

**Ieșirea etapei 1:** un singur flux research → Tasks → worker → rezultat poate fi urmărit, reluat și înțeles fără context copiat manual sau cost ascuns.

## Etapa 2 — research bun și învățare controlată

| ID | Livrabil și checklist | Gata când | Mărime / dependențe |
| --- | --- | --- | --- |
| H05 | **Surse și documente.** [ ] Selectare explicită de fișiere/pagini; [ ] extragere text/PDF cu limite și avertizare pentru pagini neextrase; [ ] source ID, URL/path, dată, pasaj și ancoră; [ ] inspector și export cu citări. Imagini doar când modelul le suportă. | Fiecare citare de research poate deschide pasajul folosit. Link verificat nu este etichetat automat „afirmație adevărată”. Browserul Off nu este ocolit prin alt tool. | L; H03/H04. Atașamentele sunt și cerință de bază a produsului, nu declarate „cele mai votate”. |
| H06 | **Memorie curată, cu review și istoric.** [ ] Fapte/preferințe separate de tasks și Runbook; [ ] scope explicit user/chat/folder; [ ] sursă, dată, edit/delete; [ ] propunere → diff/edit → approve/reject; [ ] detectare stale, grupare și rollback. | O corecție aprobată poate fi regăsită în scope-ul ales; una respinsă sau expirată nu reapare ca fapt. Fără graph sau curator autonom în prima versiune. | M–L; H03, reviziile H01 |
| H07 | **Bibliotecă locală de skills.** [ ] Listă/search și invocare din composer; [ ] catalog de descrieri, body la cerere; [ ] scope și sursă; [ ] preview înainte de import/update, păstrarea editărilor locale. Starter: research cu surse, task planning/handoff, retrospectivă. | Același workflow poate fi refolosit fără paste și fără încărcarea întregii biblioteci în context. Inspectarea unui skill nu execută scripturi și nu acordă drepturi. | M; mecanismul de review H06 |
| H08 | **MCP selectiv și credential handles.** [ ] Conectare explicită a unui server; [ ] tool-uri activate per chat, descrieri/use-when și volum controlat; [ ] permisiuni, timeout, health/disable; [ ] secrete rezolvate în main pentru operația autorizată, nu în transcript. | Un conector util funcționează fără să expună toate tool-urile tuturor conversațiilor. Un server defect nu blochează chat-ul. Instalarea este distinctă de activare. | L; H02/H04; review de securitate înainte de conectori sensibili |

**Ieșirea etapei 2:** Hello. poate face research cu dovezi și poate reutiliza un workflow aprobat. Nu avem nevoie încă de marketplace sau de înlocuirea întregului runtime cu plugin-uri.

## Etapa 3 — ramuri și lucru în fundal

| ID | Livrabil și checklist | Limită importantă | Mărime / dependențe |
| --- | --- | --- | --- |
| H09 | **Fork from here.** [ ] Conversație copil cu parent/anchor; [ ] original neschimbat; [ ] proveniența contextului copiat și export. | Nu reexecutăm tool-uri din istoric și nu duplicăm procesele CLI. Poate intra mai devreme ca livrabil mic după H03. | M; H03 |
| H10 | **Rulări durabile + notificări.** [ ] Run ID și jurnal persistat; [ ] running/waiting/blocked/interrupted/done; [ ] rezultat final livrat o singură dată; [ ] reluare explicită; [ ] notificare la rezultat, eroare sau cerere de intervenție. | Restaurarea UI nu înseamnă că un PTY mort a fost reînviat. Nu reluăm efecte externe fără să știm dacă au avut loc. Fără fan-out autonom în prima versiune. | L; H01/H02/H04 |
| H11 | **Monitorizări programate cu continuitate.** [ ] Un job cu istoric de rulări; [ ] pause/cancel, timezone și politică pentru rulări ratate; [ ] deduplicare și memorie a ultimului rezultat; [ ] quiet dacă nu s-a schimbat nimic; [ ] script simplu fără LLM unde ajunge. | Laptop adormit/app închis ≠ execuție garantată. Agent control nu se reactivează automat pentru un job. Read-only implicit, scriere numai cu autoritate explicită. | L; H10 și limitele H02/H08 |

## În afara primului roadmap

- **Bot societies, chat-uri de grup între agenți, graph de memorie, Kanban multi-agent:** semnalul nu justifică încă complexitatea; începem cu Tasks și un owner/run clar.
- **Marketplace general / everything-is-a-plugin:** amânat până când skills locale și câțiva conectori au valoare demonstrată. Nu rescriem Hello. pentru paritate de catalog.
- **Telegram/Slack/Discord și remote control:** după H10/H11, cu pairing, revocare și livrare sigură; primul pas poate fi doar notificarea, nu shell de la distanță.
- **Vault complet pentru parole/TOTP/SSH:** nu construim acum un password manager. H08 acoperă strict credentialele necesare conectorilor.
- **Voice, browser profiles multiple, multi-model arena și import general din alte aplicații:** backlog de validat, nu eliminate. Nu avem în acest eșantion motiv suficient să le punem înaintea continuității.
- **Gmail cleanup, homelab, SEO, RSS:** exemple de skills/conectori, nu patru platforme noi în core.

## Cum alegem următorul lucru

Începem cu **H01**, apoi **H02/H03**, apoi **H04**. Nu lansăm toate epics simultan. La finalul fiecărei etape cerem demonstrarea criteriilor „gata când” în folosire reală, fără a marca un card done doar pentru că există UI.

Urmărim: task-uri preluate fără copy/paste, rezultate legate de sursa lor, decizii vechi regăsite, conflicte fără pierdere de date, consum cunoscut și propuneri de learning care nu se acumulează inutil. Nu sunt ținte numerice inventate; vom stabili baseline-ul după folosire.

Acest tur a produs numai documentație și prioritizare. Nu au fost rulate teste, schimbate setări sau pornite automatizări.
