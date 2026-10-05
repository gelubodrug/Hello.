# DSH în Hello — plan pe faze (2026-09-28)

Scop: Hello rămâne ecosistemul lui și rulează pluginurile DeepSeek Harness
(dsh): unelte, skill-uri, pluginuri de UI și teme, cu marketul lor și cu
instalare dintr-un click. Unde rulează fiecare:

- Uneltele și skill-urile rulează în chaturile Hello.
- Pluginurile de UI și temele rulează în **suprafața DSH**: clientul web dsh,
  găzduit de Hello și colorat cu tema Hello.

(Planul anterior, cercetarea din 2026-09-09, e încheiat și rămâne în istoricul git.)

## Decizii (utilizator, 28.09)

1. Ținta este Hello. Nu e un fork dsh și nici Hello rescris pe dsh.
2. Hello suportă pluginurile dsh: unelte, skill-uri, UI, teme și market. „Nu mai stăm închiși.”
3. Aspectul Hello se exprimă în tokenii temelor dsh, iar tema Hello se poate
   instala și în dsh.
4. Formatul pluginurilor făcute în Hello este formatul dsh.
5. Instalarea se face dintr-un click, cu pnpm inclus.
6. Pluginurile de UI și temele rulează în suprafața DSH (28.09, seara).

## Implicite propuse (se schimbă la cerere)

- **Locul suprafeței.** E o destinație a aplicației: rândul „DSH” din sidebar
  deschide clientul dsh pe tot workspace-ul. Un tab în panoul de unelte poate
  veni mai târziu, pe aceeași pagină. Pagina nu se mută în DOM și nu se reîncarcă.
- **Versiunea dsh.** Fixăm `0.1.7-rc.2`, versiunea din DSH Desktop 2.0.15, pe
  care o țintesc azi pluginurile din market. Spike-ul o compară cu
  `0.2.0-rc.1` (tag-ul `next` pe npm).
- **Modelul pentru sesiunile din suprafață.** Folosește conexiunea activă Hello,
  printr-un proxy în main, iar cheia reală nu intră în procesul dsh.
  Autentificarea lor DeepSeek rămâne posibilă, din suprafață.
- **Telemetria dsh.** E oprită:
  - profilul se numește `hello`, nu `desktop`;
  - rândurile de telemetrie și analytics sunt dezactivate;
  - procesul pornește cu `DO_NOT_TRACK=1`.
- **Descărcarea.** Suprafața se descarcă la prima deschidere și nu intră în
  pachetul aplicației.

## Ce știm (surse verificate)

**Marketul**

- Marketul din DSH Desktop este `dsh-community-market` (Anywhere Labs, MIT).
- Tab-urile lui sunt Discover, Installable, Installed și Sources. Are trei
  surse, alese de utilizator: 1024Store v2, dshfind și o sursă HTTP standard.
- Regulile lui de rețea: doar HTTPS, cel mult 3 redirecturi, fără adrese
  private, 2 MiB pe răspuns, termene de 8, 12 și 30 s. Comenzile venite de la
  sursă sunt aruncate.
- Instalarea are pașii:
  1. previzualizare din npm `latest`: același nume, versiune stabilă exactă,
     `dsh.bundle.patch` valid;
  2. confirmare;
  3. `pnpm add` exact;
  4. `dsh.profile.bundles`;
  5. restart explicit.

**Pluginurile**

- Un plugin dsh e un pachet npm cu `"dsh": { "bundle": { "patch": … } }`.
  Patch-ul inserează rânduri Cordis (`apply(ctx)`, `inject`).
- Pluginurile de UI și de temă cer shell-ul web dsh:
  - loader-ul `__ModuleLoader__` și graful `__DSH_BOOT__`;
  - tabela de module comune: React 18.3.1, cordis, ui-slots, ui-primitives și altele;
  - în jur de 20 de pluginuri de infrastructură;
  - pluginurile care declară slot-urile.
- Nu pot fi găzduite în React-ul Hello. Un plugin de browser care așteaptă un
  serviciu lipsă oprește tot boot-ul web.

**Cum se găzduiește gazda dsh** (`apps/desktop-host`, MIT, 122 de linii)

- Pornirea: `runProfile({ environment, profile, resolvedProfile: { profile,
  installAnchor }, patchFiles, args: ['--no-open', '--port', …], packageManager })`.
- Autentificarea: `ctx.connection.authenticatedUrl(origin)` dă `/?token=`, iar
  răspunsul e un 303 cu cookie `HttpOnly; SameSite=Strict`. Host și Origin
  sunt verificate.
- Portul 0 merge: serverul își citește portul real.
- `DSH_HOME` separă starea de `~/.dsh`.
- Profilul `desktop` pornește rândurile de telemetrie.

**Pe npm**

- `@deepseek-ai/dsh`, `dsh-app-boot`, `dsh-base`, `dsh-web-app` și
  `dsh-web-frontend` sunt publicate la `0.1.7-rc.2` (MIT). `dsh-web-frontend`
  are 5,7 MB despachetat.
- Tag-ul `latest` e rămas în urmă la mai multe pachete, deci instalăm doar
  versiuni exacte.

**Module native** în compoziția dsh: `node-pty` 1.2.0-beta.15 și `sharp` ^0.35.3.

**Tema**

- `ctx.theme.overrideTokens('sursă', { '--x': { light, dark } })` scrie
  variabile inline pe `body`.
- Nu poate schimba tokenii de elevație declarați pe fiecare element și nu
  schimbă layout-ul.
- Slot-urile de brand sunt `sidebar.brand.mark`, `sidebar.brand.name` și
  `conversation.hero.brand.mark`.

**Modelele**

- `@deepseek-ai/dsh-llm-pi-ai` folosește `@earendil-works/pi-ai ^0.85.1`,
  aceeași familie ca Pi-ul din Hello.
- Configurația are `providers.<id>.baseURL` și `apiKeyEnv`: o referință
  rezolvată la fiecare cerere, fără secret în fișier.

**MCP**: dsh are doar client MCP. Serverul MCP pentru puntea spre Hello îl scriem noi.

**Top 3 după instalări** (1024Store, 28.09)

- dsh1024 (793): UI plus rute care rulează `dsh plugin add`; în catalog apare
  doar ca GitHub; trimite telemetrie.
- dsh-memory-plugin (386): hook-uri, MCP și 2 skill-uri; cere un server OpenViking.
- archify (245): un singur skill.

Macheta: `scratchpad/hello-dsh-top3/index.html`, în afara repo-ului.

## Arhitectura, pe scurt

```
Hello main ──utilityProcess──▶ gazda dsh  (runProfile, profil „hello”, DSH_HOME = <userData>/dsh)
  │   token → cookie: net.request în partiția persist:hello-dsh        │ 127.0.0.1:<port liber>
  ├── webview „DSH” (src emis de main, fără preload) ◀─────────────────┘ clientul web + pluginurile de UI + tema Hello
  ├── proxy de model 127.0.0.1 (token per pornire) ◀── dsh-llm-pi-ai din gazdă
  ├── marketul portat: pnpm add --save-exact în profil → restart explicit al gazdei
  └── puntea MCP (pluginul Hello din gazdă) ──▶ clientul MCP Hello ──▶ chaturile Pi
```

## Jurnal de lucru (noaptea 28→29.09, autonom) — stare la final

**Făcut și verificat.** Pe lângă teste, fiecare punct a fost verificat și în
aplicația reală: build de producție, `HELLO_DATA_DIR` separat, condusă prin CDP.

