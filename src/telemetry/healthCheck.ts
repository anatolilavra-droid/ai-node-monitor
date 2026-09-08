import { statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type { CircuitState } from '../engine/circuitBreaker.js';
import type { MetricsSnapshot } from './metricsCollector.js';

export interface DetailedHealthSnapshot {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  nodeVersion: string;
  database: { ok: boolean; latencyMs: number | null };
  engine: { ready: boolean; circuitState: CircuitState };
  disk: { freeBytes: number | null; totalBytes: number | null };
  metrics: MetricsSnapshot;
}

export interface HealthCheckDeps {
  db: Database.Database;
  dbPath: string;
  engineReady: boolean;
  circuitState: CircuitState;
  metrics: MetricsSnapshot;
}

/**
 * A deeper diagnostic snapshot than GET /ready's stable, documented
 * {ready, db, engine} contract shape (docs/CONTRACT.md) - this is an
 * operational endpoint for humans/monitoring, not part of that contract,
 * so its shape can grow without a contract version bump. See
 * docs/MONITORING.md for what to alert on.
 */
export function buildDetailedHealthSnapshot(deps: HealthCheckDeps): DetailedHealthSnapshot {
  const dbStart = process.hrtime.bigint();
  let dbOk = false;
  try {
    deps.db.prepare('SELECT 1').get();
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const dbLatencyMs = dbOk ? Number(process.hrtime.bigint() - dbStart) / 1_000_000 : null;

  let disk: DetailedHealthSnapshot['disk'] = { freeBytes: null, totalBytes: null };
  try {
    const stats = statfsSync(dirname(resolve(deps.dbPath)));
    disk = { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
  } catch {
    // statfs unsupported on this platform, or the data directory doesn't
    // exist yet; disk info is diagnostic, not worth failing the request.
  }

  return {
    status: dbOk && deps.engineReady ? 'ok' : 'degraded',
    uptimeSeconds: Math.round(process.uptime()),
    nodeVersion: process.version,
    database: { ok: dbOk, latencyMs: dbLatencyMs === null ? null : Math.round(dbLatencyMs * 100) / 100 },
    engine: { ready: deps.engineReady, circuitState: deps.circuitState },
    disk,
    metrics: deps.metrics
  };
}
