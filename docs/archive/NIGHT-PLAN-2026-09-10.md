# Hello. — plan pentru noaptea de 10 septembrie 2026

**Stare: implementat pe 10 septembrie 2026.** Rezultatele, probele rulate și
ce a rămas neverificat sunt în [raportul de dimineață](NIGHT-REPORT-2026-09-10.md).
Verificarea ulterioară și corecțiile sunt în
[raportul de verificare](EXTENSIONS-VERIFICATION-2026-09-10.md).
Textul de mai jos rămâne specificația după care s-a lucrat.

**Scope actual: skills, MCP și plugins în Hello.** Proprietarul a amânat vision,
descoperirea providerilor și sidecarul; notițele sunt păstrate separat mai jos,
în afara implementării din această noapte.

Rezultatul urmărit pentru dimineață: pot importa un skill/plugin local și
configura un server MCP, văd ce oferă, le activez pentru un chat și le folosesc
acolo. Pi rămâne motorul; Hello gestionează biblioteca, selecția, serviciile și
interfața.

## Starea inițială, la redactarea planului

- Pi 0.85.1 în RPC persistent, cu extensia de tools Hello și sesiuni separate.
- Browser, cercetare cu surse, Runbook/Tasks, Files și terminale/CLI lansate explicit.
- În sursă: HTML creat/deschis local, drag-and-drop în chat și CLI, atașamente
  text/imagine cu căi originale și copii persistente. Ultima verificare a fost
  statică; acestea au nevoie de probe de comportament înaintea extinderii.
- `pi-session.ts` dezactivează discovery implicit pentru skills/extensii și
  pornește cu listele `packages`, `extensions`, `skills`, `prompts` goale.
- Settings nu are încă bibliotecă de skills/plugins; nu avem client MCP general.
- Settings nu are încă gestionarea surselor Ollama/llama.cpp și catalogul unificat
  de capabilități propus mai jos. Existența unui endpoint activ nu echivalează cu
  acest mecanism de descoperire.
- Lista de modele păstrează acum numai numele, nu capabilitățile. Declarația Pi
  `input: ['text', 'image']` permite transportul, dar nu dovedește suport vision.
  Captura proprietarului arată un refuz real al rutei pentru input imagine.

## Ordinea de lucru

| Ordine | Ce livrez | Cum se vede că este gata |
| --- | --- | --- |
| **0. Integrarea de bază** | Verific bridge-ul Pi, încărcarea resurselor, Stop/Retry și păstrarea conversației, necesare celor trei livrări. | Probe locale izolate după OK; pornirea/oprirea resurselor nu pierde istoricul și nu afectează alt chat. |
| **1. Biblioteca din Settings** | Secțiune **Extensions**, cu Skills / Plugins / MCP. Import local, nume, descriere, sursă, versiune/amprentă și stări reale. Pentru MCP afișăm numai ce este implementat. | Pot importa un `SKILL.md`, un director de skill sau un pachet Pi local. Fișiere invalide/duplicate au erori clare. Importul nu execută cod și nu activează automat resurse. |
| **2. Skills folosite în chat** | Alegere pentru conversația curentă, căutare și invocare `/skill:nume`; încărcare la nevoie a instrucțiunilor și referințelor. | Un skill activ apare în comenzile chatului și instrucțiunile lui ajung efectiv la Pi. Cel oprit nu mai este disponibil în tura următoare. Funcționează și fără folder de proiect. |
| **3. MCP local** | Primul client MCP pentru servere `stdio`: configurație în Settings, selecție per chat, conectare, listare și apel de tool-uri, stare și oprire. Integrare prin bridge-ul Hello. | Un server local de probă face handshake și execută un tool prin chat; rezultatul revine modelului; numele nu intră în conflict; timeout/Stop/disconnect funcționează; dezactivarea oprește procesul asociat. |
| **4. Plugins / extensii Pi** | Importul unui pachet local cu manifest Pi; lista resurselor și activare explicită a versiunii inspectate. Tool-uri/comenzi compatibile RPC apar în chat. | Un plugin de probă adaugă un tool real; oprirea lui elimină tool-ul din runtime, fără pierderea istoricului. Codul schimbat după activare este semnalat și nu înlocuiește tăcut versiunea aprobată. |
| **5. Exemple Hello utile** | Două skills locale livrate cu app-ul: **Hello Visuals** și **Hello Research**, plus un exemplu minim de plugin. Folosesc serviciile deja existente. | Visuals folosește HTML local și datele primite; Research folosește sursele și citările existente. Exemplele demonstrează activarea și încărcarea din aceeași bibliotecă. Calitatea cu un model real rămâne de verificat separat. |
| **6. Livrare de dimineață** | Documentație actualizată, exemplu de plugin, listă de probe și raport pe rezultate. | Separ explicit ce merge în probe, ce există doar în sursă și ce are nevoie de verificarea utilizatorului/modelului. |

