import type { RunStatus } from './types.js';
import { ConflictError } from './errors.js';

export const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'cancelled', 'failed'];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * The run lifecycle as a pure state machine, independent of SQL or HTTP:
 *
 *   queued --start--> running --complete--> completed
 *      |                  |
 *      +---cancel/fail----+---cancel/fail--> cancelled | failed
 *
 * completed/cancelled/failed are terminal - no event moves a run out of
 * them. This is the single source of truth for "is this transition legal";
 * GenerationService calls it instead of hardcoding status string literals
 * at each call site, and RunsRepository.transitionStatus stays a dumb,
 * version-guarded SQL write that trusts the status it's given.
 */
export type RunEvent = 'start' | 'complete' | 'cancel' | 'fail';

const ALLOWED_TRANSITIONS: Record<RunEvent, { from: readonly RunStatus[]; to: RunStatus }> = {
  start: { from: ['queued'], to: 'running' },
  complete: { from: ['running'], to: 'completed' },
  cancel: { from: ['queued', 'running'], to: 'cancelled' },
  fail: { from: ['queued', 'running'], to: 'failed' }
};

/**
 * Computes the status `event` moves `current` to, or throws ConflictError
 * if that transition isn't legal (e.g. completing an already-cancelled
 * run). Throwing here means a bug that tries an illegal transition is
 * caught at the point of the mistake, in a pure unit test, rather than
 * silently corrupting a persisted run.
 */
export function nextStatus(current: RunStatus, event: RunEvent): RunStatus {
  const transition = ALLOWED_TRANSITIONS[event];
  if (!transition.from.includes(current)) {
    throw new ConflictError(`cannot apply event "${event}" to a run in status "${current}"`);
  }
  return transition.to;
}