- [x] **Faza 0 — spike.** Raportul e în `docs/DSH-SPIKE.md`.
  - Piedica: `node-addon-require-builtin` recunoaște doar Electron 44.0.0 exact.
  - Rezolvare: shim-ul Hello și `--expose-internals`. Merge pe 0.1.7-rc.2 și pe 0.2.0-rc.1.
- [x] **Faza 1 — gazda.** Codul e în `src/main/dsh/`: layout, pnpm inclus (11.8.0),
      runtime, host și host-entry (utilityProcess), puncte de restaurare, profil,
      service, ipc.
  - Pinul e 0.1.7-rc.2.
  - Profilul e `hello`, cu `DSH_HOME` propriu și telemetria oprită.
  - O instalare de la zero durează în jur de 5 s cu store-ul pnpm cald; fără el, 18 s la spike.
- [x] **Faza 2 — suprafața.**
  - Login token → cookie în `persist:hello-dsh`, ghid aprobat de main, garda de navigare.
  - Vederea DSH din sidebar, parcată când e ascunsă.
  - Verificat în aplicația reală: Install → running → pagina dsh în webview.
- [x] **Faza 3 — tema.**
  - Pachetul `assets/dsh/hello-dsh`: 118 tokeni generați din tokens.css, Inter,
    brand „Hello.”, rândul `ui-brand-official` oprit.
  - Suprafața urmează aspectul Hello (dark), cu test de sincronizare.
- [x] **Faza 4 — modelul.** Proxy cu token per pornire; cheia reală merge doar spre
      furnizor; modelul Hello devine implicit; opțiunea „folosește conexiunea Hello”
      se poate opri. Verificat: un mesaj din composer-ul dsh a ajuns la un server de
      model de probă cu cheia reală, iar răspunsul a apărut în dsh.
- [x] **Faza 5 — marketul.**
  - Port din dsh-community-market: CSS copiat exact, cele 4 tab-uri, sursa 1024Store,
    regulile de rețea, iconițe prin main, verificare npm și poarta de compatibilitate.
  - Instalare în profil, „Add by npm name”, „Add from folder…”, Installed cu Uninstall.
  - Garda de boot: pluginurile pe care pagina nu le pornește sunt numite într-un banner.
  - Garda pentru schimbări făcute din afara Hello: confirmare înainte de pornire.
  - Verificat în aplicația reală: 50 de pluginuri live cu iconițe; memory instalat
    din UI; restart; totul rulează.
  - Blocat corect: `dsh-better-sidebar`, care cere dsh 0.2.
- [x] **Faza 6 (parțial) — skill-uri.** Skill-urile pluginurilor DSH instalate apar în
      „Found on this Mac” (Extensions) și se importă în biblioteca Hello.
- [x] **Faza 6 — uneltele pluginurilor în chaturile Hello.**
  - Entry-ul de gazdă pornește puntea pe 127.0.0.1, cu un token per pornire pe care
    îl șterge din mediu înainte de boot.
  - `GET /tools` dă vederea globală a registrului dsh. Ea conține doar ce au adus
    pluginurile, fiindcă uneltele dsh sunt per agent; `run_code` e exclus.
  - `POST /call` rulează o unealtă prin politica și gărzile dsh, fără sesiune dsh.
    Stop-ul din Hello ajunge la unealtă.
  - În Hello: rândul de bibliotecă `dsh-plugins`, cu comutator în Settings › DSH
    surface.
    - Managerul MCP îl atinge în proces (`McpLink`), deci nu pornește niciun server.
    - E oprit în fiecare chat până îl pornești acolo.
    - Pornește suprafața dacă e oprită; nu o instalează niciodată.
    - După un restart al gazdei listează uneltele din nou.
  - Verificat pe o gazdă dsh reală (harness): `word_count` a răspuns
    „6 words, 29 characters, 1 lines.”, `run_code` → 403, fără token → 401.
  - Verificat în aplicația construită: comutator → rând „Built into Hello. · DSH
    surface” → Connect a pornit DSH și a listat `word_count` plus cele 3 unelte MCP
    ale dsh-mcp-client (montat de OpenViking).
  - Uneltele serverului OpenViking apar doar cu un server OpenViking configurat.
  - Nerulat: un apel dintr-un chat Hello cu model real. Nu am cheltuit credite;
    calea chat → manager → punte e acoperită de teste.
- [x] **Faza 5 (completare) — sursele marketului.**
  - dshfind și sursele standard, portate din adaptoarele și contractele
    marketului original.
  - Tab-ul Sources face Add, Select this source, Remove și Add standard source
    (după URL-ul manifestului), cu o singură sursă folosită odată, ca în original.
  - Cursorul unei surse standard rămâne în main, în spatele unui token.
  - Verificat live, în harness și în aplicația construită:
    - dshfind listează 13.050 de pluginuri, câte 50 pe pagină, cu Load more și
      categorii;
    - Installable arată doar intrările cu pachet npm;
    - preview-ul pentru `@yolk_vat-y/dsh-project-memory` a rezolvat 0.5.13 prin
      npm latest, compatibil.
- [x] **Faza 7 — pluginuri făcute în Hello.**
  - Skill-ul exemplu `dsh-plugin-creator` conține un șablon: tool `word_count` și skill.
  - Verificat: instalat din folder, unealta ajunge în cererile agentului dsh.
  - `hello-dsh` e pregătit pentru npm (README), dar nepublicat.
- [x] **Documentație:** ARCHITECTURE, SECURITY și PROVENANCE au secțiunile DSH și market.
- [x] **Reparat pe drum:** `store.ts` refuza baza de date peste versiunea 7 (migrările
      ajung la 10, din commit-urile 185be75, 12ae492, 0929b0f), deci aplicația nu
      mai pornea a doua oară.
- **Teste:** 826 → 943, toate verzi; tsc curat; `node scripts/dsh-theme.mjs --check` trece.

**Rămas:**

- [ ] Faza 6: hook-urile de sesiune peste Pi, pentru recall-ul și captura
      dsh-memory-plugin în chaturile Hello.
- [ ] Faza 5, rămas din market: căutarea pe mai multe categorii deodată, reordonarea
      surselor și scanarea completă a catalogului dshfind (acum se folosește
      căutarea paginată a furnizorului).
- [ ] Suprafața ca tab în panoul de unelte, pe lângă vederea din sidebar.
- [ ] Verificarea aplicației împachetate (`pnpm package:mac`): extraResources `dsh/`
      și pnpm despachetat din asar.
  - Azi cade înainte de partea DSH: electron-builder nu găsește
    `@mariozechner/clipboard` la reconstruirea modulelor native.
  - Lockfile-ul din HEAD îl are; cel curent, după urcarea necomisă a lui Pi
    0.85.1 → 0.87.1, nu îl mai are.
  - Probabil trebuie `pnpm install` curat după acea urcare.
- [ ] Publicarea pe npm a `hello-dsh` și a șablonului: decizia și contul tău.
- [ ] Upgrade-ul la dsh 0.2.x când iese stabil. Același shim merge, dar pluginurile
      din market trebuie reverificate.
- [ ] Opțional: faza 8 (layout Hello pentru clientul lor) și micșorarea descărcării
      (motorul office are 147 MB).

## Faza 0 — Spike de validare · 1–2 zile, înainte de orice cod în `src/`

Cu acordul tău: descarcă pachetele din npm într-un folder de lucru, nu atinge
`~/.dsh` și nu cheltuie credite de model.

- [ ] Profil de probă cu versiunile exacte `0.1.7-rc.2` (`dsh`, `dsh-app-boot`,
      `dsh-base`, `dsh-web-app`), instalat cu pnpm rulat de Electron 44 ca Node
      (`ELECTRON_RUN_AS_NODE=1`), `node-linker=hoisted`.