**Prioritatea este Settings → skills → MCP → plugins → exemple și verificare.**
MCP este parte din scope-ul principal, nu un bonus după vision. Dacă apare un
blocaj, îl documentez și termin livrările independente.
Nu promit un număr de ore pentru componente încă nevalidate.

## Vision dinamic — notițe amânate, în afara nopții curente

Această secțiune păstrează discuția pentru mai târziu. Nu reprezintă un pas activ
și nu condiționează livrarea skills, MCP sau plugins.

**Hello face rutarea înainte de trimitere.** Nu lăsăm modelul text să descopere
prin erori repetate că nu vede și să caute singur imaginea pe disc.

1. Dacă modelul principal acceptă imagini, primește imaginea direct.
2. Altfel, Hello consultă sursele descoperite: catalogul providerului activ
   (OpenRouter dacă acolo este conectat chatul), serviciile locale găsite în
   sistem (Ollama, llama.cpp etc.) și sursele adăugate ulterior în Settings.
   Alege un candidat vision utilizabil după disponibilitate, cost și preferințe;
   fără furnizor sau model fix. Descoperirea nu pornește/reîncarcă servere și nu
   descarcă modele automat.
3. Sidecarul primește copia persistentă a imaginii, calea originală ca metadată
   și întrebarea exactă. Pentru „ce scrie aici?” cere transcrierea textului vizibil,
   cu zonele ilizibile marcate, nu o descriere generică a întregii imagini.
4. Rezultatul revine ca observație atribuită modelului helper, cu legătura la
   atașament. Modelul principal continuă răspunsul; descrierea nu este prezentată
   drept observație vizuală directă a lui sau adevăr garantat.

### Descoperire, Settings și adevărul despre capabilități

- Construim adaptoare care identifică providerul activ, instalările locale și
  serviciile accesibile folosind sursele/configurațiile cunoscute. Consultăm
  cataloagele lor de modele. Nu cerem modelului conversațional să caute orbește
  pe disc și nu presupunem că toate sursele sunt deja în Settings.
- **Instalat**, **pornit/accesibil**, **model disponibil** și **vision suportat**
  sunt stări separate. Un executabil Ollama prezent sau un fișier GGUF găsit nu
  este încă o destinație care poate primi imaginea. Settings va afișa sursele
  descoperite, starea lor și opțiunile de configurare/adăugare.
- **Vision: Da / Nu / Necunoscut**, per endpoint și model, cu sursa și data
  verificării în detalii. Păstrăm metadatele de modalitate din catalog; nu
  deducem suportul din nume sau din bifa `input` a adaptorului Pi.
- Pentru llama.cpp consultăm serverul pornit, inclusiv `/props` unde există.
  `modalities.vision: false` are prioritate față de un `mmproj` găsit pe disc ori
  o cale veche din Settings. Lipsa metadatelor înseamnă Necunoscut.
- Cache separat după endpoint/model, invalidat la schimbări; verificare cu
  timeout scurt înaintea trimiterii imaginilor. Un refuz explicit de suport
  imagine actualizează starea rutei; alte erori 404 nu devin automat „fără vision”.
