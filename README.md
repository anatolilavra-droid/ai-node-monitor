# POWER-NODE-01

[![CI](https://github.com/anatolilavra-droid/ai-node-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/anatolilavra-droid/ai-node-monitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A local-first inference appliance: a Fastify API in front of a local LLM
engine process, an SSE-streamed vanilla-JS monitoring console, and durable
run history in SQLite. No cloud inference, Docker, Kubernetes, Redis, or
Postgres required.

See [`CLAUDE.md`](CLAUDE.md) for the project's non-negotiables and
conventions, and [`docs/CONTRACT.md`](docs/CONTRACT.md) for the HTTP/SSE
contract.

**Deploying to production?** See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)
(systemd, a real llama.cpp engine, backups, reverse proxy),
[`docs/SECURITY.md`](docs/SECURITY.md) (checklist and threat model),
[`docs/MONITORING.md`](docs/MONITORING.md), and the
[`docs/RUNBOOKS/`](docs/RUNBOOKS/) for backup/restore, engine restarts,
and model updates.

## Screenshots

The monitoring console is plain, browser-native JS — no framework, no
bundler. Every value shown (status, token count, duration) comes straight
off the run record returned by the API, not a client-side simulation.

| Idle | Streaming | Completed |
|---|---|---|
| ![Idle state](docs/screenshots/console-idle.png) | ![Streaming state](docs/screenshots/console-streaming.png) | ![Completed state](docs/screenshots/console-completed.png) |

## Architecture

Three independent processes, each with one job: the browser talks only to
Fastify, Fastify talks to SQLite and to the engine, and the engine never
talks to anything but Fastify. The engine binds `127.0.0.1` only and can
crash and restart without taking Fastify down with it.

```mermaid
flowchart LR
    UI["Monitoring console<br/>(vanilla JS, SSE client)"]

    subgraph fastify["Fastify process — 127.0.0.1:8080"]
        API["Routes<br/>/generate /runs /health /ready"]
        GS["GenerationService<br/>(AbortController per run)"]
        EM["EngineManager<br/>(spawn / health-check / restart)"]
        DB[("SQLite — WAL<br/>runs, idempotency_keys")]
    end

    subgraph engineproc["Engine process — 127.0.0.1:ENGINE_PORT"]
        ENGINE["Inference engine<br/>/health /ready /completion"]
    end

    UI <-- "HTTP + text/event-stream" --> API
    API --> GS
    GS <--> DB
    GS -- "POST /completion (NDJSON, AbortSignal)" --> ENGINE
    EM -- "spawn, GET /health, GET /ready" --> ENGINE
    API --> EM
```

### Generation lifecycle (happy path)

Every state shown in the console — `queued`, `running`, `completed` — is a
row transition in SQLite guarded by the `version` column (optimistic
concurrency), not just an in-memory flag.

```mermaid
sequenceDiagram
    participant B as Browser
    participant F as Fastify POST /generate
    participant G as GenerationService
    participant E as Engine (127.0.0.1)
    participant D as SQLite

    B->>F: POST /generate (Idempotency-Key, prompt)
    F->>D: INSERT run (status=queued)
    F-->>B: SSE run.created
    F->>G: run(run, emit)
    G->>D: UPDATE status=running (version+1)
    G-->>B: SSE run.status
    G->>E: POST /completion (AbortSignal)
    loop each generated token
        E-->>G: NDJSON {token, index}
        G-->>B: SSE token
    end
    E-->>G: {done: true}
    G->>D: UPDATE status=completed, output, tokenCount, durationMs
    G-->>B: SSE run.completed
```

### Cancellation and disconnect reconciliation

A cancel button and a dropped connection are the same event from
`GenerationService`'s point of view: whichever happens first aborts the
one `AbortController` for that run, and the terminal status is always
persisted before the SSE stream closes — a run can never end up stuck
`running` with nothing left watching it.

```mermaid
sequenceDiagram
    participant B as Browser
    participant F as Fastify POST /generate
    participant G as GenerationService
    participant E as Engine
    participant D as SQLite
    participant X as POST /runs/:id/cancel

    par Explicit cancel
        X->>G: cancel(runId)
    and Browser disconnects mid-stream
        B--xF: connection closed (reply.raw "close")
        F->>G: cancel(runId)
    end
    G->>E: abort() the in-flight completion request
    E--xG: request aborted
    G->>D: UPDATE status=cancelled, partial output + tokenCount
    G-->>B: SSE run.cancelled (if the browser is still connected)
```

## Setup

```bash
npm install
cp .env.example .env
npm run migrate
npm run dev      # tsx watch, runs src/server.ts directly
# or
npm run build && npm start
```

The server listens on `127.0.0.1:8080` by default and serves the
monitoring console at `/`. It spawns its own local inference engine
process bound to `127.0.0.1` (see "Engine" below).

## Engine

`ENGINE_MODE` selects which engine `power-node` talks to:

- **`mock`** (default) — `src/engine/mockEngineServer.ts`, a
  deterministic, dependency-free dev/test engine: it produces real
  generated tokens with real measured timing over a small NDJSON HTTP
  contract, but does no actual deep-learning inference.
  `src/engine/engineManager.ts` spawns it as an independent OS process
  and restarts it with a bounded retry count if it crashes.
  **Deprecated for anything but local development/CI** — see the
  `@deprecated` notes in `src/engine/engineClient.ts`.
- **`llama-cpp`** (production) — connects to an already-running
  [llama.cpp](https://github.com/ggml-org/llama.cpp) server over its
  OpenAI-compatible `POST /v1/chat/completions` (SSE, `stream: true`).
  `power-node` never spawns or kills this process — it's supervised
  independently (its own systemd unit,
  `deploy/systemd/llama-cpp.service.example`) and `EngineManager`
  health-polls `GET /health` on an interval instead. See
  [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

Both modes implement the same internal `EnginePort`/`RawEngineClient`
abstractions (`src/domain/ports.ts`, `src/engine/rawEngineClient.ts`), so
`GenerationService`'s circuit-breaker/retry/cancellation logic
(`src/engine/resilientEngineClient.ts`) is identical either way — see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## API

- `GET /health` — liveness.
- `GET /ready` — readiness (DB reachable and engine ready).
- `POST /generate` — `Idempotency-Key` header required. Body:
  `{ prompt, model?, maxTokens? }`. Response is `text/event-stream`
  (`run.created`, `run.status`, `token`, `run.completed`, `run.cancelled`,
  `run.failed`).
- `GET /runs` — paginated run history (`?limit=&offset=`).
- `GET /runs/:id` — a single run.
- `POST /runs/:id/cancel` — `Idempotency-Key` header required; cancels an
  in-flight generation.

Full request/response and SSE event shapes: [`docs/CONTRACT.md`](docs/CONTRACT.md).

Additionally, `GET /internal/health` returns deeper operational
diagnostics (DB latency, engine circuit-breaker state, disk space,
metrics) — this is *not* part of the stable contract above (its shape may
grow), see [`docs/MONITORING.md`](docs/MONITORING.md). If
`API_AUTH_ENABLED=true`, it stays open (like `/health`/`/ready`) for
infra health checks.

## Testing

```bash
npm run typecheck
npm run lint
npm test               # unit tests
npm run test:integration  # migrations + SSE lifecycle (create, stream, cancel, disconnect)
```

Integration tests run against a real temporary SQLite database built from
the actual migrations in `db/migrations/`, and against the real mock
engine process (not a stub) so cancellation and disconnect behavior is
exercised end to end.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the same gate
on every push/PR to `main`: `typecheck` → `lint` → `migrate` → `test` →
`test:integration` → `build`, then uploads `dist/`, `public/`, and the
migrations as a build artifact. There is no live deploy target yet
(non-negotiable: "deployment is a native OS service first") — the
artifact is what you'd copy onto a host and run with `node dist/server.js`
behind a process supervisor (systemd, pm2, etc.).

## Known limitations

- `ENGINE_MODE=mock` is a deterministic dev/test stand-in, not a real
  model runtime — production deployments must use `ENGINE_MODE=llama-cpp`
  (see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)).
- Idempotent replay of `POST /generate` returns the run's current stored
  state as a single snapshot; it does not re-attach a second connection to
  a still-streaming generation.
- Authentication is optional and off by default (`API_AUTH_ENABLED`), and
  is a single shared bearer token with no per-user isolation — this
  remains a single-tenant appliance. See [`docs/SECURITY.md`](docs/SECURITY.md)
  for exactly what it does and does not cover.
- No model manifest/signature validation — operators verify a model's
  checksum manually per [`docs/RUNBOOKS/model-update.md`](docs/RUNBOOKS/model-update.md)
  (non-negotiable #12 covers this once built-in validation exists).
- Engine port is fixed (`ENGINE_START_PORT`), not scanned for availability.
- Backups (`deploy/scripts/backup.sh`) are not encrypted at rest.

## Project structure

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how these layers
depend on each other and why, and [`docs/TESTING.md`](docs/TESTING.md)
for how the two test suites differ.

```
.github/workflows/   CI pipeline (typecheck, lint, test, build)
deploy/              systemd units, backup script, logrotate config
db/migrations/       immutable SQL schema migrations
docs/                contract, architecture, testing, deployment, security,
                     monitoring, runbooks, screenshots
src/config/          env loading and validation (Zod)
src/domain/          business logic: GenerationService, run state machine
                     (status.ts), structured errors, port interfaces
src/db/              SQLite: RunsRepository (implements RunsRepositoryPort),
                     connection + migration runner
src/engine/          engine process manager, resilient client
                     (circuit breaker + retry, implements EnginePort),
                     mock (dev/test) and llama.cpp (production) raw clients
src/telemetry/       event bus + metrics collector
src/schemas/         Zod request schemas
src/api/             Fastify route handlers (HTTP/SSE only, no business logic)
public/              vanilla-JS monitoring console (no bundler)
tests/unit/          fast (<100ms), in-memory SQLite + port fakes, no I/O
tests/integration/   real SQLite file + real engine process
```

## Contributors

- Idea & project owner: [@anatolilavra-droid](https://github.com/anatolilavra-droid)
- Implementation: [Claude Code](https://claude.ai/code)

## License

[MIT](LICENSE)
