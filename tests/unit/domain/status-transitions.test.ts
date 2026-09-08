import { describe, expect, it } from 'vitest';
import { nextStatus, isTerminal, TERMINAL_STATUSES, type RunEvent } from '../../../src/domain/status.js';
import { ConflictError } from '../../../src/domain/errors.js';
import { RUN_STATUSES, type RunStatus } from '../../../src/domain/types.js';

const EVENTS: RunEvent[] = ['start', 'complete', 'cancel', 'fail'];

describe('isTerminal', () => {
  it('flags completed, cancelled, and failed as terminal', () => {
    expect(TERMINAL_STATUSES).toEqual(['completed', 'cancelled', 'failed']);
    for (const status of TERMINAL_STATUSES) {
      expect(isTerminal(status)).toBe(true);
    }
  });

  it('flags queued and running as non-terminal', () => {
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('running')).toBe(false);
  });
});

describe('nextStatus', () => {
  it('queued --start--> running', () => {
    expect(nextStatus('queued', 'start')).toBe('running');
  });

  it('running --complete--> completed', () => {
    expect(nextStatus('running', 'complete')).toBe('completed');
  });

  it('queued --cancel--> cancelled', () => {
    expect(nextStatus('queued', 'cancel')).toBe('cancelled');
  });

  it('running --cancel--> cancelled', () => {
    expect(nextStatus('running', 'cancel')).toBe('cancelled');
  });

  it('queued --fail--> failed', () => {
    expect(nextStatus('queued', 'fail')).toBe('failed');
  });

  it('running --fail--> failed', () => {
    expect(nextStatus('running', 'fail')).toBe('failed');
  });

  it('rejects completing a run that never started', () => {
    expect(() => nextStatus('queued', 'complete')).toThrow(ConflictError);
  });

  it('rejects starting a run that already started', () => {
    expect(() => nextStatus('running', 'start')).toThrow(ConflictError);
  });

  it.each(TERMINAL_STATUSES)('rejects every event once a run is terminal (%s)', (status) => {
    for (const event of EVENTS) {
      expect(() => nextStatus(status, event)).toThrow(ConflictError);
    }
  });

  it('the error message names both the offending event and the current status', () => {
    expect.assertions(3);
    try {
      nextStatus('completed', 'start');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as Error).message).toContain('start');
      expect((err as Error).message).toContain('completed');
    }
  });

  it('exhaustively agrees with a hand-written transition table for every (status, event) pair', () => {
    const expected: Record<RunStatus, Partial<Record<RunEvent, RunStatus>>> = {
      queued: { start: 'running', cancel: 'cancelled', fail: 'failed' },
      running: { complete: 'completed', cancel: 'cancelled', fail: 'failed' },
      completed: {},
      cancelled: {},
      failed: {}
    };

    for (const status of RUN_STATUSES) {
      for (const event of EVENTS) {
        const allowed = expected[status][event];
        if (allowed) {
          expect(nextStatus(status, event)).toBe(allowed);
        } else {
          expect(() => nextStatus(status, event)).toThrow(ConflictError);
        }
      }
    }
  });
});
