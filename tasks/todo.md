# Research: most-wanted features for Hello.-type apps (2026-09-09)

Goal: find what users of comparable apps love most, ask for most, and expect as
table stakes; map to Hello. and the existing roadmap. Deliverable: new doc in
`docs/feature-research/` (Romanian), complementing INDEPENDENT-NEXT-FEATURES.

- [x] Read README, AGENTS, both existing research docs, mini-roadmap
- [x] Parallel web research by category (9 agents)
  - [x] Local-LLM desktop chat apps (LM Studio, Jan, Msty, AnythingLLM, Cherry, Chatbox, Open WebUI, LibreChat, Ollama app)
  - [x] CLI-agent orchestrators / GUIs (Conductor, Vibe Kanban, Crystal, Claude Squad, opcode, Emdash, Superset, Claude Code desktop, Codex app)
  - [x] Agentic IDEs & terminals (Cursor, Windsurf, Warp, Zed, Copilot agent mode, Kiro)
  - [x] Coding-agent CLIs (Claude Code, Codex CLI, Gemini CLI, Aider, OpenCode, Pi) — loved features + top-voted requests
  - [x] Agentic browsers (Comet, Dia, Atlas, Opera Neon, Claude in Chrome, Browser Use)
  - [x] Desktop AI assistants (Claude Desktop/Cowork, ChatGPT desktop, Raycast AI, Copilot, Gemini)
  - [x] Notes/knowledge + AI (Obsidian plugins, Notion AI, Craft) — Runbook/Tasks angle
  - [x] Surveys & quantitative data (SO 2026, JetBrains, Pragmatic Engineer, Octoverse, reviews)
  - [x] Personal agent harnesses deep-dive with vote counts (Hermes, DeepSeek Harness, OpenClaw, Agent Zero, Manus)
- [x] Verify key URLs/dates for the final citations (47 GitHub +1 counts, 27 HN scores re-checked via API; all URLs status-checked)
- [x] Synthesize: loved / wanted / expected matrix, cross-category convergence, map to Hello. + roadmap deltas
- [x] Write `docs/feature-research/MOST-WANTED-FEATURES-2026-09-09.md`
- [x] Review section (what was verified, limits)

## Review (2026-09-09)

- Deliverable: `docs/feature-research/MOST-WANTED-FEATURES-2026-09-09.md` (Romanian), 9 categories,
  ~400 sources opened by subagents; 47 GitHub +1 counts and 27 HN scores re-verified by the main
  session via API (all matched; a few HN dates corrected to the verified post date).
- Roadmap not modified; the doc proposes deltas (section "Ce s-a schimbat").
- Pointer lines added to README.md, INDEPENDENT-NEXT-FEATURES-2026-09-09.md and MINI-ROADMAP.md.
- Known gaps: Reddit blocked in every path; SO 2026 unpublished; PE 2026 paywalled; some products
  uncovered (Warp/Kiro/Jules at orchestrators; Tana/Capacities/Craft at notes; Highlight/Poe/Notion AI).

## Follow-up (2026-09-09, later)

- [x] Read Reddit app subreddits via the owner's Chrome (Claude in Chrome extension, old.reddit, read-only, 45 pages); 3 key scores re-verified via Reddit JSON API
- [x] Add "Ce spune Reddit" section + limits update to MOST-WANTED-FEATURES-2026-09-09.md
- [x] Archive roadmap r1 to docs/archive/MINI-ROADMAP-2026-09-09-r1.md
- [x] Rewrite docs/MINI-ROADMAP.md as revision 2 (H12–H16 added; order H03 → H02 → H12 → H13 → H14 → H01 → H15 → H04; evidence lines; negatives with evidence)
- [ ] Not visited on Reddit (budget): r/openclaw, r/DeepSeek, r/ChatGPT (Pulse/memory); r/LMStudio is banned, r/ollama search empty

## Follow-up 2 (2026-09-09 21:00)

- [x] Verify internet research vs the sibling app (`sibling-app`, f24c5fcf v0.1.61) by direct code/doc reading (no agents, no app run, no runtime data)
- [x] Write `docs/feature-research/INTERNET-RESEARCH-2026-09-09-r1.md` (18 themes; the sibling app ahead 11 / equal 6 / behind 1; shared gaps; reuse candidates; risks)
