# Fluxul de cercetare continuă — arhitectură și contract de rulare

Proiectat 14 septembrie 2026 pe canvasul the sibling app al acestui chat
(workflowId scenario-b90744fd-497e-4b8a-850e-5305a18892a7).

## Noduri: input · acțiune · output

| Nod | Input | Acțiune | Output către |
| --- | --- | --- | --- |
| F1 GitHub Issues (feeder) | listă repo-uri din SURSE.md + data ultimei colectări din state.json | citește incremental issue-urile noi/actualizate, sortate după reacții; per element: rezumat, link, id, data publicării, data colectării | Coordonator analiză |
| F2 Changeloguri (feeder) | listă release-feeds din SURSE.md + baseline | citește release notes noi de la ultima rulare; extrage features livrate/retrase | Coordonator analiză |
| F3 Reddit (feeder) | subreddit-uri din SURSE.md + baseline | colectează thread-urile top noi prin canalul disponibil; dacă accesul lipsește raportează INDISPONIBIL, nu „fără noutăți" | Coordonator analiză |
| F4 YouTube (nod youtube) | cuvinte-cheie din SURSE.md | caută/citește videouri noi, arhivează subtitrări ca Markdown datat | Coordonator analiză |
| Coordonator analiză (coordinator) | materialul feederelor + FEATURE-INVENTORY.md + PROPOSALS-BACKLOG.md | brieful propriu: compară materialul nou cu funcționalitățile și backlogul; identifică probleme reale și oportunități; verifică dovezile, elimină duplicatele; poate delega analiza/verificarea propriilor workeri | Verificare |
| Verificare (verify) | propunerile candidate | verifică independent: fiecare dovadă are link datat funcțional; propunerea nu dublează inventarul; max 3–5 evidențiate | Raport (feedback la Coordonator pentru corecturi) |
| Raport (report) | propunerile verificate + starea surselor | scrie raportul Markdown datat în runs/<data>/, actualizează PROPOSALS-BACKLOG.md și state.json | omul (deschis din chat și din artefactele nodului) |

## Contract de rulare (manual = programat)

1. Fiecare feeder primește: misiunea, sursele lui din SURSE.md, ultimul
   baseline din state.json. Livrează adăugiri/schimbări sau explicit
   „nicio schimbare" / „sursă indisponibilă".
2. Coordonatorul analizează NUMAI material livrat de feederi; nu inventează.
3. Raportul rulării: docs/research-flow/runs/YYYY-MM-DD/report.md; materialele
   colectate: docs/research-flow/runs/YYYY-MM-DD/feeds/<F#>/.
4. state.json ține per sursă: lastSuccessAt, lastItemIds (dedup), lastError.
5. Buget: max 3 workeri cloud simultan (limita fluxului), 1 rundă de retry.
6. Ora rulării zilnice și fusul orar sunt configurabile de proprietar;
   nedecise încă (vezi CAPABILITATI-NECESARE.md pentru mecanismul de
   programare).
