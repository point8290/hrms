import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app.ts';
import { closePools, withPlatform, withTenant, SYSTEM_ACTOR } from '../../src/infra/db/pool.ts';
import { closeRedis } from '../../src/infra/redis.ts';
import { signAccessToken } from '../../src/http/auth.ts';
import { emitEvent } from '../../src/infra/events/outbox.ts';
import { claimDueJobs, scheduleJobs } from '../../src/infra/scheduler/jobs.ts';
import { clearJobRegistry, registerJob, runSchedulerTick } from '../../src/infra/scheduler/registry.ts';
import { registerAllJobs } from '../../src/infra/scheduler/index.ts';
import * as identity from '../../src/modules/identity/service.ts';
import {
  createEmployee,
  createTestTenant,
  dropTestTenant,
  skipWithoutDb,
  type TestTenant,
} from './helpers.ts';

/**
 * Tenant context, verified at every layer that can establish it.
 *
 * RLS is only as good as the context set in front of it, and the context is set in five
 * different places: an HTTP request, a queue consumer, a scheduled job, the outbox
 * publisher, and direct repository use. Each is a separate opportunity to get it wrong, and
 * a single one getting it wrong is a cross-tenant salary leak — so each is tested here
 * rather than relying on the repository-layer tests alone.
 *
 * The question every test below asks is the same: *where did the tenant come from?* Any
 * answer other than "a verified token, or an envelope the platform itself wrote" is a bug.
 */
