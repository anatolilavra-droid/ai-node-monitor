# POWER-NODE-01 — CLAUDE.md

## Project

POWER-NODE-01 is a local-first inference appliance.

It runs a local LLM engine on the user's hardware and exposes:
- a Fastify API with a stable contract;
- a vanilla JavaScript monitoring console with real SSE streaming;
- durable local history in SQLite.

The runtime must work without cloud inference, Docker, Kubernetes, Redis, or Postgres.

## Non-negotiables

1. The LLM engine binds to `127.0.0.1` only.
2. Fastify is the sole public API boundary.
3. All mutation routes require `Idempotency-Key`.
4. Every external input is validated with Zod before use.
5. SQLite writes that change more than one record use an explicit transaction.
6. Mutable entities use optimistic concurrency via a `version` field where concurrent updates are possible.
7. Prompts, completions, credentials, cookies, authorization headers, and raw model payloads must not be written to logs.
8. UI telemetry must originate from engine, gateway timing, or OS telemetry; never generate fake production values.
9. A browser disconnect must cancel or reconcile the upstream generation; it must not leave an invisible orphan generation.
10. A schema change requires an immutable SQL migration and migration test.
11. Public API and SSE event changes require a contract update and compatibility decision.
12. The system must fail closed on invalid configuration, malformed input, authentication failure, and unsafe model manifests.
13. The domain layer (`src/domain/`) depends only on the port interfaces it declares (`RunsRepositoryPort`, `EnginePort`); it must never import Fastify, better-sqlite3, or any other transport/storage-specific type. See `docs/ARCHITECTURE.md`.
14. A cancellation (`AbortError`) is never recorded as an engine failure; only a genuine engine error may trip the circuit breaker or count toward a retry budget.

## Language & Style

- TypeScript: strict mode, no `any`, explicit return types on exported functions.
- Prefer small modules with one responsibility over large multifile abstractions.
- Prefer explicit data flow over magic abstractions.
- Use prepared SQL statements; no hidden ORM behavior.
- Use typed result objects over thrown errors for expected domain failures.
- Use `AbortController` for cancellation propagation.
- Use monotonic clocks for durations; wall-clock timestamps for persisted events.
- Use bounded queues, buffers, caches, and timers.
- Keep public contracts stable; prefer additive API changes.

## Operational Notes

- Engine process is managed separately from Fastify; it may crash or restart independently.
- SQLite uses WAL mode, foreign keys, busy timeout, and explicit transactions.
- Logs are structured JSON through Fastify/Pino with redaction of sensitive fields.
- Frontend uses browser-native ES modules; no bundler unless an ADR explicitly requires one.
- Streaming uses Server-Sent Events; WebSocket is not used unless an ADR explicitly changes this.
- Deployment is a native OS service first; containers are optional packaging only.
- The internal layering (api/domain/db/engine/telemetry), the run state machine, and the engine's circuit-breaker/retry design are documented in `docs/ARCHITECTURE.md` - read it before restructuring any of those directories.

## Communication

- Use English for code, comments, and documentation.
- Use concise, direct language; avoid verbose explanations unless explicitly requested.
- Use Markdown for structured output; avoid long internal monologues.
- Report changed files, commands run, and verification results for every task.

## Principles

- Safety over cleverness: prefer explicit, boring code over clever abstractions.
- Observability over hope: if you cannot measure it, you cannot operate it.
- Reversibility over finality: design changes that can be rolled back safely.
- Small steps over big rewrites: ship narrow vertical slices with tests.
- Contracts over conventions: API, SSE, and database schemas are contracts, not suggestions.
- Bounded resources over unbounded growth: queues, buffers, caches, and timers must have explicit limits.
- Local-first simplicity over distributed complexity: do not add coordination layers unless there is a second node.

## Enforcement

- `npm run typecheck` must pass.
- `npm run lint` must pass.
- `npm run test` must pass.
- `npm run test:integration` must pass.
- `npm run build` must pass.
- See `docs/TESTING.md` for unit vs. integration test conventions (in-memory SQLite and port fakes for unit tests; real SQLite file and real engine process for integration tests) before adding a new test file.

For streaming changes:
- run the SSE integration suite;
- verify client disconnect;
- verify user cancellation;
- verify engine failure;
- verify final persisted run status.

For database changes:
- apply migrations to an empty database;
- apply migrations to a fixture with prior schema;
- test idempotency and rollback behavior.

For frontend changes:
- test initial load;
- test queued, running, completed, cancelled, failed, and reconnecting states;
- verify no simulated telemetry remains;
- verify rendering remains bounded during a high-token-rate stream.

For engine changes:
- verify `/health`;
- verify `/ready`;
- verify one real prompt;
- verify cancellation;
- verify metrics collection;
- record model and engine version in the benchmark artifact.

## Definition of Done

A change is complete when:

- TypeScript checks pass.
- Relevant lint and tests pass.
- New behavior is covered by a focused test.
- Public contracts are updated if changed.
- Database migrations exist for persisted schema changes.
- Logs preserve privacy requirements.
- Resource use is bounded.
- Cancellation and error paths are considered.
- Documentation changes are made when operations or deployment behavior changes.

## Task Format

For every task, produce:

1. A concise implementation summary (3–8 sentences).
2. A list of changed files and new files.
3. The exact commands you ran and their results.
4. Any risks, assumptions, or open questions.
5. Follow-up work that was intentionally not implemented.

Do not include long internal monologues.
Do not include verbose code explanations unless the task explicitly asks for them.
