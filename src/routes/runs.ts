import type { FastifyInstance } from 'fastify';
import { idempotencyKeyHeaderSchema, paginationQuerySchema, runIdParamsSchema } from '../schemas/generate.js';
import type { RunsRepository } from '../repositories/runsRepository.js';
import type { GenerationService } from '../services/generationService.js';
import { serializeRun } from '../services/serializers.js';

export function registerRunsRoutes(
  app: FastifyInstance,
  runsRepository: RunsRepository,
  generationService: GenerationService
): void {
  app.get('/runs', async (request) => {
    const { limit, offset } = paginationQuerySchema.parse(request.query);
    const runs = runsRepository.list(limit, offset);
    return { runs: runs.map(serializeRun), limit, offset };
  });

  app.get('/runs/:id', async (request, reply) => {
    const { id } = runIdParamsSchema.parse(request.params);
    const run = runsRepository.getById(id);
    if (!run) {
      reply.status(404);
      return { error: 'RUN_NOT_FOUND', message: `No run with id ${id}` };
    }
    return serializeRun(run);
  });

  // Idempotency-Key is required for contract consistency with every other
  // mutation route; unlike POST /generate there is no dedupe store behind
  // it, because aborting an already-aborted or already-terminal run is a
  // safe no-op by construction (GenerationService.cancel just returns
  // false once the run's controller has been cleaned up).
  app.post('/runs/:id/cancel', async (request, reply) => {
    idempotencyKeyHeaderSchema.parse(request.headers['idempotency-key']);
    const { id } = runIdParamsSchema.parse(request.params);

    const run = runsRepository.getById(id);
    if (!run) {
      reply.status(404);
      return { error: 'RUN_NOT_FOUND', message: `No run with id ${id}` };
    }

    const cancelled = generationService.cancel(id);
    return { runId: id, cancelRequested: cancelled, status: run.status };
  });
}
