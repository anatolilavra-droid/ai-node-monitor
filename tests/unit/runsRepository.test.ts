import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunsRepository } from '../../src/repositories/runsRepository.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(join(__dirname, '..', '..', 'db', 'migrations', '0001_init.sql'), 'utf8');

let db: Database.Database;
let repo: RunsRepository;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATION_SQL);
  repo = new RunsRepository(db);
});

afterEach(() => {
  db.close();
});

describe('RunsRepository', () => {
  it('creates a queued run with version 0', () => {
    const run = repo.createQueued({ model: 'm', prompt: 'hi', maxTokens: 10 });
    expect(run.status).toBe('queued');
    expect(run.version).toBe(0);
    expect(run.tokenCount).toBe(0);
  });

  it('applies a status transition and bumps the version', () => {
    const run = repo.createQueued({ model: 'm', prompt: 'hi', maxTokens: 10 });
    const ok = repo.transitionStatus(run.id, 0, 'running', { startedAt: new Date().toISOString() });
    expect(ok).toBe(true);

    const updated = repo.getById(run.id)!;
    expect(updated.status).toBe('running');
    expect(updated.version).toBe(1);
  });

  it('rejects a transition against a stale version (optimistic concurrency)', () => {
    const run = repo.createQueued({ model: 'm', prompt: 'hi', maxTokens: 10 });
    const first = repo.transitionStatus(run.id, 0, 'running');
    expect(first).toBe(true);

    // Same expectedVersion (0) reused - simulates a second writer that
    // read the row before the first transition committed.
    const second = repo.transitionStatus(run.id, 0, 'cancelled');
    expect(second).toBe(false);
    expect(repo.getById(run.id)!.status).toBe('running');
  });

  it('records an idempotency key alongside run creation and looks it up', () => {
    const run = repo.createQueuedWithIdempotencyKey('POST /generate', 'key-1', {
      model: 'm',
      prompt: 'hi',
      maxTokens: 10
    });

    expect(repo.findIdempotentRunId('POST /generate', 'key-1')).toBe(run.id);
    expect(repo.findIdempotentRunId('POST /generate', 'key-2')).toBeUndefined();
  });

  it('rejects reusing the same idempotency key twice on the same route', () => {
    repo.createQueuedWithIdempotencyKey('POST /generate', 'dup', { model: 'm', prompt: 'a', maxTokens: 1 });
    expect(() =>
      repo.createQueuedWithIdempotencyKey('POST /generate', 'dup', { model: 'm', prompt: 'b', maxTokens: 1 })
    ).toThrow();
  });

  it('paginates the run list newest first', () => {
    const a = repo.createQueued({ model: 'm', prompt: 'a', maxTokens: 1 });
    const b = repo.createQueued({ model: 'm', prompt: 'b', maxTokens: 1 });
    const list = repo.list(10, 0);
    expect(list.map((r) => r.id)).toEqual([b.id, a.id]);
  });
});
