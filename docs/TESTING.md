# Testing guide

Two suites, run separately (`npm test` vs. `npm run test:integration`),
because they trade off speed against fidelity differently.

## Unit tests (`tests/unit/`, `npm test`)

Fast (each test should run in well under 100ms) and fully isolated: no
real SQLite file, no real engine process, no network. They mirror `src/`
one-to-one:

```
tests/unit/config/       loadConfig - valid/invalid/coerced env values
tests/unit/domain/       status transitions, error classes, and
                         GenerationService itself against fakes
tests/unit/db/           RunsRepository against an in-memory (":memory:")
                         SQLite database
tests/unit/engine/       CircuitBreaker and RetryPolicy as pure state
                         machines, no HTTP involved
tests/unit/telemetry/    EventBus and MetricsCollector
```

### Patterns used throughout

**In-memory SQLite for repository tests.** `new Database(':memory:')` +
applying `db/migrations/0001_init.sql` directly gives a real SQLite
engine with zero filesystem I/O - fast, and it exercises the actual SQL
(including the `CHECK` constraints and unique index), not a mock of it.

```ts
db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(readFileSync('db/migrations/0001_init.sql', 'utf8'));
repo = new RunsRepository(db);
```

**Fakes for domain unit tests, not mocking libraries.** `GenerationService`
depends on `RunsRepositoryPort` and `EnginePort` (see `domain/ports.ts`),
so a unit test can hand it a small in-memory class that implements the
same interface (`FakeRunsRepository`, `ScriptedEngine` in
`tests/unit/domain/generation-service.test.ts`) instead of a real database
and a real HTTP server. Prefer this over a mocking library when the fake
is this cheap to write - it reads as executable documentation of the
port's contract.

**Injectable time instead of fake timers.** `CircuitBreaker` and
`RetryPolicy` both accept their time source as a constructor/option
argument (`now: () => number` and `sleep: (ms) => Promise<void>`
respectively) rather than calling `Date.now()`/`setTimeout` directly. A
test passes a controllable clock or an instant no-op sleep:

```ts
const clock = fakeClock(); // { now, advance }
const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: clock.now });
breaker.recordFailure();
clock.advance(1000);
expect(breaker.getState()).toBe('half-open');
```

This is simpler and less brittle than `vi.useFakeTimers()` for logic that
only ever reads the clock (it never sets a real timer), and it keeps
retry-backoff tests from actually sleeping.

**Exhaustive tables for state machines.** `status-transitions.test.ts`
doesn't just test the "happy" transitions; it iterates every
`(status, event)` pair against a hand-written expectation table so an
accidentally-added illegal transition fails a test instead of shipping.
Do this for any function whose input space is small and enumerable.

## Integration tests (`tests/integration/`, `npm run test:integration`)

Real SQLite (a temp file per test run, built from the actual migrations)
and a real engine process (the same `mockEngineServer.ts` production
spawns), talking over real HTTP to a `FastifyInstance` listening on an
OS-assigned port. Nothing here is mocked - these tests exist specifically
to catch what unit tests with fakes cannot: a real client disconnect
closing a real socket, a real process crash, a real migration applied to
a real file.

`tests/integration/testHarness.ts`'s `startTestServer()` is the shared
setup: it builds an isolated temp directory + SQLite file, a real
`EngineManager` on a randomized port (so parallel test files don't
collide), and calls `buildApp(...)` directly rather than going through
`AppState` - integration tests want a bare `FastifyInstance` they control
the lifecycle of.

When adding an integration test, cover the specific thing a unit test
cannot: an actual dropped connection (`AbortController` on the client's
`fetch`), an actual concurrent request racing a cancel, or an actual
migration applied to a fixture database that already has a prior schema.

## What NOT to unit-test

- Fastify route wiring itself (covered by integration tests hitting real
  HTTP endpoints - a unit test invoking a route handler function directly
  would need to fake `FastifyRequest`/`FastifyReply` in detail for little
  benefit).
- `EngineManager`'s process spawning (covered by integration tests; a unit
  test would need to fake `child_process.fork`, which mostly tests the
  fake).
- Anything already exercised end-to-end by an integration test where a
  unit test would just re-mock the same collaborators.

## Coverage

There is currently no coverage-reporting tool wired into `npm test`
(adding one, e.g. `@vitest/coverage-v8`, is a new dependency and is
intentionally left as a follow-up rather than added silently). Treat the
per-module test lists above as the coverage bar instead: every branch in
`domain/status.ts`, `domain/errors.ts`, `engine/circuitBreaker.ts`, and
`engine/retryPolicy.ts` should have an explicit test, since they are pure
and cheap to cover completely.

## Running a single file or test

```bash
npx vitest run tests/unit/engine/circuit-breaker.test.ts
npx vitest run tests/unit/engine/circuit-breaker.test.ts -t "half-open"
```
