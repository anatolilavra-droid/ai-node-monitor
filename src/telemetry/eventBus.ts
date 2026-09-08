type Listener = (payload: unknown) => void;

/**
 * A minimal typed publish/subscribe bus. `EventMap` pins down which event
 * names exist and what payload each carries, so `on`/`emit` call sites
 * stay type-checked even though storage internally is untyped (there is
 * no way to keep a single `Map` precisely typed per key without `any`).
 *
 * Subscribers are meant to be long-lived (registered once at startup,
 * e.g. by MetricsCollector) rather than per-request, so there is no
 * unbounded growth: `on` returns an unsubscribe function for the rare
 * case a caller does need to detach.
 */
export class EventBus<EventMap extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof EventMap, Set<Listener>>();

  on<K extends keyof EventMap>(type: K, handler: (payload: EventMap[K]) => void): () => void {
    const existing = this.listeners.get(type);
    const set = existing ?? new Set<Listener>();
    set.add(handler as Listener);
    if (!existing) this.listeners.set(type, set);

    return (): void => {
      set.delete(handler as Listener);
    };
  }

  emit<K extends keyof EventMap>(type: K, payload: EventMap[K]): void {
    const set = this.listeners.get(type);
    if (!set || set.size === 0) return;
    // Snapshot before iterating: a handler that unsubscribes itself (or
    // another listener) during emit must not mutate the set mid-iteration.
    for (const handler of [...set]) {
      handler(payload);
    }
  }

  listenerCount<K extends keyof EventMap>(type: K): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}
