import type { EnginePort, RunsRepositoryPort } from './ports.js';
import type { Run, RunStatus } from './types.js';
import { EngineUnavailableError } from './errors.js';
import { nextStatus } from './status.js';
import type { AppLogger } from '../logging/appLogger.js';
import type { EventBus } from '../telemetry/eventBus.js';
import type { AppEventMap } from '../telemetry/events.js';

export interface GenerationEvent {
  type: 'created' | 'status' | 'token' | 'completed' | 'failed' | 'cancelled';
  run: Run;
  token?: { token: string; index: number };
}

type EventSink = (event: GenerationEvent) => void;
type TerminalStatus = Extract<RunStatus, 'completed' | 'cancelled' | 'failed'>;

/**
 * Drives one run from queued to a terminal state. Pure domain logic: it
 * knows nothing about Fastify or SQL, only the RunsRepositoryPort and
 * EnginePort interfaces, so it can be exercised in a unit test against
 * fakes of both.
 *
 * Cancellation - whether from an explicit /runs/:id/cancel call or the
 * SSE handler noticing the client disconnected - always goes through the
 * same AbortController held here, so there is exactly one code path that
 * stops the upstream engine call and exactly one place that persists the
 * terminal status. That is what prevents an orphaned generation
 * continuing invisibly after the browser goes away.
 */
export class GenerationService {
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly repo: RunsRepositoryPort,
    private readonly engine: EnginePort,
    private readonly eventBus: EventBus<AppEventMap>,
    private readonly logger: AppLogger
  ) {}

  cancel(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async run(initialRun: Run, emit: EventSink): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(initialRun.id, controller);
    this.publish('created', initialRun, emit);

    // Declared outside the try block so the catch handler - reached when
    // cancellation surfaces as a thrown AbortError from the engine client
    // rather than a clean loop exit - can still persist whatever partial
    // output/tokenCount had accumulated before the abort landed.
    const startedNs = process.hrtime.bigint();
    let output = '';
    let tokenCount = 0;

    try {
      if (!this.engine.isReady()) {
        const unavailable = new EngineUnavailableError();
        this.persistTerminal(initialRun, 'fail', emit, { errorMessage: unavailable.code });
        return;
      }

      const targetStatus = nextStatus(initialRun.status, 'start');
      const transitioned = this.repo.transitionStatus(initialRun.id, initialRun.version, targetStatus, {
        startedAt: new Date().toISOString()
      });
      const afterTransition = this.repo.getById(initialRun.id)!;
      if (!transitioned) {
        // Already moved past 'queued' (e.g. cancelled before it could start).
        this.publish(afterTransition.status === 'cancelled' ? 'cancelled' : 'status', afterTransition, emit);
        return;
      }
      this.publish('status', afterTransition, emit);

      for await (const tok of this.engine.streamCompletion(
        { prompt: afterTransition.prompt, maxTokens: afterTransition.maxTokens },
        controller.signal
      )) {
        output += tok.token;
        tokenCount += 1;
        emit({ type: 'token', run: afterTransition, token: tok });
      }

      const durationMs = Math.round(Number(process.hrtime.bigint() - startedNs) / 1_000_000);
      const event = controller.signal.aborted ? 'cancel' : 'complete';
      this.persistTerminal(afterTransition, event, emit, { output, tokenCount, durationMs });
    } catch (err) {
      const current = this.repo.getById(initialRun.id) ?? initialRun;
      const durationMs = Math.round(Number(process.hrtime.bigint() - startedNs) / 1_000_000);
      if (controller.signal.aborted) {
        this.persistTerminal(current, 'cancel', emit, { output, tokenCount, durationMs });
        return;
      }
      this.logger.error({ err, runId: initialRun.id }, 'generation failed');
      this.persistTerminal(current, 'fail', emit, {
        output,
        tokenCount,
        durationMs,
        errorMessage: err instanceof Error ? err.message : 'unknown engine error'
      });
    } finally {
      this.controllers.delete(initialRun.id);
    }
  }

  private persistTerminal(
    run: Run,
    event: 'complete' | 'cancel' | 'fail',
    emit: EventSink,
    patch: { output?: string; tokenCount?: number; durationMs?: number; errorMessage?: string }
  ): void {
    const status = nextStatus(run.status, event) as TerminalStatus;
    this.repo.transitionStatus(run.id, run.version, status, {
      ...patch,
      finishedAt: new Date().toISOString()
    });
    const final = this.repo.getById(run.id)!;
    this.publish(status, final, emit);
  }

  private publish(type: GenerationEvent['type'], run: Run, emit: EventSink): void {
    emit({ type, run });
    this.logger.info({ runId: run.id, status: run.status }, 'run lifecycle event');

    switch (type) {
      case 'created':
        this.eventBus.emit('run.created', { runId: run.id, status: run.status, tokenCount: run.tokenCount });
        break;
      case 'status':
        this.eventBus.emit('run.status', { runId: run.id, status: run.status, tokenCount: run.tokenCount });
        break;
      case 'completed':
        this.eventBus.emit('run.completed', { runId: run.id, status: run.status, tokenCount: run.tokenCount });
        break;
      case 'cancelled':
        this.eventBus.emit('run.cancelled', { runId: run.id, status: run.status, tokenCount: run.tokenCount });
        break;
      case 'failed':
        this.eventBus.emit('run.failed', {
          runId: run.id,
          status: run.status,
          tokenCount: run.tokenCount,
          errorMessage: run.errorMessage ?? 'unknown error'
        });
        break;
      case 'token':
        break;
    }
  }
}
