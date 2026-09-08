# Runbook: backup and restore

## Backup

Automated nightly via the `power-node-backup.timer` systemd timer set up
in [`DEPLOYMENT.md`](../DEPLOYMENT.md#6-backups). To run one manually:

```bash
sudo -u power-node /opt/power-node-01/deploy/scripts/backup.sh \
  /opt/power-node-01/data/power-node-01.sqlite \
  /opt/power-node-01/backups \
  14
```

This is safe to run at any time, including while the service is up and
serving traffic - it uses SQLite's own `.backup` command, which reads a
WAL-mode database consistently without needing a lock the app would
contend with. It:

1. Writes a fresh backup file.
2. Runs `PRAGMA integrity_check` against *that new file* before keeping
   it - a corrupt backup is deleted immediately with a nonzero exit code
   rather than silently retained.
3. Compresses it with gzip.
4. Prunes older backups for the same database beyond the retention count
   (14 by default).

Check it actually ran:

```bash
sudo systemctl status power-node-backup.timer
sudo journalctl -u power-node-backup.service --since "2 days ago"
ls -lh /opt/power-node-01/backups/
```

A failed backup run is worth alerting on - see
[`MONITORING.md`](../MONITORING.md).

## Restore

**Stop the service first.** Restoring into a live database file out from
under a running process will corrupt it.

```bash
sudo systemctl stop power-node.service

# pick the backup to restore (newest is usually .../backups/*.bak.gz, sorted by name)
ls -lt /opt/power-node-01/backups/

BACKUP_FILE=/opt/power-node-01/backups/power-node-01.sqlite.20250101T030000Z.bak.gz
DB_PATH=/opt/power-node-01/data/power-node-01.sqlite

# move the current (possibly broken) database aside rather than deleting it,
# in case the restore itself needs to be aborted
sudo -u power-node mv "$DB_PATH" "${DB_PATH}.pre-restore.$(date -u +%Y%m%dT%H%M%SZ)"
sudo -u power-node rm -f "${DB_PATH}-wal" "${DB_PATH}-shm"

sudo -u power-node bash -c "gunzip -c '$BACKUP_FILE' > '$DB_PATH'"

# verify before trusting it
sudo -u power-node sqlite3 "$DB_PATH" "PRAGMA integrity_check;"
sudo -u power-node sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM runs;"
```

`PRAGMA integrity_check` must print exactly `ok`. If it doesn't, do not
start the service against this file - try an older backup instead, and
keep the `.pre-restore.<timestamp>` copy for forensics.

```bash
sudo systemctl start power-node.service
curl -s http://127.0.0.1:8080/ready
curl -s http://127.0.0.1:8080/internal/health
```

Confirm `/ready` reports `db: true` and `/internal/health`'s
`database.ok` is `true` with a sane `latencyMs` before considering the
restore complete.

## Data loss window

A restore recovers everything up to the moment the backup was taken -
runs created or updated after that point are gone. The nightly timer
means the worst case is losing up to ~24h of run history; run
`backup.sh` manually right before a risky operation (a model swap, a
migration, a disk-full incident) to shrink that window.

## What is NOT backed up

- `.env` (secrets/config) - back this up separately (e.g. as part of your
  configuration management), not alongside the database, and never
  unencrypted off-host given it may contain `API_AUTH_KEY`.
- The llama.cpp model file(s) - these are large, reproducible from their
  source download + checksum, and out of scope for `backup.sh`. See
  [`model-update.md`](model-update.md).
