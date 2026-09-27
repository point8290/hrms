import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app.ts';
import { closePools, withPlatform, withTenant, SYSTEM_ACTOR } from '../../src/infra/db/pool.ts';
import { closeRedis, setRedis } from '../../src/infra/redis.ts';
import { signAccessToken } from '../../src/http/auth.ts';
import { checkRedis } from '../../src/http/health.ts';
import { claimEvent } from '../../src/infra/events/outbox.ts';
import * as leave from '../../src/modules/leave/service.ts';
import * as identity from '../../src/modules/identity/service.ts';
import {
  createEmployee,
  createLeaveType,
  createTestTenant,
  dropTestTenant,
  skipWithoutDb,
  type TestTenant,
} from './helpers.ts';

/**
 * What happens when the things this system depends on are not there.
 *
 * Two failure shapes, tested separately because they demand opposite responses:
 *
 *   * A **degraded dependency** (Redis) must not cost availability. Rate limiting is a
 *     protection against abuse, not a correctness control, so losing it degrades accuracy
 *     and nothing else.
 *   * A **correctness boundary** (a leave balance, a refresh token, an event claim) must
 *     never be softened by concurrency. Two requests racing is the normal case, not the
 *     exotic one — a retry, two tabs, or two workers handed the same message.
 */

describe('degraded dependencies', skipWithoutDb, () => {
  let app: FastifyInstance;
  let tenant: TestTenant;
  let token: string;
  let employeeId: string;

  before(async () => {
    process.env.LOG_LEVEL = 'error';

    // A Redis that fails every command, installed before the app is built so the rate
    // limiter is configured against it exactly as it would be during a real outage.
    setRedis({
      status: 'end',
      async quit() {
        return 'OK';
      },
      on() {
        return undefined;
      },
      // @fastify/rate-limit calls through these; every one rejects.
      async ping() {
        throw new Error('Redis is unreachable');
      },
      async eval() {
        throw new Error('Redis is unreachable');
      },
      async evalsha() {
        throw new Error('Redis is unreachable');
      },
      async get() {
        throw new Error('Redis is unreachable');
      },
      async set() {
        throw new Error('Redis is unreachable');
      },
      defineCommand() {
        return undefined;
      },
    } as never);

    app = await buildApp();
    await app.ready();

    tenant = await createTestTenant('degraded');
    employeeId = await createEmployee(tenant, { code: 'DEG001', joiningDate: '2025-01-01' });

    const membership = await tenant.as(async (tx) => {
      await tx.query(`INSERT INTO identity.role (tenant_id, name, is_system) VALUES ($1, 'Reader', false)`, [
        tenant.tenantId,
      ]);
      const role = await tx.query<{ id: string }>(
        `SELECT id FROM identity.role WHERE tenant_id = $1 AND name = 'Reader'`,
        [tenant.tenantId],
      );
      await tx.query(
        `INSERT INTO identity.role_permission (tenant_id, role_id, permission_code)
         VALUES ($1, $2, 'employee.read')`,
        [tenant.tenantId, role.rows[0]!.id],
      );
      return identity.inviteUser(tx, {
        email: 'degraded@example.com',
        fullName: 'Degraded Reader',
        password: 'DegradedPassword1',
        roleNames: ['Reader'],
      });
    });

    token = await signAccessToken({
      sub: membership.userId,
      tid: tenant.tenantId,
      mid: membership.membershipId,
      eid: employeeId,
      perms: ['employee.read'],
      name: 'Degraded Reader',
      mfa: false,
    });
  });

  after(async () => {
    await app.close();
    await dropTestTenant(tenant.tenantId);
    await closePools();
    setRedis(undefined);
    await closeRedis();
  });

  it('keeps serving requests while Redis is unreachable', async () => {
    // Fail open. A Redis outage taking the whole API down would turn a cache problem into
    // an outage, and nothing about isolation or authorization depends on Redis.
    for (let i = 0; i < 5; i += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/employees/${employeeId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.statusCode, 200, 'a Redis outage must not fail a legitimate request');
    }
  });

  it('still enforces authentication while Redis is unreachable', async () => {
    // The important half of failing open: it opens the *limiter*, not the door.
    const response = await app.inject({ method: 'GET', url: `/api/employees/${employeeId}` });
    assert.equal(response.statusCode, 401);
  });

  it('still enforces tenant isolation while Redis is unreachable', async () => {
    const other = await createTestTenant('degraded-other');
    const otherEmployee = await createEmployee(other, { code: 'OTH001', joiningDate: '2025-01-01' });

    const response = await app.inject({
      method: 'GET',
      url: `/api/employees/${otherEmployee}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 404);
    await dropTestTenant(other.tenantId);
  });

  it('reports Redis as degraded, not down, so healthy instances stay in rotation', async () => {
    const result = await checkRedis();
    assert.ok(
      result.status === 'degraded' || result.status === 'not_configured',
      `expected degraded, got ${result.status}`,
    );
  });

  it('answers liveness without touching any dependency', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'alive');
  });

  it('reports ready while only Redis is down, because the database is what a request needs', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(response.statusCode, 200);
  });

  it('describes every dependency without leaking a connection string', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/deps' });
    assert.equal(response.statusCode, 200, 'diagnostics must not tell a load balancer to act');

    const body = JSON.stringify(response.json());
    for (const secret of ['postgres://', 'redis://', process.env.DATABASE_URL ?? 'x', 'password']) {
      assert.ok(!body.includes(secret), `health output must not contain ${secret}`);
    }
  });
});

/**
 * Invariants under concurrency.
 *
 * Each of these has a single-threaded test elsewhere that passes. The question here is
 * whether the invariant survives two callers arriving at the same instant — which is where
 * a check-then-act becomes a double-spend.
 */
describe('concurrency invariants', skipWithoutDb, () => {
  let tenant: TestTenant;
  let employeeId: string;
  let leaveTypeId: string;

  before(async () => {
    tenant = await createTestTenant('concurrency');
    employeeId = await createEmployee(tenant, { code: 'CON001', joiningDate: '2025-01-01' });
    leaveTypeId = await createLeaveType(tenant, { requiresApproval: false, allowNegative: false });

    // Exactly five days of entitlement. Two five-day applications cannot both be right.
    await tenant.as((tx) =>
      tx.query(
        `INSERT INTO leave_mgmt.leave_ledger_entry
           (tenant_id, employee_id, leave_type_id, entry_type, quantity, effective_date,
            period_start, period_end, source_type)
         VALUES ($1,$2,$3,'allocation',5,'2026-01-01','2026-01-01','2026-12-31','leave_allocation')`,
        [tenant.tenantId, employeeId, leaveTypeId],
      ),
    );
  });

  after(async () => {
    await dropTestTenant(tenant.tenantId);
    await closePools();
  });

  it('will not let two concurrent applications spend the same leave balance', async () => {
    const applyOnce = (startDate: string, endDate: string) =>
      tenant.as((tx) =>
        leave.apply(tx, {
          employeeId,
          leaveTypeId,
          startDate,
          endDate,
          startHalfDay: false,
          endHalfDay: false,
          reason: 'concurrency test',
        }),
      );

    // Non-overlapping dates, so the overlap constraint is not what stops the second one —
    // only the balance is. Five days available, ten days requested.
    const results = await Promise.allSettled([
      applyOnce('2026-03-02', '2026-03-06'),
      applyOnce('2026-03-09', '2026-03-13'),
    ]);

    const accepted = results.filter((r) => r.status === 'fulfilled');
    assert.equal(accepted.length, 1, `exactly one application may succeed, got ${accepted.length}`);

    const balance = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ total: string }>(
        `SELECT COALESCE(sum(quantity), 0)::text AS total FROM leave_mgmt.leave_ledger_entry
          WHERE employee_id = $1 AND leave_type_id = $2`,
        [employeeId, leaveTypeId],
      );
      return Number(rows[0]!.total);
    });
    assert.ok(balance >= 0, `the balance must never go negative, got ${balance}`);
  });

  it('will not let two concurrent overlapping applications both be recorded', async () => {
    // Its own type with plenty of balance: this test is about the overlap constraint, and
    // a shared, exhausted balance would stop the second application for the wrong reason
    // and prove nothing.
    const overlapType = await createLeaveType(tenant, { requiresApproval: false });
    await tenant.as((tx) =>
      tx.query(
        `INSERT INTO leave_mgmt.leave_ledger_entry
           (tenant_id, employee_id, leave_type_id, entry_type, quantity, effective_date,
            period_start, period_end, source_type)
         VALUES ($1,$2,$3,'allocation',20,'2026-01-01','2026-01-01','2026-12-31','leave_allocation')`,
        [tenant.tenantId, employeeId, overlapType],
      ),
    );

    const applyOnce = () =>
      tenant.as((tx) =>
        leave.apply(tx, {
          employeeId,
          leaveTypeId: overlapType,
          startDate: '2026-06-01',
          endDate: '2026-06-01',
          startHalfDay: false,
          endHalfDay: false,
        }),
      );

    const results = await Promise.allSettled([applyOnce(), applyOnce()]);
    assert.equal(
      results.filter((r) => r.status === 'fulfilled').length,
      1,
      'the same day must not be booked twice',
    );
  });

  it('hands a duplicated event to exactly one consumer', async () => {
    const eventId = crypto.randomUUID();

    // The SQS at-least-once case: the same message delivered to five workers at once.
    const claims = await Promise.all(
      Array.from({ length: 5 }, () =>
        withTenant(tenant.tenantId, { ...SYSTEM_ACTOR, label: 'dup-test' }, (tx) =>
          claimEvent(tx, tenant.tenantId, eventId, 'concurrency-test-consumer'),
        ).catch(() => false),
      ),
    );

    assert.equal(
      claims.filter(Boolean).length,
      1,
      'processed_event is what makes at-least-once delivery safe; exactly one claim may win',
    );
  });

  it('lets two consumers claim the same event independently', async () => {
    const eventId = crypto.randomUUID();
    const as = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
      withTenant(tenant.tenantId, { ...SYSTEM_ACTOR, label: 'dup-test' }, fn);

    // The guard is (event_id, consumer_name): two different consumers legitimately both
    // handle the same event, and keying it on event_id alone would starve one of them.
    assert.equal(await as((tx) => claimEvent(tx, tenant.tenantId, eventId, 'consumer-a')), true);
    assert.equal(await as((tx) => claimEvent(tx, tenant.tenantId, eventId, 'consumer-b')), true);
    assert.equal(await as((tx) => claimEvent(tx, tenant.tenantId, eventId, 'consumer-a')), false);
  });

  it('rotates a refresh token exactly once under a concurrent double-refresh', async () => {
    const slug = await withPlatform('maintenance', async (tx) => {
      const { rows } = await tx.query<{ slug: string }>('SELECT slug FROM identity.tenant WHERE id = $1', [
        tenant.tenantId,
      ]);
      return rows[0]!.slug;
    });

    await tenant.as(async (tx) => {
      await tx.query(`INSERT INTO identity.role (tenant_id, name, is_system) VALUES ($1, 'Plain', false)`, [
        tenant.tenantId,
      ]);
      const role = await tx.query<{ id: string }>(
        `SELECT id FROM identity.role WHERE tenant_id = $1 AND name = 'Plain'`,
        [tenant.tenantId],
      );
      await tx.query(
        `INSERT INTO identity.role_permission (tenant_id, role_id, permission_code)
         VALUES ($1, $2, 'employee.read.self')`,
        [tenant.tenantId, role.rows[0]!.id],
      );
      await identity.inviteUser(tx, {
        email: 'rotate@example.com',
        fullName: 'Rotate User',
        password: 'RotatePassword1',
        roleNames: ['Plain'],
      });
    });

    const session = await identity.login({ slug, email: 'rotate@example.com', password: 'RotatePassword1' });
    assert.ok(!identity.isChallenge(session));

    const attempts = await Promise.allSettled([
      identity.refresh(tenant.tenantId, session.refreshToken),
      identity.refresh(tenant.tenantId, session.refreshToken),
    ]);

    const succeeded = attempts.filter((a) => a.status === 'fulfilled');
    assert.equal(succeeded.length, 1, 'one rotation may win; the other must be refused');

    // And the loser must not have been treated as theft — a retry on a flaky network is not
    // an attack, and revoking every session for it logs a real user out for no reason.
    const live = await withPlatform('maintenance', async (tx) => {
      const { rows } = await tx.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM identity.refresh_token
          WHERE tenant_id = $1 AND revoked_at IS NULL`,
        [tenant.tenantId],
      );
      return rows[0]!.count;
    });
    assert.ok(live >= 1, 'the winning session must still be alive');
  });
});
