# Implementation Plan: Blaizzy/nativ PR Monitoring for Hello.

**Feature**: blaizzy-nativ-hello-monitor
**Created**: 2026-10-07

## Technical Context

This is an automated monitoring workflow. No new source code in Hello. itself; the workflow is entirely in canvas nodes. Implementation tasks identified by the Analyst are applied to Hello. TypeScript/Electron source by the Implementor.

## Constitution Check

- Behaviour Ports Only: each task carries a Hello. file:line anchor. PASS
- Owner Decides: tasks requiring decisions are tagged DECIZIE OWNER. PASS
- Incremental and Verified: tsc --noEmit required per task. PASS
- Deduplication via tasks.md: Analyst reads tasks.md before proposing. PASS
- Simplicity First: each task is the smallest change that closes the gap. PASS

## Phase 0: Research

No NEEDS CLARIFICATION items. The Analyst already researched the Hello. codebase for each proposal; findings are at .od/passes/pass-2026-10-07-001/analyst-nativ-prs-proposals.md.

## Phase 1: Design

No data model changes required. No new API contracts. No infrastructure changes.

Quickstart validation: after implementing a task, run  in the Hello. root. Zero errors = task complete.

## Task Ordering

Priority 1 (actionable now, no decisions needed):
- P1a: Drop new Date() from pi-instructions.ts
- P1b: Narrow AppSettings fingerprint
- P5: Add getCatalog to CLI bridge
- P6: Symlink-safe atomic writes

Priority 2 (need owner decision):
- P7: Attachment secretPath policy (DECIZIE OWNER: .env refusal)
- P2: Document extraction layer (DECIZIE DEPEDINTA)
- P3: Attachment budget from model context (DECIZIE TOKENI)
- P4: MCP folder scoping (GAP SECURITATE)

Priority 3 (lower priority):
- P8: Compaction transcript divider
- P9: Work-pane tab drag reorder
