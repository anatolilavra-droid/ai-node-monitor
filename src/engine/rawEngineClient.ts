import type { EngineToken } from '../domain/ports.js';

/**
 * The engine-protocol-specific half of talking to an inference engine:
 * how to open a completion request and how to parse its response body
 * into tokens. Two implementations exist - the mock's NDJSON protocol
 * (engineClient.ts) and llama.cpp's OpenAI-compatible SSE protocol
 * (llamaCppEngineClient.ts) - and ResilientEngineClient wraps whichever
 * one is configured with the same circuit-breaker/retry/cancellation
 * logic either way. The domain layer never sees this interface; it only
 * sees EnginePort (domain/ports.ts), which ResilientEngineClient
 * implements on top of this one.
 */
export interface RawEngineClient {
  connect(
    input: { prompt: string; maxTokens: number },
    signal: AbortSignal
  ): Promise<ReadableStreamDefaultReader<Uint8Array>>;

  consume(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<EngineToken, void, void>;
}
