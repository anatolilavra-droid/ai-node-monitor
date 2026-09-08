# Monitoring

No metrics exporter, dashboard, or alerting stack is bundled (this
appliance intentionally stays local-first with no new dependencies or
cloud services - see CLAUDE.md's principles). This document is instead
about which existing signals to watch and simple, dependency-free ways to
watch them.

## Endpoints

| Endpoint | Purpose | Use for |
|---|---|---|
| `GET /health` | Liveness - is the Fastify process up at all | systemd/uptime checks, load balancer liveness probe |
| `GET /ready` | Readiness - `{ready, db, engine}`, stable contract (`CONTRACT.md`) | Load balancer readiness probe; gate traffic on `ready: true` |
| `GET /internal/health` | Deep diagnostics - not part of the stable API contract, shape can grow | Dashboards, alerting scripts, incident triage |

`/internal/health`'s shape (`src/telemetry/healthCheck.ts`):

```json
{
  "status": "ok",
  "uptimeSeconds": 12345,
  "nodeVersion": "v20.x.x",
  "database": { "ok": true, "latencyMs": 0.42 },
  "engine": { "ready": true, "circuitState": "closed" },
  "disk": { "freeBytes": 123456789, "totalBytes": 987654321 },
  "metrics": {
    "runsCreated": 100,
    "runsCompleted": 92,
    "runsCancelled": 5,
    "runsFailed": 3,
    "engineCircuitOpenTransitions": 1
  }
}
```

## What each field means operationally

- **`database.latencyMs`** - a `SELECT 1` round-trip. Should stay under a
  few milliseconds on local SQLite; a sustained rise suggests disk I/O
  contention or a growing database needing WAL checkpointing attention.
- **`engine.circuitState`** - `"closed"` is healthy. `"open"` means the
  engine has failed enough consecutive times that new generations are
  being rejected closed (`ENGINE_NOT_READY`) rather than hammering it -
  see `RUNBOOKS/engine-restart.md`. `"half-open"` means it's mid-recovery
  trial.
- **`disk.freeBytes`** - the SQLite database only grows; model files are
  multi-gigabyte. Alert well before this hits zero, not after.
- **`metrics.runsFailed`** vs. **`runsCompleted`** - a rising failure
  rate (compare successive snapshots) is the earliest signal of an
  unhealthy engine, often before the circuit breaker trips.
- **`metrics.engineCircuitOpenTransitions`** - a monotonically increasing
  counter (resets only on process restart). Any increase is worth
  investigating even if the breaker has since closed again - it means
  the engine failed repeatedly at some point.

## Alerting without a metrics stack

A systemd timer running a small script is enough for a single-host
appliance. Example, checking every 5 minutes:

```bash
#!/usr/bin/env bash
set -euo pipefail
RESPONSE="$(curl -sf http://127.0.0.1:8080/internal/health)" || {
  echo "power-node: /internal/health request failed" | mail -s "power-node ALERT" ops@example.com
  exit 0
}
STATUS="$(echo "$RESPONSE" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).status))')"
if [[ "$STATUS" != "ok" ]]; then
  echo "power-node degraded: $RESPONSE" | mail -s "power-node ALERT: degraded" ops@example.com
fi
```

Wire it with a systemd timer the same way as the backup job in
`DEPLOYMENT.md`. Swap `mail` for a `curl` to whatever webhook (Slack,
PagerDuty, etc.) your team already uses - no new dependency required
either way, `curl` is already present for the backup/health checks
above.

**Suggested thresholds to start from** (tune against your own traffic):

- `/ready` returning non-200 for more than 5 consecutive minutes.
- `disk.freeBytes` below 1 GiB.
- `engine.circuitState: "open"` for more than 2 minutes (llama.cpp likely
  needs attention - see `RUNBOOKS/engine-restart.md`).
- Any backup job failure (`systemctl status power-node-backup.service`
  exits nonzero) - see `RUNBOOKS/backup-restore.md`.

## Log-based monitoring

Logs are structured JSON (pino) via
`StandardOutput=append:/opt/power-node-01/logs/app.log` (see
`deploy/systemd/power-node.service`). Every request logs only
`method`/`url`/status/`responseTime` (never bodies, per CLAUDE.md
non-negotiable #7); error-level entries include the error name/message.

```bash
# tail errors only
journalctl -u power-node -f -o cat | node -e '
  process.stdin.resume(); let buf = "";
  process.stdin.on("data", d => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const e = JSON.parse(line); if (e.level >= 50) console.log(line); } catch {}
    }
  });
'

# or, if logging to the file directly rather than through journald:
tail -f /opt/power-node-01/logs/app.log | jq 'select(.level >= 50)'
```

(`jq` is a more common tool for this than the inline Node one-liner above
if it's already installed on your host - either works without adding a
project dependency, since neither runs inside the application itself.)

## Recording model/engine version

Per `RUNBOOKS/model-update.md` step 2, record the model file's checksum
and the llama.cpp build version alongside any performance
benchmark/incident report - `/internal/health` does not expose the model
name or checksum today (llama.cpp's own `/health`/`/v1/models` may,
depending on build; check what your specific build exposes). Treat this
as a manual bookkeeping step until/unless a future change threads that
through `ENGINE_MODEL_NAME` more thoroughly.
