# Analiză: WebCMD — e de interes pentru Hello.? (rulare manuală F4 YouTube)

Data analizei: 2026-09-27. Nod: Coordonator analiză (după nodul de input YouTube).
Material sursă: un singur video, extras complet de nodul de input.

## Sursa și verificarea ei

- Video: „This Free Tool Cuts Claude Code Web Browsing Tokens by 90 Percent
  Permanently", canal InsiderForce, publicat 2026-09-25, 1:41.
  https://www.youtube.com/watch?v=bS6IlkUozAI
- Transcript arhivat: `.od/youtube/yt-eedd91ffbf769532d8a4be8c533cf6c2/bS6IlkUozAI.md`
- Videoul NU dă linkul uneltei (cere comentariu + follow — tipar de engagement-bait).
  Unealta a fost găsită independent: **https://github.com/agentrhq/webcmd**
  („Self-learning agent browser", Apache-2.0, ~2.6k stars / ~1.5k forks,
  ~694 commits, activ). Existența, licența și mecanismul de integrare
  (skill `webcmd-browser` pentru Claude Code/Codex + CLI + sesiuni) sunt
  **confirmate**. Multe fork-uri identice apar în căutare — semn de campanie
  de promovare; cifrele de popularitate se citesc cu prudență.

## Ce afirmă sursa (confirmat vs. neconfirmat)

| Afirmație | Stare |
| --- | --- |
| Unealtă open-source Apache-2.0, skill pentru Claude Code/Codex/OpenCode | confirmat (README repo) |
| Memorie per domeniu: context de navigare, shortcuts, rate limits, warnings | confirmat ca design declarat; neverificat funcțional |
| „Stealth driver" care trece de protecția Cloudflare | neverificat; README menționează un motor „CloakBrowser" |
| Profiles/spaces: agenți paraleli cu conturi diferite pe același site | confirmat ca feature declarat (profiles = cookie jars) |
| Reducere „până la 90%" a tokenilor | neverificat — fără benchmark public; claim de marketing |
| „Subsequent learning stays local" | parțial: README spune că primul acces poate folosi un „Webcmd Cloud seed" (serviciu cloud, „not yet stable") |

## Comparație cu Hello. azi (FEATURE-INVENTORY.md)

- Hello are deja browser `<webview>` cu granturi Off/Read/Full per tab și
  web research propriu (`web_tools.ts`) — ambele **stateless între rulări**:
  agentul redescoperă fiecare site de fiecare dată. Exact problema pe care
  o numește videoul există și la noi.
- `agent-target.ts` (nou, necomis) țintește elemente prin cuvinte vizibile —
  complementar: o memorie per domeniu ar reduce numărul de citiri de pagină
  necesare pentru a regăsi aceleași ținte.
- Backlog aprobat conex: #8 „Browserul ca sursă" (H05) și #9 „Memorie
  explicită cu control" (H06). Nu există duplicat în PROPOSALS-BACKLOG.md (gol).

## Conflicte cu contractul Hello. (de ce NU se adoptă unealta ca dependență)

1. **Stealth/bypass Cloudflare** contrazice frontal modelul de granturi
   explicite și postura de securitate a Hello (SECURITY.md): nu livrăm
   evaziune de bot-protection.
2. **Webcmd Cloud seed** trimite context despre domeniile vizitate către un
   serviciu terț „not yet stable" — contra posturii local-first (SQLite
   propriu, fără scurgeri).
3. **Profiles cu sesiuni autentificate** pentru agenți paraleli = agenți care
   operează conturi — contra regulii „no user credentials" și a granturilor
   per tab.
4. Integrarea nativă este un **skill pentru CLI-uri**: pe calea CLI workers,
   utilizatorul și-l poate instala singur în Claude Code/Codex; Hello nu are
   nimic de integrat acolo.

## Verdict și propunere candidat (pentru nodul de verificare)

**Interesant ca pattern, nu ca dependență.** Ideea validă și aplicabilă:

> **Candidat P — Memorie de navigare per domeniu pentru uneltele de browser
> ale Hello.** După ce un agent explorează un site prin browser tools,
> Hello păstrează local (SQLite propriu) note per domeniu: repere de
> navigare, ținte de elemente învățate (extinde `agent-target.ts`),
> capcane/rate limits observate. La următoarea sesiune pe același domeniu,
> notele se injectează în contextul tool-ului, sub aceleași granturi
> Off/Read/Full (memoria unui domeniu se citește doar când tabul are cel
> puțin Read). Fără stealth, fără cloud, fără conturi.
> Se leagă de backlog #8 (H05) și #9 (H06).
> **Recomandare: investighează** (dimensionare + schema de stocare + invalidare
> la schimbarea site-ului), nu prototipa încă — dovada e un singur video de
> promovare + un repo tânăr; lipsesc semnale de cerere de la utilizatori.

## Neverificat / limite

- Eficiența reală (90%) — nimeni nu a publicat măsurători.
- Funcționarea stealth driver-ului și calitatea memoriei — neinstanțiat local
  (interzis în QA: fără execuție reală de CLI / consum de credite).
- Cifrele de popularitate ale repo-ului — posibil umflate de campanie.
