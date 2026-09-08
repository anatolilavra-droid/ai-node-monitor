import type { Run, RunStatus } from '../domain/types.js';

/** The raw `runs` table row shape - a SQL concern, not a domain one. */
export interface RunRow {
  id: string;
  status: RunStatus;
  model: string;
  prompt: string;
  max_tokens: number;
  output: string;
  token_count: number;
  error_message: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
}

export function runFromRow(row: RunRow): Run {
  return {
    id: row.id,
    status: row.status,
    model: row.model,
    prompt: row.prompt,
    maxTokens: row.max_tokens,
    output: row.output,
    tokenCount: row.token_count,
    errorMessage: row.error_message,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms
  };
}
