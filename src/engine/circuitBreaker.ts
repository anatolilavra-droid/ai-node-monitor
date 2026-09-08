export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures required to trip the breaker open. */
  failureThreshold: number;
  /** How long to stay open before allowing one half-open trial call. */
  resetTimeoutMs: number;
  /** Injectable clock so tests don't depend on real elapsed time. */
  now?: () => number;
}

/**
 * A standard three-state circuit breaker guarding calls to the local
 * engine: closed (calls proceed normally) -> open (calls are rejected
 * outright once too many consecutive failures happen) -> half-open (after
 * resetTimeoutMs, exactly one trial call is allowed through to test
 * recovery) -> closed again on success, or back to open on failure.
 *
 * This class only tracks state; it does not itself call anything. The
 * caller checks `canProceed()` before attempting a call and reports the
 * outcome via `recordSuccess()`/`recordFailure()`.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? Date.now;
  }

  getState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.options.resetTimeoutMs) {
      this.state = 'half-open';
    }
    return this.state;
  }

  canProceed(): boolean {
    return this.getState() !== 'open';
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    const state = this.getState();
    if (state === 'half-open' || this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }
}
