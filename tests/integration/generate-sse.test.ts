import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestContext } from './testHarness.js';
import { collectSse, parseSse } from './sseClient.js';

let ctx: TestContext;
const extraContexts: TestContext[] = [];

beforeAll(async () => {
  ctx = await startTestServer();
});

afterEach(async () => {
  while (extraContexts.length > 0) {
    await extraContexts.pop()!.cleanup();
  }
});

afterAll(async () => {
  await ctx.cleanup();
});

function generateHeaders(idempotencyKey: string) {
  return { 'content-type': 'application/json', 'idempotency-key': idempotencyKey };
}

describe('POST /generate SSE lifecycle', () => {
  it('streams created -> status -> tokens -> completed, and persists the final run', async () => {
    const res = await fetch(`${ctx.baseUrl}/generate`, {
      method: 'POST',
      headers: generateHeaders(randomUUID()),
      body: JSON.stringify({ prompt: 'hello world', maxTokens: 5 })
    });
    expect(res.status).toBe(200);

    const events = await collectSse(res.body!.getReader());
    const names = events.map((e) => e.eventName);

    expect(names[0]).toBe('run.created');
    expect(names).toContain('run.status');
    expect(names.filter((n) => n === 'token').length).toBe(5);
    expect(names[names.length - 1]).toBe('run.completed');

    const runId = events[0].data.id;
    const finalEvent = events[events.length - 1];
    expect(finalEvent.data.tokenCount).toBe(5);
    expect(typeof finalEvent.data.durationMs).toBe('number');

    const persisted = await fetch(`${ctx.baseUrl}/runs/${runId}`).then((r) => r.json());
    expect(persisted.status).toBe('completed');
    expect(persisted.tokenCount).toBe(5);
  });

  it('cancels an in-flight run via POST /runs/:id/cancel and persists status=cancelled', async () => {
    const res = await fetch(`${ctx.baseUrl}/generate`, {
      method: 'POST',
      headers: generateHeaders(randomUUID()),
      body: JSON.stringify({ prompt: 'cancel me', maxTokens: 500 })
    });

    const reader = res.body!.getReader();
    let runId: string | undefined;
    const events = [];

    for await (const frame of parseSse(reader)) {
      events.push(frame);
      if (frame.eventName === 'run.created') runId = frame.data.id;
      if (frame.eventName === 'token' && events.filter((e) => e.eventName === 'token').length === 1) {
        void fetch(`${ctx.baseUrl}/runs/${runId}/cancel`, {
          method: 'POST',
          headers: { 'idempotency-key': randomUUID() }
        });
      }
    }

    expect(events[events.length - 1].eventName).toBe('run.cancelled');

    const persisted = await fetch(`${ctx.baseUrl}/runs/${runId}`).then((r) => r.json());
    expect(persisted.status).toBe('cancelled');
    // A cancelled run must not silently look like it never happened: it
    // keeps whatever partial output/tokenCount it produced before cancel.
    expect(persisted.tokenCount).toBeGreaterThan(0);
    expect(persisted.tokenCount).toBeLessThan(500);
  });

  it('reconciles a client disconnect instead of leaving an orphan generation running', async () => {
    const clientAbort = new AbortController();
    const res = await fetch(`${ctx.baseUrl}/generate`, {
      method: 'POST',
      headers: generateHeaders(randomUUID()),
      body: JSON.stringify({ prompt: 'disconnect me', maxTokens: 300 }),
      signal: clientAbort.signal
    });

    let runId: string | undefined;
    for await (const frame of parseSse(res.body!.getReader())) {
      if (frame.eventName === 'run.created') runId = frame.data.id;
      if (frame.eventName === 'token') break;
    }
    expect(runId).toBeTruthy();

    clientAbort.abort();

    let status = 'running';
    for (let i = 0; i < 50 && (status === 'running' || status === 'queued'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const run = await fetch(`${ctx.baseUrl}/runs/${runId}`).then((r) => r.json());
      status = run.status;
    }
    expect(status).toBe('cancelled');
  });

  it('fails the run closed when the engine is not ready, instead of hanging', async () => {
    const localCtx = await startTestServer();
    extraContexts.push(localCtx);
    await localCtx.engine.stop();

    const res = await fetch(`${localCtx.baseUrl}/generate`, {
      method: 'POST',
      headers: generateHeaders(randomUUID()),
      body: JSON.stringify({ prompt: 'no engine', maxTokens: 10 })
    });

    const events = await collectSse(res.body!.getReader());
    const final = events[events.length - 1];
    expect(final.eventName).toBe('run.failed');
    expect(final.data.errorMessage).toBe('ENGINE_NOT_READY');

    const persisted = await fetch(`${localCtx.baseUrl}/runs/${final.data.id}`).then((r) => r.json());
    expect(persisted.status).toBe('failed');
  });

  it('replays a retried Idempotency-Key as a snapshot instead of regenerating', async () => {
    const idempotencyKey = randomUUID();
    const body = JSON.stringify({ prompt: 'idempotent test', maxTokens: 3 });

    const first = await fetch(`${ctx.baseUrl}/generate`, { method: 'POST', headers: generateHeaders(idempotencyKey), body });
    const firstEvents = await collectSse(first.body!.getReader());
    const runId = firstEvents[0].data.id;
    expect(firstEvents[firstEvents.length - 1].eventName).toBe('run.completed');

    const second = await fetch(`${ctx.baseUrl}/generate`, { method: 'POST', headers: generateHeaders(idempotencyKey), body });
    const secondEvents = await collectSse(second.body!.getReader());

    expect(secondEvents).toHaveLength(2);
    expect(secondEvents[0].eventName).toBe('run.created');
    expect(secondEvents[0].data.id).toBe(runId);
    expect(secondEvents[1].eventName).toBe('run.completed');

    const list = await fetch(`${ctx.baseUrl}/runs?limit=200`).then((r) => r.json());
    const matching = list.runs.filter((r: { id: string }) => r.id === runId);
    expect(matching).toHaveLength(1);
  });

  it('rejects a request missing the Idempotency-Key header', async () => {
    const res = await fetch(`${ctx.baseUrl}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'no key', maxTokens: 1 })
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid body with a 400 before touching the engine', async () => {
    const res = await fetch(`${ctx.baseUrl}/generate`, {
      method: 'POST',
      headers: generateHeaders(randomUUID()),
      body: JSON.stringify({ prompt: '' })
    });
    expect(res.status).toBe(400);
  });
});
