# Runbook: restarting the engine

What "restart the engine" means, and what happens to in-flight and future
generations, depends on `ENGINE_MODE`.

## `ENGINE_MODE=llama-cpp` (production)

The engine is `llama-cpp.service`, supervised independently of
`power-node.service` (CLAUDE.md non-negotiable: the engine process is
managed separately from Fastify). Restarting it does **not** require
restarting `power-node.service` at all.

```bash
sudo systemctl restart llama-cpp.service
curl -s http://127.0.0.1:8090/health   # wait for {"status":"ok"}
```

**What happens to requests in flight at the moment of restart:**

1. Any `POST /generate` currently streaming loses its connection to the
   engine. `GenerationService` observes the failed request, and the run
   is persisted as `failed` with the partial `output`/`tokenCount` it had
   produced so far - never left stuck `running` (CLAUDE.md non-negotiable
   #9, tested in `tests/integration/generate-sse.test.ts`).
2. Repeated failures like this trip `ResilientEngineClient`'s circuit
   breaker (`docs/ARCHITECTURE.md`), which briefly rejects new generation
   attempts closed (`ENGINE_NOT_READY`) instead of hammering a
   restarting engine.
3. `EngineManager`'s background health poll (every
   `ENGINE_HEALTH_POLL_INTERVAL_MS`, default 5s) notices llama.cpp is
   back once `/health` returns `200` again, and `GET /ready` flips back
   to `engine: true` automatically. **No action needed on the
   power-node side** - do not restart `power-node.service` for this.
4. In the browser console, an in-progress generation's SSE connection
   will end; `app.js`'s reconnect logic (`public/app.js`) polls the run's
   final status and shows it as `failed`. The user re-submits the prompt.

**Verify recovery:**

```bash
curl -s http://127.0.0.1:8080/internal/health
```

Check `engine.ready: true` and `engine.circuitState: "closed"` (not
`"open"` or `"half-open"`). If it's stuck `open`, llama.cpp likely isn't
actually healthy yet - check `journalctl -u llama-cpp -f`.

## `ENGINE_MODE=mock` (dev/test only)

The mock engine is a child process `power-node`'s own process spawned
(`EngineManager`, `src/engine/mockEngineServer.ts`). It restarts itself
automatically on crash, with a bounded retry count in a rolling window
(`ENGINE_MAX_RESTARTS` / `ENGINE_RESTART_WINDOW_MS`) - there is normally
nothing to do manually. If you do need to force it:

```bash
# there's no separate unit to restart - restart the whole dev process
npm run dev
```

If the mock engine has exceeded its restart budget (logged as "engine
exceeded max restarts in the configured window; leaving it stopped"),
`/ready` will report `engine: false` until the whole `power-node`
process is restarted - this mode has no independent supervision to fall
back on, which is exactly why production uses `llama-cpp` mode instead.

## When to restart `power-node.service` itself

Only for an application-code change (a deploy) or if `power-node.service`
itself is unhealthy (`systemctl status power-node.service` shows it
crashed/degraded) - never merely to recover the engine in `llama-cpp`
mode, per above.

```bash
sudo systemctl restart power-node.service
curl -s http://127.0.0.1:8080/ready
```

This does not touch `data/power-node-01.sqlite` - no data loss from a
restart alone, restore only ever needed per
[`backup-restore.md`](backup-restore.md).
