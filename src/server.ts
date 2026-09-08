import pino from 'pino';
import { loadConfig } from './config/env.js';
import { openDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { EngineManager } from './engine/engineManager.js';
import { AppState } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.DB_PATH);
  runMigrations(db);

  const engineLogger = pino({ level: config.LOG_LEVEL });
  const engine = new EngineManager(config, engineLogger);
  const appState = new AppState({ config, db, engine });

  await appState.start();
  appState.log.info(`POWER-NODE-01 listening on http://${config.HOST}:${config.PORT}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    appState.log.info({ signal }, 'shutting down');
    await appState.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
