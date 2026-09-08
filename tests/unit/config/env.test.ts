import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/env.js';

describe('loadConfig', () => {
  it('applies defaults when env vars are absent', () => {
    const config = loadConfig({});
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.PORT).toBe(8080);
    expect(config.ENGINE_HOST).toBe('127.0.0.1');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.MAX_PROMPT_LENGTH).toBe(8000);
    expect(config.MAX_TOKENS_LIMIT).toBe(2048);
  });

  it('coerces numeric env strings to numbers', () => {
    const config = loadConfig({ PORT: '9090', ENGINE_START_PORT: '9191', MAX_TOKENS_LIMIT: '64' });
    expect(config.PORT).toBe(9090);
    expect(config.ENGINE_START_PORT).toBe(9191);
    expect(config.MAX_TOKENS_LIMIT).toBe(64);
  });

  it('fails closed on an invalid PORT', () => {
    expect(() => loadConfig({ PORT: 'not-a-number' })).toThrow(/Invalid configuration/);
  });

  it('fails closed on a negative or zero PORT', () => {
    expect(() => loadConfig({ PORT: '0' })).toThrow(/Invalid configuration/);
    expect(() => loadConfig({ PORT: '-1' })).toThrow(/Invalid configuration/);
  });

  it('fails closed if ENGINE_HOST is anything other than 127.0.0.1', () => {
    expect(() => loadConfig({ ENGINE_HOST: '0.0.0.0' })).toThrow(/Invalid configuration/);
  });

  it('fails closed on an unknown LOG_LEVEL', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(/Invalid configuration/);
  });

  it('accepts "silent" as a valid LOG_LEVEL (used by tests)', () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    expect(config.LOG_LEVEL).toBe('silent');
  });

  it('fails closed on a non-positive MAX_TOKENS_LIMIT', () => {
    expect(() => loadConfig({ MAX_TOKENS_LIMIT: '0' })).toThrow(/Invalid configuration/);
  });

  it('reports every failing field in one error, not just the first', () => {
    expect(() => loadConfig({ PORT: 'nope', LOG_LEVEL: 'nope' })).toThrow(/PORT.*LOG_LEVEL|LOG_LEVEL.*PORT/s);
  });
});