- [ ] Entry de gazdă (în jur de 60 de linii, după `desktop-host`) pornit cu
      `utilityProcess.fork`, pe portul 0. Trimite `ready { port, url }` și `fatal`.
- [ ] Schimbul token → cookie în main, apoi clientul încărcat într-un webview
      fără preload.
- [ ] O temă minimă: un plugin de client construit de mână, cu 10 tokeni prin
      `overrideTokens`.
- [ ] Măsurători:
  - [ ] mărimea și durata instalării;
  - [ ] pornirea la rece;
  - [ ] memoria gazdei;
  - [ ] conexiunile de rețea în repaus;
  - [ ] încărcarea `node-pty` și `sharp` în utility process;
  - [ ] ce rânduri pornesc;
  - [ ] ce cere clientul pentru model.
- [ ] Instalarea a 2 pluginuri de UI (dsh1024, cost-meter) și a unei teme
      (skin-center): pornesc sau cad, și de ce.
- [ ] Aceeași probă, pe scurt, cu `0.2.0-rc.1`.
- Gata când: raportul `docs/DSH-SPIKE.md` are cifrele, problemele și o recomandare
  de versiune, iar tu decizi dacă mergem mai departe.

## Faza 1 — Gazda DSH în main · M

- [ ] `src/main/dsh/profile.ts`:
  - `DSH_HOME = <userData>/dsh`, profilul `hello`;
  - `package.json` cu pinii din `src/main/dsh/versions.json`;
  - `.npmrc`/workspace ca la profilurile dsh.
- [ ] `src/main/dsh/pnpm.ts`: pnpm inclus, rulat cu `ELECTRON_RUN_AS_NODE=1`.
  Scripturile de instalare rulează doar din lista aprobată în spike
  (`onlyBuiltDependencies`).
- [ ] Instalarea la prima deschidere, cu progres, anulare și reluare. Arată
      spațiul pe disc și dă o eroare clară fără rețea.
- [ ] `src/main/dsh/host-entry.ts` (intrare separată în build): încarcă dsh din
      profil (`createRequire` pe ancora de instalare) și rulează `runProfile`.
      Dsh nu intră în pachetul Hello.
- [ ] `src/main/dsh/host.ts`, ciclul de viață:
  - `utilityProcess.fork` cu mediu curat: `DSH_HOME`, `DO_NOT_TRACK=1` și
    tokenii per pornire, fără cheile Hello;
  - protocolul `ready`, `fatal`, `shutdown`, `shutdown-complete`;
  - oprire grațioasă, cu termen, la ieșirea din aplicație;
  - fără bucle de restart automat.
- [ ] `hello.patch.yml` (în `patchFiles`):
  - `web-runtime` cu `{ openBrowser: false, printUrl: false }`;
  - serverul pe `127.0.0.1` și portul 0;
  - rândurile de telemetrie și analytics dezactivate.
- [ ] Puncte de restaurare: ultimele 3 porniri sănătoase (`package.json`,
      lockfile, patch) și acțiunea „Restore”.
- [ ] Settings › Extensions › „DSH”:
  - stare, versiune, profil și disc;
  - Start, Stop, Restart;
  - Restore;
  - log-ul (într-un fișier din `userData`, fără tokeni).
- [ ] IPC:
  - comenzile `dsh.status`, `dsh.install`, `dsh.start`, `dsh.stop`, `dsh.restart`;
  - evenimentul `hello:dsh-status`;
  - tipurile în `src/shared/types.ts`.
- [ ] Teste:
  - fixture `tests/fixtures/fake-dsh-host.mjs`, ca `fake-pi-rpc`;
  - invariantul mediului curat (nicio variabilă cu aspect de cheie);
  - doar loopback;
  - restaurarea;
  - termenul de oprire.
- Gata când:
  - din Settings: Install, apoi gazda pornește și arată Running cu portul;
  - la ieșire nu rămâne niciun proces orfan;
  - un profil stricat revine din punctul de restaurare.

## Faza 2 — Suprafața în interfață · M

- [ ] Partiția `persist:hello-dsh`:
  - permisiunile refuzate, cu excepția fullscreen cât timp suprafața se vede;
  - fără preload;
  - descărcările trec prin managerul Hello, într-o listă „DSH”.
- [ ] Schimbul token → cookie se face în main, cu `net.request` în sesiunea
      partiției, fără redirect automat. Main emite apoi src-ul
      `http://127.0.0.1:<port>/`. Tokenul nu ajunge în renderer și nici în
      log-uri. Schimbul se reface la fiecare pornire a gazdei.
- [ ] `approveGuest` alege după src-ul emis: BrowserManager pentru taburile web,
      DshSurface pentru suprafață. Atributele sunt impuse de main: partiție,
      `sandbox`, `contextIsolation`, fără `nodeIntegration`, fără popup-uri.
- [ ] Navigarea rămâne în aceeași origine.
  - Linkurile externe și `window.open` deschid un tab nou în browserul Hello,
    cu AI Mode Off, sau sunt oprite cu un mesaj.
- [ ] Plasarea: un singur ghid, poziționat peste placeholder-ul din vederea
      „DSH” prin mecanismul folosit la ghidurile browserului.
  - Când nu se vede, rămâne montat și parcat.
  - Nu se mută în DOM și nu se reîncarcă pentru a face loc interfeței.
- [ ] Stările vederii:
  - neinstalat (cu mărimea și butonul Install);
  - se instalează;
  - pornește;
  - rulează;
  - căzut (mesaj, log, Restore sau Disable plugin);
  - oprit.
- [ ] Rândul „DSH” în sidebar, cu punct de stare.
- [ ] Agentul Hello nu are acces la suprafață: nu apare în `browser_tabs` și
      nu are unelte de citire sau click pe ea.
- [ ] Teste:
  - tokenul nu apare în src sau în renderer;
  - garda de navigare;
  - aprobarea ghidului;
  - parcarea.
- Gata când:
  - clientul dsh rulează în Hello și trece prin ascundere și reafișare fără reîncărcare;
  - linkurile se deschid în browserul Hello;
  - nu apar erori de boot.

## Faza 3 — Tema Hello pentru dsh · S–M

- [ ] Pachetul `packages/hello-dsh/` (bundle-ul Hello, format dsh) conține
      pluginul de client `hello-theme` (`inject: ['theme', 'slots']`).
- [ ] Build-ul propriu al jumătății de client, fiindcă preset-ul lor nu e publicat:
  - învelișul `window.__ModuleLoader__.load({ id, factory })`;
  - externals doar din tabela comună;
  - un smoke test de încărcare.
- [ ] Harta de tokeni e generată din `src/renderer/styles/tokens.css` (o
      singură sursă), în perechi `{ light, dark }`. Acoperă toate
      `--dsw-alias-*`, `--dsw-specific-*`, `--dsw-radius-*` și fonturile.
      Se aplică prin `overrideTokens('hello', …)`.
- [ ] Testul de acoperire compară harta cu snapshot-ul tokenilor oficiali ai
      versiunii fixate. Pică atunci când dsh adaugă un token fără valoare Hello.
- [ ] Fonturile Inter Variable și Geist Mono (OFL) vin în bundle și sunt
      servite de jumătatea de gazdă, fără rețea.
- [ ] Brand-ul „Hello.” în slot-urile de brand.
- [ ] Light/dark: preferința dsh este `system`, iar suprafața urmează sistemul,
      ca Hello.
- [ ] Limita e documentată: elevația pe element rămâne a lor. Dacă deranjează,
      adăugăm un stylesheet țintit, cu test.
