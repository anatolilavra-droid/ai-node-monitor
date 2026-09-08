import type { RunStatus } from '../domain/types.js';
import type { CircuitState } from '../engine/circuitBreaker.js';

/**
 * Telemetry payloads are deliberately thin: runId, status, and counts
 * only - never `prompt` or `output`. Non-negotiable #7 (no prompts or
 * completions in logs) applies just as much to anything published on the
 * event bus, since a future subscriber could log or export it.
 */
export interface RunLifecyclePayload {
  runId: string;
  status: RunStatus;
  tokenCount: number;
}

export interface RunFailedPayload extends RunLifecyclePayload {
  errorMessage: string;
}

export interface EngineCircuitPayload {
  state: CircuitState;
}

export interface AppEventMap extends Record<string, unknown> {
  'run.created': RunLifecyclePayload;
  'run.status': RunLifecyclePayload;
  'run.completed': RunLifecyclePayload;
  'run.cancelled': RunLifecyclePayload;
  'run.failed': RunFailedPayload;
  'engine.circuit': EngineCircuitPayload;
}
