import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';
import { EngineManager } from '../../src/engine/engineManager.js';
import type { AppLogger } from '../../src/logging/appLogger.js';
import { buildApp } from '../../src/app.js';

function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 20000);
}

export interface TestContext {
  app: FastifyInstance;
  config: AppConfig;
  engine: EngineManager;
  baseUrl: string;
  cleanup: () => Promise<void>;
}

const silentLogger: AppLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

export async function startTestServer(overrides: Partial<NodeJS.ProcessEnv> = {}): Promise<TestContext> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'power-node-01-test-'));
  const dbPath = join(tmpDir, 'test.sqlite');

  const config = loadConfig({
    ...process.env,
    DB_PATH: dbPath,
    ENGINE_START_PORT: String(randomPort()),
    LOG_LEVEL: 'silent',
    ...overrides
  });

  const db = openDatabase(config.DB_PATH);
  runMigrations(db);

  const engine = new EngineManager(config, silentLogger);
  await engine.start();

  const app = buildApp({ config, db, engine });
  await app.listen({ host: config.HOST, port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.PORT;
  const baseUrl = `http://${config.HOST}:${port}`;

  return {
    app,
    config,
    engine,
    baseUrl,
    cleanup: async () => {
      await app.close();
      await engine.stop();
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}
