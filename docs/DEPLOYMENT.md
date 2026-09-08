# Deployment

Step-by-step path from a fresh Ubuntu 22.04 host to a running,
systemd-supervised POWER-NODE-01 talking to a real llama.cpp engine. See
[`SECURITY.md`](SECURITY.md) before exposing this to anything beyond
`localhost`, and [`MONITORING.md`](MONITORING.md) for what to watch once
it's up.

## 0. What you need first

- Ubuntu 22.04 LTS (or similar systemd-based distro) with Node.js 20+
  installed and on `PATH` for whichever user will run the service.
- The `sqlite3` CLI (`apt-get install sqlite3`) - used by
  `deploy/scripts/backup.sh`, not by the app itself (that uses
  `better-sqlite3` directly).
- A built llama.cpp `server` binary and a GGUF model file already
  downloaded. Building/obtaining these is outside this repo's scope;
  llama.cpp's own README covers it.

## 1. Create dedicated system users

Running as a dedicated, unprivileged user (not the one you SSH in as, and
never root) is what makes the systemd hardening in
`deploy/systemd/*.service` mean anything.

```bash
sudo useradd --system --home /opt/power-node-01 --shell /usr/sbin/nologin power-node
sudo useradd --system --home /opt/llama-cpp --shell /usr/sbin/nologin llama-cpp
```

## 2. Install the engine (llama.cpp)

```bash
sudo mkdir -p /opt/llama-cpp/models
# copy your built `server` binary to /opt/llama-cpp/server and your
# .gguf model to /opt/llama-cpp/models/current.gguf (see
# docs/RUNBOOKS/model-update.md for how to do this safely with a
# checksum and a rollback path instead of just `cp`)
sudo chown -R llama-cpp:llama-cpp /opt/llama-cpp

sudo cp deploy/systemd/llama-cpp.service.example /etc/systemd/system/llama-cpp.service
# edit ExecStart's -m/-c/-t flags for your model and hardware
sudo systemd-analyze verify /etc/systemd/system/llama-cpp.service
sudo systemctl daemon-reload
sudo systemctl enable --now llama-cpp.service

# confirm it bound 127.0.0.1 only, and is actually healthy
ss -tlnp | grep 8090
curl -s http://127.0.0.1:8090/health
```

**If `curl`'s output isn't a 200 `{"status":"ok"}`**, stop here - fix the
engine first (`journalctl -u llama-cpp -f`). Non-negotiable #1 (CLAUDE.md):
the engine binds `127.0.0.1` only, and `ss -tlnp` above must never show it
on `0.0.0.0` or a routable address.

## 3. Deploy the application

```bash
sudo mkdir -p /opt/power-node-01
sudo chown power-node:power-node /opt/power-node-01
sudo -u power-node git clone https://github.com/anatolilavra-droid/ai-node-monitor /opt/power-node-01
cd /opt/power-node-01

sudo -u power-node npm ci --omit=dev
sudo -u power-node npm run build

sudo -u power-node mkdir -p data logs
sudo -u power-node cp .env.example .env
sudo -u power-node chmod 600 .env
```

Edit `/opt/power-node-01/.env` (see the comments in `.env.example` for
every field):

```bash
NODE_ENV=production
ENGINE_MODE=llama-cpp
ENGINE_START_PORT=8090          # must match llama-cpp.service's --port
ENGINE_MODEL_NAME=local-model   # whatever you want in request logs
DB_PATH=/opt/power-node-01/data/power-node-01.sqlite
API_AUTH_ENABLED=false          # see docs/SECURITY.md before turning this on
```

Apply migrations once up front (the app also runs them automatically on
every start - `db/migrate.ts` is idempotent, see the note in
[`ARCHITECTURE.md`](ARCHITECTURE.md) - but doing it explicitly here lets
you catch a schema problem before the service is live):

```bash
sudo -u power-node env DB_PATH=/opt/power-node-01/data/power-node-01.sqlite \
  node dist/db/migrate.js
```

