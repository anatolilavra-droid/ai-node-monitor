import { describe, expect, it } from 'vitest';
import {
  AppError,
  ConflictError,
  EngineUnavailableError,
  NotFoundError,
  ValidationError,
  isAppError
} from '../../../src/domain/errors.js';

describe('ValidationError', () => {
  it('carries a fixed code and 400 status', () => {
    const err = new ValidationError('bad input');
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('bad input');
  });
});

describe('NotFoundError', () => {
  it('takes its code from the caller, so existing API contract codes (e.g. RUN_NOT_FOUND) still work', () => {
    const err = new NotFoundError('RUN_NOT_FOUND', 'No run with id abc');
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('RUN_NOT_FOUND');
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('No run with id abc');
  });

  it('supports a different code for a different resource type', () => {
    const err = new NotFoundError('SESSION_NOT_FOUND', 'gone');
    expect(err.code).toBe('SESSION_NOT_FOUND');
  });
});

describe('ConflictError', () => {
  it('carries a fixed code and 409 status', () => {
    const err = new ConflictError('illegal transition');
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('CONFLICT');
    expect(err.statusCode).toBe(409);
  });
});

describe('EngineUnavailableError', () => {
  it('defaults to a stable code and message, and a 503 status', () => {
    const err = new EngineUnavailableError();
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('ENGINE_NOT_READY');
    expect(err.statusCode).toBe(503);
    expect(err.message).toBeTruthy();
  });

  it('accepts a custom message while keeping the same code', () => {
    const err = new EngineUnavailableError('circuit breaker is open');
    expect(err.code).toBe('ENGINE_NOT_READY');
    expect(err.message).toBe('circuit breaker is open');
  });
});

describe('isAppError', () => {
  it('is true for every AppError subclass', () => {
    expect(isAppError(new ValidationError('x'))).toBe(true);
    expect(isAppError(new NotFoundError('X', 'x'))).toBe(true);
    expect(isAppError(new ConflictError('x'))).toBe(true);
    expect(isAppError(new EngineUnavailableError())).toBe(true);
  });

  it('is false for a plain Error or a non-error value', () => {
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError('not an error')).toBe(false);
    expect(isAppError(undefined)).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});
