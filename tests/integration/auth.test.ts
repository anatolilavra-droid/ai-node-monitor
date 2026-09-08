import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestContext } from './testHarness.js';

const API_KEY = 'a'.repeat(32);
let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer({ API_AUTH_ENABLED: 'true', API_AUTH_KEY: API_KEY });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe('optional API auth (API_AUTH_ENABLED=true)', () => {
  it('rejects POST /generate with no Authorization header', async () => {
    const res = await fetch(`${ctx.baseUrl}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ prompt: 'hi', maxTokens: 1 })
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('UNAUTHORIZED');
  });

  it('rejects GET /runs with a wrong key', async () => {
    const res = await fetch(`${ctx.baseUrl}/runs`, {
      headers: { authorization: 'Bearer wrong-key' }
    });
    expect(res.status).toBe(401);
  });

  it('allows GET /runs with the correct bearer key', async () => {
    const res = await fetch(`${ctx.baseUrl}/runs`, {
      headers: { authorization: `Bearer ${API_KEY}` }
    });
    expect(res.status).toBe(200);
  });

  it('allows a full POST /generate lifecycle with the correct bearer key', async () => {
    const res = await fetch(`${ctx.baseUrl}/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
        authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({ prompt: 'hi', maxTokens: 2 })
    });
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  it('never protects GET /health, /ready, or /internal/health', async () => {
    const [health, ready, internal] = await Promise.all([
      fetch(`${ctx.baseUrl}/health`),
      fetch(`${ctx.baseUrl}/ready`),
      fetch(`${ctx.baseUrl}/internal/health`)
    ]);
    expect(health.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(internal.status).toBe(200);
  });

  it('never protects the static monitoring console', async () => {
    const res = await fetch(`${ctx.baseUrl}/`);
    expect(res.status).toBe(200);
  });
});
