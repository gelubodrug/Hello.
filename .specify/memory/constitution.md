<!-- Version 1.0.0 | Ratified 2026-10-07 -->

# Blaizzy/nativ to Hello. Monitor Constitution

## Core Principles

### I. Behaviour Ports Only
No Swift code is copied into Hello. TypeScript source. Every proposal carries a Hello. file:line anchor.

### II. Owner Decides, Automation Proposes
The pipeline proposes and implements only changes free of owner decisions. Proposals requiring decisions are marked and wait for an explicit human ruling.

### III. Incremental and Verified
Each implemented task MUST pass tsc before being marked done. No app builds unless explicitly called for.

### IV. Deduplication via tasks.md
tasks.md is the canonical deduplication record across passes. The Analyst reads it before proposing; the Orchestrator does not append a task already covered.

### V. Simplicity First
Each proposed change must be as small as possible. Effort is rated honestly. The Implementor does not gold-plate.

## Scope

Automated monitoring workflow for Blaizzy/nativ PRs and their applicability to Hello. Electron app. Out of scope: audio surfaces, local model file classification, orchestrator infrastructure, nativ website PRs.

## Workflow

Each pass: Feeder reads new PRs and updates baseline. Analyst maps onto Hello. source. Orchestrator appends actionable proposals to tasks.md. Implementor implements pending tasks, verifies with tsc, marks done.

## Governance

Amendments require a written rationale in the spec journal. The owner reviews pass summaries and may override any proposal or implementation decision.

**Version**: 1.0.0 | **Ratified**: 2026-10-07 | **Last Amended**: 2026-10-07