## 4. Install and start the systemd unit

```bash
sudo systemd-analyze verify deploy/systemd/power-node.service   # do this before installing anything
sudo cp deploy/systemd/power-node.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now power-node.service

sudo systemctl status power-node.service
curl -s http://127.0.0.1:8080/health
curl -s http://127.0.0.1:8080/ready
curl -s http://127.0.0.1:8080/internal/health | node -e "process.stdin.pipe(process.stdout)"
```

`/ready` should report `{"ready":true,"db":true,"engine":true}` once
llama.cpp has finished loading the model. `/internal/health` adds DB
latency, the engine circuit breaker's state, and free disk space - see
[`MONITORING.md`](MONITORING.md).

## 5. Log rotation

The unit redirects stdout/stderr to `/opt/power-node-01/logs/app.log`
(structured JSON, one line per event - see `deploy/systemd/power-node.service`'s
comments for why `copytruncate` is required rather than a reopen signal).

```bash
sudo cp deploy/logrotate/power-node /etc/logrotate.d/power-node
sudo logrotate -d /etc/logrotate.d/power-node   # dry run, sanity-check paths
```

## 6. Backups

```bash
sudo -u power-node /opt/power-node-01/deploy/scripts/backup.sh \
  /opt/power-node-01/data/power-node-01.sqlite \
  /opt/power-node-01/backups \
  14
```

Wire this to run nightly with a systemd timer (preferred over cron here,
since it's already the process manager for everything else):

`/etc/systemd/system/power-node-backup.service`:

```ini
[Unit]
Description=POWER-NODE-01 database backup

[Service]
Type=oneshot
User=power-node
ExecStart=/opt/power-node-01/deploy/scripts/backup.sh /opt/power-node-01/data/power-node-01.sqlite /opt/power-node-01/backups 14
```

`/etc/systemd/system/power-node-backup.timer`:

```ini
[Unit]
Description=Nightly POWER-NODE-01 database backup

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now power-node-backup.timer
```

See [`RUNBOOKS/backup-restore.md`](RUNBOOKS/backup-restore.md) for restore
steps.

## 7. Optional: reverse proxy (TLS termination)

Only needed if this appliance is reached from outside `localhost`/your
LAN. Keep `HOST=127.0.0.1` and `PORT=8080` in `.env` either way - only the
proxy should be internet-facing.

**nginx** (note `proxy_buffering off` - required for `POST /generate`'s
SSE response to actually stream instead of being buffered until the
generation finishes):

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```

**Caddy** (buffers off by default for chunked responses, but pin the
timeout for long generations):

```
your-domain.example {
    reverse_proxy 127.0.0.1:8080 {
        transport http {
            response_header_timeout 300s
        }
    }
}
```

Set `TRUST_PROXY=true` in `.env` when using either of these, so Fastify's
request logging reflects the real client rather than the proxy.

## 8. Firewall

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp    # only if using a reverse proxy
sudo ufw allow 443/tcp   # only if using a reverse proxy
sudo ufw enable
```

Never open `8080` (Fastify) or `8090` (engine) in the firewall - both
must stay reachable only from `127.0.0.1`.

## Rollback

```bash
cd /opt/power-node-01
sudo -u power-node git fetch origin
sudo -u power-node git checkout <previous-tag-or-commit>
sudo -u power-node npm ci --omit=dev
sudo -u power-node npm run build
sudo systemctl restart power-node.service
curl -s http://127.0.0.1:8080/ready
```

Migrations are additive-only and never edited in place (CLAUDE.md
non-negotiable #10), so rolling the application back does not require a
database rollback - the schema a newer version added is simply unused by
the older code. If a specific migration must be rolled back, that is a
new forward migration that undoes it, not a checkout of an older
`db/migrations/` directory against an already-migrated database.

For rolling back a *model* change specifically, see
[`RUNBOOKS/model-update.md`](RUNBOOKS/model-update.md) instead - that's a
llama.cpp/model-file concern, independent of the application version.
