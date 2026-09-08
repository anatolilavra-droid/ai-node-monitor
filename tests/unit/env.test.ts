import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';

describe('loadConfig', () => {
  it('applies defaults when env vars are absent', () => {
    const config = loadConfig({});
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.PORT).toBe(8080);
    expect(config.ENGINE_HOST).toBe('127.0.0.1');
  });

  it('fails closed on an invalid PORT', () => {
    expect(() => loadConfig({ PORT: 'not-a-number' })).toThrow(/Invalid configuration/);
  });

  it('fails closed if ENGINE_HOST is anything other than 127.0.0.1', () => {
    expect(() => loadConfig({ ENGINE_HOST: '0.0.0.0' })).toThrow(/Invalid configuration/);
  });

  it('fails closed on an unknown LOG_LEVEL', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(/Invalid configuration/);
  });
});
