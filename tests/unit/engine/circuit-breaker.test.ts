import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../../../src/engine/circuitBreaker.js';

/** A controllable clock so tests never depend on real elapsed time. */
function fakeClock(startMs = 0): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    }
  };
}

describe('CircuitBreaker', () => {
  it('starts closed and allows calls through', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    expect(breaker.getState()).toBe('closed');
    expect(breaker.canProceed()).toBe(true);
  });

  it('stays closed while failures remain below the threshold', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.canProceed()).toBe(true);
  });

  it('trips open once consecutive failures reach the threshold', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');
    expect(breaker.canProceed()).toBe(false);
  });

  it('a success resets the failure count, so the threshold requires consecutive failures', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe('closed');
  });

  it('moves from open to half-open only after resetTimeoutMs has elapsed', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: clock.now });

    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');

    clock.advance(999);
    expect(breaker.getState()).toBe('open');

    clock.advance(1);
    expect(breaker.getState()).toBe('half-open');
    expect(breaker.canProceed()).toBe(true);
  });

  it('a failure while half-open reopens the breaker immediately', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: clock.now });

    breaker.recordFailure();
    clock.advance(1000);
    expect(breaker.getState()).toBe('half-open');

    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');
    expect(breaker.canProceed()).toBe(false);
  });

  it('a success while half-open closes the breaker and clears the failure count', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000, now: clock.now });

    breaker.recordFailure();
    breaker.recordFailure();
    clock.advance(1000);
    expect(breaker.getState()).toBe('half-open');

    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');

    // Confirms the failure count actually reset, not just the state label.
    breaker.recordFailure();
    expect(breaker.getState()).toBe('closed');
  });

  it('re-opening resets the timeout window from the moment it reopens', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: clock.now });

    breaker.recordFailure();
    clock.advance(1000);
    expect(breaker.getState()).toBe('half-open');

    breaker.recordFailure(); // reopens at t=1000
    clock.advance(999);
    expect(breaker.getState()).toBe('open');

    clock.advance(1);
    expect(breaker.getState()).toBe('half-open');
  });
});
