# Capabilități necesare — lipsuri aplicația-soră pentru fluxul zilnic de cercetare

Constatate 14 septembrie 2026, prin inspecția contractelor existente
(scenario_edit/scenario_workflow, spawn_worker, nodurile feeder/youtube) și
prin încercări reale. O configurație desenată pe canvas NU este integrare
funcțională; lista de mai jos e ce trebuie construit sau clarificat în aplicația-soră.

## 1. Programare zilnică a unui workflow întreg

- Lipsă: un declanșator zilnic la nivel de workflow (oră + fus orar
  configurabile). Doar nodul YouTube are intervalMinutes propriu; feederii și
  coordonatorul nu au trigger.
- Input: workflowId + oră locală + fus orar. Output: o rulare identică cu cea
  manuală (același graf, aceleași contracte), cu jurnal al pornirii.
- Contract de extins: scenario_workflow / executarea legată de chat; sau un
  scheduler al aplicației care „apasă run" pe workflow.
- Verificare: două rulări consecutive programate produc runs/<data>/report.md
  fără intervenție umană, iar rularea manuală produce exact aceeași structură.
- Paliativ actual: rulare manuală din acest chat; sau un cron al harness-ului
  coordonatorului — dar acesta cere ca aplicația-soră să fie deschisă.

## 2. Disponibilitatea punții — condiție de funcționare

- Constatat azi: puntea od-orchestrator (127.0.0.1:51537) a fost indisponibilă
  în timpul lucrului („bridge unreachable"); fără ea nu există canvas, spawn
  sau raportare. O rulare zilnică nesupravegheată are nevoie fie de aplicația
  pornită garantat, fie de detectarea căderii cu raport „rulare ratată", nu
  raport gol.
- Verificare: o rulare pornită cu puntea căzută lasă în state.json lastError
  per sursă și un raport de eșec datat.

## 3. Stare incrementală per sursă (baseline, dedup, cache)

- Lipsă: Aplicația-soră nu oferă feederilor un store de stare între rulări; contractul
  feeder cere „ce s-a schimbat de la ultima trecere", dar baseline-ul trebuie
  purtat manual în brief.
- Input: identitatea sursei. Output: lastSuccessAt, id-urile deja văzute,
  lastError, citibile/scriibile de feeder la fiecare trecere.
- Contract de extins: raportul acceptat al feederului ar trebui să-și
  actualizeze automat referința de baseline pentru trecerea următoare.
- Paliativ actual: docs/research-flow/state.json în repo, scris de raportor.
- Verificare: a doua rulare pe surse neschimbate produce „nicio schimbare"
  fără a re-livra elementele primei rulări.

## 4. Conector Reddit

- Lipsă: old.reddit.com refuză colectarea din script (403 confirmat la
  14 sept.). Calea autorizată existentă e browserul Chrome al utilizatorului
  (read-only), care nu e disponibil unui feeder aplicația-soră.
- Input: listă subreddit-uri + interval. Output: thread-uri top cu titlu,
  link, scor, dată.
- Verificare: o colectare reală returnează thread-uri datate din ziua rulării.
- Până atunci: F3 raportează „sursă indisponibilă pentru colectare automată".

## 5. Livrarea materialului între noduri ca artefact datat

- Parțial: nodul YouTube arhivează Markdown datat; feederii generici nu au un
  loc standard al livrării, iar raportul unui nod nu e automat „deschis din
  chat și din artefactele nodului".
- Contract dorit: fiecare livrare de feeder = fișier Markdown datat, asociat
  nodului, vizibil în UI-ul nodului și referențiabil de coordonator.
- Paliativ actual: runs/<data>/feeds/<F#>/ în repo + linkuri în raport.
- Verificare: din chat se poate deschide raportul unei rulări și materialul
  fiecărui feeder al acelei rulări.

## 6. Identitate de chat proprie pentru Coordonatorul de analiză

- De clarificat: nodul coordinator promite „aceleași drepturi și tooluri ca
  Orchestratorul, cu propria misiune și identitate de chat"; trebuie
  confirmat pe o rulare reală că primește brieful propriu și materialul
  feederelor conectate, nu promptul misiunii globale.
- Verificare: în prima rulare completă, raportul coordonatorului citează
  explicit livrările feederelor (nu misiunea globală) ca input.
