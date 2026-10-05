# Metoda: pagina web în document, nu deasupra lui

10 septembrie 2026. Scris pentru echipa aplicația-soră, ca să se poată judeca dacă
tehnica din Hello. se poate muta într-o aplicație Tauri/Rust. Prima parte
descrie exact ce s-a făcut în Electron și de ce; a doua spune ce se traduce în
Tauri și ce nu.

## Problema

O vizualizare nativă adăugată ferestrei — `WebContentsView` în Electron, un
`WKWebView`/`WebView2` copil în orice altă tehnologie — compune **deasupra**
paginii proprii a ferestrei. Nu e o chestiune de `z-index`: sunt două suprafețe
diferite, iar cea nativă e mai sus prin construcție.

Consecința: orice meniu, listă derulantă sau dialog al aplicației care se
suprapune peste panoul cu pagina e desenat dedesubt, adică invizibil.

Ocolirea evidentă — și cea pe care Hello. o avea — e să măsori dreptunghiul
meniului în renderer, să-l trimiți în procesul principal și să ascunzi sau să
repoziționezi vizualizarea nativă cât timp meniul e deschis. Costul real, măsurat
pe aplicația noastră:

- meniurile se închideau singure, pentru că ascunderea paginii producea un
  `blur` de fereastră, iar meniul trata orice `blur` ca „utilizatorul a plecat";
- pâlpâire la fiecare deschidere de meniu, fiindcă pagina dispărea și reapărea;
- un aparat întreg de contabilitate: regiuni de meniu numărate, rețineri pe
  toată fereastra pentru dialoguri, reconciliere ca să nu se trimită IPC redundant,
  sincronizarea geometriei la fiecare `resize`, `scroll` și animație de layout.

## Soluția

Pagina nu se mai stivuiește deasupra documentului: **trăiește în document**, ca
element `<webview>` — un guest `WebContents` care participă la compoziția paginii
gazdă. Din acel moment stivuirea e CSS obișnuit: `.menu-popup { z-index: 100 }`
se desenează peste pagină fără ca cineva să ascundă ceva.

Verificat pe o aplicație care livrează asta: Cursor 3.20.7 creează exact așa —
`document.createElement("webview")` cu `partition`, `preload` și `webpreferences`,
într-un container `position: fixed` sincronizat pe slotul din layout.

### Ce am eliminat

`registerAppMenu`, `menuRegions`, `reconcileBrowser`, `setAppOverlay`,
`useMenuOverlay`, `useOverlay`, IPC-ul de prezentare cu geometrie și toate cele
opt locuri care rețineau fereastra în timpul animațiilor. Aproape 200 de linii.

### Autoritatea rămâne în procesul principal

Asta e partea care contează și e ușor de pierdut. Fereastra poate cere o pagină,
dar nu decide nimic despre ea:

1. **Nonce de unică folosință.** Renderer-ul cere `browser.attach(tabId)`, iar
   main răspunde cu `about:blank#hello-attach-<uuid>`, legat de exact o filă.
   Un `about:` a fost ales anume: o schemă proprie ar fi avut nevoie de handler
   în fiecare partiție, iar guest-ul rulează în partiția lui.
2. **`will-attach-webview` rescrie tot.** În main, înainte de atașare, se șterg
   *toate* cheile din `webPreferences` cerute de etichetă și se scriu ale
   noastre — sandbox, izolare de context, fără Node, fără webview imbricat,
   partiția filei — plus se șterg din `params` atributele periculoase
   (`preload`, `nodeintegration`, `webpreferences`, `disablewebsecurity`).
   Un nonce necunoscut sau consumat înseamnă `event.preventDefault()`.
3. **`did-attach-webview` leagă guest-ul.** Evenimentul îți dă `WebContents`-ul,
   iar de acolo main pune pe el aceleași reguli ca înainte:
   `setWindowOpenHandler`, `will-navigate`, `will-redirect`, veto pe webview
   imbricat, ascultătorii de stare. Un guest a cărui gazdă nu e fereastra
   noastră e închis pe loc.
4. **Renderer-ul nu setează niciodată `src` după atașare.** `will-navigate` nu
   se declanșează pentru încărcări programatice, deci o scriere de `src` din
   renderer ar ocoli validarea adreselor. Singura scriere permisă e nonce-ul.

### Trei capcane care ne-au costat timp

- **La `did-attach-webview` guest-ul încă nu are URL.** Legarea prin nonce citit
  din `getURL()` nu funcționează; perechea se face la `will-attach`, unde
  nonce-ul e vizibil în `params.src`.
- **Chromium nu creează pagina pentru un element fără casetă.** Sub
  `display: none`, sau cu dimensiune zero, atașarea nu are loc niciodată. Un
  panou ascuns nu poate deci să găzduiască pagina: la noi pagina stă într-o
  gazdă `position: fixed` proprie, care urmărește slotul panoului când e vizibil
  și e parcată în spatele aplicației (`z-index: -1`) când nu e. O pagină deja
  atașată supraviețuiește apoi lui `display: none` — dar nu se naște sub el.