- Gata când: capturile light și dark arată clientul dsh cu culorile, fonturile
  și colțurile Hello, iar testul de acoperire trece.

## Faza 4 — Modelul pentru sesiunile din suprafață · M

- [ ] `src/main/dsh/model-proxy.ts`:
  - ascultă pe `127.0.0.1`, cu token per pornire;
  - trimite mai departe la conexiunea activă Hello și adaugă cheia reală doar spre furnizor;
  - trece streaming-ul;
  - are limite de mărime;
  - rulează doar cât rulează gazda.
- [ ] Patch-ul Hello configurează `@deepseek-ai/dsh-llm-pi-ai` cu furnizorul
      `hello`: `baseURL` duce la proxy, iar `apiKeyEnv` la tokenul per pornire.
      Primește modelele conexiunii.
- [ ] Setarea „DSH folosește: conexiunea Hello / autentificarea lui”. Datele
      lor de autentificare rămân în `DSH_HOME`-ul Hello.
- [ ] Teste:
  - proxy-ul refuză fără token;
  - cheia nu apare în mediul gazdei, în profil sau în log-uri;
  - formatul OpenAI-compatibil merge primul.
- Gata când: o sesiune dsh din suprafață răspunde prin conexiunea Hello.

## Faza 5 — Marketul portat și instalarea dintr-un click · L

Poate merge în paralel cu fazele 1–4; doar instalarea depinde de profilul din faza 1.

- [ ] UI-ul portat din `dsh-community-market` (MIT):
  - Discover, Installable, Installed, Sources;
  - CSS-ul lor neschimbat, cu puntea `--dsw-*` (22 de variabile) și primitivele Hello;
  - intrarea „Plugin Market” în sidebar;
  - `docs/PROVENANCE.md`.
- [ ] Adaptoarele 1024Store v2, dshfind și standard-http, în main, cu regulile
      de rețea ale contractului. Textul venit de la sursă e tratat ca neîncrezut.
      Iconițele trec prin main, ca PNG 128×128 fără metadate.
- [ ] Previzualizarea:
  - npm `latest`, cu condițiile dsh;
  - compatibilitatea cu versiunea fixată (peers);
  - ce aduce pluginul: UI în suprafață, unelte în chaturi, skill-uri, hook-uri.
- [ ] Instalarea:
  1. confirmare cu token one-shot;
  2. punct de restaurare;
  3. `pnpm add --save-exact`;
  4. `dsh.profile.bundles`;
  5. restart explicit al gazdei. Chaturile și terminalele rămân deschise.
- [ ] Un plugin incompatibil (de exemplu, peers `^0.2.0-rc.1` pe o gazdă
      0.1.7) primește cardul „Needs dsh 0.2” și nu se instalează.
- [ ] Garda de boot: dacă boot-ul web cade după restart, Hello numește pluginul
      și oferă Disable sau Restore.
- [ ] Modificările făcute de pluginuri, de exemplu `dsh plugin add` rulat de
      dsh1024, se văd prin supravegherea profilului. Nu se aplică la următorul
      restart fără confirmarea Hello (diff, apoi Accept sau Revert).
- [ ] Installed arată dependențele directe, cu Uninstall. Există „Add by npm
      name”. Intrările doar cu GitHub rămân manuale.
- Gata când:
  - memory și archify se instalează dintr-un click;
  - dsh1024 intră prin „Add by npm name” și apare în suprafață;
  - un plugin incompatibil e oprit la previzualizare.

## Faza 6 — Punți spre chaturile Hello · M–L

- [ ] Pluginul de gazdă `hello-bridge` din bundle-ul Hello:
  - expune uneltele profilului (serviciul `tools`) ca MCP pe loopback, cu token per pornire;
  - listează rădăcinile de skill-uri ale furnizorilor dsh.
- [ ] Partea Hello: clientul MCP se conectează (proxy stdio sau suport pentru
      loopback HTTP; decidem în fază). În meniul Extensions al fiecărui chat
      apar „DSH tools” și skill-urile, importate doar pentru citire. Regulile
      de aprobare Hello se aplică.
- [ ] Hook-urile de sesiune pentru chaturile Pi (fostul 3b):
  - evenimentele dsh `agent/session-start`, `agent/pre-step`, `session/event`,
    `session/flush`, `tools/pre-execute`, `tools/post-execute` se mapează pe
    evenimentele extensiilor Pi;
  - opțiunea per chat „nu captura acest chat”.
- Făcut pe 29.09, altfel decât planul (detalii în jurnal):
  - puntea e în entry-ul de gazdă al Hello (`dsh/tool-bridge.ts`), nu într-un plugin;
  - în Hello nu există proxy stdio: managerul MCP ajunge la ea în proces
    (`dsh/tool-link.ts`).
  - De ce: registrul are o vedere globală care conține exact uneltele pluginurilor.
    Uneltele proprii ale dsh se înregistrează per agent, deci nu e nevoie de o listă
    aleasă manual.
- Experiment 29.09, extensia OpenViking pentru Pi (v0.4.6, commit 75830be2ec) în Hello:
  - Setup: aplicația construită, HOME separat, model fals, server OpenViking fals;
    fără server real și fără credite. Harness-ul e în scratchpad.
  - Merge, pe calea reală din Hello:
    - recall injectat în mesajul trimis modelului, prin `context`;
    - captura după fiecare tură, prin `turn_end`;
    - unealta MCP `openviking_search`, oferită și rulată cu cardul ei în chat;
    - un recall lent (35 s) e tăiat de extensie la 15 s, iar tura continuă fără memorie.
  - [ ] Extensia publicată nu se importă: nu are `pi` în package.json, iar `shared/`
        se generează la build.
    - Un folder cu manifest, dar fără `node_modules`, strică tot chatul:
      „Pi closed its RPC output”. Motivul real, lipsa `@modelcontextprotocol/client`,
      rămâne doar în stderr.
    - Merge doar împachetată într-un singur fișier (esbuild, 1,1 MB).
  - [ ] Oprirea Pi în Hello (`stdin.destroy()` plus SIGTERM imediat, în
        src/main/chat/pi-rpc.ts) ucide procesul în ~10 ms.
    - Un handler async de `session_shutdown` nu termină: sonda cu 300 ms s-a pierdut.
    - Cu EOF urmat de așteptare, handler-ul termină (311 ms).
    - Commit-ul OpenViking (doar cu `takeoverEnabled: false`) pleacă totuși. Se
      pierde răspunsul, deci și re-încercarea locală.
  - [ ] Pi rulează în `<data>/pi-chat/<hash>/work`, nu în folderul chatului. Extensia
        nu vede proiectul (git remote), deci nu trimite peer.
    - Variabilele `OPENVIKING_*` sunt tăiate de allowlist.
  - Uneltele extensiei nu cer aprobare, ca uneltele MCP: activarea în chat e acordul.
- Făcut 29.09, după experiment (cele trei lucruri):
  - [x] Instalarea extensiilor Pi cu dependențe:
    - Found on this Mac citește `~/.pi/agent/extensions` (și `PI_CODING_AGENT_DIR`).
    - Biblioteca acceptă o extensie-director cu `index.ts` sau un singur fișier.
    - Ce importă extensia din afara copiei e împachetat cu esbuild (0.28.2, deja
      adus de Pi), într-un `*.hello-bundle.mjs` lângă intrare.
    - Un pachet lipsă oprește importul și e numit.
    - Re-importul e atomic.
  - [x] Oprirea Pi: abort pentru tura în curs, EOF, 1,5 s pentru `session_shutdown`,
        abia apoi SIGTERM.
    - O extensie care nu se încarcă e numită în chat, cu motivul dat de Pi.
    - Eroarea unui plugin la rulare nu mai oprește răspunsul.
  - [x] Folderul chatului devine `process.cwd()` pentru extensii (`HELLO_CHAT_FOLDER`).
        Pi rămâne în directorul privat.
  - Revizia adversarială (8 agenți) a confirmat 16 probleme. Rezolvate: toate în
    afară de două mărunte:
    - [ ] un `require()` CommonJS al modulelor date de Pi, într-un pachet împachetat;
    - [ ] Found on this Mac poate lista o extensie pe care importul o refuză.
  - [ ] Nevalidat: esbuild în aplicația împachetată. `ESBUILD_BINARY_PATH` spre
        `app.asar.unpacked`, dar împachetarea e blocată de urcarea Pi.
