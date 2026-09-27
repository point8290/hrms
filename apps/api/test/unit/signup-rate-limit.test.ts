import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.ts';

/**
 * The signup allowance.
 *
 * `POST /api/tenants` is unauthenticated and provisions a tenant, so it is the one route where
 * a loose limit is a way to fill the database from outside. Five an hour is the production
 * figure.
 *
 * Development legitimately creates many tenants in a sitting — rehearsing a demo, or running
 * the payroll journey twice — and waiting out a production limiter is not a security control,
 * it is just a slow way to work. So the allowance is configurable and production is held to
 * the production figure by a guard that refuses to boot rather than starting relaxed.
 *
 * These tests exist because that guard is the whole safety property: without it, the knob is
 * simply a way to turn the protection off.
 */

/** The minimum a production config needs in order to parse at all. */
const PRODUCTION = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  PLATFORM_DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  JWT_SECRET: 'a-real-secret-that-is-long-enough-to-pass',
  FIELD_ENCRYPTION_KEY: '1'.repeat(64),
  REDIS_URL: 'redis://localhost:6379',
  QUEUE_DRIVER: 'sqs',
  STORAGE_DRIVER: 's3',
  SQS_WORKFORCE_QUEUE_URL: 'https://sqs.example/workforce',
  SQS_PAYROLL_QUEUE_URL: 'https://sqs.example/payroll',
  SQS_PLATFORM_QUEUE_URL: 'https://sqs.example/platform',
  S3_BUCKET: 'hrms-documents',
};

describe('signup rate limit', () => {
  it('defaults to the production allowance', () => {
    const cfg = loadConfig({ ...PRODUCTION, NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    assert.equal(cfg.SIGNUP_RATE_LIMIT_MAX, 5);
    assert.equal(cfg.SIGNUP_RATE_LIMIT_WINDOW, '1 hour');
  });

  it('keeps that default in production when nothing is set', () => {
    const cfg = loadConfig(PRODUCTION as NodeJS.ProcessEnv);
    assert.equal(cfg.SIGNUP_RATE_LIMIT_MAX, 5);
    assert.equal(cfg.SIGNUP_RATE_LIMIT_WINDOW, '1 hour');
  });

  it('lets development raise it', () => {
    const cfg = loadConfig({
      ...PRODUCTION, NODE_ENV: 'development', SIGNUP_RATE_LIMIT_MAX: '50',
    } as NodeJS.ProcessEnv);
    assert.equal(cfg.SIGNUP_RATE_LIMIT_MAX, 50);
  });

  it('refuses to boot production with a raised allowance', () => {
    // The property that makes the knob safe: production cannot be talked into a looser limit
    // by an environment variable. It fails loudly at startup rather than serving relaxed.
    assert.throws(
      () => loadConfig({ ...PRODUCTION, SIGNUP_RATE_LIMIT_MAX: '50' } as NodeJS.ProcessEnv),
      /SIGNUP_RATE_LIMIT_MAX must not exceed 5 in production/,
    );
    assert.throws(
      () => loadConfig({ ...PRODUCTION, SIGNUP_RATE_LIMIT_MAX: '6' } as NodeJS.ProcessEnv),
      /must not exceed 5/,
    );
  });

  it('refuses to boot production with a widened window', () => {
    // Raising the window is the same attack as raising the count — five a day and five a
    // second are not the same control.
    assert.throws(
      () => loadConfig({ ...PRODUCTION, SIGNUP_RATE_LIMIT_WINDOW: '1 second' } as NodeJS.ProcessEnv),
      /SIGNUP_RATE_LIMIT_WINDOW must remain '1 hour' in production/,
    );
  });

  it('still allows production to tighten it', () => {
    const cfg = loadConfig({ ...PRODUCTION, SIGNUP_RATE_LIMIT_MAX: '2' } as NodeJS.ProcessEnv);
    assert.equal(cfg.SIGNUP_RATE_LIMIT_MAX, 2);
  });

  it('rejects a nonsensical allowance outright', () => {
    for (const bad of ['0', '-1', 'lots']) {
      assert.throws(
        () => loadConfig({ ...PRODUCTION, NODE_ENV: 'development', SIGNUP_RATE_LIMIT_MAX: bad } as NodeJS.ProcessEnv),
        /Invalid configuration/,
      );
    }
  });
});
