import { streamCompletion } from '../engine/engineClient.js';
import type { EngineManager } from '../engine/engineManager.js';
import type { RunsRepository } from '../repositories/runsRepository.js';
import type { Run } from '../domain/types.js';
import type { AppLogger } from '../logging/appLogger.js';

export interface GenerationEvent {
  type: 'created' | 'status' | 'token' | 'completed' | 'failed' | 'cancelled';
  run: Run;
  token?: { token: string; index: number };
}

type EventSink = (event: GenerationEvent) => void;

/**
 * Drives one run from queued to a terminal state. Cancellation - whether
 * from an explicit /runs/:id/cancel call or the SSE handler noticing the
 * client disconnected - always goes through the same AbortController held
 * here, so there is exactly one code path that stops the upstream engine
 * call and exactly one place that persists the terminal status. That is
 * what prevents an orphaned generation continuing invisibly after the
 * browser goes away.
 */
export class GenerationService {
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly repo: RunsRepository,
    private readonly engine: EngineManager,
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
    emit({ type: 'created', run: initialRun });

    // Declared outside the try block so the catch handler - reached when
    // cancellation surfaces as a thrown AbortError from streamCompletion
    // rather than a clean loop exit - can still persist whatever partial
    // output/tokenCount had accumulated before the abort landed.
    const startedNs = process.hrtime.bigint();
    let output = '';
    let tokenCount = 0;

    try {
      if (!this.engine.isReady()) {
        this.persistTerminal(initialRun, 'failed', emit, { errorMessage: 'ENGINE_NOT_READY' });
        return;
      }

      const running = this.repo.transitionStatus(initialRun.id, initialRun.version, 'running', {
        startedAt: new Date().toISOString()
      });
      const afterTransition = this.repo.getById(initialRun.id)!;
      if (!running) {
        // Already moved past 'queued' (e.g. cancelled before it could start).
        emit({ type: afterTransition.status === 'cancelled' ? 'cancelled' : 'status', run: afterTransition });
        return;
      }
      emit({ type: 'status', run: afterTransition });

      for await (const tok of streamCompletion(
        this.engine.getBaseUrl(),
        { prompt: afterTransition.prompt, maxTokens: afterTransition.maxTokens },
        controller.signal
      )) {
        output += tok.token;
        tokenCount += 1;
        emit({ type: 'token', run: afterTransition, token: tok });
      }

      const durationMs = Math.round(Number(process.hrtime.bigint() - startedNs) / 1_000_000);
      const status = controller.signal.aborted ? 'cancelled' : 'completed';
      this.persistTerminal(afterTransition, status, emit, { output, tokenCount, durationMs });
    } catch (err) {
      const current = this.repo.getById(initialRun.id) ?? initialRun;
      const durationMs = Math.round(Number(process.hrtime.bigint() - startedNs) / 1_000_000);
      if (controller.signal.aborted) {
        this.persistTerminal(current, 'cancelled', emit, { output, tokenCount, durationMs });
        return;
      }
      this.logger.error({ err, runId: initialRun.id }, 'generation failed');
      this.persistTerminal(current, 'failed', emit, {
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
    status: 'completed' | 'cancelled' | 'failed',
    emit: EventSink,
    patch: { output?: string; tokenCount?: number; durationMs?: number; errorMessage?: string }
  ): void {
    this.repo.transitionStatus(run.id, run.version, status, {
      ...patch,
      finishedAt: new Date().toISOString()
    });
    const final = this.repo.getById(run.id)!;
    emit({ type: status, run: final });
  }
}
