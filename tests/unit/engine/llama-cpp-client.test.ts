import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectChatCompletion, consumeChatCompletion } from '../../../src/engine/llamaCppEngineClient.js';

/**
 * A ReadableStreamDefaultReader<Uint8Array> stand-in that yields each
 * string in `chunks` as one `read()` call, encoded to bytes - used to
 * exercise consumeChatCompletion's SSE parsing without a real network
 * stream or a real llama.cpp server.
 */
function fakeReader(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    read: async () => {
      if (index >= chunks.length) return { done: true, value: undefined };
      const value = encoder.encode(chunks[index]);
      index += 1;
      return { done: false, value };
    },
    releaseLock: () => undefined
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

async function collect(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const tokens = [];
  for await (const token of consumeChatCompletion(reader)) tokens.push(token);
  return tokens;
}

describe('consumeChatCompletion', () => {
  it('parses delta.content chunks into sequential tokens', async () => {
    const reader = fakeReader([
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n'
    ]);

    const tokens = await collect(reader);
    expect(tokens).toEqual([
      { token: 'Hello', index: 0 },
      { token: ' world', index: 1 }
    ]);
  });

  it('stops at [DONE] even if more bytes remain buffered', async () => {
    const reader = fakeReader([
      'data: {"choices":[{"delta":{"content":"one"}}]}\n\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"never seen"}}]}\n\n'
    ]);

    const tokens = await collect(reader);
    expect(tokens).toEqual([{ token: 'one', index: 0 }]);
  });

  it('ignores frames with no delta.content (role announcement, finish_reason-only close)', async () => {
    const reader = fakeReader([
      'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ]);

    const tokens = await collect(reader);
    expect(tokens).toEqual([{ token: 'hi', index: 0 }]);
  });

  it('skips a malformed data line instead of throwing, and keeps parsing', async () => {
    const reader = fakeReader([
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: not valid json at all\n\n',
      'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
      'data: [DONE]\n\n'
    ]);

    const tokens = await collect(reader);
    expect(tokens).toEqual([
      { token: 'a', index: 0 },
      { token: 'b', index: 1 }
    ]);
  });

  it('reassembles a single SSE frame split across multiple read() calls', async () => {
    const reader = fakeReader([
      'data: {"choices":[{"delta":',
      '{"content":"split"}}]}\n\n',
      'data: [DONE]\n\n'
    ]);

    const tokens = await collect(reader);
    expect(tokens).toEqual([{ token: 'split', index: 0 }]);
  });

  it('releases the reader lock when the stream ends without [DONE]', async () => {
    const reader = fakeReader(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n']);
    const releaseSpy = vi.spyOn(reader, 'releaseLock');

    await collect(reader);

    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });
});

describe('connectChatCompletion', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('POSTs the OpenAI-compatible request shape to /v1/chat/completions', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => fakeReader([]) }
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await connectChatCompletion(
      'http://127.0.0.1:8090',
      { model: 'local-model', requestTimeoutMs: 5000 },
      { prompt: 'hi there', maxTokens: 16 },
      new AbortController().signal
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8090/v1/chat/completions');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: 'local-model',
      messages: [{ role: 'user', content: 'hi there' }],
      max_tokens: 16,
      stream: true
    });
  });

  it('throws a descriptive error on a non-ok response instead of returning a broken reader', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, body: null }) as unknown as typeof fetch;

    await expect(
      connectChatCompletion(
        'http://127.0.0.1:8090',
        { model: 'local-model', requestTimeoutMs: 5000 },
        { prompt: 'hi', maxTokens: 8 },
        new AbortController().signal
      )
    ).rejects.toThrow(/status 503/);
  });
});
