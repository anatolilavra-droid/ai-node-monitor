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

  it('GET /internal/health reports detailed diagnostics without leaking prompts', async () => {
    const res = await fetch(`${ctx.baseUrl}/internal/health`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.database).toEqual({ ok: true, latencyMs: expect.any(Number) });
    expect(body.engine).toEqual({ ready: true, circuitState: 'closed' });
    expect(typeof body.disk.freeBytes === 'number' || body.disk.freeBytes === null).toBe(true);
    expect(body.metrics).toEqual({
      runsCreated: expect.any(Number),
      runsCompleted: expect.any(Number),
      runsCancelled: expect.any(Number),
      runsFailed: expect.any(Number),
      engineCircuitOpenTransitions: expect.any(Number)
    });

    // Never a prompt/output field anywhere in the diagnostics payload.
    expect(JSON.stringify(body)).not.toMatch(/prompt|output/i);
  });
});
