# Decizia de implementare — aplicație nouă

Decizie explicită a utilizatorului la 2026-09-09. Înlocuiește recomandarea
anterioară de shell nou peste serviciile existente. Implementarea aplicației
noi nu a început; mockupul este referința validată.

## Decizia

Construim **aplicația de la zero, pornind de la designul și comportamentele
aprobate în mockup**. Nu facem retrofit, nu adaptăm shell-ul vechi și nu
transplantăm automat serviciile, store-urile sau contractele lui.

Motivul ales de utilizator: preferăm problemele unei implementări noi și clare
în locul complexității unei tranziții între două organizări incompatibile.
Acest lucru nu garantează mai puține buguri; elimină obligația de a susține
vechiul layout și compatibilitatea lui internă în noua implementare.

Codul și datele aplicației vechi rămân separate și neatinse. Decizia nu
autorizează ștergerea lor, migrarea automată a datelor sau suprascrierea
instalării existente. Locul și pachetul aplicației noi se stabilesc la pornirea
implementării; deocamdată fixăm referința completă în `design/`.

`LOOK.md` definește aspectul; mockupul executabil definește interacțiunile de
testat. Logica demonstrativă nu devine automat logică de producție.

## Ce luăm din acest studiu

- Aspectul exact din `LOOK.md`: fonturi, spațiere, pills, meniuri, materiale,
  contururi și umbre. Nu reluăm interpretarea screenshoturilor.
- Mockupul complet din `mockup/` ca referință executabilă și set de scenarii
  pentru verificare. Include componente importate de specimen din proiectul
  actual pentru a putea rula independent; aceasta nu este o decizie de a le
  importa în aplicația nouă împreună cu dependențele și stările lor.
- Modelul chat-centric: numai chaturi în sidebar; Runbook, Tasks și actorii
  aparțin chatului; Chat și Tools au controale de redeschidere în header.
- Constrângerea deliberată: un singur instrument vizibil, fără suprapunere
  peste browser sau consolă. La lățimi mici alegem pe rând Chat sau Tools.
- Testele și riscurile descoperite, ca cerințe pentru noua implementare,
  nu ca obligație de a conserva mecanismele vechi.

## Limite clare în implementarea nouă

O singură autoritate pentru layout și tranziții. Separăm de la început
prezentarea, datele conversației și viața sesiunilor. Ascunderea unui panou,
închiderea unui tab, oprirea unui proces și ștergerea datelor sunt operații
distincte. Alegem contractele necesare noului produs, fără adaptoare de
compatibilitate doar ca să susținem vechea organizare.

Runbook și Tasks rămân documente accesibile, alăturate și opțional goale.
Nu blocăm lansarea unui worker și nu injectăm automat sarcini în prompt.
Omul poate cere explicit workerului să le citească și să le execute.

## Riscurile care trebuie demonstrate devreme

1. **Browserul real.** Dacă folosim o suprafață nativă, verificăm devreme
   compoziția, focusul, bounds și vizibilitatea. Headerul și acțiunile Open
   rămân în afara viewportului. Permisiunile sunt per tab, inițial Off;
   Read only este galben, controlul complet roșu și necesită alegere explicită.
2. **Terminalul și workerii.** Ascunderea UI nu trebuie să blocheze outputul
   sau execuția. Verificăm continuarea în fundal, recuperarea outputului,
   focusul, folderul chatului și oprirea explicită a sesiunii.
3. **Date și stare.** Verificăm drafturi, scroll, selecții și persistență
   pentru chat și notebook-uri. Nu folosim baza de date veche în teste și
   nu tratăm datele locale ale mockupului ca stocare de producție.

Mockupul validează aspectul și interacțiunea. Nu validează aceste trei aspecte
native doar pentru că arată corect în browser.

## Ordinea propusă

1. Înghețăm referința vizuală și codul ei complet în `design/`.
2. Pornim proiectul nou, izolat de runtime și datele aplicației vechi: shell,
   sidebar numai cu chaturi, header, pills și controller de prezentare.
3. Implementăm chatul, stocarea proprie și editorul comun Runbook/Tasks, cu
   aceleași interacțiuni ca în specimen și teste de păstrare a datelor.
4. Integrăm un browser real și verificăm devreme hide/open, redimensionare,
   permisiuni și lipsa suprapunerilor înainte de a extinde setul de instrumente.
5. Adăugăm un terminal, apoi lansarea workerilor CLI cu lista de alegere,
   folderul chatului și ciclul propriu de viață al sesiunilor.
6. Validăm schimbarea chatului, restartul, recuperarea sesiunilor și erorile.
   Orice import din aplicația veche este un proiect separat, numai la cerere.

Compromisul rămâne intenționat: un singur instrument vizibil în Tools. Nu
reintroducem un manager arbitrar de ferestre ca să satisfacem layoutul vechi.
