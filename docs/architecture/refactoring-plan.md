# Refactoring plan

The repository will be restructured incrementally. The priority is to reduce cognitive load without combining large file moves with behavior changes.

## Phase 0: governance baseline

Establish a single validation command, CI, editor/line-ending rules, contribution guidance, architecture boundaries, ownership, and a PR checklist. No production behavior changes and no source relocation.

Exit criteria:

- `npm run check` is the local and CI validation contract;
- structural rules are documented for humans and coding agents;
- future PRs can identify compatibility impact explicitly.

## Phase 1: cleanup inventory

Create a repository inventory that classifies file families as:

- **stable**: required by the supported Session Relay;
- **experimental**: Project Agent and multi-agent collaboration;
- **shared candidate**: potentially reusable but requiring ownership review;
- **removal candidate**: apparently orphaned, duplicated, or superseded.

For every removal candidate, record imports, script/document references, persisted data dependencies, and test coverage. Classification does not authorize deletion.

Phase 1 inventory: [`repository-inventory.md`](repository-inventory.md). It
accounts for all tracked production modules and operational scripts, records the
actual local dependency graph, identifies shared ownership decisions, and gives
evidence requirements for every removal candidate.

Expected family mapping:

| Current family | Target area |
| --- | --- |
| `codex-*` | `src/codex/` |
| `session-relay-*`, command orchestration | `src/relay/` |
| `feishu-*`, cards, documents, media | `src/feishu/` |
| bindings, queues, settings, ledgers, outboxes, audit | `src/persistence/` |
| process runners and platform integration | `src/runtime/` |
| `agent-*`, `collaboration-*`, `team-*`, `project-*`, `knowledge-*` | `src/experimental/collaboration/` |

## Phase 2: mechanical directory migration

Move stable and shared production modules under `src/`, their tests under
`tests/`, examples under `config/`, and development tooling under `scripts/`.
Retained experimental production modules stay in their current locations until
Phase 3 establishes the experimental boundary. This phase should change paths
and imports only.

Operational PowerShell entry points are part of the installation contract. If implementation scripts move, keep backward-compatible root wrappers until a versioned migration removes them.

Exit criteria:

- the diff is dominated by renames and import-path changes;
- all existing tests pass without altered assertions;
- release, install, update, and doctor entry points remain valid;
- no persisted schema or command behavior changes.

## Phase 3: stable and experimental isolation

Move Project Agent and collaboration code into the experimental boundary. Remove accidental startup dependencies from the stable Session Relay and document explicit extension points.

Exit criteria:

- stable startup does not require experimental modules;
- experimental tests remain runnable;
- README/release contracts match the physical structure.

## Phase 4: Bridge decomposition

Reduce the large Bridge entry point into a thin composition root plus cohesive modules for inbound handling, command routing, Session orchestration, progress rendering, and outbound delivery.

Extract behavior only after characterization or integration tests protect the current flow. Avoid line-count-driven splitting; each module must have a clear owner and dependency direction.

## Phase 5: Codex Session decomposition

Clarify the responsibilities of Session controller, observer, runner, store, and Desktop catalog. Introduce narrow interfaces where Relay currently depends on Codex implementation details.

Exit criteria:

- Session state transitions are testable without a real Desktop process;
- observer and controller responsibilities no longer overlap implicitly;
- retry/reconnect semantics remain unchanged or are explicitly versioned.

## Phase 6: optional type migration

Evaluate TypeScript or checked JSDoc only after boundaries and file topology stabilize. A type-system migration must be a separate decision and must not be combined with directory moves or behavioral refactoring.

## Rules for every phase

1. One architectural intention per PR.
2. Mechanical and semantic diffs are separate.
3. Persisted formats and external commands are treated as APIs.
4. New behavior has tests; moved behavior keeps existing tests unchanged.
5. No new generic `utils`, `helpers`, `common`, or `misc` dumping grounds.
6. No secrets, user identifiers, runtime state, or absolute personal paths enter the repository.
7. `npm run check` passes before review; operational changes include the relevant Windows validation.
