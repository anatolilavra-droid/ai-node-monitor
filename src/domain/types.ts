export const RUN_STATUSES = ['queued', 'running', 'completed', 'cancelled', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface Run {
  id: string;
  status: RunStatus;
  model: string;
  prompt: string;
  maxTokens: number;
  output: string;
  tokenCount: number;
  errorMessage: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

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
