import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { EngineManager } from '../engine/engineManager.js';

export function registerHealthRoutes(app: FastifyInstance, db: Database.Database, engine: EngineManager): void {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_request, reply) => {
    let dbOk = false;
    try {
      db.prepare('SELECT 1').get();
      dbOk = true;
    } catch {
      dbOk = false;
    }

    const engineReady = engine.isReady();
    const ready = dbOk && engineReady;

    reply.status(ready ? 200 : 503);
    return { ready, db: dbOk, engine: engineReady };
  });
}
