-- Runs are individual generation requests. version supports optimistic
-- concurrency for the status transitions applied by the generation
-- service and the cancel route.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  max_tokens INTEGER NOT NULL,
  output TEXT NOT NULL DEFAULT '',
  token_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_runs_status_created ON runs (status, created_at);

-- One row per (route, Idempotency-Key). A replayed request with the same
-- key on the same route is resolved by looking up the run it already
-- created instead of starting a new generation.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  route TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (route, idempotency_key)
);