- **Vision fallback: Auto / model preferat / Off**, cu destinațiile permise și
  modelul ales vizibile. Setările endpointurilor reutilizează stocarea securizată
  a cheilor. Descoperirea locală nu importă automat secrete din alte aplicații.
  Preț necunoscut nu
  înseamnă gratuit; selecția respectă limitele configurate, fără prețuri ghicite.
- Hello are acum un singur endpoint activ: construim registrul de surse și
  modele alimentat de descoperire, apoi îl expunem în Settings. Profilurile
  salvate completează descoperirea; nu o înlocuiesc. Adaptăm mecanismele aplicația-soră
  relevante acestui flux.

### Canalul de retur

API-ul direct este prima variantă: returnează un rezultat sau o eroare prin
același apel, fără parsarea unui terminal. CLI-ul este alternativă pentru un
model disponibil numai astfel, ales dintre configurațiile compatibile; numele
CLI-ului nu dovedește capabilitatea vision a modelului său.

Pentru CLI reutilizăm ideea aplicația-soră: script de raport cu heredoc delimitat prin
ghilimele simple, autentificare locală și confirmare reală de primire. Cererea
leagă un ID unic de chat, tură și atașament; raportul are stare succes/eșec/blocat
și conținut limitat. Un prompt „mandatory” ajută, dar **nu garantează livrarea**.
Exit 0 fără raport nu este succes. Timeout, Stop, raport întârziat și duplicat
au tratament explicit; rezultatul valid intră o singură dată în tura corectă.

În ambele variante: execuție limitată ca timp și output, fără bucle de retry,
fără subdelegare și fără acces implicit la întregul chat/Runbook/disc. Conținutul
din imagine și raport rămâne date, nu instrucțiuni de sistem. Dacă nu există o
rută eligibilă, păstrăm mesajul și atașamentul și afișăm cauza concretă.
Retry/restart și schimbarea de la un model vision la unul text trebuie să
trateze și imaginile din istoricul Pi; filtrarea doar a mesajului nou nu ajunge.

Aplicația-soră conține atât apelul API `describe_image`, cât și o rută de delegare către
CLI. Comentariile lui semnalează descrieri locale nesigure în utilizarea reală;
de aceea validarea trebuie să verifice întrebarea exactă și incertitudinea din
rezultat, nu doar faptul că a sosit text. Refolosim selectiv detecția și canalul,
nu euristicile de nume ori pornirea automată a unui daemon.

## Alegeri de produs pentru această iterație

- O singură bibliotecă instalată în Hello, cu resurse alese per conversație.
  Chat și Coder folosesc același mecanism. CLI-urile externe păstrează configurația
  proprie; activarea în chat nu modifică instalarea globală Qwen/OpenCode/Pi.
- Un **skill** conține instrucțiuni și resurse; o **extensie** adaugă cod/tool-uri;
  un **plugin** grupează resurse într-un pachet Pi. Folosim formatul Pi unde există.
- Control simplu: nume, descriere, sursă, activare, detalii la cerere. Respectăm
  `design/LOOK.md`, dimensiunile compacte și materialele aprobate.
- Modificarea selecției nu întrerupe răspunsul activ. Se afișează clar că se aplică
  după terminarea turei; următoarea tură pornește cu exact selecția nouă și același
  istoric Pi. Dacă nu există reload RPC adecvat, recreăm copilul între ture.
- Agentul poate pregăti un skill/plugin ca propunere locală. Activarea codului
  nou ori modificat rămâne o acțiune a utilizatorului. Nu poate bifa singur o
  versiune pe care tocmai a rescris-o.
- Biblioteca nu injectează toate instrucțiunile în fiecare mesaj. Lista compactă
  și instrucțiunile încărcate se pot inspecta; nu inventăm un cost exact de tokeni.

## Puncte tehnice care trebuie rezolvate, nu doar desenate

1. **Citirea skills.** Pi știe `--skill` și `/skill:nume`, dar în Hello tool-urile
   native `read` și `bash` sunt excluse. Simpla adăugare a căii în config nu ajunge:
   asigur o cale de citire limitată la resursele importate/activate și verific
   încărcarea instrucțiunilor/referințelor fără acces arbitrar la disc.