- Unelte etajate, 29.09 („prompt context driven”):
  - [x] Nucleu mereu activ; grupurile `coding`, `browser`, `workers`, `notebook`,
        câte unul per server MCP și per plugin se încarcă cu `tools_find`.
    - `tools_find` întoarce și manualul grupului; promptul de bază a pierdut
      manualele.
    - Grupurile încărcate se refac din transcript după un restart Pi.
  - [x] Revizia etajării și a tab-urilor Full: 14 constatări confirmate, toate rezolvate.
    - compactarea descarcă grupurile al căror manual a dispărut;
    - potrivire pe cuvinte întregi;
    - modul Coder, notebook, nume MCP sanitizate, ancore în preview-uri.
  - [x] `browser_read` dădea linkurile trunchiate la 80 de caractere, și modelul făcea
        404 cu ele. Acum adresa e întreagă, iar una prea lungă e scurtată vizibil.
  - [ ] `fetch_url` nu citește PDF-uri (un PDF de pe HN a eșuat în testul real).
  - [ ] WebGPU:
    - verificat `navigator.gpu` în tab-urile Hello;
    - manualul de browser îi spune modelului că îl poate folosi în vizualuri;
    - rezervă pentru embeddings locale.
- Cereri noi (utilizator, 29.09):
  - [x] Pi market în Hello, alături de DSH market (29.09):
    - rândul „Plugin Market” are meniul DSH / Pi, fiecare cu fereastra lui, făcută la fel;
    - lista, filtrele (tip, ordine, Reset) și numărătoarea sunt ale pi.dev/packages;
      cardul arată autorul, descărcările pe lună și când a fost publicat;
      npm e rezerva când pi.dev nu răspunde;
    - instalarea e pnpm ca la DSH, într-un folder din biblioteca Hello: fără scripturi,
      registry fixat, integritatea din lockfile legată de preview; pornit pe chat;
    - Installed are Update la versiunea nouă și Uninstall, în ambele market-uri;
    - „Browse Pi packages” în Settings › Extensions.
  - [ ] Nevalidat în aplicație: o instalare reală din Pi market (testele folosesc un pnpm fals).
  - [x] DSH market: pnpm 11 aștepta o zi versiunile noi, iar un plugin publicat în
        ultimele 24h trecea de preview și cădea la instalare. Acum versiunea confirmată
        e scutită (doar ea; dependențele încă așteaptă), la instalare și la update,
        iar o dependență prea nouă e spusă pe nume.
  - [x] Skill-uri din tot sistemul într-un singur loc (răspuns: „Include și surse online”):
    - [x] catalogul (`skill-catalog.ts`): biblioteca, skill-urile altor agenți de
          pe Mac (Claude Code, pluginurile Anthropic, dsh, Codex, Pi) și skills.sh,
          care are și skill-urile Anthropic;
    - [x] modelul: `skills_find` în nucleu, `skill_load` cu id-ul găsit îl copiază
          în bibliotecă și îl pornește pentru chat;
    - [x] composerul: meniul `/` alege un skill după nume și scrie `/skill:<nume>`,
          pe care Pi îl extinde; `/find-skills <sarcină>` caută și online.
  - [x] Revizia skill-urilor, 19 constatări, rezolvate:
    - main extinde singur `/skill:<nume>` (steer, follow-up, Retry, nume cu spații);
    - doar id-uri listate de skills.sh, fără segmente `..`;
    - folderul găsit după numele din SKILL.md, subarbore pentru repo-uri mari,
      nicio copie parțială;
    - un `use` pe rând, fără dubluri cu skill-ul unui plugin, copii modificate
      refuzate, re-importul de pe skills.sh.
  - [ ] `/review` al unui șablon de prompt poate fi luat de meniul `/` când un skill
        conține cuvântul (Enter alege skill-ul).
  - [ ] Nevalidat în aplicație: meniul `/`, descărcarea reală de pe skills.sh
        (testele folosesc un HTTP fals).
- Gata când:
  - archify și uneltele OpenViking merg dintr-un chat Hello;
  - cu hook-urile, recall-ul apare înainte de răspuns.

## Notebook într-un singur pane (utilizator, 29.09)

„Un buton lângă Chat”, un pane cu trei secțiuni și capitole. Răspuns: comutator pe
capitol **și** pe secțiune.

- [x] Store: tipul `plan` (planul scris de `plan_write` iese din Tasks) și coloana
      `shared` pe capitol; migrarea v11 mută intrarea „Plan” din Tasks în Plans.
- [x] Model și CLI: văd doar capitolele pornite din secțiunile pornite.
  - `notebook_list`, `notebook_save`, `notebook_task_status`, `plan_write`,
    `notebook_paths`, clientul CLI (`list plan`), manualul și promptul.
- [x] IPC `notebooks.share(id, shared)`: nu schimbă revizia, deci nu rupe ciornele.
- [x] Interfața:
  - pill-urile Runbook, Tasks și switch-ul Plan devin un singur pill „Notebook”;
  - arborele Runbooks / Tasks / Plans are comutatorul secțiunii în dreapta, „+” și
    capitole cu comutatorul lor, „Show more”; secțiunea oprită e estompată;
  - comutatoarele ies din meniul „…” al chatului.
- [x] Teste, documentație (ARCHITECTURE, SECURITY, LOOK.md: decizia 29.09), revizie.
- [x] Revizia: 7 constatări, rezolvate.
  - exporturile pentru workeri urmează și comutatorul secțiunii;
  - `plan.md` e șters odată cu chatul, iar reset-ul anunță și Plans;
  - ciornele vechi ale planului mutat se refac după id;
  - propoziția ruptă din manual când e pornit doar Plans;
  - identitatea ciornei la refresh;
  - `plan_write` alege cel mai recent plan pornit.
- [ ] Nevalidat vizual în aplicație (pornirea aplicației de dev e a utilizatorului).

## Pluginurile Pi în Hello, headless (utilizator, 29.09)

„Fă toate 3, începe cu 1”:
- [x] 1. O tură pe care Pi o începe singur (pi-subagents când termină în fundal) apare
      în chat ca răspuns nou, cu „A plugin started this reply: …”, cu uneltele Hello,
      Stop și lista de așteptare. Schema v12: `messages.startedBy`.
- [x] 2. UI-ul extensiilor prin RPC, lângă composer: widget-uri text, status-uri,
      notificări și întrebări (select, confirm, input, editor) la care răspunde omul,
      nu mai sunt refuzate automat. Componentele de terminal (ex. rpiv-todo) nu pot
      apărea: Pi nu le trimite în modul RPC.
- [x] 3. Settings › Model for subagents: al doilea model pe aceeași conexiune, scris în
      Pi ca `subagents.defaultModel`; gol = modelul chatului.
- [x] Starea pi-subagents (`PI_SUBAGENT_ASYNC_JSON:`) apare ca listă de rulări, nu JSON;
      răspunsurile de inspecție (`PI_SUBAGENT_INSPECT_JSON:`) nu se afișează, cum cere pluginul.
