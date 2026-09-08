import { describe, expect, it } from 'vitest';
import { GenerationService, type GenerationEvent } from '../../../src/domain/generationService.js';
import { EventBus } from '../../../src/telemetry/eventBus.js';
import type { AppEventMap } from '../../../src/telemetry/events.js';
import type { CreateRunInput, EnginePort, EngineToken, RunsRepositoryPort, StatusPatch } from '../../../src/domain/ports.js';
import type { Run, RunStatus } from '../../../src/domain/types.js';
import type { AppLogger } from '../../../src/logging/appLogger.js';

/**
 * An in-memory stand-in for RunsRepositoryPort - no SQLite involved. This
 * is the point of depending on the port instead of the concrete
 * RunsRepository: GenerationService's business logic is testable without
 * a database.
 */
class FakeRunsRepository implements RunsRepositoryPort {
  private readonly runs = new Map<string, Run>();
  private nextId = 1;

  createQueued(input: CreateRunInput): Run {
    const id = `run-${this.nextId++}`;
    const now = new Date().toISOString();
    const run: Run = {
      id,
      status: 'queued',
      model: input.model,
      prompt: input.prompt,
      maxTokens: input.maxTokens,
      output: '',
      tokenCount: 0,
      errorMessage: null,
      version: 0,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      durationMs: null
    };
    this.runs.set(id, run);
    return { ...run };
  }

  getById(id: string): Run | undefined {
    const run = this.runs.get(id);
    return run ? { ...run } : undefined;
  }

  list(): Run[] {
    return [...this.runs.values()].map((run) => ({ ...run }));
  }

  transitionStatus(id: string, expectedVersion: number, status: RunStatus, patch: StatusPatch = {}): boolean {
    const run = this.runs.get(id);
    if (!run || run.version !== expectedVersion) return false;
    this.runs.set(id, {
      ...run,
      status,
      version: run.version + 1,
      updatedAt: new Date().toISOString(),
      output: patch.output ?? run.output,
      tokenCount: patch.tokenCount ?? run.tokenCount,
      errorMessage: patch.errorMessage ?? run.errorMessage,
      startedAt: patch.startedAt ?? run.startedAt,
      finishedAt: patch.finishedAt ?? run.finishedAt,
      durationMs: patch.durationMs ?? run.durationMs
    });
    return true;
  }

  findIdempotentRunId(): string | undefined {
    return undefined;
  }

  createQueuedWithIdempotencyKey(_route: string, _key: string, input: CreateRunInput): Run {
    return this.createQueued(input);
  }
}

function noopLogger(): AppLogger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

/** An EnginePort that yields deterministic tokens and honors abort. */
class ScriptedEngine implements EnginePort {
  ready = true;

  isReady(): boolean {
    return this.ready;
  }

  async *streamCompletion(
    input: { prompt: string; maxTokens: number },
    signal: AbortSignal
  ): AsyncGenerator<EngineToken, void, void> {
    for (let i = 0; i < input.maxTokens; i += 1) {
      if (signal.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      yield { token: `t${i}`, index: i };
    }
  }
}

/** An EnginePort whose stream always fails with a genuine (non-abort) error. */
class FailingEngine implements EnginePort {
  isReady(): boolean {
    return true;
  }

  async *streamCompletion(): AsyncGenerator<EngineToken, void, void> {
    throw new Error('engine exploded');
  }
}

function collect(events: GenerationEvent[]) {
  return {
    types: events.map((e) => e.type),
    final: events.at(-1)?.run
  };
}

describe('GenerationService', () => {
  it('drives a run from queued to completed and publishes matching lifecycle events', async () => {
    const repo = new FakeRunsRepository();
    const eventBus = new EventBus<AppEventMap>();
    const service = new GenerationService(repo, new ScriptedEngine(), eventBus, noopLogger());
    const published: string[] = [];
    eventBus.on('run.completed', (payload) => published.push(`completed:${payload.tokenCount}`));

    const run = repo.createQueued({ model: 'm', prompt: 'hi', maxTokens: 3 });
    const events: GenerationEvent[] = [];
    await service.run(run, (e) => events.push(e));

    const { types, final } = collect(events);
    expect(types).toEqual(['created', 'status', 'token', 'token', 'token', 'completed']);
    expect(final?.status).toBe('completed');
    expect(final?.tokenCount).toBe(3);
    expect(final?.output).toBe('t0t1t2');
    expect(published).toEqual(['completed:3']);
  });

  it('fails the run closed with ENGINE_NOT_READY when the engine reports not ready, without calling it', async () => {
    const repo = new FakeRunsRepository();
    const engine = new ScriptedEngine();
    engine.ready = false;
    const service = new GenerationService(repo, engine, new EventBus<AppEventMap>(), noopLogger());

    const run = repo.createQueued({ model: 'm', prompt: 'hi', maxTokens: 3 });
    const events: GenerationEvent[] = [];
    await service.run(run, (e) => events.push(e));

    const { types, final } = collect(events);
    expect(types).toEqual(['created', 'failed']);
    expect(final?.status).toBe('failed');
    expect(final?.errorMessage).toBe('ENGINE_NOT_READY');
  });

  it('cancelling mid-stream persists partial output and ends in cancelled, not failed', async () => {
    const repo = new FakeRunsRepository();
    const service = new GenerationService(repo, new ScriptedEngine(), new EventBus<AppEventMap>(), noopLogger());

    const run = repo.createQueued({ model: 'm', prompt: 'hi', maxTokens: 100 });
    const events: GenerationEvent[] = [];
    let tokensSeen = 0;

    await service.run(run, (e) => {
      events.push(e);
      if (e.type === 'token') {
        tokensSeen += 1;
        if (tokensSeen === 2) service.cancel(run.id);
      }
    });

    const { types, final } = collect(events);
    expect(types.at(-1)).toBe('cancelled');
    expect(types.filter((t) => t === 'token')).toHaveLength(2);
    expect(final?.status).toBe('cancelled');
    expect(final?.tokenCount).toBe(2);
    expect(final?.output).toBe('t0t1');
  });

  it('a genuine engine error (not an abort) ends the run in failed with the error message', async () => {
    const repo = new FakeRunsRepository();
    const service = new GenerationService(repo, new FailingEngine(), new EventBus<AppEventMap>(), noopLogger());

    const run = repo.createQueued({ model: 'm', prompt: 'hi', maxTokens: 5 });
    const events: GenerationEvent[] = [];
    await service.run(run, (e) => events.push(e));

    const { types, final } = collect(events);
    expect(types).toEqual(['created', 'status', 'failed']);
    expect(final?.status).toBe('failed');
    expect(final?.errorMessage).toBe('engine exploded');
  });

  it('cancel() on an unknown run id is a harmless no-op', () => {
    const repo = new FakeRunsRepository();
    const service = new GenerationService(repo, new ScriptedEngine(), new EventBus<AppEventMap>(), noopLogger());
    expect(service.cancel('does-not-exist')).toBe(false);
  });

  it('cancel() after the run has already finished is a harmless no-op', async () => {
    const repo = new FakeRunsRepository();
    const service = new GenerationService(repo, new ScriptedEngine(), new EventBus<AppEventMap>(), noopLogger());
    const run = repo.createQueued({ model: 'm', prompt: 'hi', maxTokens: 1 });

    await service.run(run, () => undefined);

    expect(service.cancel(run.id)).toBe(false);
  });
});
