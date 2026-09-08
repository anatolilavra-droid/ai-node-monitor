import { z } from 'zod';

const envSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DB_PATH: z.string().default('./data/power-node-01.sqlite'),

  ENGINE_HOST: z.literal('127.0.0.1').default('127.0.0.1'),
  ENGINE_START_PORT: z.coerce.number().int().positive().default(8090),
  ENGINE_STARTUP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  ENGINE_MAX_RESTARTS: z.coerce.number().int().nonnegative().default(5),
  ENGINE_RESTART_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  MAX_PROMPT_LENGTH: z.coerce.number().int().positive().default(8000),
  MAX_TOKENS_LIMIT: z.coerce.number().int().positive().default(2048)
});

export type AppConfig = z.infer<typeof envSchema>;

/**
 * Parses process.env eagerly and throws on any invalid/missing value.
 * The engine must never bind to anything but 127.0.0.1, so ENGINE_HOST
 * is a literal rather than a free-form string.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  return result.data;
}
