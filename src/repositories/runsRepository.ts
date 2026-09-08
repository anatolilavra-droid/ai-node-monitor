import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { runFromRow, type Run, type RunRow, type RunStatus } from '../domain/types.js';

export interface CreateRunInput {
  model: string;
  prompt: string;
  maxTokens: number;
}

export interface AppendTokenResult {
  updated: boolean;
}

export class RunsRepository {
  constructor(private readonly db: Database.Database) {}

  createQueued(input: CreateRunInput): Run {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO runs (id, status, model, prompt, max_tokens, output, token_count, version, created_at, updated_at)
         VALUES (@id, 'queued', @model, @prompt, @maxTokens, '', 0, 0, @now, @now)`
      )
      .run({ id, model: input.model, prompt: input.prompt, maxTokens: input.maxTokens, now });
    return this.getById(id)!;
  }

  getById(id: string): Run | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? runFromRow(row) : undefined;
  }

  list(limit: number, offset: number): Run[] {
    const rows = this.db
      .prepare('SELECT * FROM runs ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as RunRow[];
    return rows.map(runFromRow);
  }

  /**
   * Optimistic-concurrency transition: only applies when the row is still
   * at `expectedVersion`. Returns false (no-op) if another writer already
   * moved the run past that version, e.g. a concurrent cancel racing the
   * generation loop's own completion update.
   */
  transitionStatus(
    id: string,
    expectedVersion: number,
    status: RunStatus,
    patch: Partial<Pick<Run, 'output' | 'tokenCount' | 'errorMessage' | 'startedAt' | 'finishedAt' | 'durationMs'>> = {}
  ): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE runs
         SET status = @status,
             version = version + 1,
             updated_at = @now,
             output = COALESCE(@output, output),
             token_count = COALESCE(@tokenCount, token_count),
             error_message = COALESCE(@errorMessage, error_message),
             started_at = COALESCE(@startedAt, started_at),
             finished_at = COALESCE(@finishedAt, finished_at),
             duration_ms = COALESCE(@durationMs, duration_ms)
         WHERE id = @id AND version = @expectedVersion`
      )
      .run({
        id,
        status,
        now,
        expectedVersion,
        output: patch.output ?? null,
        tokenCount: patch.tokenCount ?? null,
        errorMessage: patch.errorMessage ?? null,
        startedAt: patch.startedAt ?? null,
        finishedAt: patch.finishedAt ?? null,
        durationMs: patch.durationMs ?? null
      });
    return result.changes === 1;
  }

  findIdempotentRunId(route: string, idempotencyKey: string): string | undefined {
    const row = this.db
      .prepare('SELECT run_id FROM idempotency_keys WHERE route = ? AND idempotency_key = ?')
      .get(route, idempotencyKey) as { run_id: string } | undefined;
    return row?.run_id;
  }

  /**
   * Records the run created for (route, idempotencyKey) inside the same
   * transaction as the insert that created it, so a crash between the two
   * statements is impossible.
   */
  createQueuedWithIdempotencyKey(route: string, idempotencyKey: string, input: CreateRunInput): Run {
    const create = this.db.transaction((): Run => {
      const run = this.createQueued(input);
      const now = new Date().toISOString();
      this.db
        .prepare('INSERT INTO idempotency_keys (route, idempotency_key, run_id, created_at) VALUES (?, ?, ?, ?)')
        .run(route, idempotencyKey, run.id, now);
      return run;
    });
    return create();
  }
}
