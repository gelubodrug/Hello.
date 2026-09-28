# RAPORT-2026-09-28-webcmd-agent-browser — Raport consolidat (trecerea run-2026-09-28-v37)

**Data consolidării:** 2026-09-28
**Baza consolidării:** extractul sursei + secțiunea „Analiză (nod Analiză, trecerea run-2026-09-28-v37)" din `docs/research-flow/FILM-2026-09-28-webcmd-agent-browser.md` (canonic pentru această trecere, decizie a coordonatorului).
**Notă de fișier:** numele `RAPORT-…` în loc de tiparul `FILM-…` este o abatere deliberată decisă de coordonator, ca inputurile (extract + analiză) din `FILM-2026-09-28-webcmd-agent-browser.md` să nu fie suprascrise.
**Trecere anterioară pe aceeași sursă (istoric, nu dovadă proprie):** `docs/research-flow/FILM-2026-09-27-webcmd-youtube.md`, verdict „MAI MULTE DOVEZI" — cererea ei de dovezi a fost verificată în trecerea de azi, deci verdictul ei e consumat.

---

## Sursa

- **Titlu:** „This Free Tool Cuts Claude Code Web Browsing Tokens by 90 Percent Permanently"
- **Link:** https://www.youtube.com/watch?v=bS6IlkUozAI (video ID: `bS6IlkUozAI`), YouTube Shorts
- **Canal:** InsiderForce · **Durată:** PT1M41S · **Publicat:** 2026-09-25T15:05:03Z
- **Unealta:** WebCMD — `github.com/agentrhq/webcmd` (Apache-2.0, creat 2026-07-02, ultimul push 2026-09-25, 2 610 stars / 1 534 forks la 2026-09-28)
- **Afirmația centrală a videoclipului:** „up to 90% fewer tokens on every workflow your agent already understands" [00:01:16–00:01:19], printr-o memorie de navigare per domeniu.

---

## Findings consolidate (cu origine și stare)

1. **Repo real, activ, licență Apache-2.0** — GitHub API, 2026-09-28 — **confirmat**. Linkul direct, neverificabil din video (cerea „Comment web"), e acum confirmat.

2. **Claimul central de −90% tokeni este contrazis de benchmark-ul propriu al autorilor.** BU Bench V1 (`benchmarks/README.md`, 100 de task-uri, self-published): tokeni totali −10% față de browser-use și practic paritate (+0,09%) față de dev-browser; acuratețe 67% vs. 66% (1 task din 100), rulări unice fără intervale de încredere, recunoscut explicit în raportul lor — **claim infirmat ca ordin de mărime acolo unde există măsurătoare**.

3. **Stratul de memorie/self-learning — argumentul central al videoclipului [00:00:29–00:00:46] — nu este exercitat deloc în benchmark**: nicio rulare warm/cold, nicio vizită repetată pe domeniu. Câștigurile măsurate provin din trei tehnici ortogonale memoriei: snapshot pruning cu prioritizare, diff structural după acțiuni, execuție batch a comenzilor de browser — **efectul memoriei rămâne nemăsurat inclusiv la autori**.

4. **Benchmark-ul cere motorul propriu CloakBrowser pentru toate uneltele comparate**, iar judecătorul e ales de autori — reproducere legată de ecosistemul lor — **confirmat din README; slăbește valoarea probatorie a benchmark-ului**.

5. **Trei conflicte directe cu invariantele Hello (AGENTS.md/SECURITY.md), confirmate în README-ul curent:** (a) stealth driver/CloakBrowser pentru bypass de bot-detection [00:00:48–00:00:55] — contra granturilor explicite Off/Read/Full decise în main; (b) „Webcmd Cloud seed" la primul acces, serviciu „not yet stable" — contextul de domenii pleacă la un terț, contra posturii local-first; (c) profiles/spaces cu conturi diferite pentru agenți paraleli [00:00:57–00:01:05] — contra regulii „no user credentials".

6. **Semnale de cerere: generice da, specifice nu.** Există un ecosistem real de memorie persistentă pentru agenți (claude-mem, agentmemory, memory tool-ul Anthropic), dar **nicio dovadă de cerere specifică pentru memorie de navigare per domeniu în browser** — exact problema din video. Feederele F1/F3 nu au rulat în această trecere.

7. **Anomalia de popularitate persistă:** raport stars:forks ~1,7:1 (normal 10:1+), ultimul push exact în ziua publicării videoclipului — suspiciune de promovare artificială, consemnată și în trecerea din 27.09 — **anomalie confirmată, cauză nedovedită**.

8. **Integrarea nativă în Hello nu are obiect:** WebCMD se livrează ca skill de CLI pe care utilizatorul și-l poate instala singur în CLI workers; nu există nimic de integrat în browserul `<webview>` sau în web research fără a prelua conflictele de la punctul 5.

---

## Neverificat

- Funcționarea reală a memoriei per domeniu și a stealth-ului — neinstanțiat local (QA-ul trecerii interzice execuție reală și credite).
- Orice măsurătoare a efectului memoriei pe vizite repetate — nu există nicăieri, nici la autori.
- Proveniența celor 1 534 de fork-uri — anomalia e consemnată, cauza nu e dovedită.
- Cererea specifică de utilizatori pe feederele F1/F3 (GitHub Issues/Reddit țintit) — nerulate în această trecere.

---

## Verdict

Cele două dovezi cerute de trecerea din 27.09 au fost căutate: benchmark-ul a apărut și **contrazice** claimul central (−10%, nu −90%, cu stratul de memorie neexercitat); cererea specifică **lipsește în continuare**. A cere „mai multe dovezi" a doua oară ar bucla fără un fapt nou de așteptat.

- **Ca dependență (adopția WebCMD): NU** — trei conflicte directe de invariante, confirmate azi în README, plus lipsa oricărui obiect de integrare (pct. 8).
- **Ca pattern de implementat acum (memorie de navigare per domeniu): NU** — eficiența promisă e nemăsurată chiar și de autori, cererea specifică nedemonstrată; subiectul rămâne acoperit de itemii de backlog existenți #8 „Browserul ca sursă" (H05) și #9 „Memorie explicită cu control" (H06), fără duplicat.
- **Observație colaterală pentru o trecere viitoare (propunere nouă, nu obiectul acestei porți):** tehnicile care chiar au produs câștigurile măsurate — snapshot pruning cu buget prioritizat, diff structural după acțiune, batch de comenzi de browser — sunt implementabile local în `browser_read`/agent-input, fără dependență și fără conflict de invariante; merită subiect propriu, cu măsurătoare proprie a costului real al `browser_read` în Hello.

Maparea pe formele porții: analiza a scris „NU IMPLEMENTA"; forma corespunzătoare este RESPINS — soluția nu se aplică în Hello (contravine invariantelor), iar claimul care o motiva e infirmat de măsurătoarea propriilor autori. Fără PLAN-*.md în această trecere; poarta omului rămâne închisă pe acest subiect dacă nu apar semnale de cerere specifice.

---

RECOMANDARE: RESPINS
