import { z } from 'zod';
import type { AppConfig } from '../config/env.js';

export function buildGenerateBodySchema(config: AppConfig) {
  return z.object({
    prompt: z.string().min(1).max(config.MAX_PROMPT_LENGTH),
    model: z.string().min(1).max(200).default('mock-engine-v1'),
    maxTokens: z.coerce.number().int().positive().max(config.MAX_TOKENS_LIMIT).default(128)
  });
}

export type GenerateBody = z.infer<ReturnType<typeof buildGenerateBodySchema>>;

export const runIdParamsSchema = z.object({
  id: z.string().uuid()
});

export const idempotencyKeyHeaderSchema = z
  .string({ required_error: 'Idempotency-Key header is required for this route' })
  .min(1)
  .max(200);

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0)
});
