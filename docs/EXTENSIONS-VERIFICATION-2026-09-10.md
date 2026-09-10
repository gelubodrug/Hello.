# Verificarea implementării Claude — skills, MCP și plugins

10 septembrie 2026. Verificare și corecții în `/Users/q/Documents/Hello.`,
după cererea proprietarului „vezi că le-a făcut Claude, dar verifică”.
Implementarea inițială și raportul lui Claude au fost păstrate; constatările
de mai jos descriu verificarea ulterioară.

**Rezultat:** biblioteca și integrarea funcționează în probe locale, dar au
existat defecte neacoperite de cele 29 de teste inițiale. Corecțiile au acum
51 de teste de extensions și 12 verificări native trecute. Suita completă
are încă cele șase eșecuri deja raportate de Claude.

## Defecte confirmate și reparate

| Caz | Corecția verificată |
| --- | --- |
| Editarea MCP reconstruia comanda prin separare la spații și pierdea argumente/cwd; mediul nu putea fi golit explicit | API-ul livrează separat comanda, argumentele și folderul, fără valorile secrete. Editorul păstrează argumentele intacte și permite păstrarea sau ștergerea explicită a mediului stocat. Există Disconnect. Proba nativă folosește intenționat o cale cu spații. |
| Dezactivarea sau închiderea managerului în timpul handshake-ului nu urmărea copilul încă în pornire | Pornirile sunt urmărite împreună cu procesul. Disconnect/reconcile/dispose le opresc; o pornire veche nu poate înlocui o conexiune nouă. Executabilul inexistent eșuează fără a aștepta un eveniment exit care nu vine. |
| Un apel deja anulat putea fi trimis; listenerele de anulare rămâneau după succes | Semnalul e verificat înainte de conectare și trimitere, iar listenerele sunt eliminate la terminare. Stop poate întrerupe așteptarea handshake-ului fără să omoare serverul necesar altui chat activ. |
| Rezultatul MCP `isError: true` era tratat ca succes | Eroarea ajunge pe calea de eșec a tool-ului. Timeout-urile, limita de mesaj în octeți și limita reală de 20 KB pentru schema unui tool sunt acoperite de teste. |
| Clientul ignora negocierea versiunii, paginarea și schimbarea catalogului; un request al serverului putea avea același ID ca un request Hello | Validează versiunile acceptate și capabilitatea tools, încarcă paginile cu limite, tratează `tools/list_changed` între ture și separă request-urile serverului. Răspunde la ping. Numele oferite modelului sunt distincte și au maximum 64 de caractere. |
| Pluginurile afișau prompt templates în bibliotecă fără a le încărca în Pi | Template-urile activate ajung prin `--prompt-template`. Exemplul `hello-text-tools` include acum `/concise`; proba nativă verifică textul expandat în cererea reală Pi și executarea tool-ului `text_stats`. |
| Manifestul Pi era combinat cu autodiscovery, astfel încât excluderile puteau fi ignorate și module helper încărcate drept extensii | Un manifest explicit este sursa selecției. Sunt rezolvate căi locale, directoare, glob-uri și excluderi. Directoarele de extensii preferă index-ul; convențiile sunt folosite numai în absența manifestului. |
| Metadatele skill-urilor erau parsate superficial, iar numele unui skill din plugin putea fi dedus greșit din folder | Parser YAML pentru descrieri multiline; numele declarat ajunge atât în index, cât și în `skill_load`. Coliziunile între skills active sunt semnalate. |
| Un re-import cu nume nou, deja ocupat, putea suprascrie copia veche înainte de refuzul bazei de date | Coliziunea este verificată înainte de copiere; testul confirmă păstrarea copiei anterioare. |

Identitatea sesiunii include și configurația MCP plus definițiile tool-urilor,
astfel încât schimbarea lor reîncarcă runtime-ul pe același istoric Pi.
Dependențele directe `yaml@2.9.0` și `minimatch@10.2.6` sunt fixate în proiect;
instalarea a folosit cache-ul local, cu scripts dezactivate.

## Verificări executate

| Comandă | Rezultat |
| --- | --- |
| `pnpm typecheck` | Trecut |
| `pnpm build` | Trecut: main, preload și renderer |
| `pnpm test tests/extensions-library.test.ts tests/extensions-chat.test.ts tests/extensions-mcp.test.ts` | **51/51**: library 22, chat 7, MCP 22 |
| `node scripts/extensions-check.mjs` | **12/12** verificări native |
| `pnpm test` | **370 trec, 6 eșuează**, 376 în total |

