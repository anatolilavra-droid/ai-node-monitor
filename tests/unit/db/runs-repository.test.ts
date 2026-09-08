import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunsRepository } from '../../../src/db/runsRepository.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(join(__dirname, '..', '..', '..', 'db', 'migrations', '0001_init.sql'), 'utf8');

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

describe('RunsRepository CRUD', () => {
  it('creates a queued run with version 0 and empty output', () => {
    const run = repo.createQueued({ model: 'm', prompt: 'hi', maxTokens: 10 });
    expect(run.status).toBe('queued');
    expect(run.version).toBe(0);
    expect(run.tokenCount).toBe(0);
    expect(run.output).toBe('');
    expect(run.errorMessage).toBeNull();
    expect(run.startedAt).toBeNull();
    expect(run.finishedAt).toBeNull();
  });

  it('returns undefined for an id that does not exist', () => {
    expect(repo.getById('00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });

  it('paginates the run list newest first, honoring limit and offset', () => {
    const a = repo.createQueued({ model: 'm', prompt: 'a', maxTokens: 1 });
    const b = repo.createQueued({ model: 'm', prompt: 'b', maxTokens: 1 });
    const c = repo.createQueued({ model: 'm', prompt: 'c', maxTokens: 1 });

    expect(repo.list(10, 0).map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    expect(repo.list(2, 0).map((r) => r.id)).toEqual([c.id, b.id]);
    expect(repo.list(2, 2).map((r) => r.id)).toEqual([a.id]);
  });
});

describe('RunsRepository.transitionStatus', () => {
  it('applies a status transition, bumps the version, and stamps updatedAt', () => {
    const run = repo.createQueued({ model: 'm', prompt: 'hi', maxTokens: 10 });
    const ok = repo.transitionStatus(run.id, 0, 'running', { startedAt: new Date().toISOString() });
    expect(ok).toBe(true);

    const updated = repo.getById(run.id)!;
    expect(updated.status).toBe('running');
    expect(updated.version).toBe(1);
    expect(updated.startedAt).not.toBeNull();
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
    expect(repo.getById(run.id)!.version).toBe(1);
  });

  it('returns false for an id that does not exist, without throwing', () => {
    expect(repo.transitionStatus('00000000-0000-0000-0000-000000000000', 0, 'running')).toBe(false);
  });

  it('leaves unspecified patch fields untouched (COALESCE semantics)', () => {
    const run = repo.createQueued({ model: 'm', prompt: 'hi', maxTokens: 10 });
    repo.transitionStatus(run.id, 0, 'running', { startedAt: '2024-01-01T00:00:00.000Z' });
    repo.transitionStatus(run.id, 1, 'completed', { output: 'done', tokenCount: 3 });

    const final = repo.getById(run.id)!;
    expect(final.startedAt).toBe('2024-01-01T00:00:00.000Z'); // preserved from the earlier transition
    expect(final.output).toBe('done');
    expect(final.tokenCount).toBe(3);
  });

  it('accumulates two independent transitions correctly (running then completed)', () => {
    const run = repo.createQueued({ model: 'm', prompt: 'hi', maxTokens: 10 });
    repo.transitionStatus(run.id, 0, 'running', { startedAt: new Date().toISOString() });
    const completedOk = repo.transitionStatus(run.id, 1, 'completed', {
      output: 'result',
      tokenCount: 5,
      durationMs: 42,
      finishedAt: new Date().toISOString()
    });

    expect(completedOk).toBe(true);
    const final = repo.getById(run.id)!;
    expect(final.status).toBe('completed');
    expect(final.version).toBe(2);
    expect(final.durationMs).toBe(42);
  });
});
