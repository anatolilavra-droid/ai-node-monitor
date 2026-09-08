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

  describe('boolean env vars (TRUST_PROXY, API_AUTH_ENABLED)', () => {
    // Regression test: Zod's z.coerce.boolean() calls JS Boolean(value),
    // under which the *string* "false" is truthy - only "" is falsy. An
    // earlier version of this schema used z.coerce.boolean() directly,
    // which silently turned TRUST_PROXY=false / API_AUTH_ENABLED=false in
    // .env.example into `true`. booleanEnv() must parse the literal text.
    it('parses the string "false" as false, not true', () => {
      expect(loadConfig({ TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
      expect(loadConfig({ API_AUTH_ENABLED: 'false' }).API_AUTH_ENABLED).toBe(false);
    });

    it('parses the string "true" as true', () => {
      expect(loadConfig({ TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(loadConfig({ TRUST_PROXY: 'TRUE' }).TRUST_PROXY).toBe(true);
      expect(loadConfig({ TRUST_PROXY: 'False' }).TRUST_PROXY).toBe(false);
    });

    it('defaults to false when absent', () => {
      expect(loadConfig({}).TRUST_PROXY).toBe(false);
      expect(loadConfig({}).API_AUTH_ENABLED).toBe(false);
    });

    it('fails closed on a value that is neither "true" nor "false"', () => {
      expect(() => loadConfig({ TRUST_PROXY: 'yes' })).toThrow(/Invalid configuration/);
      expect(() => loadConfig({ TRUST_PROXY: '1' })).toThrow(/Invalid configuration/);
    });
  });

  describe('API_AUTH_ENABLED / API_AUTH_KEY cross-validation', () => {
    it('fails closed when auth is enabled without a key', () => {
      expect(() => loadConfig({ API_AUTH_ENABLED: 'true' })).toThrow(/API_AUTH_KEY/);
    });

    it('fails closed when the key is shorter than 16 characters', () => {
      expect(() => loadConfig({ API_AUTH_ENABLED: 'true', API_AUTH_KEY: 'short' })).toThrow(/Invalid configuration/);
    });

    it('succeeds when auth is enabled with a sufficiently long key', () => {
      const config = loadConfig({ API_AUTH_ENABLED: 'true', API_AUTH_KEY: 'a'.repeat(32) });
      expect(config.API_AUTH_ENABLED).toBe(true);
      expect(config.API_AUTH_KEY).toBe('a'.repeat(32));
    });

    it('does not require a key when auth is disabled', () => {
      expect(() => loadConfig({ API_AUTH_ENABLED: 'false' })).not.toThrow();
    });

    it('treats an empty-string API_AUTH_KEY (blank in .env) as unset, not as a too-short key', () => {
      expect(() => loadConfig({ API_AUTH_ENABLED: 'false', API_AUTH_KEY: '' })).not.toThrow();
      expect(loadConfig({ API_AUTH_KEY: '' }).API_AUTH_KEY).toBeUndefined();
    });
  });

  describe('ENGINE_MODE', () => {
    it('defaults to mock', () => {
      expect(loadConfig({}).ENGINE_MODE).toBe('mock');
    });

    it('accepts llama-cpp', () => {
      expect(loadConfig({ ENGINE_MODE: 'llama-cpp' }).ENGINE_MODE).toBe('llama-cpp');
    });

    it('fails closed on an unknown engine mode', () => {
      expect(() => loadConfig({ ENGINE_MODE: 'openai' })).toThrow(/Invalid configuration/);
    });
  });
});