Proba nativă a folosit aplicația Electron construită, runtime-ul Pi real,
un model fixture pe loopback și un server MCP stdio local. Datele au fost într-un
director temporar separat. Instanța proprietarului nu a fost repornită și nu au
fost folosite conversațiile, cheile sau modelele sale. Nu s-au făcut apeluri
plătite și nu s-au lansat CLI-uri de coding pentru lucru real.

Cele 12 verificări acoperă biblioteca din Settings, importul exemplelor,
conectarea și editarea MCP, activarea per chat, încărcarea și executarea unui
plugin, expandarea template-ului, eliminarea pluginului la dezactivare,
`skill_load` urmat de apelul MCP, oprirea serverului dezactivat, refuzul unei
copii modificate și persistența după restartul instanței de probă.

Capturi inspectate: [Settings / editare MCP](../test-results/extensions/04-mcp-edit-form.png)
și [rezultatul pluginului în chat](../test-results/extensions/08-plugin-tool-offered.png).
Alte capturi ale fluxului sunt în `test-results/extensions/`.

Testele MCP folosesc procese reale de fixture pentru timeout, anulare cu ID-ul
corect, paginare, protocol, schema prea mare și accesul separat al două chat-uri.
Acest ultim caz verifică autoritatea la apel, nu izolarea memoriei serverului.

## Cele șase teste încă roșii

Se reproduc aceleași nume de teste din raportul anterior; fișierele lor nu au
fost schimbate în această verificare:

- `tests/chat-tools.test.ts`: trei cazuri de cale HTML relativă/absolută/file URL;
  calea temporară `/var/...` și cea canonică `/private/var/...` ajung la verificarea
  de containment în forme diferite.
- `tests/chat-attachments.test.ts`: cazul cu ID-uri străine/căi/duplicate se
  oprește la validarea „Choose up to 8 valid attachments from this chat.”.
- `tests/renderer-interactions.test.tsx`: așteptarea vechiului `.status-pill`
  și apelurile globale `setAppOverlay`, diferite de interfața curentă.

Suita completă nu este declarată verde și aceste eșecuri nu au fost ascunse,
dezactivate sau convertite în teste care trec fără verificarea comportamentului.

## Limite care rămân

- Un server MCP este partajat de chat-urile care îl activează. Activarea este
  verificată separat la listare/apel; nu există un proces izolat per chat.
  Dezactivarea ultimei conversații oprește procesul. Disconnect din Settings
  oprește conexiunea curentă; un chat în care serverul rămâne activ îl poate
  reconecta la următoarea utilizare.
- Stop pentru un apel MCP deja trimis încheie așteptarea și trimite anularea.
  Nu poate garanta că serverul cooperează sau că efectele executate sunt anulate.
  La oprirea în timpul conectării, procesul este închis dacă nu mai este necesar
  unui alt chat activ.
- Activarea este decizia de încredere pentru MCP/plugins. Nu s-a introdus
  aprobare per apel. Codul pluginului rulează în copilul Pi, cu autoritatea și
  mediul acelui proces; nu este un sandbox.
- Clientul acoperă tools prin stdio. HTTP/SSE, OAuth, sampling, elicitation și
  consumul complet de resources/prompts MCP nu sunt implementate. Conținutul
  imagine/audio al rezultatelor nu este transmis ca media modelului.
- Importul acoperă subsetul documentat de pachete Pi locale. Nu instalează
  dependențe, nu interpretează orice manifest de subpachet și nu transformă
  extensiile TUI în interfață Electron. Skills-urile din plugin sunt directoare
  cu `SKILL.md`; o declarație explicită fără fișiere suportate este refuzată.
- Amprenta detectează schimbarea copiei la verificarea dintre ture; biblioteca
  nu este un mecanism de izolare împotriva unui proces local care poate modifica
  simultan aceleași fișiere. Importul nu garantează atomicitate la o eroare de
  disc în timpul copierii.
- Probele demonstrează transportul și execuția, nu calitatea unui model real.
  Fluxurile complete Visuals → HTML și Research → web nu au fost rulate aici.
  Vision, registrul de provideri și sidecarul rămân amânate explicit.

Comportamentul protocolului a fost verificat față de documentația oficială MCP:
[lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle),
[tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) și
[cancellation](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation).
Compatibilitatea pachetelor și flag-urile de lansare au fost verificate în
documentația și codul Pi 0.85.1 instalat în proiect.
