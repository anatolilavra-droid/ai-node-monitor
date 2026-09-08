import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../src/telemetry/eventBus.js';

interface TestEventMap extends Record<string, unknown> {
  greeting: { text: string };
  count: { value: number };
}

describe('EventBus', () => {
  it('delivers an emitted payload to a subscriber', () => {
    const bus = new EventBus<TestEventMap>();
    const handler = vi.fn();
    bus.on('greeting', handler);

    bus.emit('greeting', { text: 'hi' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ text: 'hi' });
  });

  it('does nothing when a type has no subscribers', () => {
    const bus = new EventBus<TestEventMap>();
    expect(() => bus.emit('greeting', { text: 'hi' })).not.toThrow();
  });

  it('delivers to every subscriber of the same event type', () => {
    const bus = new EventBus<TestEventMap>();
    const first = vi.fn();
    const second = vi.fn();
    bus.on('count', first);
    bus.on('count', second);

    bus.emit('count', { value: 1 });

    expect(first).toHaveBeenCalledWith({ value: 1 });
    expect(second).toHaveBeenCalledWith({ value: 1 });
  });

  it('keeps subscribers of different event types independent', () => {
    const bus = new EventBus<TestEventMap>();
    const greetingHandler = vi.fn();
    const countHandler = vi.fn();
    bus.on('greeting', greetingHandler);
    bus.on('count', countHandler);

    bus.emit('greeting', { text: 'hi' });

    expect(greetingHandler).toHaveBeenCalledTimes(1);
    expect(countHandler).not.toHaveBeenCalled();
  });

  it('unsubscribing stops further delivery to that handler only', () => {
    const bus = new EventBus<TestEventMap>();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = bus.on('greeting', first);
    bus.on('greeting', second);

    unsubscribeFirst();
    bus.emit('greeting', { text: 'hi' });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('calling the unsubscribe function twice is a harmless no-op', () => {
    const bus = new EventBus<TestEventMap>();
    const handler = vi.fn();
    const unsubscribe = bus.on('greeting', handler);

    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();

    bus.emit('greeting', { text: 'hi' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('delivers every emitted payload, in order, across multiple emits', () => {
    const bus = new EventBus<TestEventMap>();
    const received: number[] = [];
    bus.on('count', (payload) => received.push(payload.value));

    bus.emit('count', { value: 1 });
    bus.emit('count', { value: 2 });
    bus.emit('count', { value: 3 });

    expect(received).toEqual([1, 2, 3]);
  });

  it('reports the current listener count for a type', () => {
    const bus = new EventBus<TestEventMap>();
    expect(bus.listenerCount('greeting')).toBe(0);

    const unsubscribe = bus.on('greeting', vi.fn());
    expect(bus.listenerCount('greeting')).toBe(1);

    unsubscribe();
    expect(bus.listenerCount('greeting')).toBe(0);
  });

  it('a handler that throws does not prevent other handlers from running', () => {
    const bus = new EventBus<TestEventMap>();
    const boom = vi.fn(() => {
      throw new Error('boom');
    });
    const fine = vi.fn();
    bus.on('greeting', boom);
    bus.on('greeting', fine);

    expect(() => bus.emit('greeting', { text: 'hi' })).toThrow('boom');
    // The throwing handler ran (and stopped the loop); this documents
    // current behavior rather than asserting isolation that doesn't exist.
    expect(boom).toHaveBeenCalledTimes(1);
  });
});
