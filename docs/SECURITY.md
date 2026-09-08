# Security

## Threat model

**What this appliance protects:** the content of prompts and completions
(potentially sensitive - this is the entire reason it's local-first
rather than a cloud API call), the run history in SQLite (the same
content, persisted), and the integrity of what the engine actually runs
(the model file).

**Who it's designed to resist:** an unauthenticated party reaching the
Fastify API or the engine's HTTP port directly (network access, whether
LAN or - if misconfigured - the internet), and a corrupted or tampered
model file being loaded silently.

**Explicitly out of scope** (a compromised host is a bigger problem than
this appliance can solve):

- A root-level compromise of the host OS.
- A malicious or compromised reverse proxy sitting in front of it.
- Protecting model weights as intellectual property from someone with
  filesystem access to the host.
- Multi-tenant isolation - this is a single-tenant appliance (see
  README's "Known limitations"); it has no concept of separate users or
  per-user data isolation.

## Checklist

Run through this on every deploy and after every model update.

- [ ] **Engine binds `127.0.0.1` only.** `ENGINE_HOST` is a Zod literal
      (`src/config/env.ts`) - the config layer already refuses any other
      value. Still verify the actual bound socket after every engine
      start, since a literal in config doesn't prove the engine binary
      itself honored the `--host` flag: `ss -tlnp | grep <ENGINE_START_PORT>`
      must show `127.0.0.1:<port>`, never `0.0.0.0` or a routable address.
- [ ] **Fastify itself binds `127.0.0.1`** (`HOST` in `.env`) unless a
      reverse proxy is intentionally the only other hop - see
      `DEPLOYMENT.md`'s firewall section. Never open `PORT` or
      `ENGINE_START_PORT` in the firewall.
- [ ] **`.env` is `chmod 600`**, owned by the service user, never
      committed (`.gitignore` excludes it) - it can contain
      `API_AUTH_KEY`.
- [ ] **The database file is not world-readable.** `DB_PATH`'s directory
      should be owned by the service user with restrictive permissions;
      it contains every prompt and completion ever run.
- [ ] **Backups inherit the same sensitivity as the live database** - see
      `RUNBOOKS/backup-restore.md`. `deploy/scripts/backup.sh`'s output
      directory should have the same access restrictions as `DB_PATH`'s.
      This appliance does not encrypt backups at rest (see Follow-ups).
- [ ] **Logs never contain prompts, completions, secrets, or auth
      headers.** This is enforced in code (`src/app.ts`'s Fastify logger
      config redacts `authorization`, `cookie`, and `idempotency-key`,
      and its request serializer logs only `method`/`url`) - if you add
      a new log call anywhere, it must not log a `Run`'s `prompt` or
      `output` field, or the `Authorization` header. This is CLAUDE.md
      non-negotiable #7; treat a violation of it as a security bug, not
      a style nit.
- [ ] **Model file integrity checked before every switch** - see
      `RUNBOOKS/model-update.md`. A checksum obtained from the model's
      *original* source, not from alongside the download itself.
- [ ] **Node.js and the llama.cpp build are kept current** for CVEs in
      either.
- [ ] **The systemd hardening directives in
      `deploy/systemd/power-node.service` are intact** - `ProtectSystem=strict`,
      `NoNewPrivileges`, `RestrictAddressFamilies` (loopback + Unix
      sockets only - this process makes no external network calls other
      than to the engine on `127.0.0.1`), `MemoryDenyWriteExecute`, and
      the rest. If you need to loosen one of these for a legitimate
      reason, say why in a comment in the unit file itself.
- [ ] **API key rotated periodically if `API_AUTH_ENABLED=true`** - see
      below for what this scheme does and does not cover.

## Optional API authentication - what it actually covers

`API_AUTH_ENABLED`/`API_AUTH_KEY` (`src/api/middleware/auth.ts`) is a
single shared bearer token, off by default, gating `POST /generate` and
every `/runs*` route. It exists for the case where the Fastify port is
reachable by more than just the operator (e.g. shared across a small
team's LAN).

**What it does not cover:**

- **The bundled monitoring console cannot authenticate with it.** There
  is no login UI in `public/` (out of scope for this change - see
  Follow-ups), so its `fetch()` calls never send the header. Enabling
  auth without also protecting or removing access to the console page
  itself means the console will simply show failed requests. If you need
  both the console and auth, put the console behind your reverse proxy's
  own auth (e.g. `nginx`'s `auth_basic`, or an IP allowlist) instead of
  relying on this scheme for it.
- **It is a single shared secret, not per-user auth.** Anyone with the
  key has full access to every route it protects. There is no
  revocation short of rotating the key (which invalidates it for
  everyone) and restarting the service.
- **It is not a substitute for network-level controls.** Prefer keeping
  the appliance unreachable except from a trusted network/reverse proxy
  over relying on this alone - "security over convenience" per this
  project's stated priorities means defense in depth, not either/or.
- **`/health`, `/ready`, and `/internal/health` are always open**
  (needed for infra health checks to function without credentials).
  `/internal/health` does not leak prompts/completions (see
  `src/telemetry/healthCheck.ts` - only counts, latency, and disk/engine
  state), but it is still an unauthenticated information-disclosure
  surface (uptime, Node version, run counts); if that's unacceptable for
  your deployment, put it behind a reverse-proxy IP allowlist rather than
  removing it (monitoring needs it - see `MONITORING.md`).

Generate a key with `openssl rand -hex 32` - never reuse a short or
guessable value; `src/config/env.ts` enforces a 16-character minimum as a
floor, not a recommendation.

## Follow-ups (not implemented - flagged rather than silently skipped)

- **Backup encryption at rest.** `backup.sh` produces plain gzip, not
  encrypted archives. If the appliance handles sensitive content and
  backups leave the host, encrypt them (e.g. `age` or `gpg`) - this
  needs a decision on key management this task did not make on your
  behalf.
- **Model manifest validation.** CLAUDE.md non-negotiable #12 mentions
  "unsafe model manifests"; today that's entirely the operator's
  responsibility per `RUNBOOKS/model-update.md`'s checksum step. A
  built-in signature/manifest check before `EngineManager` will connect
  to a given model is future work.
- **Per-user auth / multi-tenancy.** Explicitly out of scope (see threat
  model above) - would be a significant architecture change, not a
  config flag.
- **A login UI for the console**, if you want `API_AUTH_ENABLED` and the
  bundled console to work together without a reverse-proxy workaround.
