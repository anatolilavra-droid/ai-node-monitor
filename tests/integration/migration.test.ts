import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrate.js';

let tmpDir: string;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('runMigrations', () => {
  it('applies all migrations to an empty database', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'power-node-01-migrate-'));
    const db = openDatabase(join(tmpDir, 'empty.sqlite'));

    const { applied } = runMigrations(db);
    expect(applied).toContain('0001_init.sql');

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(['runs', 'idempotency_keys', 'schema_migrations']));

    db.close();
  });

  it('is idempotent: re-running against an already-migrated database applies nothing', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'power-node-01-migrate-'));
    const db = openDatabase(join(tmpDir, 'twice.sqlite'));

    const first = runMigrations(db);
    expect(first.applied.length).toBeGreaterThan(0);

    const second = runMigrations(db);
    expect(second.applied).toEqual([]);

    db.close();
  });

  it('applies cleanly on top of a fixture that already has the schema (simulated prior deploy)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'power-node-01-migrate-'));
    const dbPath = join(tmpDir, 'fixture.sqlite');

    const first = openDatabase(dbPath);
    runMigrations(first);
    first.prepare(
      `INSERT INTO runs (id, status, model, prompt, max_tokens, output, token_count, version, created_at, updated_at)
       VALUES ('r1', 'completed', 'm', 'hi', 8, 'ok', 2, 1, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`
    ).run();
    first.close();

    const reopened = openDatabase(dbPath);
    const { applied } = runMigrations(reopened);
    expect(applied).toEqual([]);

    const row = reopened.prepare('SELECT * FROM runs WHERE id = ?').get('r1');
    expect(row).toBeTruthy();
    reopened.close();
  });
});
