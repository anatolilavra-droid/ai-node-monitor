import type { EngineToken } from '../domain/ports.js';
import type { EngineManager } from './engineManager.js';
import type { RawEngineClient } from './rawEngineClient.js';

export interface LlamaCppClientOptions {
  model: string;
  requestTimeoutMs: number;
}

interface ChatCompletionChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
}

/**
 * Combines two AbortSignals into one that aborts when either does,
 * without depending on `AbortSignal.any` (added in Node 20.3 - this
 * package only requires Node >=20, so a version below that would crash
 * at the call site rather than here).
 */
function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  if (a.aborted) {
    controller.abort(a.reason);
  } else {
    a.addEventListener('abort', () => controller.abort(a.reason), { once: true });
  }
  if (b.aborted) {
    controller.abort(b.reason);
  } else {
    b.addEventListener('abort', () => controller.abort(b.reason), { once: true });
  }
  return controller.signal;
}

/**
 * Opens a streaming chat completion against llama.cpp's OpenAI-compatible
 * `/v1/chat/completions` endpoint. Split from `consumeChatCompletion` for
 * the same reason as the mock client: ResilientEngineClient retries only
 * this half, never the token stream itself.
 */
export async function connectChatCompletion(
  baseUrl: string,
  options: LlamaCppClientOptions,
  input: { prompt: string; maxTokens: number },
  signal: AbortSignal
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const timeoutSignal = AbortSignal.timeout(options.requestTimeoutMs);
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: options.model,
      messages: [{ role: 'user', content: input.prompt }],
      max_tokens: input.maxTokens,
      stream: true
    }),
    signal: combineSignals(signal, timeoutSignal)
  });

  if (!res.ok || !res.body) {
    throw new Error(`llama.cpp chat completion request failed with status ${res.status}`);
  }

  return res.body.getReader();
}

/**
 * Parses an OpenAI-style SSE stream (`data: {...}\n\n` frames, terminated
 * by `data: [DONE]\n\n`) into our internal token shape. Each SSE
 * `delta.content` chunk becomes one EngineToken - llama.cpp does not
 * expose a stable per-token index, so this assigns a running counter
 * itself rather than trusting anything from the response.
 *
 * A frame that fails to parse as JSON (a stray comment/keep-alive line
 * some proxies inject) is skipped rather than aborting the whole
 * generation - one malformed frame should not fail an otherwise-healthy
 * stream.
 */
export async function* consumeChatCompletion(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<EngineToken, void, void> {
  const decoder = new TextDecoder();
  let buffer = '';
  let index = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let sepIndex = buffer.indexOf('\n\n');
      while (sepIndex !== -1) {
        const frame = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        sepIndex = buffer.indexOf('\n\n');

        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice('data:'.length).trim();
          if (data === '[DONE]') return;
          if (!data) continue;

          let parsed: ChatCompletionChunk;
          try {
            parsed = JSON.parse(data) as ChatCompletionChunk;
          } catch {
            continue;
          }

          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            yield { token: content, index };
            index += 1;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function createLlamaCppRawClient(engineManager: EngineManager, options: LlamaCppClientOptions): RawEngineClient {
  return {
    connect: (input, signal) => connectChatCompletion(engineManager.getBaseUrl(), options, input, signal),
    consume: consumeChatCompletion
  };
}