- [x] Validat de utilizator (29.09): două rulări async au terminat și au trezit singure
      chatul. Sarcina goală din test a venit din apelul modelului (cheia `task»`, valoare
      obiect), nu din Hello: Pi citește argumentele direct de la endpoint.
- [ ] Nevalidat în aplicație: un plugin care pune o întrebare.
- [ ] Subagenții rulează cu uneltele Pi (bash, edit, write) fără aprobările Hello:
      de decis dacă Hello îi restrânge (ex. `subagents.agentOverrides` cu tools).

## Reparații din testarea din 29–30.09

- [x] Plans (și Runbook/Tasks) se pot porni sau opri și cât timp rulează un răspuns:
      uneltele urmează de la pasul următor, iar tura următoare pornește într-o sesiune
      Pi ale cărei instrucțiuni spun asta (comutatoarele intră în amprenta sesiunii).
- [x] Reasoning Off ajunge la un server local cu un model Qwen și pe Auto
      (`chat_template_kwargs.enable_thinking`): MTPLX îl respectă din 2.5.3. Înainte,
      modelul gândea la nivelul serverului: 7.803 tokeni de raționament, 157 s, un clic.
- [ ] Low/Medium/High ajung la MTPLX doar ca „gândire pornită”, la nivelul serverului;
      nivelul în sine (`reasoning_effort`) nu e trimis.
- [x] Erorile scripturilor din pagină nu mai poartă stiva scriptului injectat de Hello.
- [x] „Set as chat tab” pe un terminal/CLI din Tools: devine pagină lângă Chat și
      Notebook, același xterm și același PTY (un nod al lui, mutat între panouri);
      „Move to tools” îl duce înapoi. Nu supraviețuiește unei reporniri, ca și PTY-ul.
- [x] Browserul din Hello pentru workerii CLI (utilizator, 30.09: „Canal Hello, toate CLI-urile”):
      `browser <acțiune> '<json>'` pe conexiunea pe care o au deja, aceleași unelte și
      aceeași poartă Off/Read/Full ca în chat; screenshot-ul e salvat ca fișier, iar ghidul
      spune că browserul e cel din Hello, nu Chrome/Safari din sistem.
- [x] O pagină ale cărei cadre le tot încarcă reclamele (eBay) nu mai blochează click, scroll,
      tastă și `wait`: contează încărcarea paginii însăși (`isLoadingMainFrame`), în chat și în CLI.
- [x] Clientul CLI tipărește pagina citită ca text, nu ca un șir JSON cu `\n` escapat.
- [x] Pi CLI încarcă extensia Hello (`-e`, rolul `cli`): uneltele de notebook și browser devin
      ale lui, iar screenshot-ul vine ca imagine; procesul lui rămâne neatins (folder, fetch, context).
- [x] MCP pentru Claude Code și Codex peste aceeași punte (utilizator, 30.09): server stdio
      `hello-mcp.cjs`; Claude cu `--mcp-config` (tokenul prin `${…}`), Codex cu
      `-c mcp_servers.hello.*` (tokenul prin `env_vars`). Niciun fișier nu ține tokenul.
- [ ] Nevalidat în aplicație: Claude Code și Codex văd uneltele `hello` (mcp__hello__browser_read).
- [x] Serverul MCP `hello` și pentru Kimi (`mcp.json`), Qwen Code (`settings.json`) și OpenCode
      (`mcp`) — utilizator, 30.09: Kimi a folosit `open_browser` al lui aplicația-soră (od-orchestrator,
      oprit) în loc de browserul Hello. Ghidul spune că uneltele de browser ale altui server MCP
      nu sunt browserul chatului.
- [x] Reparat (utilizator, 30.09): după repornire, tabul de chat relansa CLI-ul în buclă (8 copii
      Pi pe aceeași sesiune): o singură relansare pe tab, id-ul nou scris imediat, iar main nu
      pornește a doua oară aceeași conversație a unui CLI.
- [x] Markurile agentului rămân cu pagina (utilizator, 30.09): salvate cu tabul (schema v13),
      redesenate cu reveal la restaurare, șterse la reload/navigare; × pe fiecare, bulă de chat
      în stânga (hover listă, click → scroll la mark), ce păstrează omul e ce se salvează.
- [ ] Nevalidat în aplicație: marks după repornire, bula din stânga, × pe mark.
- [x] Markurile sunt ale paginii care le-a făcut (utilizator, 30.09): ținute pe tab pagină cu
      pagină, revin la Back/Forward/restart; pleacă la reload-ul omului sau la reset (× pe unul,
      dublu-click pe bulă pentru toate, cu fade).
- [x] „Vizibil” înseamnă ce vede omul (utilizator, 30.09: agenticskills.io — un `<nav class="sr-only">`
      repeta numele cardurilor; Codex a pus markurile acolo): ascuns de un strămoș care taie
      (sr-only, clip-path inset(50%), meniu închis la 0 px) nu e vizibil; cutia unui link inline
      în jurul unui card e conținutul lui. Markurile pe ce se mișcă singur sunt refuzate, iar
      browser_read spune „moves by itself”.
- [x] `tab_id` în loc de `tabId` nu mai pică validarea: extensia Hello dă Pi `prepareArguments`
      (snake_case → camelCase, argumente trimise ca text JSON).
- [x] Markul e legat de elementul lui (utilizator, 30.09): cale CSS la element, urmărit la
      resize, scroll interior și conținut care se mută; găsit din nou după re-render; ascuns cât
      e ascuns elementul. Legat și de adresă: o adresă nouă fără reload îl șterge, #secțiune nu.
- [x] Validat de utilizator (30.09): bula din stânga, lista și × pe mark merg.
- [x] Un mark numește cuvintele pe care elementul le arată pe pagină (label sau selector): un
      model a pus rezultate din skills_find pe o pagină eBay deschisă. Refuzul spune pagina și
      că markul se pune pe pagina lui, după ce e deschisă și citită.
- [x] Pi 0.99.1 (schimbat în package.json de altcineva, 30.09): verificat ce folosește Hello —
      comanda unui plugin răspunde la prompt cu `disposition: "handled"`, pe care Hello îl citește acum.
- [x] Un CLI setat ca tab de chat rămâne după repornire (utilizator, 30.09): chatul, deschis din
      nou, își primește CLI-urile înapoi; Claude Code și Pi își continuă conversația
      (id dat de Hello), celelalte revin cu o conversație nouă.
- [x] O comandă slash a unui plugin (ex. `/subagents delegate`) nu mai lasă răspunsul agățat:
      Pi nu dă `agent_settled` pentru ea, iar Hello încheie răspunsul când Pi răspunde la prompt.
- [ ] Nevalidat în aplicație: repornire cu un Pi/Claude ca tab de chat.
- [x] Meniul `/` oferă și comenzile pluginurilor chatului (utilizator, 30.09: „/sub… să apară
      /subagents”): ce spune Pi-ul lui care rulează (`get_commands`), ultima listă ținută
      pentru fereastră cât nu rulează.
- [x] Validat de utilizator (30.09): `/subagents delegate` arată întrebarea pluginului.
- [ ] Pasul următor al unor întrebări pi-subagents (Change model / thinking) e un ecran de
      terminal pe care Pi nu îl trimite prin RPC: se închide fără continuare.
- [x] `browser_mark` (utilizator, 30.09: „un pointer la agenți”): modelul pune pe pagină pini
      numerotați cu notă și un contur în jurul elementului, ca la Annotate, pe un strat al lui;
      la Read, iar la Full îl aduce pe primul în vizor. Și pentru CLI (shell și Pi).
