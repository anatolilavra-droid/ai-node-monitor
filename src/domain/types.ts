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
