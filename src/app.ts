import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type Database from 'better-sqlite3';
import { ZodError } from 'zod';
import type { AppConfig } from './config/env.js';
import type { EngineManager } from './engine/engineManager.js';
import { ResilientEngineClient } from './engine/resilientEngineClient.js';
import { RunsRepository } from './db/runsRepository.js';
import { GenerationService } from './domain/generationService.js';
import { isAppError } from './domain/errors.js';
import { EventBus } from './telemetry/eventBus.js';
import type { AppEventMap } from './telemetry/events.js';
import { MetricsCollector, type MetricsSnapshot } from './telemetry/metricsCollector.js';
import { registerHealthRoutes } from './api/health.js';
import { registerGenerateRoute } from './api/generate.js';
import { registerRunsRoutes } from './api/runs.js';

export interface AppDeps {
  config: AppConfig;
  db: Database.Database;
  engine: EngineManager;
  /** Defaults to a fresh, unobserved bus - pass one in to attach a MetricsCollector to it (see AppState). */
  eventBus?: EventBus<AppEventMap>;
}

/**
 * Builds and wires the Fastify instance: routes, error handling, static
 * console assets, and the domain/engine/telemetry objects that back them.
 * Does not call `.listen()` or start the engine - that lifecycle belongs
 * to AppState below (production) or to a test harness that wants a bare
 * FastifyInstance to call `.listen()` on directly.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: deps.config.LOG_LEVEL,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["idempotency-key"]'],
        censor: '[redacted]'
      },
      // Prompts/completions never appear in default request/response
      // logging because we never log request bodies or SSE payloads -
      // only method, url, and status code (Fastify's default shape).
      serializers: {
        req(request) {
          return { method: request.method, url: request.url };
        }
      }
    }
  });

  const eventBus = deps.eventBus ?? new EventBus<AppEventMap>();
  const runsRepository = new RunsRepository(deps.db);
  const engineClient = new ResilientEngineClient(deps.engine, eventBus, app.log);
  const generationService = new GenerationService(runsRepository, engineClient, eventBus, app.log);

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ZodError) {
      reply.status(400).send({
        error: 'VALIDATION_FAILED',
        message: err.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      });
      return;
    }

    if (isAppError(err)) {
      reply.status(err.statusCode).send({ error: err.code, message: err.message });
      return;
    }

    const statusCode = 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
    app.log.error({ err: { name: err.name, message: err.message } }, 'request failed');
    reply.status(statusCode).send({
      error: statusCode === 500 ? 'INTERNAL_ERROR' : err.name || 'ERROR',
      message: statusCode === 500 ? 'Internal server error' : err.message
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: 'ROUTE_NOT_FOUND', message: 'The requested route does not exist' });
  });

  registerHealthRoutes(app, deps.db, deps.engine);
  registerGenerateRoute(app, deps.config, runsRepository, generationService);
  registerRunsRoutes(app, runsRepository, generationService);

  const __dirname = dirname(fileURLToPath(import.meta.url));
  app.register(fastifyStatic, {
    root: join(__dirname, '..', 'public'),
    prefix: '/'
  });

  return app;
}

export type AppLifecycle = 'created' | 'starting' | 'running' | 'stopping' | 'stopped';

export interface AppStateSnapshot {
  lifecycle: AppLifecycle;
  dbOpen: boolean;
  engineReady: boolean;
  metrics: MetricsSnapshot;
}

/**
 * Owns the full process lifecycle: start the engine, start Fastify, and
 * tear both down (plus the database handle) in the right order exactly
 * once, however shutdown was triggered (SIGINT/SIGTERM, or a caller
 * deciding to stop). `getState()` gives a single place to answer "is this
 * process healthy" for structured logging or a future operator endpoint,
 * independent of any one HTTP request.
 */
export class AppState {
  private readonly fastify: FastifyInstance;
  private readonly eventBus: EventBus<AppEventMap>;
  private readonly metrics: MetricsCollector;
  private lifecycle: AppLifecycle = 'created';

  constructor(private readonly deps: AppDeps) {
    this.eventBus = deps.eventBus ?? new EventBus<AppEventMap>();
    this.fastify = buildApp({ ...deps, eventBus: this.eventBus });
    this.metrics = new MetricsCollector(this.eventBus);
  }

  async start(): Promise<void> {
    this.lifecycle = 'starting';
    await this.deps.engine.start();
    await this.fastify.listen({ host: this.deps.config.HOST, port: this.deps.config.PORT });
    this.lifecycle = 'running';
  }

  async stop(): Promise<void> {
    if (this.lifecycle === 'stopping' || this.lifecycle === 'stopped') return;
    this.lifecycle = 'stopping';
    await this.fastify.close();
    await this.deps.engine.stop();
    this.deps.db.close();
    this.lifecycle = 'stopped';
  }

  getState(): AppStateSnapshot {
    return {
      lifecycle: this.lifecycle,
      dbOpen: this.deps.db.open,
      engineReady: this.deps.engine.isReady(),
      metrics: this.metrics.getSnapshot()
    };
  }

  get log(): FastifyInstance['log'] {
    return this.fastify.log;
  }
}
