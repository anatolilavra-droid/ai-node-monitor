import type { EnginePort, EngineToken } from '../domain/ports.js';
import type { AppLogger } from '../logging/appLogger.js';
import type { EventBus } from '../telemetry/eventBus.js';
import type { AppEventMap } from '../telemetry/events.js';
import { CircuitBreaker } from './circuitBreaker.js';
import { connectCompletion, consumeCompletion } from './engineClient.js';
import type { EngineManager } from './engineManager.js';
import { RetryPolicy } from './retryPolicy.js';

export interface ResilientEngineClientOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  maxConnectAttempts?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

const DEFAULTS: Required<ResilientEngineClientOptions> = {
  failureThreshold: 3,
  resetTimeoutMs: 5_000,
  maxConnectAttempts: 3,
  baseRetryDelayMs: 50,
  maxRetryDelayMs: 1_000
};

/**
 * The EnginePort implementation GenerationService actually uses in
 * production: process-level readiness from EngineManager, gated by a
 * circuit breaker that trips after repeated connection failures, with the
 * initial connection attempt (only - never the token stream itself)
 * retried with exponential backoff.
 *
 * Cancellation is never treated as a failure: an AbortError means the
 * caller (or a client disconnect) asked to stop, not that the engine is
 * unhealthy, so it skips both the retry loop and the circuit breaker.
 */
export class ResilientEngineClient implements EnginePort {
  private readonly circuitBreaker: CircuitBreaker;
  private readonly retryPolicy: RetryPolicy;

  constructor(
    private readonly engineManager: EngineManager,
    private readonly eventBus: EventBus<AppEventMap>,
    private readonly logger: AppLogger,
    options: ResilientEngineClientOptions = {}
  ) {
    const resolved = { ...DEFAULTS, ...options };
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: resolved.failureThreshold,
      resetTimeoutMs: resolved.resetTimeoutMs
    });
    this.retryPolicy = new RetryPolicy({
      maxAttempts: resolved.maxConnectAttempts,
      baseDelayMs: resolved.baseRetryDelayMs,
      maxDelayMs: resolved.maxRetryDelayMs,
      isRetryable: (err) => !isAbortError(err)
    });
  }

  isReady(): boolean {
    return this.engineManager.isReady() && this.circuitBreaker.canProceed();
  }

  async *streamCompletion(
    input: { prompt: string; maxTokens: number },
    signal: AbortSignal
  ): AsyncGenerator<EngineToken, void, void> {
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = await this.retryPolicy.execute(() => connectCompletion(this.engineManager.getBaseUrl(), input, signal));
    } catch (err) {
      this.recordOutcome(false, err);
      throw err;
    }
    this.recordOutcome(true);

    try {
      yield* consumeCompletion(reader);
    } catch (err) {
      this.recordOutcome(false, err);
      throw err;
    }
  }

  private recordOutcome(success: boolean, err?: unknown): void {
    if (!success && isAbortError(err)) return;

    const before = this.circuitBreaker.getState();
    if (success) {
      this.circuitBreaker.recordSuccess();
    } else {
      this.circuitBreaker.recordFailure();
    }
    const after = this.circuitBreaker.getState();

    if (after !== before) {
      this.logger.warn({ from: before, to: after }, 'engine circuit breaker state changed');
      this.eventBus.emit('engine.circuit', { state: after });
    }
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
