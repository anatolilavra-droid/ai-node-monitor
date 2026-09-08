import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type Database from 'better-sqlite3';
import { ZodError } from 'zod';
import type { AppConfig } from './config/env.js';
import type { EngineManager } from './engine/engineManager.js';
import { RunsRepository } from './repositories/runsRepository.js';
import { GenerationService } from './services/generationService.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerGenerateRoute } from './routes/generate.js';
import { registerRunsRoutes } from './routes/runs.js';

export interface AppDeps {
  config: AppConfig;
  db: Database.Database;
  engine: EngineManager;
}

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

  const runsRepository = new RunsRepository(deps.db);
  const generationService = new GenerationService(runsRepository, deps.engine, app.log);

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ZodError) {
      reply.status(400).send({
        error: 'VALIDATION_FAILED',
        message: err.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      });
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
