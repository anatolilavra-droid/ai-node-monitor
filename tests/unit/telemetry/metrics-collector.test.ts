import { describe, expect, it } from 'vitest';
import { EventBus } from '../../../src/telemetry/eventBus.js';
import { MetricsCollector } from '../../../src/telemetry/metricsCollector.js';
import type { AppEventMap } from '../../../src/telemetry/events.js';

function payload(overrides: Partial<AppEventMap['run.created']> = {}): AppEventMap['run.created'] {
  return { runId: 'r1', status: 'queued', tokenCount: 0, ...overrides };
}

describe('MetricsCollector', () => {
  it('starts at zero for every counter', () => {
    const collector = new MetricsCollector(new EventBus<AppEventMap>());
    expect(collector.getSnapshot()).toEqual({
      runsCreated: 0,
      runsCompleted: 0,
      runsCancelled: 0,
      runsFailed: 0,
      engineCircuitOpenTransitions: 0
    });
  });

  it('counts each lifecycle event independently', () => {
    const bus = new EventBus<AppEventMap>();
    const collector = new MetricsCollector(bus);

    bus.emit('run.created', payload());
    bus.emit('run.created', payload({ runId: 'r2' }));
    bus.emit('run.completed', payload({ status: 'completed' }));
    bus.emit('run.cancelled', payload({ status: 'cancelled' }));
    bus.emit('run.failed', { ...payload({ status: 'failed' }), errorMessage: 'boom' });

    expect(collector.getSnapshot()).toEqual({
      runsCreated: 2,
      runsCompleted: 1,
      runsCancelled: 1,
      runsFailed: 1,
      engineCircuitOpenTransitions: 0
    });
  });

  it('counts a circuit breaker opening but not closing or half-opening', () => {
    const bus = new EventBus<AppEventMap>();
    const collector = new MetricsCollector(bus);

    bus.emit('engine.circuit', { state: 'open' });
    bus.emit('engine.circuit', { state: 'half-open' });
    bus.emit('engine.circuit', { state: 'closed' });
    bus.emit('engine.circuit', { state: 'open' });

    expect(collector.getSnapshot().engineCircuitOpenTransitions).toBe(2);
  });

  it('does not mutate a previously returned snapshot on later events (each call is a fresh copy)', () => {
    const bus = new EventBus<AppEventMap>();
    const collector = new MetricsCollector(bus);

    const before = collector.getSnapshot();
    bus.emit('run.created', payload());
    const after = collector.getSnapshot();

    expect(before.runsCreated).toBe(0);
    expect(after.runsCreated).toBe(1);
  });
});
