import { describe, expect, it, vi } from 'vitest';
import { RetryPolicy } from '../../../src/engine/retryPolicy.js';

/** Never actually waits, but records every requested delay for assertions. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    }
  };
}

describe('RetryPolicy', () => {
  it('returns the result immediately on a first-try success, without sleeping', async () => {
    const { sleep, delays } = recordingSleep();
    const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 1000, sleep });

    const fn = vi.fn().mockResolvedValue('ok');
    const result = await policy.execute(fn);

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('retries a failing call until it succeeds, within maxAttempts', async () => {
    const { sleep, delays } = recordingSleep();
    const policy = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 1000, sleep });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('ok');

    const result = await policy.execute(fn);

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([10, 20]);
  });

  it('applies exponential backoff capped at maxDelayMs', async () => {
    const { sleep, delays } = recordingSleep();
    const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 250, sleep });

    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(policy.execute(fn)).rejects.toThrow('always fails');

    // 100, 200, then capped at 250 for the remaining retries.
    expect(delays).toEqual([100, 200, 250, 250]);
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('throws the last error once maxAttempts is exhausted', async () => {
    const { sleep } = recordingSleep();
    const policy = new RetryPolicy({ maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 100, sleep });

    const fn = vi.fn().mockRejectedValueOnce(new Error('first')).mockRejectedValueOnce(new Error('second'));

    await expect(policy.execute(fn)).rejects.toThrow('second');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('fails fast without retrying when isRetryable returns false', async () => {
    const { sleep, delays } = recordingSleep();
    const policy = new RetryPolicy({
      maxAttempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 100,
      sleep,
      isRetryable: (err) => !(err instanceof Error && err.name === 'AbortError')
    });

    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const fn = vi.fn().mockRejectedValue(abortError);

    await expect(policy.execute(fn)).rejects.toThrow('aborted');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('never calls the operation more than maxAttempts times, even with a maxAttempts of 1', async () => {
    const { sleep } = recordingSleep();
    const policy = new RetryPolicy({ maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 100, sleep });

    const fn = vi.fn().mockRejectedValue(new Error('nope'));
    await expect(policy.execute(fn)).rejects.toThrow('nope');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
