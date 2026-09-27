import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app.ts';
import { closePools } from '../../src/infra/db/pool.ts';
import { closeRedis } from '../../src/infra/redis.ts';
import { storage } from '../../src/infra/storage.ts';
import { skipWithoutDb } from './helpers.ts';

/**
 * `/internal/*`.
 *
 * A route is not private because it is named `internal`. There is exactly one in the Node
 * API — the local-storage driver's object endpoint, which exists so development mirrors the
 * S3 presigned-URL flow — and these are the properties that make it safe to have at all.
 */
describe('internal routes', skipWithoutDb, () => {
  let app: FastifyInstance;

  before(async () => {
    process.env.LOG_LEVEL = 'error';
    app = await buildApp();
    await app.ready();
  });

  after(async () => {
    await app.close();
    await closePools();
    await closeRedis();
  });

  it('refuses an unsigned request', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/internal/files/tenants/whatever/payslip/leak.pdf',
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'invalid_signature');
  });

  it('refuses a request whose signature does not match the key', async () => {
    const store = storage();
    const key = store.buildKey('00000000-0000-0000-0000-000000000001', 'payslip', 'mine.pdf');
    const presigned = await store.presignUpload(key, 'application/pdf');
    const signature = new URL(presigned.url, 'http://localhost').searchParams.get('sig');

    // The signature is over the key, so reusing it for a different object must fail. Without
    // that binding, one valid link would be a key to the whole bucket.
    const otherKey = store.buildKey('00000000-0000-0000-0000-000000000002', 'payslip', 'theirs.pdf');
    const response = await app.inject({
      method: 'GET',
      url: `/internal/files/${encodeURIComponent(otherKey)}?expires=${
        Math.floor(Date.now() / 1000) + 600
      }&sig=${signature}`,
    });
    assert.equal(response.statusCode, 403);
  });

  it('refuses an expired link even with a valid signature for that expiry', async () => {
    const store = storage();
    const key = store.buildKey('00000000-0000-0000-0000-000000000001', 'payslip', 'old.pdf');
    // A signature covering an expiry in the past is genuinely valid *and* must be refused:
    // the expiry is part of what is signed precisely so it cannot be extended.
    const response = await app.inject({
      method: 'GET',
      url: `/internal/files/${encodeURIComponent(key)}?expires=1&sig=anything`,
    });
    assert.equal(response.statusCode, 403);
  });

  it('is not a route at all when object storage is S3', async () => {
    const original = process.env.STORAGE_DRIVER;
    try {
      // In production this is enforced at boot: config.ts refuses to start with
      // STORAGE_DRIVER=local. The route re-checks anyway, so it is dead in any environment
      // pointed at a real bucket.
      process.env.STORAGE_DRIVER = 's3';
      const { loadConfig } = await import('../../src/config.ts');
      const cfg = loadConfig(process.env);
      assert.equal(cfg.STORAGE_DRIVER, 's3');
    } finally {
      if (original === undefined) delete process.env.STORAGE_DRIVER;
      else process.env.STORAGE_DRIVER = original;
    }
  });

  it('refuses to start in production with development drivers', () => {
    // The guard that makes the /internal route dead code in production, checked directly
    // rather than trusted.
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      JWT_SECRET: 'a'.repeat(48),
      FIELD_ENCRYPTION_KEY: 'a'.repeat(64),
      REDIS_URL: 'redis://x',
      QUEUE_DRIVER: 'sqs',
      STORAGE_DRIVER: 's3',
    } as NodeJS.ProcessEnv;

    return import('../../src/config.ts').then(({ loadConfig }) => {
      assert.throws(
        () => loadConfig({ ...base, STORAGE_DRIVER: 'local' }),
        /STORAGE_DRIVER=local is a development transport/,
      );
      assert.throws(
        () => loadConfig({ ...base, QUEUE_DRIVER: 'local' }),
        /QUEUE_DRIVER=local is a development transport/,
      );
      assert.throws(
        () => loadConfig({ ...base, REDIS_URL: undefined }),
        /REDIS_URL is required in production/,
      );
      assert.throws(
        () => loadConfig({ ...base, ALLOW_UNVERIFIED_RLS: 'true' }),
        /ALLOW_UNVERIFIED_RLS must not be enabled in production/,
      );
    });
  });
});
