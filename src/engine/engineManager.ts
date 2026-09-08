import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AppConfig } from '../config/env.js';
import type { AppLogger } from '../logging/appLogger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveEngineScript(): { script: string; execArgv: string[] } {
  const isTsSource = import.meta.url.endsWith('.ts');
  return isTsSource
    ? { script: join(__dirname, 'mockEngineServer.ts'), execArgv: ['--import', 'tsx/esm'] }
    : { script: join(__dirname, 'mockEngineServer.js'), execArgv: [] };
}

async function pollUntilOk(url: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not accepting connections, or not ready yet; retry until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/**
 * Owns the lifecycle of the local inference engine child process: spawns
 * it bound to 127.0.0.1, tracks readiness, and restarts it with a bounded
 * retry count inside a rolling window if it crashes. The engine and the
 * Fastify process are independent - a crash here must not crash the API,
 * it must only be reflected in /ready.
 */
export class EngineManager {
  private child: ChildProcess | undefined;
  private ready = false;
  private stopped = false;
  private restartTimestamps: number[] = [];
  private readonly baseUrl: string;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger
  ) {
    this.baseUrl = `http://${config.ENGINE_HOST}:${config.ENGINE_START_PORT}`;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  isReady(): boolean {
    return this.ready;
  }

  async start(): Promise<void> {
    this.spawnChild();
    const deadline = Date.now() + this.config.ENGINE_STARTUP_TIMEOUT_MS;

    const healthy = await pollUntilOk(`${this.baseUrl}/health`, deadline);
    if (!healthy) {
      this.logger.error({ baseUrl: this.baseUrl }, 'engine did not become healthy within startup timeout');
      return;
    }

    this.ready = await pollUntilOk(`${this.baseUrl}/ready`, deadline);
    if (!this.ready) {
      this.logger.error({ baseUrl: this.baseUrl }, 'engine did not become ready within startup timeout');
    }
  }

  private spawnChild(): void {
    const { script, execArgv } = resolveEngineScript();
    const child = fork(script, [String(this.config.ENGINE_START_PORT)], {
      execArgv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    this.child = child;
    this.ready = false;

    child.stdout?.on('data', (chunk: Buffer) => this.logger.info({ engine: true }, chunk.toString().trim()));
    child.stderr?.on('data', (chunk: Buffer) => this.logger.error({ engine: true }, chunk.toString().trim()));

    child.on('exit', (code, signal) => {
      this.ready = false;
      if (this.stopped) return;

      this.logger.warn({ code, signal }, 'engine process exited unexpectedly');
      if (!this.canRestart()) {
        this.logger.error('engine exceeded max restarts in the configured window; leaving it stopped');
        return;
      }
      this.restartTimestamps.push(Date.now());
      void this.start();
    });
  }

  private canRestart(): boolean {
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter(
      (ts) => now - ts < this.config.ENGINE_RESTART_WINDOW_MS
    );
    return this.restartTimestamps.length < this.config.ENGINE_MAX_RESTARTS;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    if (!this.child) return;
    const child = this.child;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
        resolve();
      }, 2000);
    });
  }
}
