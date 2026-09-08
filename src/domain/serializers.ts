import type { Run } from './types.js';

export interface RunView {
  id: string;
  status: Run['status'];
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

export function serializeRun(run: Run): RunView {
  return {
    id: run.id,
    status: run.status,
    model: run.model,
    prompt: run.prompt,
    maxTokens: run.maxTokens,
    output: run.output,
    tokenCount: run.tokenCount,
    errorMessage: run.errorMessage,
    version: run.version,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs
  };
}
