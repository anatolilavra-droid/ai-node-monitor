import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config/env.js';

const EXEMPT_PATHS = new Set(['/health', '/ready', '/internal/health']);
const PROTECTED_PREFIXES = ['/generate', '/runs'];

function isProtectedPath(path: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Optional bearer-token gate for the JSON API, off by default
 * (config.API_AUTH_ENABLED). When enabled, every /generate and /runs*
 * request must carry `Authorization: Bearer <API_AUTH_KEY>` or gets a 401
 * before touching a route handler; /health, /ready, and /internal/health
 * stay open so infra health checks keep working, and the static console
 * assets stay open too (there is no login UI for them to authenticate
 * with - see docs/SECURITY.md for what this scheme does and does not
 * cover before enabling it).
 *
 * loadConfig() already rejects API_AUTH_ENABLED=true without a key, so
 * config.API_AUTH_KEY is guaranteed defined here.
 */
export function registerAuthMiddleware(app: FastifyInstance, config: AppConfig): void {
  if (!config.API_AUTH_ENABLED) return;

  const expected = `Bearer ${config.API_AUTH_KEY}`;

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (EXEMPT_PATHS.has(path) || !isProtectedPath(path)) return;

    if (request.headers.authorization !== expected) {
      reply.status(401).send({
        error: 'UNAUTHORIZED',
        message: 'A valid Authorization: Bearer <key> header is required'
      });
    }
  });
}
