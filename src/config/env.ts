import { z } from 'zod';

/**
 * Zod's built-in `z.coerce.boolean()` calls JS `Boolean(value)`, so the
 * *string* "false" (as every env var literally is) coerces to `true` -
 * only an empty string is falsy. That silently inverts any env var
 * meant to default/document itself as "false" (see .env.example). This
 * accepts exactly 'true' or 'false' (case-insensitive) and rejects
 * anything else, so a typo fails closed at startup instead of silently
 * flipping a security-relevant flag like API_AUTH_ENABLED.
 */
function booleanEnv(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return value;
  }, z.boolean().default(defaultValue));
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().positive().default(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    // Set when the API sits behind a reverse proxy (nginx/caddy) that
    // terminates TLS, so Fastify trusts X-Forwarded-* for client IP/proto
    // in its own request logging instead of logging the proxy's address.
    TRUST_PROXY: booleanEnv(false),

    DB_PATH: z.string().default('./data/power-node-01.sqlite'),

    ENGINE_HOST: z.literal('127.0.0.1').default('127.0.0.1'),
    ENGINE_START_PORT: z.coerce.number().int().positive().default(8090),
    ENGINE_STARTUP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    ENGINE_MAX_RESTARTS: z.coerce.number().int().nonnegative().default(5),
    ENGINE_RESTART_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    // 'mock' spawns the bundled deterministic dev/test engine as a child
    // process of this one. 'llama-cpp' connects to an already-running,
    // independently-managed llama.cpp server instead (see
    // docs/DEPLOYMENT.md) - this process never spawns or kills it.
    ENGINE_MODE: z.enum(['mock', 'llama-cpp']).default('mock'),
    // Sent as the `model` field of the OpenAI-compatible chat completion
    // request; most llama.cpp builds ignore it (one model per server
    // process) but some accept it for logging/routing.
    ENGINE_MODEL_NAME: z.string().min(1).default('local-model'),
    ENGINE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    // How often to re-poll an externally-managed engine's /health while
    // running, since (unlike 'mock') this process gets no OS-level signal
    // if that process crashes or restarts independently.
    ENGINE_HEALTH_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),

    MAX_PROMPT_LENGTH: z.coerce.number().int().positive().default(8000),
    MAX_TOKENS_LIMIT: z.coerce.number().int().positive().default(2048),

    // Minimal bearer-token gate for the JSON API (POST /generate, /runs*).
    // Off by default so existing deployments and every test are
    // unaffected. See docs/SECURITY.md for what this does and does not
    // protect - there is no login flow in the bundled console, so
    // enabling this makes the console itself unable to authenticate.
    API_AUTH_ENABLED: booleanEnv(false),
    // An empty string (e.g. `API_AUTH_KEY=` left blank in .env) is
    // treated the same as unset, not as an invalid too-short key.
    API_AUTH_KEY: z.preprocess((value) => (value === '' ? undefined : value), z.string().min(16).optional())
  })
  .superRefine((config, ctx) => {
    if (config.API_AUTH_ENABLED && !config.API_AUTH_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['API_AUTH_KEY'],
        message: 'API_AUTH_KEY (16+ characters) is required when API_AUTH_ENABLED is true'
      });
    }
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