- **Demontarea trebuie să numească pagina pe care a creat-o.** Altfel un panou
  care se demontează târziu închide pagina pe care un panou nou tocmai a
  montat-o. `detach(tabId, nonce)` închide doar dacă nonce-ul se potrivește.

### Ce s-a pierdut

Un `<webview>` nu poate adopta un `WebContents` existent. Un pop-up (`window.open`)
nu mai poate deveni filă în aplicație păstrându-și `opener`-ul; la noi devine
fereastră copil, cu aceleași preferințe și partiția celui care l-a deschis. Asta
păstrează `window.opener`, `postMessage` și corpul POST — lucruri pe care
redeschiderea adresei ca filă nouă le-ar fi rupt.

Și o premisă de încredere nouă, scrisă explicit în `docs/SECURITY.md`: renderer-ul
poate acum chema metode ale etichetei pe guest, inclusiv `loadURL` și
`executeJavaScript`, iar main nu i le poate lua. Deci codul din renderer e cod de
încredere și nu randează niciodată HTML din web sau de la model în propriul
document: HTML-ul generat se deschide într-un guest cu partiție izolată.

## Ce înseamnă asta pentru Tauri

**Nu se portează**, și nu din lipsă de efort: mecanismul pe care stă nu există
acolo. `<webview>` din Electron e un iframe out-of-process care participă la
compoziția paginii gazdă, de aceea `z-index` ajunge să conteze. În Tauri v2 și
wry, un webview copil e o vizualizare nativă a platformei — `WKWebView`,
`WebView2`, `WebKitGTK` — care compune întotdeauna deasupra webview-ului
principal. Nu există echivalentul unui guest în document.

Deci întrebarea utilă pentru aplicația-soră nu e „cum portăm asta", ci **„cum desenăm
meniurile aplicației peste o pagină încorporată, în Tauri"** — cu constrângerea
că meniurile sunt HTML, iar pagina trebuie să rămână vie și citibilă de agent.

### Ce spun sursele

Nu e o lacună de documentație, e o decizie de proiectare, ținută în două
runtime-uri:

- **Nu există niciun API de ordonare** în tauri, wry sau tao. Căutare de cod
  pentru `z_index` / `set_z_index` / `bring_to_front` în ambele depozite: zero
  rezultate. `wry::WebView` (0.57.0, septembrie 2026) expune `bounds`,
  `set_bounds`, `set_visible`, `focus` — și nimic care să ridice sau să coboare
  o vizualizare.