- [x] Validat de utilizator (30.09): Claude Code și Qwen Code (model local) au marcat anunțul pe eBay.
- [x] Eroarea unui script din pagină ajunge cu motivul ei: Electron o dă ca text, nu ca Error,
      iar un CLI primea doar „Hello tool execution failed.”, iar chatul vedea stiva.
- [x] „Gândire oprită” pentru un Qwen local și în CLI-urile de pe endpointul Hello (utilizator,
      30.09): Qwen Code (`extra_body`), OpenCode (`options` ale modelului), Pi CLI
      (`thinkingFormat` + `--thinking`), Aider (fișier de setări cu `extra_body`).
- [ ] Kimi nu poate trimite câmpul către un server OpenAI: gândește la nivelul MTPLX.
- [ ] Nevalidat în aplicație: Qwen Code / OpenCode / Pi CLI pe modelul local, fără gândire.
- [ ] Nevalidat în aplicație: un CLI care citește și apasă într-un tab din Hello.
- [x] O adresă scrisă care nu există devine căutare Google (utilizator, 30.09: „smarbill.ro” dădea
      „Could not load”): doar un nume scris fără schemă, al unui site public (nu localhost, .local,
      .lan, IP sau port) și doar când DNS nu îl cunoaște. Fără eroare pe drum; Back sare peste
      numele care a eșuat. Modelul primește în continuare eroarea.
- [ ] Nevalidat în aplicație: „smarbill.ro” în bara de adrese, apoi Back.
- [x] Suprafața DSH (utilizator, 01.10: „intră peste semafoare și nu mai poți trece înapoi în
      Hello”): sidebar-ul Hello rămâne lângă ea orice ar face chatul din spate (panou extins,
      unelte deschise); un chat cerut (rândul lui, New chat, o notificare) iese din DSH; cu
      sidebar-ul ascuns, header-ul ocolește semafoarele și începe cu butonul care îl repune.
- [ ] Nevalidat în aplicație: DSH deschis cu chatul extins, apoi înapoi în chat.
- [x] Pill „Free” în căutarea selectorului de modele (utilizator, 01.10), pornit la fiecare
      deschidere: modelele de pe serverele tale (localhost, rețea privată) și cele cu preț zero
      (OpenRouter `:free` sau `pricing` 0); oprit, apar toate. Oferit doar când alege ceva.
- [x] Tema DSH nu mai e forțată (utilizator, 01.10: „dsh nu permite să treci în light nici în
      opțiunile lui”): overlay-ul Hello seta `ui-theme`, iar dsh refuză o schimbare din Settings
      pe care un overlay ar suprascrie-o. Dark rămâne doar implicit, din bundle-ul hello-dsh.
- [ ] Nevalidat în aplicație: Settings › Appearance în DSH (Light/System) după repornire; meniurile albe.
- [x] „model … not found” în DSH (utilizator, 01.10): Hello avea salvat serverul oMLX cu un model
      OpenRouter. Selectorul ținea lista minute întregi cu „activ” vechi și salva doar modelul;
      acum compară cu conexiunea de acum și salvează perechea. Proxy-ul DSH trimite modelul
      curent al Hello, nu pe cel de la pornire.
- [ ] De făcut de utilizator: modelul ales din nou în selectorul Hello repară perechea salvată.
- [x] DSH și Pi cu versiunea în bara de jos și „update” doar când npm are una nouă (utilizator,
      01.10); actualizarea din aplicație, cu întoarcere la versiunea cu care a venit Hello.
      Pi se instalează în `<data>/pi/runtime` (verificat real cu pnpm-ul Hello: 0.99.2, 6 s);
      dsh în runtime-ul lui, cu versiunea aleasă în `<data>/dsh/version.json`.
- [ ] Nevalidat în aplicație: update la Pi 0.99.2 și înapoi; update la dsh 0.2.0-rc.2 (tema Hello
      și shim-ul sunt făcute pentru 0.1.7) și înapoi.
- [ ] `PI_VERSION` din market (pi-install.ts) e încă 0.87.1, deși Hello rulează 0.99.x.
- [x] „update” la DSH clipea și nu făcea nimic (utilizator, 01.10): pnpm rulează ca în CI, cu
      lockfile-ul înghețat, iar lockfile-ul runtime-ului era pentru 0.1.7-rc.2
      (`ERR_PNPM_OUTDATED_LOCKFILE`). Acum `--no-frozen-lockfile`; un eșec se vede roșu lângă versiune.
- [x] Tabul Pi pornește același Pi ca chaturile (utilizator, 01.10): `cli.js` al motorului Hello,
      rulat de Electron ca Node, nu `pi` din PATH; „update” din bara de jos le mută pe amândouă.
      Tema `aplicația-soră` din aplicația-soră e implicită în folderul privat al Pi-ului din tab.
- [ ] Nevalidat în aplicație: tabul Pi nou (v0.99.2, tema aplicația-soră).
- [x] Instalarea DSH „vie” (utilizator, 01.10: pnpm a zis Done și a stat agățat 2 ore cu retry-uri
      pentru tarball-uri libreoffice-kit de alte platforme): panoul arată ce face pnpm, timpul
      scurs și de cât tace; Hello ia „Done” de bun după 20 s și oprește pnpm după 5 min de tăcere.
- [ ] De făcut de utilizator: repornește Hello (oprește pnpm-ul agățat); runtime-ul 0.2.0-rc.2 e
      instalat complet, DSH pornește pe el.

## Auditul de design, pe rând (utilizator, 04.10)

Verificat în cod înainte: meniul de context, stările butoanelor și strângerea grupurilor există
deja. Ridicarea butoanelor la hover, liniile despărțitoare, ⌘W și „durata estimată” nu se fac:
contrazic designul nativ aprobat sau nu pot fi adevărate.

- [x] 1. Cronologia: durata muncii în antetul activității (live, apoi `workedMs`, adunat peste
      retry-uri); starea „aprobare” își primește culoarea. (Coada live arată 2 pași, cum spune
      comentariul ei: nu era un bug.)
- [x] 2. Butoane: `:active` unde lipsea; inel de focus pe pastila câmpurilor care îl pierduseră;
      mesajul focalizat cu inelul aplicației; tokenii de focus. Editoarele din notebook rămân fără inel.
- [x] 3. Tastatură: ⌘B sidebar, ⌘N chat nou (din meniul aplicației); ↑/↓/Home/End între mesaje;
      ⌘C pe un mesaj focalizat fără selecție îl copiază; comentariul fals din keys.ts corectat.
- [x] 4. Context: „Summarise now” de la galben (comanda `compact` a Pi); după, indicatorul spune cât a
      eliberat. Textul roșu zice „summarises soon”: Pi decide după estimarea lui, nu se poate promite tura.
- [x] 5. Operații lungi: timp scurs live la pasul care rulează și la „Waiting for response…”;
      reduced-motion oprește și strălucirea pașilor care rulează.

A doua părere (04.10):
- [x] „Summarise now” (comun cu 4). „Start fresh chat” există deja în meniul chatului (Restart chat…).
- [x] Costuri și tokeni în Settings › App: total, pe model, cele mai scumpe 5 chaturi.
- [x] „Save to Runbook” pe un răspuns terminat (titlul din primul heading, sursele păstrate).
- [x] Regula terminalelor scrisă în `WorkspacePrefs`: un terminal e într-un singur loc.
- [x] Model per chat în loc de per folder (utilizator, 04.10: „ultimul model folosit în acel chat… nimic
      fancy”): chatul ține minte modelul cu care a rulat ultima tură sau pe care l-ai ales în el, pe
      conexiunea lui și cu cheia ei. Alegerea rămâne și selecția din Settings, pentru chaturile noi, DSH
      și CLI-uri. Rezumarea și turele pornite de Pi folosesc același model.
