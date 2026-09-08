/**
 * Standalone local inference engine process.
 *
 * This is a deterministic mock model: it does not call out to any cloud
 * provider and produces genuinely generated tokens with real, measured
 * timing (via process.hrtime.bigint()), so telemetry derived from it is
 * real engine telemetry, not fabricated production data - it is simply a
 * stand-in for a real model weights runtime (e.g. llama.cpp) during local
 * development. Swapping in a real engine means replacing this file while
 * keeping the same HTTP contract (GET /health, GET /ready, POST /completion).
 *
 * Runs as its own OS process, managed by src/engine/engineManager.ts, and
 * binds to 127.0.0.1 only - never a routable interface.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const HOST = '127.0.0.1';
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  console.error('mockEngineServer: a positive integer port must be passed as argv[2]');
  process.exit(1);
}

const STARTUP_DELAY_MS = 200;
const TOKEN_INTERVAL_MS = 8;
const startedAt = process.hrtime.bigint();
let ready = false;

setTimeout(() => {
  ready = true;
}, STARTUP_DELAY_MS);

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function generateToken(index: number, promptWordCount: number): string {
  return `tok${index}_${(index * 31 + promptWordCount) % 97}`;
}

async function handleCompletion(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { prompt?: unknown; maxTokens?: unknown };
  try {
    body = (await readJsonBody(req)) as typeof body;
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'INVALID_JSON' }));
    return;
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  const maxTokens = typeof body.maxTokens === 'number' && body.maxTokens > 0 ? Math.floor(body.maxTokens) : 32;
  const promptWordCount = prompt.split(/\s+/).filter(Boolean).length;

  res.writeHead(200, {
    'content-type': 'application/x-ndjson',
    'cache-control': 'no-cache'
  });

  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });

  for (let i = 0; i < maxTokens; i += 1) {
    if (aborted || res.destroyed) break;

    await new Promise((resolve) => setTimeout(resolve, TOKEN_INTERVAL_MS));
    if (aborted || res.destroyed) break;

    const token = generateToken(i, promptWordCount);
    res.write(`${JSON.stringify({ token, index: i })}\n`);
  }

  if (!aborted && !res.destroyed) {
    res.end(`${JSON.stringify({ done: true })}\n`);
  }
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method === 'GET' && req.url === '/ready') {
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ready }));
    return;
  }

  if (req.method === 'POST' && req.url === '/completion') {
    if (!ready) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'ENGINE_NOT_READY' }));
      return;
    }
    void handleCompletion(req, res);
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'NOT_FOUND' }));
});

server.listen(port, HOST, () => {
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  console.log(`mock engine listening on http://${HOST}:${port} (boot ${elapsedMs.toFixed(1)}ms)`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
