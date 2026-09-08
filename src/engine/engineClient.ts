export interface EngineToken {
  token: string;
  index: number;
}

/**
 * Streams tokens from the local engine's NDJSON completion endpoint.
 * The AbortSignal is the single cancellation path: aborting it tears down
 * the underlying HTTP request to the engine, which the engine observes as
 * a client disconnect and stops generating (see mockEngineServer.ts).
 */
export async function* streamCompletion(
  baseUrl: string,
  input: { prompt: string; maxTokens: number },
  signal: AbortSignal
): AsyncGenerator<EngineToken, void, void> {
  const res = await fetch(`${baseUrl}/completion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal
  });

  if (!res.ok || !res.body) {
    throw new Error(`engine completion request failed with status ${res.status}`);
  }

  const reader = res.body.getReader();
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
