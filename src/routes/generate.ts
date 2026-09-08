import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/env.js';
import { buildGenerateBodySchema, idempotencyKeyHeaderSchema } from '../schemas/generate.js';
import type { RunsRepository } from '../repositories/runsRepository.js';
import type { GenerationService, GenerationEvent } from '../services/generationService.js';
import { serializeRun } from '../services/serializers.js';

const ROUTE = 'POST /generate';

function sseEventNameFor(type: GenerationEvent['type']): string {
  return type === 'token' ? 'token' : `run.${type}`;
}

export function registerGenerateRoute(
  app: FastifyInstance,
  config: AppConfig,
  runsRepository: RunsRepository,
  generationService: GenerationService
): void {
  const generateBodySchema = buildGenerateBodySchema(config);

  app.post('/generate', async (request, reply) => {
    const idempotencyKey = idempotencyKeyHeaderSchema.parse(request.headers['idempotency-key']);
    const body = generateBodySchema.parse(request.body);

    const existingRunId = runsRepository.findIdempotentRunId(ROUTE, idempotencyKey);

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });

    const send = (type: GenerationEvent['type'], data: unknown): void => {
      reply.raw.write(`event: ${sseEventNameFor(type)}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (existingRunId) {
      // Idempotent replay: return the run's current stored state as a
      // single snapshot rather than re-invoking the engine. This is
      // sufficient to make client retries safe; it does not re-attach a
      // second connection to a still-streaming generation.
      const run = runsRepository.getById(existingRunId);
      if (run) {
        send('created', serializeRun(run));
        if (run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed') {
          send(run.status, serializeRun(run));
        } else {
          send('status', serializeRun(run));
        }
      }
      reply.raw.end();
      return reply;
    }

    const run = runsRepository.createQueuedWithIdempotencyKey(ROUTE, idempotencyKey, {
      model: body.model,
      prompt: body.prompt,
      maxTokens: body.maxTokens
    });

    // reply.raw (not request.raw) is the response socket: it is what
    // closes when the browser navigates away or drops the connection
    // mid-stream. request.raw's 'close' fires as soon as the request body
    // has been fully read, which happens before the handler even starts
    // streaming - listening on it would cancel every generation instantly.
    const onDisconnect = (): void => {
      if (!reply.raw.writableEnded) {
        generationService.cancel(run.id);
      }
    };
    reply.raw.on('close', onDisconnect);

    try {
      await generationService.run(run, (event) => {
        send(event.type, event.type === 'token' ? { runId: event.run.id, ...event.token } : serializeRun(event.run));
      });
    } finally {
      reply.raw.off('close', onDisconnect);
      reply.raw.end();
    }

    return reply;
  });
}
