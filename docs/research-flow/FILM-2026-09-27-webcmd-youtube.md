# FILM-2026-09-27-webcmd-youtube — Raport consolidat (findings)

**Data consolidării:** 2026-09-28 (reluare pe seat Fable 5 — Coordinator)  
**Inputuri:** analiza Fable 5.1 (nod 01a0e6f2-bf90-74d0-8366-2b1f3b8607ac) + evaluarea OpenJev `01a0e23d-8e8a-70a3-a576-d023ecb639f9`

---

## Sursa

- **Titlu:** „This Free Tool Cuts Claude Code Web Browsing Tokens by 90 Percent Permanently"
- **Link:** https://www.youtube.com/watch?v=bS6IlkUozAI (video ID: `bS6IlkUozAI`)
- **Canal:** InsiderForce
- **Durată:** PT1M41S
- **Dată publicare:** 2026-09-25T15:05:03Z
- **Transcript arhivat:** `.od/youtube/yt-eedd91ffbf769532d8a4be8c533cf6c2/bS6IlkUozAI.md`
- **Unealta menționată:** https://github.com/agentrhq/webcmd (Apache-2.0, ~2.6k stars / ~1.5k forks, ~694 commits, activ, creat 2026-07-02T11:49:31Z)

---

## Findings

1. **Unealtă open-source Apache-2.0; skill `webcmd-browser` pentru Claude Code/Codex + CLI** — origine: README repo webcmd — **confirmat**.

2. **Memorie per domeniu: context de navigare, ținte, capcane/rate limits** — origine: video + README — **confirmat ca design declarat; neverificat funcțional**.

3. **„Stealth driver" pentru bypass Cloudflare** — origine: video; README menționează motor „CloakBrowser" — **neconfirmat funcțional; claim de marketing**.

4. **Profiles/spaces: agenți paraleli cu conturi diferite pe același site** — origine: README — **confirmat ca feature declarat**.

5. **Reducere „până la 90%" a tokenilor** — origine: video (titlu direct) — **neconfirmat: fără benchmark public direct; BU Bench V1 găsit în README acoperă accuracy/cost/turns, nu claim-ul de 90% tokeni**. Analiză din nodul Fable 5.1: „covers accuracy/cost/turns rather than the 90% token claim".

6. **„Subsequent learning stays local"** — origine: video vs. README — **parțial contrazis: README menționează „Webcmd Cloud seed" (serviciu cloud, „not yet stable")** — context despre domenii pleacă la terț.

7. **Repo statistics: star-to-fork ratio și timing** — origine: GitHub API (nodul Fable 5.1) — **1.7:1 star-to-fork ratio (suspicious; fork-uri identice în căutare posibil campanie de promovare)**. Ultimul push (2026-09-25T15:05:03Z) aliniază exact cu data publicării video-ului — **coincidență suspectă, reinforces suspiciune asupra inflării artificiale de popularitate**.

---

## Hello: ce există și golul real

Din analiza Fable 5.1:

- Browser `<webview>` cu granturi Off/Read/Full per tab; web research propriu (`web_tools.ts`) — ambele **stateless între rulări**: agentul redescoperă fiecare site de fiecare dată. Exact problema numită de video.
- `src/main/browser/agent-target.ts` (nou, necomis) — țintește elemente prin cuvinte vizibile, complementar unei memorii per domeniu.
- Backlog aprobat conex: #8 „Browserul ca sursă" (H05), #9 „Memorie explicită cu control" (H06).

**Golul:** memorie de navigare per domeniu persistată între sesiuni.

**Propunerea candidat (netranșată; planul e nodul următor):** memorie de navigare per domeniu în SQLite propriu (repere, ținte, capcane/rate limits), injectată la următoarea sesiune, sub granturile Off/Read/Full existente. Fără stealth, fără cloud, fără conturi.

---

## Verdict

**Analiză Fable 5.1: INTERES — DA ca pattern, NU ca dependență.** Trei conflicte directe cu AGENTS.md:

1. Stealth driver/bypass Cloudflare — contra granturi explicite + SECURITY.md.
2. Webcmd Cloud seed — context domenii la serviciu terț, contra local-first.
3. Profiles autentificate — contra regulii „no user credentials".

**Recomandare analizei:** investigați pattern (memorie per domeniu), nu prototipați WebCMD — dovada e un singur video + repo tânăr; lipsesc semnale de utilizatori.

### Scoruri OpenJev (evaluarea `01a0e23d-8e8a-70a3-a576-d023ecb639f9`)

| Criteriu | Rezultat | Confidence |
|---|---|---|
| dovezi | 82.2% prob. yes | — |
| efort | 0.99 / 2 (mediu) | 0.85 |
| noutate | 86.4% prob. yes | — |
| relevant hello | 85.4% prob. yes | — |
| risc invariante | 0.70 / 2 (izolat, reversibil) | 0.36 |
| **ruta** | **mai_multe_dovezi: 60.1%** | **0.47** |

Distribuție: mai_multe_dovezi 60.1% · backlog 38.6% · respins 1.0% · implementeaza 0.3%.

### Contradicția de semnale — analiză explicită

- Relevanța 85.4%, noutate 86.4%, dovezi 82.2% (toate > 0.70) ar indica IMPLEMENTEAZĂ după regulă.
- Dar ruta aleasă: mai_multe_dovezi 60.1% cu implementeaza la 0.3% — semnalul opus.
- **Semnalul rută cântărește mai mult** pentru că: (a) e singurul care întreabă direct acțiunea finală, integrând toate celelalte; scorurile booleene sunt parțiale. (b) Distribuția rutei e decisivă: 0.3% nu e marginal. (c) Confidence-urile scăzute (ruta 0.47, risc 0.36) cer prudență. (d) Ruta e coerentă cu verdictul analizei („investigați, nu prototipați") — claim-ul central e nemăsurat, propunerea Hello-nativă nu a fost evaluată separat.

---

## Neverificat

- **Reducerea 90% tokenilor:** fără benchmark public; BU Bench V1 din README e self-published și nu acoperă claim-ul direct (accuracy/cost/turns).
- **Stealth driver, calitate memorie:** neinstanțiat local (QA: fără execuție reală CLI/credite).
- **Cifrele popularității repo:** posibil umflate (fork-uri identice în căutare, push exact la publicare video).
- **Propunerea Hello-nativă:** netranșată separat de OpenJev.

### Dovezi care ar schimba recomandarea în IMPLEMENTEAZĂ

1. **Semnale de cerere de la utilizatori:** pe Reddit/GitHub Issues/feederele F1/F3 — „agent browser memory" / „persistent navigation state" / „re-exploring sites" (conform „roadmap needs external validation").
2. **Benchmark public măsurabil:** o verificare a claim-ului „90%" sau o măsurare proprie în Hello a costului de redescoperire per sesiune.

---

RECOMANDARE: MAI MULTE DOVEZI
