# Feature Specification: Blaizzy/nativ PR Monitoring for Hello.

**Feature Branch**: blaizzy-nativ-hello-monitor
**Created**: 2026-10-07
**Status**: Active

## User Scenarios and Testing

### User Story 1 - Automated PR Monitoring (Priority: P1)
As a developer working on Hello., I want new and merged Blaizzy/nativ PRs automatically analyzed for implementation opportunities so I do not have to manually track another repo.

**Why this priority**: Core purpose of the workflow. Without this, nothing else runs.

**Acceptance Scenarios**:
1. Given a new PR is merged in Blaizzy/nativ, When the workflow runs, Then the PR appears in the Feeder report and is analyzed by the Analyst.
2. Given a PR was already seen in a previous pass, When the workflow runs again, Then the Feeder does not re-report it.

### User Story 2 - Prioritized Proposals with Hello. Anchors (Priority: P2)
As a developer, I want each proposal to point at the exact Hello. source file and line where the gap is so I can immediately assess feasibility.

**Acceptance Scenarios**:
1. Given the Analyst runs, Then each proposal includes at least one file:line reference in the Hello. codebase.
2. Given a PR has no transferable behaviour, Then the Analyst declines it with a brief reason.

### User Story 3 - Automatic Implementation of Decided Tasks (Priority: P3)
As a developer, I want tasks that require no owner decision to be automatically implemented so the workflow delivers real code changes, not just proposals.

**Acceptance Scenarios**:
1. Given a task is marked actionable (no pending decisions), When the Implementor runs, Then it implements the task and tsc --noEmit passes.
2. Given a task requires an owner decision, Then it is added to tasks.md with a DECIZIE OWNER marker and skipped by the Implementor.

## Functional Requirements

- FR1: Feeder reads open and recently merged PRs from Blaizzy/nativ via gh CLI on each pass.
- FR2: Feeder persists a baseline of seen PR numbers so subsequent passes report only new PRs.
- FR3: Analyst maps each new PR onto Hello. source code, produces proposals with file:line anchors, deduplicates against tasks.md.
- FR4: Orchestrator appends actionable proposals to tasks.md without duplicating existing rows.
- FR5: Implementor implements pending tasks in priority order, verifies with tsc --noEmit, marks done.
- FR6: Tasks requiring owner decisions are appended to tasks.md with a DECIZIE OWNER prefix and are not auto-implemented.

## Success Criteria

- Each pass takes less than 30 minutes end-to-end.
- Feeder never re-proposes a PR that was already seen in a previous pass.
- Every implemented task results in a passing tsc --noEmit.
- Proposals that need decisions are clearly distinguished from actionable ones.

## Assumptions

- Blaizzy/nativ is publicly accessible via gh CLI without authentication beyond what is already configured.
- The Hello. codebase is TypeScript/Electron; behaviour (not code) is what is ported.
- Owner reviews pass summaries and acts on DECIZIE OWNER items manually.
