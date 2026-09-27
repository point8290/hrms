import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { closePools, withPlatform, withTenant, SYSTEM_ACTOR } from '../../src/infra/db/pool.ts';
import {
  claimDueJobs,
  scheduleJobs,
  tenantClocks,
  type ClaimedJob,
} from '../../src/infra/scheduler/jobs.ts';
import {
  clearJobRegistry,
  registerJob,
  runSchedulerTick,
  type JobDefinition,
  type JobOutcome,
} from '../../src/infra/scheduler/registry.ts';
import { registerAllJobs } from '../../src/infra/scheduler/index.ts';
import { financialYearOf } from '../../src/modules/tenant/financial-year.ts';
import { createTestTenant, dropTestTenant, skipWithoutDb, type TestTenant } from './helpers.ts';

/**
 * The generic scheduled-job framework.
 *
 * The properties under test are the ones every job type inherits, and the reason the
 * framework exists at all: a job runs once per tenant per date however many schedulers are
 * running, a crash is recovered rather than lost, a persistent failure backs off and is
 * eventually surfaced, and one tenant's bad data never stops another tenant's work.
 */
describe('scheduled job framework', skipWithoutDb, () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  // Unique per run: `runSchedulerTick` visits every active tenant, and other test files
  // create tenants in parallel processes against the same database. A shared job type would
  // make this suite's counts depend on what else happened to be running.
  const JOB = `test.job_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const DATE = '2026-03-04';

  /** Executions belonging to this suite's own tenants. Others are someone else's test. */
  const mine = (rows: Array<{ tenantId: string }>) =>
    rows.filter((r) => r.tenantId === tenantA.tenantId || r.tenantId === tenantB.tenantId);

  before(async () => {
    tenantA = await createTestTenant('sched-a');
    tenantB = await createTestTenant('sched-b');
  });

  after(async () => {
    registerAllJobs();
    await dropTestTenant(tenantA.tenantId);
    await dropTestTenant(tenantB.tenantId);
    await closePools();
  });

  /** A job definition that records what it was asked to do and can be made to fail. */
  function testJob(options: {
    dates?: string[];
    onExecute?: (job: ClaimedJob, tenantId: string) => Promise<JobOutcome>;
  }): { definition: JobDefinition; executed: Array<{ tenantId: string; jobId: string }> } {
    const executed: Array<{ tenantId: string; jobId: string }> = [];
    const definition: JobDefinition = {
      jobType: JOB,
      async plan() {
        return (options.dates ?? [DATE]).map((executionDate) => ({ jobType: JOB, executionDate }));
      },
      async execute(tx, job) {
        executed.push({ tenantId: tx.tenantId, jobId: job.id });
        return options.onExecute ? options.onExecute(job, tx.tenantId) : { mode: 'completed' };
      },
    };
    return { definition, executed };
  }

  async function statusOf(tenant: TestTenant, date = DATE) {
    return tenant.as(async (tx) => {
      const { rows } = await tx.query<{
        status: string;
        attempt_count: number;
        last_error: string | null;
        result: Record<string, unknown>;
      }>(
        `SELECT status, attempt_count, last_error, result FROM integration.scheduled_job
          WHERE job_type = $1 AND execution_date = $2`,
        [JOB, date],
      );
      return rows[0];
    });
  }

  async function clearTestJobs(): Promise<void> {
    await withPlatform('maintenance', (tx) =>
      tx.query(`DELETE FROM integration.scheduled_job WHERE job_type = $1`, [JOB]),
    );
  }

  it('plans, claims and executes a job for every active tenant', async () => {
    clearJobRegistry();
    const { definition, executed } = testJob({});
    registerJob(definition);

    await runSchedulerTick({ jobTypes: [JOB] });

    const tenants = executed.map((e) => e.tenantId);
    assert.ok(tenants.includes(tenantA.tenantId));
    assert.ok(tenants.includes(tenantB.tenantId));
    assert.equal((await statusOf(tenantA))?.status, 'completed');
  });

  it('does not run a completed job again, however many ticks pass', async () => {
    clearJobRegistry();
    const { definition, executed } = testJob({});
    registerJob(definition);

    await runSchedulerTick({ jobTypes: [JOB] });
    await runSchedulerTick({ jobTypes: [JOB] });

    assert.equal(mine(executed).length, 0, 're-planning must not resurrect a completed job');
    await clearTestJobs();
  });

  it('runs a job exactly once when two schedulers tick at the same instant', async () => {
    clearJobRegistry();
    const { definition, executed } = testJob({});
    registerJob(definition);

    // The real concurrency case: two scheduler replicas, one database.
    await Promise.all([
      runSchedulerTick({ jobTypes: [JOB] }),
      runSchedulerTick({ jobTypes: [JOB] }),
      runSchedulerTick({ jobTypes: [JOB] }),
    ]);

    const forTenantA = executed.filter((e) => e.tenantId === tenantA.tenantId);
    assert.equal(forTenantA.length, 1, `expected exactly one execution, got ${forTenantA.length}`);
    await clearTestJobs();
  });

  it('records a failure with its attempt count even though the executor rolled back', async () => {
    clearJobRegistry();
    const errors: unknown[] = [];
    const { definition } = testJob({
      onExecute: async () => {
        throw new Error('engine unreachable');
      },
    });
    registerJob(definition);

    await runSchedulerTick({ jobTypes: [JOB], onError: (_c, err) => errors.push(err) });

    const row = await statusOf(tenantA);
    assert.equal(row?.status, 'failed');
    assert.equal(row?.attempt_count, 1, 'a failed attempt must still count towards abandonment');
    assert.match(row!.last_error!, /engine unreachable/);
    assert.ok(errors.length >= 1, 'the caller must be told, not just the database');
    await clearTestJobs();
  });

  it('keeps running other tenants when one tenant fails', async () => {
    clearJobRegistry();
    const { definition, executed } = testJob({
      onExecute: async (_job, tenantId) => {
        if (tenantId === tenantA.tenantId) throw new Error('bad data for this tenant');
        return { mode: 'completed' };
      },
    });
    registerJob(definition);

    await runSchedulerTick({ jobTypes: [JOB], onError: () => {} });

    assert.equal((await statusOf(tenantA))?.status, 'failed');
    assert.equal((await statusOf(tenantB))?.status, 'completed');
    assert.ok(executed.some((e) => e.tenantId === tenantB.tenantId));
    await clearTestJobs();
  });

  it('leaves a dispatched job running until whoever executes it reports back', async () => {
    clearJobRegistry();
    const { definition } = testJob({ onExecute: async () => ({ mode: 'dispatched' }) });
    registerJob(definition);

    await runSchedulerTick({ jobTypes: [JOB] });

    const row = await statusOf(tenantA);
    assert.equal(row?.status, 'running', 'a handed-off job must not be reported as done');
    await clearTestJobs();
  });

  it('records a skipped job as settled rather than retrying it forever', async () => {
    clearJobRegistry();
    const { definition } = testJob({
      onExecute: async () => ({ mode: 'skipped', reason: 'no employees configured' }),
    });
    registerJob(definition);

    await runSchedulerTick({ jobTypes: [JOB] });

    const row = await statusOf(tenantA);
    assert.equal(row?.status, 'completed');
    assert.equal(row?.result.skipped, true);
    assert.equal(row?.result.reason, 'no employees configured');
    await clearTestJobs();
  });

  it('stops claiming a job once it exhausts its attempts', async () => {
    clearJobRegistry();
    const { definition, executed } = testJob({
      onExecute: async () => {
        throw new Error('permanently broken');
      },
    });
    registerJob(definition);

    // Drive it to exhaustion, resetting the backoff between ticks the way time would.
    for (let i = 0; i < 6; i += 1) {
      await runSchedulerTick({ jobTypes: [JOB], onError: () => {} });
      await withPlatform('maintenance', (tx) =>
        tx.query(`UPDATE integration.scheduled_job SET available_at = now() WHERE job_type = $1`, [JOB]),
      );
    }

    const row = await statusOf(tenantA);
    assert.equal(row?.status, 'abandoned');
    assert.equal(row?.attempt_count, 5);

    const before = mine(executed).length;
    await runSchedulerTick({ jobTypes: [JOB], onError: () => {} });
    assert.equal(mine(executed).length, before, 'an abandoned job must not be claimed again');
    await clearTestJobs();
  });

  it('never hands the same job to two concurrent claimers', async () => {
    clearJobRegistry();
    await tenantA.as((tx) => scheduleJobs(tx, [{ jobType: JOB, executionDate: '2026-03-09' }]));

    const actor = { ...SYSTEM_ACTOR, label: 'concurrency-test' };
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        withTenant(tenantA.tenantId, actor, (tx) => claimDueJobs(tx, { jobTypes: [JOB], limit: 10 })),
      ),
    );

    const claims = results.flat();
    assert.equal(claims.length, 1, `exactly one claimer must win, got ${claims.length}`);
    await clearTestJobs();
  });

  it('schedules nothing for a tenant that has no work to do', async () => {
    clearJobRegistry();
    const { definition } = testJob({ dates: [] });
    registerJob(definition);

    const report = await runSchedulerTick({ jobTypes: [JOB] });
    assert.equal(report.jobsCreated, 0);
    assert.equal(report.jobsExecuted, 0);
    assert.ok(report.tenantsConsidered >= 2);
    await clearTestJobs();
  });
});

/**
 * Leave accrual and carry-forward, scheduled rather than remembered.
 *
 * The bug being prevented is quiet: nobody notices that accrual did not run until an
 * employee tries to take leave they earned and is told they have none.
 */
describe('leave period jobs', skipWithoutDb, () => {
  let tenant: TestTenant;

  before(async () => {
    tenant = await createTestTenant('leave-sched');
    registerAllJobs();
  });

  after(async () => {
    await dropTestTenant(tenant.tenantId);
    await closePools();
  });

  it('derives the financial year from the tenant configuration, not the calendar', () => {
    const boundaries = (date: string, startMonth: number) => {
      const fy = financialYearOf(date, startMonth);
      return { start: fy.start, end: fy.end };
    };

    // April start (India's default): March belongs to the year that began last April.
    assert.deepEqual(boundaries('2026-03-31', 4), { start: '2025-04-01', end: '2026-03-31' });
    assert.deepEqual(boundaries('2026-04-01', 4), { start: '2026-04-01', end: '2027-03-31' });
    // January start behaves like a calendar year.
    assert.deepEqual(boundaries('2026-07-15', 1), { start: '2026-01-01', end: '2026-12-31' });
    // Leap year: the year ending inside February must not lose a day.
    assert.deepEqual(boundaries('2024-05-01', 3), { start: '2024-03-01', end: '2025-02-28' });
  });

  it('schedules an annual accrual per leave type once the tenant has lived through a year', async () => {
    const leaveTypeId = await tenant.as(async (tx) => {
      const type = await tx.query<{ id: string }>(
        `INSERT INTO leave_mgmt.leave_type (tenant_id, code, name, is_paid, carry_forward_enabled)
         VALUES ($1, 'EL', 'Earned Leave', true, true) RETURNING id`,
        [tenant.tenantId],
      );
      const policy = await tx.query<{ id: string }>(
        `INSERT INTO leave_mgmt.leave_policy (tenant_id, name, effective_from)
         VALUES ($1, 'Standard', '2020-01-01') RETURNING id`,
        [tenant.tenantId],
      );
      await tx.query(
        `INSERT INTO leave_mgmt.leave_policy_rule
           (tenant_id, leave_policy_id, leave_type_id, annual_allocation, accrual_frequency)
         VALUES ($1, $2, $3, 18, 'annual')`,
        [tenant.tenantId, policy.rows[0]!.id, type.rows[0]!.id],
      );
      return type.rows[0]!.id;
    });

    // Backdate the tenant so the current financial year began under our management.
    await withPlatform('maintenance', (tx) =>
      tx.query(`UPDATE identity.tenant SET created_at = now() - INTERVAL '3 years' WHERE id = $1`, [
        tenant.tenantId,
      ]),
    );

    await runSchedulerTick({ jobTypes: ['leave.accrual', 'leave.carry_forward'], onError: () => {} });

    const clock = (await withPlatform('maintenance', (tx) => tenantClocks(tx))).find(
      (c) => c.tenant_id === tenant.tenantId,
    )!;
    const fy = financialYearOf(clock.local_date, clock.fy_start_month);

    const jobs = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ job_type: string; job_key: string; status: string; execution_date: string }>(
        `SELECT job_type, job_key, status, to_char(execution_date, 'YYYY-MM-DD') AS execution_date
           FROM integration.scheduled_job
          WHERE job_type LIKE 'leave.%'
          ORDER BY job_type`,
      );
      return rows;
    });

    const accrual = jobs.find((j) => j.job_type === 'leave.accrual');
    assert.ok(accrual, 'annual accrual must be scheduled automatically');
    assert.equal(accrual.job_key, leaveTypeId, 'one job per leave type, keyed by it');
    assert.equal(accrual.execution_date, fy.start);
    assert.equal(accrual.status, 'completed');

    const carry = jobs.find((j) => j.job_type === 'leave.carry_forward');
    assert.ok(carry, 'carry-forward must be scheduled automatically');
    assert.equal(carry.status, 'completed');
  });

  it('does not schedule a monthly or quarterly rule it cannot period-correctly accrue', async () => {
    const before = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM integration.scheduled_job WHERE job_type = 'leave.accrual'`,
      );
      return Number(rows[0]!.count);
    });

    await tenant.as(async (tx) => {
      const type = await tx.query<{ id: string }>(
        `INSERT INTO leave_mgmt.leave_type (tenant_id, code, name, is_paid)
         VALUES ($1, 'CL', 'Casual Leave', true) RETURNING id`,
        [tenant.tenantId],
      );
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM leave_mgmt.leave_policy WHERE tenant_id = $1 LIMIT 1`,
        [tenant.tenantId],
      );
      await tx.query(
        `INSERT INTO leave_mgmt.leave_policy_rule
           (tenant_id, leave_policy_id, leave_type_id, annual_allocation, accrual_frequency)
         VALUES ($1, $2, $3, 12, 'monthly')`,
        [tenant.tenantId, rows[0]!.id, type.rows[0]!.id],
      );
    });

    await runSchedulerTick({ jobTypes: ['leave.accrual'], onError: () => {} });

    const after = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM integration.scheduled_job WHERE job_type = 'leave.accrual'`,
      );
      return Number(rows[0]!.count);
    });
    assert.equal(after, before, 'a monthly rule must not be granted a full annual allocation');
  });
});
