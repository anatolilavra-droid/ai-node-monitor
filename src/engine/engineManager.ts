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

async function checkOnce(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Owns readiness tracking for the local inference engine, in one of two
 * modes (ENGINE_MODE):
 *
 * - 'mock': spawns and owns a child process (mockEngineServer.ts), bound
 *   to 127.0.0.1, and restarts it with a bounded retry count inside a
 *   rolling window if it crashes. Dev/test only.
 * - 'llama-cpp': the engine is a real llama.cpp server, started and
 *   supervised independently (its own systemd unit - see
 *   docs/DEPLOYMENT.md). This class never spawns or kills it, only polls
 *   its GET /health on an interval, since a crash/restart there produces
 *   no OS-level signal this process can otherwise observe.
 *
 * Either way, the engine and the Fastify process are independent - a
 * problem here must not crash the API, it must only be reflected in
 * `isReady()` (and therefore `/ready`).
 */
export class EngineManager {
  private child: ChildProcess | undefined;
  private ready = false;
  private stopped = false;
  private restartTimestamps: number[] = [];
  private healthPollTimer: NodeJS.Timeout | undefined;
  private polling = false;
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
    if (this.config.ENGINE_MODE === 'mock') {
      this.spawnChild();
    } else {
      this.logger.info(
        { baseUrl: this.baseUrl },
        'ENGINE_MODE=llama-cpp: connecting to an externally-managed engine, not spawning one'
      );
    }

    const deadline = Date.now() + this.config.ENGINE_STARTUP_TIMEOUT_MS;
    this.ready = await this.waitUntilReady(deadline);
    if (!this.ready) {
      this.logger.error(
        { baseUrl: this.baseUrl },
        'engine did not become ready within startup timeout; will keep retrying in the background'
      );
    }

    if (this.config.ENGINE_MODE === 'llama-cpp') {
      this.startHealthPolling();
    }
  }

  /**
   * The mock engine implements a distinct GET /ready that lags GET
   * /health by design (see mockEngineServer.ts's STARTUP_DELAY_MS), so
   * startup checks both. A real llama.cpp server has only GET /health,
   * which itself only returns 200 once the model is loaded - that single
   * check is both liveness and readiness for 'llama-cpp' mode.
   */
  private async waitUntilReady(deadline: number): Promise<boolean> {
    const healthy = await pollUntilOk(`${this.baseUrl}/health`, deadline);
    if (!healthy) return false;
    if (this.config.ENGINE_MODE === 'mock') {
      return pollUntilOk(`${this.baseUrl}/ready`, deadline);
    }
    return true;
  }

  private startHealthPolling(): void {
    this.healthPollTimer = setInterval(() => {
      if (this.polling || this.stopped) return;
      this.polling = true;
      void checkOnce(`${this.baseUrl}/health`)
        .then((ok) => {
          if (ok !== this.ready) {
            this.logger.warn({ ready: ok }, 'external engine readiness changed');
          }
          this.ready = ok;
        })
        .finally(() => {
          this.polling = false;
        });
    }, this.config.ENGINE_HEALTH_POLL_INTERVAL_MS);
    this.healthPollTimer.unref();
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
    if (this.healthPollTimer) {
      clearInterval(this.healthPollTimer);
      this.healthPollTimer = undefined;
    }
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
