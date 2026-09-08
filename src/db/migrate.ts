import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { loadConfig } from '../config/env.js';
import { openDatabase } from './connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// db/migrations lives at the repo root, two levels above this compiled/run file.
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

/**
 * Applies every migration file that has not yet been recorded in
 * schema_migrations, in filename order. Each file runs inside its own
 * transaction alongside its own bookkeeping row, so a partial failure
 * never leaves a migration half-applied but marked done.
 */
export function runMigrations(db: Database.Database): { applied: string[] } {
  ensureMigrationsTable(db);
  const alreadyApplied = new Set(
    db.prepare('SELECT filename FROM schema_migrations').all().map((row) => (row as { filename: string }).filename)
  );

  const applied: string[] = [];
  for (const filename of listMigrationFiles()) {
    if (alreadyApplied.has(filename)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
    const transaction = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)').run(
        filename,
        new Date().toISOString()
      );
    });
    transaction();
    applied.push(filename);
  }

  return { applied };
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  const config = loadConfig();
  const db = openDatabase(config.DB_PATH);
  const { applied } = runMigrations(db);
  if (applied.length === 0) {
    console.log('No pending migrations.');
  } else {
    console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
  }
  db.close();
}
