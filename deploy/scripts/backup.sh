#!/usr/bin/env bash
# Backs up the POWER-NODE-01 SQLite database using SQLite's own online
# backup command (safe to run against a live, WAL-mode database - it does
# not require stopping the service or holding a long-lived lock), then
# compresses the result and prunes old backups beyond the retention
# count. See docs/RUNBOOKS/backup-restore.md for restore instructions.
#
# Usage:
#   deploy/scripts/backup.sh [DB_PATH] [BACKUP_DIR] [RETENTION_COUNT]
#
# All three arguments are optional; defaults match .env.example and are
# also overridable via the DB_PATH / BACKUP_DIR / RETENTION_COUNT env
# vars (useful when invoked from a systemd timer's Environment=).
#
# Exit codes: 0 success, 1 bad usage/missing dependency, 2 backup failed,
# 3 integrity check on the fresh backup failed.

set -euo pipefail

DB_PATH="${1:-${DB_PATH:-./data/power-node-01.sqlite}}"
BACKUP_DIR="${2:-${BACKUP_DIR:-./backups}}"
RETENTION_COUNT="${3:-${RETENTION_COUNT:-14}}"

log() {
  echo "[backup.sh $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
}

fail() {
  echo "[backup.sh $(date -u +%Y-%m-%dT%H:%M:%SZ)] ERROR: $*" >&2
  exit "${2:-2}"
}

if ! command -v sqlite3 >/dev/null 2>&1; then
  fail "sqlite3 CLI not found - install it (e.g. 'apt-get install sqlite3') before running backups" 1
fi

if [[ ! -f "$DB_PATH" ]]; then
  fail "database file not found at '$DB_PATH'" 1
fi

if ! [[ "$RETENTION_COUNT" =~ ^[0-9]+$ ]] || [[ "$RETENTION_COUNT" -lt 1 ]]; then
  fail "RETENTION_COUNT must be a positive integer, got '$RETENTION_COUNT'" 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DB_BASENAME="$(basename "$DB_PATH")"
BACKUP_FILE="${BACKUP_DIR}/${DB_BASENAME}.${TIMESTAMP}.bak"
COMPRESSED_FILE="${BACKUP_FILE}.gz"

log "backing up '$DB_PATH' -> '$BACKUP_FILE'"
if ! sqlite3 "$DB_PATH" ".backup '${BACKUP_FILE}'"; then
  rm -f "$BACKUP_FILE"
  fail "sqlite3 .backup command failed"
fi

log "verifying backup integrity"
INTEGRITY_RESULT="$(sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check;")"
if [[ "$INTEGRITY_RESULT" != "ok" ]]; then
  rm -f "$BACKUP_FILE"
  fail "integrity check on the fresh backup failed: $INTEGRITY_RESULT" 3
fi

gzip -f "$BACKUP_FILE"
log "compressed backup written to '$COMPRESSED_FILE' ($(du -h "$COMPRESSED_FILE" | cut -f1))"

# Retention: keep the newest RETENTION_COUNT backups for this database
# file, delete the rest. Sorting lexicographically on the UTC timestamp
# in the filename is equivalent to sorting by time.
mapfile -t EXISTING_BACKUPS < <(find "$BACKUP_DIR" -maxdepth 1 -name "${DB_BASENAME}.*.bak.gz" -print | sort)
COUNT="${#EXISTING_BACKUPS[@]}"
if [[ "$COUNT" -gt "$RETENTION_COUNT" ]]; then
  TO_DELETE=$((COUNT - RETENTION_COUNT))
  for ((i = 0; i < TO_DELETE; i++)); do
    log "pruning old backup: ${EXISTING_BACKUPS[$i]}"
    rm -f "${EXISTING_BACKUPS[$i]}"
  done
fi

log "done - $(find "$BACKUP_DIR" -maxdepth 1 -name "${DB_BASENAME}.*.bak.gz" | wc -l) backup(s) retained"
