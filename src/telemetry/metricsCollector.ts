import type { EventBus } from './eventBus.js';
import type { AppEventMap } from './events.js';

export interface MetricsSnapshot {
  runsCreated: number;
  runsCompleted: number;
  runsCancelled: number;
  runsFailed: number;
  engineCircuitOpenTransitions: number;
}

/**
 * Aggregates run-lifecycle and engine-circuit events into in-process
 * counters. Not exposed over HTTP (the API contract in docs/CONTRACT.md
 * is stable and unchanged) - this is read via AppState.getState() for
 * structured shutdown logging and tests, and is the natural place to hang
 * a future /metrics route without touching GenerationService again.
 */
export class MetricsCollector {
  private runsCreated = 0;
  private runsCompleted = 0;
  private runsCancelled = 0;
  private runsFailed = 0;
  private engineCircuitOpenTransitions = 0;

  constructor(eventBus: EventBus<AppEventMap>) {
    eventBus.on('run.created', () => {
      this.runsCreated += 1;
    });
    eventBus.on('run.completed', () => {
      this.runsCompleted += 1;
    });
    eventBus.on('run.cancelled', () => {
      this.runsCancelled += 1;
    });
    eventBus.on('run.failed', () => {
      this.runsFailed += 1;
    });
    eventBus.on('engine.circuit', (payload) => {
      if (payload.state === 'open') this.engineCircuitOpenTransitions += 1;
    });
  }

  getSnapshot(): MetricsSnapshot {
    return {
      runsCreated: this.runsCreated,
      runsCompleted: this.runsCompleted,
      runsCancelled: this.runsCancelled,
      runsFailed: this.runsFailed,
      engineCircuitOpenTransitions: this.engineCircuitOpenTransitions
    };
  }
}
