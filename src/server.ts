import pino from 'pino';
import { loadConfig } from './config/env.js';
import { openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { EngineManager } from './engine/engineManager.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.DB_PATH);
  runMigrations(db);

  const engineLogger = pino({ level: config.LOG_LEVEL });
  const engine = new EngineManager(config, engineLogger);
  const app = buildApp({ config, db, engine });

  await engine.start();

  const address = await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(`POWER-NODE-01 listening on ${address}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await engine.stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