2. **Compatibilitatea extensiilor.** Extensiile care cer TUI nu devin automat UI
   Electron. Suport explicit pentru tool-uri/comenzi și cereri UI pe care bridge-ul
   le poate reprezenta; extensiile incompatibile primesc un diagnostic clar.
3. **Dezactivare reală.** Catalogul, comenzile oferite modelului și procesul Pi
   trebuie să fie de acord. O bifă stinsă cu tool-ul încă activ este defect.
4. **Cod și permisiuni.** Extensiile Pi sunt cod Node, nu un sandbox. UI-ul arată
   această diferență; o listă declarativă de capabilități nu este prezentată drept
   limită tehnică. Tools Hello păstrează verificările din main.
5. **MCP.** Configurație validată, argumente separate de comandă, mediu minim,
   secrete în stocarea Hello și nume de tool-uri separate per server. Tool-urile
   MCP nu primesc implicit acces la renderer sau la browserul autentificat.

## Validarea propusă spre aprobare

OK-ul pe acest plan ar include **teste automate locale, build local și o probă
într-o instanță separată Hello cu date temporare**, folosind un runtime/model
simulat pentru integrare, skills/plugin de probă și un server MCP local de probă.
Verificăm încărcarea la nevoie, izolarea între chat-uri, persistența, activarea/
dezactivarea efectivă, erorile și Stop. Mai întâi verific scripturile de test,
ca să nu lanseze un provider ori un CLI real.

Nu repornesc instanța deschisă de proprietar, nu folosesc conversațiile/datele
reale pentru probe, nu fac apeluri taxabile și nu schimb setările globale ale
CLI-urilor. Nu public, nu instalez pluginuri terțe pentru utilizator și nu activez
integrări cu conturi externe în absența lui. Fără npm/git install automat la
importul unui pachet local; dependențele lipsă sunt raportate. Eventualele
dependențe de dezvoltare necesare sunt fixate în proiect, fără instalări globale.

Excepția pentru validare a fost aprobată prin „ok implementează-le”. Ea era
necesară deoarece `AGENTS.md` spune:
“Do not run builds, packaging, tests or restart the dev app unless requested.”
Probele acestei livrări folosesc exclusiv instanțe și date temporare, conform
limitelor de mai sus; aprobarea nu include restartul aplicației proprietarului.

## Ce rămâne pentru după această noapte

Vision, descoperirea providerilor locali/cloud și sidecarul cu retur în chat.
De asemenea: marketplace online, instalare automată npm/git, OAuth pentru MCP remote, memorie
nouă, orchestrare generală multi-CLI, worktrees/checkpoints per tură și redesenarea
generală a aplicației. Helperul vision cu raport limitat nu presupune aceste
proiecte separate.

## Repere de implementare

- Hello: `src/main/chat/pi-session.ts`, `pi-rpc.ts`, `pi-extension.ts`,
  `pi-tool-bridge.ts`, `service.ts`, `tools.ts`; `src/main/data/store.ts`;
  `src/main/ipc.ts`, `src/preload/index.ts`, `src/shared/types.ts`;
  `src/renderer/settings/SettingsDialog.tsx`, `chat/ConversationView.tsx`.
- Pi instalat: `docs/skills.md`, `docs/packages.md`, `docs/extensions.md` și
  `docs/rpc.md` din pachetul `@earendil-works/pi-coding-agent` 0.85.1.
- Aplicația-soră, numai reutilizare punctuală autorizată:
  `src-tauri/src/cmd/pi_agent.rs`, `src-tauri/resources/pi-ext/`,
  `src/runtime/localModels/visionSidecar.ts`,
  `src-tauri/resources/pi-ext/vision-sidecar.ts`,
  `src-tauri/resources/hooks/worker-done.sh`,
  `src/runtime/mcpServerResources.test.ts`. Adaptările se notează în PROVENANCE.
- Fără cercetare nouă pe Reddit. Planul pleacă de la codul local și deciziile
  proprietarului, nu de la numărul de feature-uri din research.
