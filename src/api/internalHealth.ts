import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/env.js';
import type { EngineManager } from '../engine/engineManager.js';
import type { ResilientEngineClient } from '../engine/resilientEngineClient.js';
import type { MetricsCollector } from '../telemetry/metricsCollector.js';
import { buildDetailedHealthSnapshot } from '../telemetry/healthCheck.js';

export function registerInternalHealthRoute(
  app: FastifyInstance,
  db: Database.Database,
  config: AppConfig,
  engineManager: EngineManager,
  engineClient: ResilientEngineClient,
  metrics: MetricsCollector
): void {
  app.get('/internal/health', async (_request, reply) => {
    const snapshot = buildDetailedHealthSnapshot({
      db,
      dbPath: config.DB_PATH,
      engineReady: engineManager.isReady(),
      circuitState: engineClient.getCircuitState(),
      metrics: metrics.getSnapshot()
    });
    reply.status(snapshot.status === 'ok' ? 200 : 503);
    return snapshot;
  });
}
