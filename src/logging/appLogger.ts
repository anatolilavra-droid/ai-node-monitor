/**
 * The subset of the pino/Fastify logger surface used outside the HTTP
 * layer, so EngineManager and GenerationService don't need to depend on
 * either package's concrete logger type - a Fastify request logger, a
 * standalone pino instance, or a test double all satisfy this.
 */
export interface AppLogger {
  info: (objOrMsg: unknown, msg?: string) => void;
  warn: (objOrMsg: unknown, msg?: string) => void;
  error: (objOrMsg: unknown, msg?: string) => void;
}