describe('tenant context at every boundary', skipWithoutDb, () => {
  let app: FastifyInstance;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let employeeA: string;
  let employeeB: string;
  let tokenA: string;

  before(async () => {
    // The app's request log is deliberately verbose; in a test it drowns the assertions.
    process.env.LOG_LEVEL = 'error';
    app = await buildApp();
    await app.ready();

    tenantA = await createTestTenant('ctx-a');
    tenantB = await createTestTenant('ctx-b');
    employeeA = await createEmployee(tenantA, { code: 'CTXA001', joiningDate: '2025-01-01' });
    employeeB = await createEmployee(tenantB, { code: 'CTXB001', joiningDate: '2025-01-01' });

    const membershipA = await tenantA.as(async (tx) => {
      await tx.query(
        `INSERT INTO identity.role (tenant_id, name, is_system) VALUES ($1, 'Reader', false)`,
        [tenantA.tenantId],
      );
      const role = await tx.query<{ id: string }>(
        `SELECT id FROM identity.role WHERE tenant_id = $1 AND name = 'Reader'`,
        [tenantA.tenantId],
      );
      await tx.query(
        `INSERT INTO identity.role_permission (tenant_id, role_id, permission_code)
         VALUES ($1, $2, 'employee.read'), ($1, $2, 'audit.read')`,
        [tenantA.tenantId, role.rows[0]!.id],
      );
      return identity.inviteUser(tx, {
        email: 'reader@tenant-a.example',
        fullName: 'Reader A',
        password: 'ReaderPassword1',
        roleNames: ['Reader'],
      });
    });

    // Signed directly rather than through login: this suite is about what a *valid* token
    // authorises, and `audit.read` is sensitive, so the login path would (correctly) demand
    // a second factor first. That enforcement has its own tests.
    tokenA = await signAccessToken({
      sub: membershipA.userId,
      tid: tenantA.tenantId,
      mid: membershipA.membershipId,
      eid: null,
      perms: ['employee.read', 'audit.read'],
      name: 'Reader A',
      mfa: true,
    });
  });

  after(async () => {
    registerAllJobs();
    await app.close();
    await dropTestTenant(tenantA.tenantId);
    await dropTestTenant(tenantB.tenantId);
    await closePools();
    // buildApp opens a Redis connection for the shared rate limiter; without closing it the
    // test process stays alive after the last assertion and the run looks like a hang.
    await closeRedis();
  });

  // ---------------------------------------------------------------- HTTP layer

  it('takes the tenant from the token and refuses to read another tenant employee', async () => {
    const mine = await app.inject({
      method: 'GET',
      url: `/api/employees/${employeeA}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(mine.statusCode, 200);

    const theirs = await app.inject({
      method: 'GET',
      url: `/api/employees/${employeeB}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(theirs.statusCode, 404, 'another tenant employee must not be readable by id');
  });

  it('ignores a tenant supplied in a header', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/employees/${employeeB}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        // The obvious escalation attempt: ask nicely to be another tenant.
        'x-tenant-id': tenantB.tenantId,
        'x-tenant': tenantB.tenantId,
      },
    });
    assert.equal(response.statusCode, 404);
  });

  it('ignores a tenant supplied in a query string', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/employees?tenantId=${tenantB.tenantId}&tenant_id=${tenantB.tenantId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(response.statusCode, 200);

    const body = response.json() as { employees: Array<{ id: string }> };
    const rows = body.employees;
    assert.ok(rows.length > 0, 'the caller should still see its own employees');
    assert.ok(
      !rows.some((r) => r.id === employeeB),
      'a tenant id in the query string must not widen the result set',
    );
  });

  it('refuses a token signed with the wrong secret', async () => {
    const [header, payload] = tokenA.split('.');
    const forged = `${header}.${payload}.${'A'.repeat(43)}`;
    const response = await app.inject({
      method: 'GET',
      url: `/api/employees/${employeeA}`,
      headers: { authorization: `Bearer ${forged}` },
    });
    assert.equal(response.statusCode, 401);
  });

  it('refuses an unauthenticated request rather than defaulting to a tenant', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/employees/${employeeA}` });
    assert.equal(response.statusCode, 401);
  });

  it('keeps the audit trail scoped to the caller tenant', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/audit?limit=200',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { entries: Array<{ tenant_id?: string }> };
    for (const row of body.entries) {
      if (row.tenant_id) assert.equal(row.tenant_id, tenantA.tenantId);
    }
  });

  // ------------------------------------------------------- queue consumer layer

  it('scopes a consumer to the envelope tenant, not the aggregate it names', async () => {
    // The dangerous shape: a message for tenant A whose payload points at tenant B's row.
    // Tenant context comes from the envelope, so B's row is simply not visible — the
    // handler finds nothing rather than acting on another tenant's data.
    const visible = await withTenant(
      tenantA.tenantId,
      { ...SYSTEM_ACTOR, label: 'consumer-test' },
      async (tx) => {
        const { rowCount } = await tx.query('SELECT 1 FROM core.employee WHERE id = $1', [employeeB]);
        return rowCount ?? 0;
      },
    );
    assert.equal(visible, 0, 'a consumer running as tenant A must not resolve a tenant B aggregate');
  });

  it('keeps the outbox publisher from mixing tenants into one envelope', async () => {
    await tenantA.as((tx) =>
      emitEvent(tx, 'EmployeeCreated', {
        aggregateType: 'employee',
        aggregateId: employeeA,
        payload: { employee_id: employeeA },
      }),
    );
    await tenantB.as((tx) =>
      emitEvent(tx, 'EmployeeCreated', {
        aggregateType: 'employee',
        aggregateId: employeeB,
        payload: { employee_id: employeeB },
      }),
    );

    // The publisher legitimately reads across tenants — it is the one place that does — so
    // what matters is that each row still carries its own tenant, and that the envelope the
    // consumer will act on is the one that decides context.
    const rows = await withPlatform('outbox-publisher', async (tx) => {
      const { rows } = await tx.query<{ tenant_id: string; aggregate_id: string }>(
        `SELECT tenant_id, aggregate_id FROM integration.event_outbox
          WHERE aggregate_id IN ($1, $2)`,
        [employeeA, employeeB],
      );
      return rows;
    });

    const byAggregate = new Map(rows.map((r) => [r.aggregate_id, r.tenant_id]));
    assert.equal(byAggregate.get(employeeA), tenantA.tenantId);
    assert.equal(byAggregate.get(employeeB), tenantB.tenantId);
  });

  // ------------------------------------------------------- scheduled job layer

  it('runs a scheduled job inside its own tenant context, under RLS', async () => {
    clearJobRegistry();
    const seen: Array<{ jobTenant: string; visibleEmployees: number }> = [];

    registerJob({
      jobType: 'test.context',
      async plan() {
        return [{ jobType: 'test.context', executionDate: '2026-02-02' }];
      },
      async execute(tx) {
        // What the job can see is what its tenant can see — not everything.
        const { rows } = await tx.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM core.employee',
        );
        seen.push({ jobTenant: tx.tenantId, visibleEmployees: rows[0]?.count ?? 0 });
        return { mode: 'completed' };
      },
    });

    await runSchedulerTick({ jobTypes: ['test.context'], onError: () => {} });

    const runA = seen.find((s) => s.jobTenant === tenantA.tenantId);
    const runB = seen.find((s) => s.jobTenant === tenantB.tenantId);
    assert.ok(runA && runB, 'both tenants must get their own job');
    assert.equal(runA.visibleEmployees, 1, 'a job must see only its own tenant employees');
    assert.equal(runB.visibleEmployees, 1);

    await withPlatform('maintenance', (tx) =>
      tx.query(`DELETE FROM integration.scheduled_job WHERE job_type = 'test.context'`),
    );
    registerAllJobs();
  });

  it('will not let one tenant claim another tenant scheduled job', async () => {
    await tenantB.as((tx) =>
      scheduleJobs(tx, [{ jobType: 'attendance.close', executionDate: '2026-02-03' }]),
    );

    const stolen = await tenantA.as((tx) =>
      claimDueJobs(tx, { jobTypes: ['attendance.close'], limit: 10 }),
    );
    assert.ok(
      !stolen.some((j) => j.execution_date === '2026-02-03'),
      'a claim is scoped by tenant; one tenant must never run another tenant job',
    );

    const ownedByB = await tenantB.as(async (tx) => {
      const { rowCount } = await tx.query(
        `SELECT 1 FROM integration.scheduled_job
          WHERE job_type = 'attendance.close' AND execution_date = '2026-02-03'`,
      );
      return rowCount ?? 0;
    });
    assert.equal(ownedByB, 1, 'and the job is still there, waiting for its own tenant');
  });

  // ------------------------------------------------------------ repository layer

  it('refuses to open a tenant transaction without a real tenant id', async () => {
    await assert.rejects(
      withTenant('', SYSTEM_ACTOR, async () => undefined),
      /Tenant context is not a valid UUID/,
    );
    await assert.rejects(
      withTenant("' OR 1=1 --", SYSTEM_ACTOR, async () => undefined),
      /Tenant context is not a valid UUID/,
    );
  });

  it('does not carry tenant context across pooled transactions', async () => {
    await withTenant(tenantB.tenantId, SYSTEM_ACTOR, async (tx) => {
      const { rowCount } = await tx.query('SELECT 1 FROM core.employee WHERE id = $1', [employeeB]);
      assert.equal(rowCount, 1);
    });

    // Same pool, very likely the same physical connection. SET LOCAL is transaction-scoped
    // precisely so the next borrower cannot inherit the last one's tenant.
    await withTenant(tenantA.tenantId, SYSTEM_ACTOR, async (tx) => {
      const { rowCount } = await tx.query('SELECT 1 FROM core.employee WHERE id = $1', [employeeB]);
      assert.equal(rowCount, 0, 'the previous transaction tenant must not leak into this one');
    });
  });
});
