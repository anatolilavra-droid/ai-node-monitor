import type { FastifyInstance } from 'fastify';
import { idempotencyKeyHeaderSchema, paginationQuerySchema, runIdParamsSchema } from '../schemas/generate.js';
import type { RunsRepositoryPort } from '../domain/ports.js';
import type { GenerationService } from '../domain/generationService.js';
import type { Run } from '../domain/types.js';
import { serializeRun } from '../domain/serializers.js';
import { NotFoundError } from '../domain/errors.js';

function requireRun(runsRepository: RunsRepositoryPort, id: string): Run {
  const run = runsRepository.getById(id);
  if (!run) {
    throw new NotFoundError('RUN_NOT_FOUND', `No run with id ${id}`);
  }
  return run;
}

export function registerRunsRoutes(
  app: FastifyInstance,
  runsRepository: RunsRepositoryPort,
  generationService: GenerationService
): void {
  app.get('/runs', async (request) => {
    const { limit, offset } = paginationQuerySchema.parse(request.query);
    const runs = runsRepository.list(limit, offset);
    return { runs: runs.map(serializeRun), limit, offset };
  });

  app.get('/runs/:id', async (request) => {
    const { id } = runIdParamsSchema.parse(request.params);
    const run = requireRun(runsRepository, id);
    return serializeRun(run);
  });

  // Idempotency-Key is required for contract consistency with every other
  // mutation route; unlike POST /generate there is no dedupe store behind
  // it, because aborting an already-aborted or already-terminal run is a
  // safe no-op by construction (GenerationService.cancel just returns
  // false once the run's controller has been cleaned up).
  app.post('/runs/:id/cancel', async (request) => {
    idempotencyKeyHeaderSchema.parse(request.headers['idempotency-key']);
    const { id } = runIdParamsSchema.parse(request.params);
    const run = requireRun(runsRepository, id);

    const cancelled = generationService.cancel(id);
    return { runId: id, cancelRequested: cancelled, status: run.status };
  });
}
