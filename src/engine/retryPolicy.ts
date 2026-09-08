export interface RetryOptions {
  /** Total attempts including the first call, >= 1. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Defaults to "retry everything". Return false to fail fast. */
  isRetryable?: (err: unknown) => boolean;
  /** Injectable so tests don't spend real wall-clock time waiting. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries a failing async operation with exponential backoff
 * (baseDelayMs * 2^attempt, capped at maxDelayMs). Used only for the
 * local engine's initial connection attempt - retrying after a completion
 * stream has already yielded tokens would duplicate output, so
 * ResilientEngineClient never wraps the token-consuming half of a call
 * with this.
 */
export class RetryPolicy {
  constructor(private readonly options: RetryOptions) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const { maxAttempts, baseDelayMs, maxDelayMs, isRetryable = () => true, sleep = defaultSleep } = this.options;

    let attempt = 0;
    // Populated on the first failure; execute() only reaches the throw
    // below after at least one failed attempt, so this is never read
    // while still undefined.
    let lastError: unknown;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt >= maxAttempts || !isRetryable(err)) {
          throw err;
        }
        const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
        await sleep(delay);
      }
    }

    throw lastError;
  }
}
