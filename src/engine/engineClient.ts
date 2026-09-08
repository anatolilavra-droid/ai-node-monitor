import type { EngineToken } from '../domain/ports.js';

export type { EngineToken };

/**
 * Opens the completion request and returns a reader positioned at the
 * start of the NDJSON body. Split out from token consumption so
 * ResilientEngineClient can retry only this half on failure - retrying
 * after tokens have already been yielded to a caller would duplicate
 * output, so that half is never retried.
 */
export async function connectCompletion(
  baseUrl: string,
  input: { prompt: string; maxTokens: number },
  signal: AbortSignal
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await fetch(`${baseUrl}/completion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal
  });

  if (!res.ok || !res.body) {
    throw new Error(`engine completion request failed with status ${res.status}`);
  }

  return res.body.getReader();
}

/**
 * Consumes newline-delimited JSON tokens from an already-connected
 * completion stream. The AbortSignal that was passed to connectCompletion
 * remains the single cancellation path: aborting it tears down the
 * underlying HTTP request, which the engine observes as a client
 * disconnect and stops generating (see mockEngineServer.ts) - this
 * generator simply sees `reader.read()` reject.
 */
export async function* consumeCompletion(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<EngineToken, void, void> {
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');

        if (line.trim().length === 0) continue;
        const parsed = JSON.parse(line) as { token?: string; index?: number; done?: boolean };
        if (parsed.done) return;
        if (typeof parsed.token === 'string' && typeof parsed.index === 'number') {
          yield { token: parsed.token, index: parsed.index };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Connects and consumes in one call - the plain, non-resilient path. */
export async function* streamCompletion(
  baseUrl: string,
  input: { prompt: string; maxTokens: number },
  signal: AbortSignal
): AsyncGenerator<EngineToken, void, void> {
  const reader = await connectCompletion(baseUrl, input, signal);
  yield* consumeCompletion(reader);
}
