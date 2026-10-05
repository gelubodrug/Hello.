# Feeduri de cercetare — surse exacte

Verificate la 14 septembrie 2026 (cod HTTP la momentul verificării).
Fiecare livrare de feeder trebuie să conțină, per element: conținut/rezumat,
link, identificator stabil, data publicării și data colectării.

## F1 — GitHub Issues: cereri și dureri la tool-urile comparabile · DISPONIBIL (200)

- https://api.github.com/repos/anthropics/claude-code/issues
- https://api.github.com/repos/openai/codex/issues
- https://api.github.com/repos/open-webui/open-webui/issues
- https://api.github.com/repos/lmstudio-ai/lmstudio-bug-tracker/issues

Utilitate: cele mai votate cereri de funcționalități din CLI-urile agentice și
app-urile locale de chat — exact segmentul Hello. Parametrul since= dă citire
incrementală; numărul de reacții dă prioritizare obiectivă.

## F2 — Changeloguri / release notes ale aplicațiilor similare · DISPONIBIL (200)

- https://api.github.com/repos/open-webui/open-webui/releases
- https://api.github.com/repos/janhq/jan/releases
- https://lmstudio.ai/blog (HTML; fără API — se citește pagina)
- https://www.anthropic.com/news (Claude Desktop/Code, best-effort)

Utilitate: ce livrează efectiv concurența și cum formulează valoarea; un
feature livrat de doi concurenți e presiune de paritate, unul retras e lecție.

## F3 — Reddit: cereri recurente și frustrări · PARȚIAL (403 la scripturi)

- https://old.reddit.com/r/LocalLLaMA/top/ (interval: zi)
- https://old.reddit.com/r/ClaudeAI/top/ (interval: zi)
- https://old.reddit.com/r/ChatGPTCoding/top/ (interval: săptămână)

Utilitate: vocea utilizatorului final, nemediată; aici apar soluțiile
improvizate care indică lipsuri de produs. Acces: JSON-ul refuză scripturile
(403 confirmat); calea autorizată este browserul Chrome al utilizatorului,
read-only. Până la un conector, feederul raportează sursa ca indisponibilă
pentru colectare automată — nu „fără noutăți".

## F4 — YouTube: demonstrații și comparații · DISPONIBIL (nod nativ the sibling app)

Cuvinte-cheie: "local LLM desktop app", "LM Studio vs Jan", "Claude Code
workflow", "AI coding agent desktop". Canale de urmărit când apar constant în
căutări. Utilitate: cum arată utilizarea reală și demo-urile concurenței;
capturile de subtitrări arată limbajul utilizatorilor. Nodul YouTube the sibling app
arhivează subtitrările ca Markdown datat.

## F5 — Feedback direct / Discord · INDISPONIBIL

Nu există acces autorizat la vreun Discord sau canal direct de feedback al
proiectului. Se raportează ca indisponibil; dacă proprietarul furnizează un
export sau un token, devine feeder standard.