- **Pe Windows regula e scrisă în cod**: wry cheamă `SetWindowPos(hwnd, HWND_TOP, …)`
  imediat după crearea fiecărui webview copil
  ([wry#1271](https://github.com/tauri-apps/wry/pull/1271), încă pe `dev`). Pe
  macOS ordinea vine din ordinea de inserare ca subview
  ([tauri#10155](https://github.com/tauri-apps/tauri/issues/10155), răspuns de
  un mentenanțor).
- **Cererile exacte pentru asta zac needeschise.**
  [tauri#11124](https://github.com/tauri-apps/tauri/issues/11124) cere fix un
  `level()` pentru ca meniurile să stea deasupra — deschisă din septembrie 2024,
  fără niciun răspuns de la mentenanți.
  [tauri#15682](https://github.com/tauri-apps/tauri/issues/15682) o reformulează
  în iulie 2026, cu capturi: tot fără răspuns.
- **Simptomul nostru, raportat de altcineva**:
  [tauri#14463](https://github.com/tauri-apps/tauri/issues/14463) — un dropdown
  Element Plus din webview-ul principal e acoperit de webview-ul copil, pe macOS
  și pe Windows. Detaliul care contează: raportorul spune că **un `<select>`
  nativ nu are problema**, fiindcă sistemul îl desenează în fereastra lui popup.
- **Ce s-a livrat în locul ordonării**: ascunderea
  ([tauri#11126](https://github.com/tauri-apps/tauri/issues/11126), închisă ca
  implementată în trei zile) — adică exact ocolirea de care scăpăm noi.
- **Nici runtime-ul CEF nu schimbă asta**:
  [tauri#15148](https://github.com/tauri-apps/tauri/pull/15148), martie 2026,
  adaugă aceeași regulă „ultimul creat deasupra" pe Windows.

### Ce rămâne de făcut, atunci

Din dovezile de mai sus, direcția e dată de `<select>`-ul nativ: ceea ce se
desenează peste un webview copil e o **fereastră a sistemului**, nu un element
din DOM-ul principal. Deci meniurile aplicației ar trebui să fie ferestre
proprii — mici, fără ramă, transparente, poziționate peste panou — nu popup-uri
HTML în webview-ul principal. Este și ce fac Chrome și Firefox pentru meniurile
lor.

Capcana de verificat înainte de a construi asta: **focalizarea**. La noi, în
Electron, meniurile se închideau pentru că ascunderea paginii producea un `blur`
de fereastră. O fereastră-meniu separată produce exact același `blur` pe
fereastra principală, deci regula de închidere nu poate fi „orice blur", ci
„focus plecat în afara perechii fereastră + meniu".

Două portițe de urmărit, dacă se dorește totuși stivuire reală:

- [wry#1712](https://github.com/tauri-apps/wry/pull/1712) (livrat, aprilie 2026)
  expune `WebViewExtWindows::hwnd`, deci pe Windows se poate chema `SetWindowPos`
  direct, pe cont propriu.
- [wry#1762](https://github.com/tauri-apps/wry/pull/1762) adaugă găzduire prin
  DirectComposition pe Windows — singura cale către compunere stratificată
  adevărată. Deschisă și nerevizuită de la iulie 2026.

Pe Linux, poziționarea webview-urilor copil e oricum ruptă: lanțul de reparații
(tao#1232, wry#1745, tauri#15463, tauri#15704) e nemerge de la iunie 2026, iar
[tauri#15656](https://github.com/tauri-apps/tauri/issues/15656) e deschisă.

### Recomandarea

**Meniurile ca ferestre proprii** — fără ramă, transparente, always-on-top,
nefocalizabile, cu `.parent(&main)` — pe macOS și Windows; **ascunderea
webview-ului copil** ca variantă pentru Linux și ca plasă de siguranță peste tot.

E singura cale care păstrează meniurile în HTML *și* lasă pagina neatinsă, vie și
citibilă de agent. E și tiparul pe care îl folosește Chromium: meniurile lui sunt
widget-uri `TYPE_MENU`, nefocalizabile prin construcție.

Practic: o singură fereastră-meniu, creată ascunsă la pornire și mutată cu
`show()` / `set_position()` / `hide()` — nu una nouă la fiecare deschidere, până
nu măsori costul. `parent()` îți dă, pe macOS, urmărirea ferestrei părinte gratis,
iar pe Windows garanția că fereastra stă deasupra proprietarului ei.

### Capcanele, în ordinea în care te lovesc

- **Focalizarea, aceeași care ne-a costat azi.** Nu lega închiderea meniului de
  `blur`-ul din DOM-ul paginii principale; folosește `WindowEvent::Focused` pe
  fereastra-meniu, plus Escape și clic în afară.
- **`focusable(false)` e raportat rupt exact unde contează.** Pe macOS fură
  focalizarea la clic ([tauri#14102](https://github.com/tauri-apps/tauri/issues/14102),
  deschisă); pe Windows pune `WS_EX_NOACTIVATE`, care **taie tastatura**, deci
  omoară un câmp de căutare în meniu
  ([tauri#14386](https://github.com/tauri-apps/tauri/issues/14386), deschisă).
  Pe macOS soluția reală e `NSWindowStyleMask.nonActivatingPanel` prin FFI pe
  `ns_window()`, cu `becomesKeyOnlyIfNeeded` — tao nu expune NSPanel.
- **Wayland: opțiunea nu funcționează.** `set_position` și `always_on_top` eșuează
  în tăcere ([tauri#14913](https://github.com/tauri-apps/tauri/issues/14913)).
  Acolo rămâne ascunderea webview-ului.
- **Transparența pe macOS cere `macos-private-api`**, ceea ce înseamnă că
  aplicația nu mai poate intra în App Store. Dacă asta contează, meniul trebuie
  opac.

### Ce s-a exclus și de ce

- **Meniuri native.** Apple documentează explicit, pentru vizualizări în
  `NSMenuItem`: „Keyboard events are not supported" — deci fără câmp de căutare.
  Win32 nu are cale documentată de a găzdui un control într-un `HMENU`. Iar
  `tauri::menu` oferă doar text, bifă, iconiță și submeniu.
- **`<iframe>` în locul webview-ului copil.** Aproximativ jumătate din siteurile
  populare refuză încadrarea (`X-Frame-Options`, `frame-ancestors`) — verificat
  live: GitHub, Google, X, Reddit, YouTube. În plus agentul devine orb pe
  cross-origin, iar Tauri are un aviz de securitate,
  [GHSA-57fm-592m-34r7](https://github.com/tauri-apps/tauri/security/advisories/GHSA-57fm-592m-34r7),
  a cărui recomandare e literalmente „folosiți ferestre dedicate în loc de
  iframe-uri pentru conținut neîncrezut".
- **Un al doilea webview transparent, deasupra paginii.** Se poate stivui, dar nu
  poți da clic prin el: `set_ignore_cursor_events` e per fereastră, nu per webview
  ([tauri#10564](https://github.com/tauri-apps/tauri/issues/10564), deschisă).

### Ce merită urmărit

[wry#1762](https://github.com/tauri-apps/wry/pull/1762) — găzduire prin
DirectComposition pe Windows, singura cale către compunere stratificată
adevărată; deschisă și nerevizuită din iulie 2026.
[wry#391](https://github.com/tauri-apps/wry/issues/391) — randare offscreen,
deschisă din 2021.

Un detaliu util indiferent de alegere: pe macOS 14+, `backgroundThrottling:
"disabled"` pe webview-ul paginii, altfel motorul poate descărca pagina după
câteva minute în care e ascunsă — exact ce ar rupe cititul de către agent.
