/**
 * Structured domain errors. Each carries a stable `code` (used as the
 * `error` field in HTTP responses, unchanged from before this refactor)
 * and a `statusCode` the central Fastify error handler maps to directly,
 * replacing the old ad-hoc `'statusCode' in err` duck-typing.
 */
export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly statusCode: number;
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** A request failed a domain-level invariant Zod cannot express. */
export class ValidationError extends AppError {
  readonly code = 'VALIDATION_FAILED';
  readonly statusCode = 400;
}

/**
 * A named resource does not exist. `code` is supplied by the caller
 * (e.g. 'RUN_NOT_FOUND') so this stays generic across resource types
 * while keeping the exact error codes the API contract already documents.
 */
export class NotFoundError extends AppError {
  readonly statusCode = 404;

  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/** A state transition or write was rejected because the resource moved. */
export class ConflictError extends AppError {
  readonly code = 'CONFLICT';
  readonly statusCode = 409;
}

/** The local inference engine cannot currently serve a completion request. */
export class EngineUnavailableError extends AppError {
  readonly code = 'ENGINE_NOT_READY';
  readonly statusCode = 503;

  constructor(message = 'the local inference engine is not ready') {
    super(message);
  }
}
