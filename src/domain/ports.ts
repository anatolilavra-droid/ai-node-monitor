import type { Run, RunStatus } from './types.js';

/**
 * What GenerationService needs from persistence, expressed as an
 * interface it depends on instead of the concrete RunsRepository class.
 * This is what "the domain service doesn't know about SQL" means in
 * practice: it can be satisfied by the real SQLite-backed repository or,
 * in a unit test, by an in-memory fake - no database required.
 */
export interface CreateRunInput {
  model: string;
  prompt: string;
  maxTokens: number;
}

export interface StatusPatch {
  output?: string;
  tokenCount?: number;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface RunsRepositoryPort {
  createQueued(input: CreateRunInput): Run;
  getById(id: string): Run | undefined;
  list(limit: number, offset: number): Run[];
  transitionStatus(id: string, expectedVersion: number, status: RunStatus, patch?: StatusPatch): boolean;
  findIdempotentRunId(route: string, idempotencyKey: string): string | undefined;
  createQueuedWithIdempotencyKey(route: string, idempotencyKey: string, input: CreateRunInput): Run;
}

export interface EngineToken {
  token: string;
  index: number;
}

/**
 * What GenerationService needs from the inference engine. The concrete
 * implementation (ResilientEngineClient) adds circuit-breaking and retry
 * on top of the raw HTTP call; the domain layer only sees this contract.
 */
export interface EnginePort {
  isReady(): boolean;
  streamCompletion(
    input: { prompt: string; maxTokens: number },
    signal: AbortSignal
  ): AsyncGenerator<EngineToken, void, void>;
}
