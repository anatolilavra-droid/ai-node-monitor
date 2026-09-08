import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestContext } from './testHarness.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestServer();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe('health and readiness', () => {
  it('GET /health always reports ok', async () => {
    const res = await fetch(`${ctx.baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /ready reports ready once the engine and db are up', async () => {
    const res = await fetch(`${ctx.baseUrl}/ready`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ready: true, db: true, engine: true });
  });

  it('serves the monitoring console at /', async () => {
    const res = await fetch(`${ctx.baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
