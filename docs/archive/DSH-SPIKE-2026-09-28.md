# Spike: suprafața DSH în Hello (Faza 0, 2026-09-28)

Întrebarea: poate Hello rula gazda DeepSeek Harness (dsh) și clientul ei web,
colorat cu tema Hello, cu pluginuri reale, pe Electron-ul Hello (44.3.0)?

Răspunsul este **da**, cu o singură piedică, rezolvată mai jos. Recomandare: mergem mai departe.

Spike-ul a rulat într-un folder de lucru din afara repo-ului, cu `DSH_HOME` propriu.
Nu a atins `~/.dsh`, nu a cheltuit credite de model și nu a lăsat proces pornit.

## Ce am rulat

1. Runtime-ul dsh: `package.json` cu `"@deepseek-ai/dsh": "0.1.7-rc.2"`
   (pachetul aduce toată instalarea: `dsh-base`, `dsh-web-app` și restul),
   instalat cu pnpm, `nodeLinker: hoisted`.
2. Un entry de gazdă de 30 de linii, după `apps/desktop-host`. Rulează
   `runProfile({ profile: 'hello', fromDefaultProfile: 'web', args: ['--no-open',
   '--port', '0'] })`, iar după boot trimite `ctx.connection.authenticatedUrl(...)`.
3. Gazda pornită cu Electron-ul Hello ca Node (`ELECTRON_RUN_AS_NODE=1`),
   cu mediu curat: `DSH_HOME`, `DSH_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`.
4. Clientul deschis în browser prin URL-ul autentificat: un 303 care pune
   cookie-ul, apoi aplicația.
5. Un plugin de temă Hello scris de mână, în formatul loader-ului lor
   (`window.__ModuleLoader__.load({ id, factory })`, `inject: ['theme']`,
   `overrideTokens('hello', …)`).
6. Două pluginuri de UI reale: `dsh1024` 0.5.0 și `dsh-cost-meter` 1.7.44,
   instalate în profil (dependență exactă plus `dsh.profile.bundles`).
7. Aceeași probă cu `0.2.0-rc.1`.

## Cifre

| Ce | Valoare |
|---|---|
| Pachete instalate | 514 |
| Mărime runtime (`node_modules`, hoisted) | 492 MB |
| Cele mai mari | `@deepseek-ai/libreoffice-kit-darwin-arm64` 147 MB, `sherpa-onnx` 32 MB, `@opentelemetry` 27 MB, `node-pty` 26 MB, `sharp`/libvips 17 MB |
| Instalare (store parțial cald) | 18 s |
| Boot-ul gazdei, după încărcarea modulelor | 420–540 ms |
| Memorie gazdă, în repaus | 156 MB RSS; 243 MB cu dsh1024 + cost-meter |
| Rețea în repaus | nimic în afară de ascultătorul loopback |
| Port | 0 merge: serverul își citește portul real |

## Piedica: `node-addon-require-builtin`

`dsh-app-boot` citește modulele interne ale Node-ului (loader-ul ESM/CJS)
printr-un addon N-API: `node-addon-require-builtin` 0.1.6.

Addonul recunoaște doar amprente exacte de Electron (V8): 43.0.0, 44.0.0 și
45.0.0-alpha.6. DSH Desktop rulează Electron 44.0.0, așa că la el merge.
Electron-ul Hello, 44.3.0 (V8 15.2.124.19), este refuzat, iar gazda cade la
pregătire:

```
dsh: host preparation failed: node-addon-require-builtin unsupported:
unsupported Electron runtime fingerprint: Node 24.20.0, V8 15.2.124.19-electron.0
```

**Soluția:** gazda pornește cu `--expose-internals`, așa că Node-ul răspunde
direct la `require('internal/modules/…')` (verificat pe toate cele 5 module
folosite).

- Pachetul e înlocuit prin `overrides` pnpm cu un shim Hello, care are
  același API: `requireBuiltin`, `isAllowedInternalId`, `getBindingInfo`.
- Același procedeu îl folosește deja `@deepseek-ai/cordis-plugin-loader`,
  care preferă `--expose-internals` când e prezent.
- Merge pe 0.1.7-rc.2 și pe 0.2.0-rc.1.

Shim-ul intră în repo la `resources/dsh/shims/node-addon-require-builtin/`.

Observație pnpm: versiunile noi ignoră câmpul `pnpm` din `package.json`.
`overrides` și `nodeLinker` stau în `pnpm-workspace.yaml`.

## Ce am văzut în client

- **Clientul rulează.** Sidebar-ul are brand, New Session, Plugins,
  Workspaces și Settings.
- **La prima pornire** apar două dialoguri:
  - „Internal Testing Notice”, cu un buton Continue;
  - „Add an API key to get started”, pentru furnizorul oficial DeepSeek.
    Faza 4 îl înlocuiește cu conexiunea Hello.
- **Tema Hello se aplică.** Variabilele din `body` au luat valorile Hello
  (`--dsw-alias-bg-layer-3 = #222222` și `--dsw-specific-sidebar-fill =
  #111111` în dark), iar fontul este Inter Variable.
- **dsh1024** adaugă rândul „1024 Store · N plugins”, cu punctul „connected”.
- **cost-meter** adaugă „Today ¥0 / Off-peak” în sidebar și propunerea „A lighter sidebar”.

## De știut pentru implementare

- **Tokenul apare în log.** Gazda scrie `dsh web: http://127.0.0.1:<port>/?token=…`
  pe stdout. Hello nu copiază stdout-ul brut în log-uri, sau oprește tipărirea
  URL-ului.
- **pnpm ignoră unele scripturi de build.** Sunt ignorate implicit
  scripturile pentru `@deepseek-ai/dsh-subprocess-local`, `@google/genai`,
  `koffi`, `node-pty` și `protobufjs`. Gazda pornește și fără ele. Terminalul
  dsh (`node-pty`) trebuie verificat separat, iar aprobarea stă în
  `onlyBuiltDependencies`.
- **Profilul** creat de `fromDefaultProfile: 'web'` conține `package.json`
  (bundles), `cordis.yml`, `cordis.patch.yml` și `pnpm-workspace.yaml`
  (`nodeLinker: hoisted`). Datele pluginurilor stau în `<DSH_HOME>/storages/`.
- **Un plugin nou** înseamnă o dependență exactă, adăugată în
  `dsh.profile.bundles` dacă e bundle. Pluginurile de client simple (ca tema)
  intră printr-un rând în `cordis.patch.yml`.
- **Descărcarea** are aproape 0,5 GB. Mai târziu o putem micșora înlocuind
  motorul office (147 MB) cu un pachet gol, dacă cineva nu vrea previzualizare
  de documente Office.
- **Pinul** rămâne 0.1.7-rc.2: e versiunea din DSH Desktop 2.0.15, iar
  pluginurile din market o țintesc azi. Trecerea la 0.2.x merge cu același
  shim și se face în faza de upgrade.
