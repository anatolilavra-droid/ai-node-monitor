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

describe('idempotency key handling', () => {
  it('saves a run and its idempotency key together', () => {
    const run = repo.createQueuedWithIdempotencyKey('POST /generate', 'key-1', {
      model: 'm',
      prompt: 'hi',
      maxTokens: 10
    });

    expect(run.status).toBe('queued');
    expect(repo.getById(run.id)).toEqual(run);
  });

  it('looks up the run created for a given (route, key) pair', () => {
    const run = repo.createQueuedWithIdempotencyKey('POST /generate', 'key-1', {
      model: 'm',
      prompt: 'hi',
      maxTokens: 10
    });

    expect(repo.findIdempotentRunId('POST /generate', 'key-1')).toBe(run.id);
  });

  it('returns undefined for a key that was never used', () => {
    expect(repo.findIdempotentRunId('POST /generate', 'never-used')).toBeUndefined();
  });

  it('scopes keys per route: the same key on a different route is a separate entry', () => {
    const generateRun = repo.createQueuedWithIdempotencyKey('POST /generate', 'shared-key', {
      model: 'm',
      prompt: 'a',
      maxTokens: 1
    });
    const cancelRun = repo.createQueuedWithIdempotencyKey('POST /runs/:id/cancel', 'shared-key', {
      model: 'm',
      prompt: 'b',
      maxTokens: 1
    });

    expect(repo.findIdempotentRunId('POST /generate', 'shared-key')).toBe(generateRun.id);
    expect(repo.findIdempotentRunId('POST /runs/:id/cancel', 'shared-key')).toBe(cancelRun.id);
    expect(generateRun.id).not.toBe(cancelRun.id);
  });

  it('rejects reusing the same key twice on the same route (duplicate detection)', () => {
    repo.createQueuedWithIdempotencyKey('POST /generate', 'dup', { model: 'm', prompt: 'a', maxTokens: 1 });
    expect(() =>
      repo.createQueuedWithIdempotencyKey('POST /generate', 'dup', { model: 'm', prompt: 'b', maxTokens: 1 })
    ).toThrow();
  });

  it('does not leave a half-written run behind when the duplicate insert fails', () => {
    repo.createQueuedWithIdempotencyKey('POST /generate', 'dup', { model: 'm', prompt: 'a', maxTokens: 1 });
    try {
      repo.createQueuedWithIdempotencyKey('POST /generate', 'dup', { model: 'm', prompt: 'b', maxTokens: 1 });
    } catch {
      // expected - the second attempt's transaction must roll back entirely.
    }

    const runs = repo.list(10, 0);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.prompt).toBe('a');
  });
});