- [ ] Nevalidat în aplicație: toate cele de mai sus; mai ales două chaturi pe modele diferite, unul
      pornit în timp ce celălalt răspunde.

## Revizia UI din sesiunea S202 (utilizator, 05.10)

Două rapoarte: S202_A001 (claude, `src/renderer`) și S202_A002 (codex, specimenul din
`design/reference`). Totul pe main; celelalte ramuri au fost șterse la cererea utilizatorului.

- [x] Modelul per chat, șters la 04.10, 22:56, de un commit greșit al integratorului S202 pe main urmat de
      `reset --hard`, recuperat întreg din commitul orfan `60f298a` (commitul `3c5c1e0`).
- [x] Overlay-ul ⌘ + / adus de pe ramura S202 (`1ad23be`), cu tastele pe care aplicația chiar le are:
      grupul Transcript (↑/↓, Home/End, ⌘C), ⌘B, Enter pe atașament; scos „command palette” (⌘K
      deschide căutarea) și „↑/↓ prin mesajele tale” (era doar pe o ramură ștearsă).
- [x] A001 #1: rândurile bifabile din meniuri sunt `menuitemradio` / `menuitemcheckbox` cu `aria-checked`;
      bara indicatorului de context și `aria-valuenow` spun același număr după rezumare.
- [x] A001 #2: rezumarea se anunță (`role="status"`), eșecul apare în cuvinte, nu doar la hover, iar
      butonul rămâne pe loc, dezactivat, cu spinner, cât lucrează.
- [x] A001 #3: tastele transcriptului în overlay și `aria-keyshortcuts` pe mesaj.
- [x] A001 #4: Edit pune cursorul la finalul textului; ieșirea din editare și o acțiune din meniul contextual
      dau focusul înapoi mesajului; sertarul sidebar-ului nu mai ține focusul în ce ascunde.
- [x] A001 #5: copierea, „Save to Runbook” și aprobările arată un spinner după o secundă.
- [x] A002, ce se aplică aplicației: dialogul face aplicația din spate inertă cât e deschis, Tab trece doar
      prin ce poate primi focus (nu câmpuri ascunse sau dezactivate), `overscroll-behavior: contain`.
- [x] A002, deja în regulă în aplicație: `useOverlayLock` nu există în `src/`; Escape închide doar meniul de
      deasupra; Tab închide meniul; IconButton cere etichetă și are `type="button"`; nu există tooltip-uri
      sau câmpuri `aria-invalid`.
- [x] Nefăcut, cu motiv: `aria-keyshortcuts` generalizat din `shortcut` (doar Copy are o scurtătură care
      chiar merge, și e deja anunțată); butonul primar albastru în repaus (așa e în referința aprobată —
      decizia ta).
- [ ] Nevalidat în aplicație: toate cele de mai sus.

## Mărunțișuri de interfață (utilizator, 05.10)

- [x] „Open tools” e doar iconița (`Columns2`); numele rămâne ca tooltip și pentru cititorul de ecran.
- [x] Runbooks, Tasks și Plans pornesc oprite într-un chat nou. Chaturile existente își păstrează paginile
      (baza de date v15 le scrie „on” acolo unde erau implicit pornite).
- [x] Tabul rămâne „Chat” și în modul Coder; doar iconița spune modul.
- [x] Punctul care „plutea” în colțul composer-ului (`.extension-dot`, fără `position: relative` pe buton)
      și deschidea meniul de extensii nu mai există; butonul spune în nume ce e disponibil.
- [x] Click dreapta în browser: meniu nativ cu Look Up, Copy și Select All pe text selectat; Cut, Copy și
      Paste în câmpuri; pe imagine Copy Image, Save Image (descărcare a chatului) și Copy Image Address;
      pe link Copy Link Address. Înainte nu apărea nimic.
- [ ] Nevalidat în aplicație: toate cele de mai sus.

## Faza 7 — Pluginuri făcute în Hello și tema Hello publicată · M

- [ ] Un șablon și un skill „creator”: Coder scrie pluginuri în format dsh
      (bundle, Cordis, `defineTool`, jumătate de client la nevoie) cu build-ul
      nostru. Ele se instalează în Hello și în dsh.
- [ ] `hello-dsh-theme` publicat pe npm (topic `dsh-plugin`), ca tema Hello să
      se poată instala în DSH Desktop.
- Gata când: un plugin făcut în Hello rulează și în DSH Desktop, iar tema Hello
  se instalează acolo.

## Faza 8 (opțională) — Modul extins

- [ ] Un layout în forma Hello care înlocuiește `ui-layout`, cum face modul
      `extended` din DSH Desktop. Trebuie să ofere `layout` și
      `usePanelInfo`, să declare copiii lui `root` și să aibă prezentatorul de temă.
- Îl facem doar dacă suprafața încă pare străină după faza 3.

## Transversal (în fiecare fază)

- [ ] `docs/SECURITY.md`:
  - noua graniță de încredere: cod străin în gazdă, cu permisiunile utilizatorului;
  - loopback, cookie și tokeni per pornire;
  - ce iese din mașină: npm, 1024Store sau dshfind, furnizorul de model,
    rețeaua pluginurilor;
  - telemetria oprită.
- [ ] `docs/ARCHITECTURE.md` primește diagrama de mai sus. `docs/PROVENANCE.md`
      primește marketul, modelul `desktop-host` și snapshot-ul de tokeni.
- [ ] Teste unitare cu fake-uri în fiecare fază. QA-ul manual îl faci tu
      (AGENTS.md: fără build-uri, teste sau restartul aplicației de dev
      nesolicitate).
- [ ] Manifestul de versiuni cu pini exacți și procedura de upgrade
      (0.1.7 → 0.2.x), verificată pe pluginurile de top din market.
- [ ] Bugetul de memorie și CPU al gazdei, din spike. Gazda se oprește la ieșire.

## Ce acoperă

- Skill-urile (≈1.046) și pluginurile de unelte sau prompt: în chaturile Hello
  (faza 6) și în suprafață.
- UI (≈2.628) și teme (≈497): în suprafață, cu layout-ul lor. O temă dsh
  instalată schimbă suprafața peste tema Hello; alegi tu care rămâne activă.
- Memoria și pluginurile de sesiune: complet în suprafață, iar în chaturile
  Hello după hook-uri (faza 6).
- Furnizorii de modele (≈819): doar în suprafață. Hello are conexiunile lui.

## Riscuri

- dsh e developer preview și `0.2.0-rc.1` e deja `next`; unele pluginuri cer
  0.2. Mitigare: pini exacți, poarta de compatibilitate și faza de upgrade.
- Resursele: dsh complet (63 de rânduri de client, `node-pty`, `sharp`). Le
  măsurăm în spike.
- Cod străin cu permisiunile utilizatorului. Hello dă confirmare, izolare de
  proces și puncte de restaurare, dar nu un sandbox.
- Un plugin poate opri tot boot-ul web. Mitigare: garda de boot și restaurarea.
- Temele populare se bazează pe clase hash-uite și `!important`, deci pot cădea
  la update-uri.
- Loader-ul lor nu are un preset de build publicat. Build-ul nostru urmează
  contractul, iar un smoke test îl verifică.
- Telemetria unor pluginuri (de exemplu dsh1024): oprită implicit prin
  `DO_NOT_TRACK=1`, iar rândurile active sunt verificate la pornire.
