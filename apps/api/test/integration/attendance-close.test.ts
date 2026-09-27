import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closePools, withPlatform } from '../../src/infra/db/pool.ts';
import {
  abandonExhaustedJobs,
  claimDueJobs,
  failJob,
  reclaimStaleJobs,
  scheduleJobs,
  tenantClocks,
  DEFAULT_MAX_ATTEMPTS,
  type TenantClock,
} from '../../src/infra/scheduler/jobs.ts';
import {
  ATTENDANCE_CLOSE_JOB,
  closeCoverage,
  plannedCloseDates,
} from '../../src/modules/workforce/close-schedule.ts';
import * as payroll from '../../src/modules/payroll/service.ts';
import {
  createEmployee,
  createTestTenant,
  dropTestTenant,
  skipWithoutDb,
  type TestTenant,
} from './helpers.ts';
import { createPeriod } from '../../src/modules/payroll/service.ts';

const TYPES = [ATTENDANCE_CLOSE_JOB];

/**
 * The daily attendance close (ADR-007), now expressed as a scheduled job.
 *
 * These cover the properties the scheduler exists for: the right business date per
 * timezone, exactly-once scheduling, no concurrent duplicate, safe retry, and payroll
 * refusing to run on days that were never evaluated.
 */
describe('attendance close scheduling', skipWithoutDb, () => {
  let tenant: TestTenant;

  before(async () => {
    tenant = await createTestTenant('close');
    await createEmployee(tenant, { code: 'CLOSE001', joiningDate: '2025-01-01' });
  });

  after(async () => {
    await dropTestTenant(tenant.tenantId);
    await closePools();
  });

  /**
   * Sets the tenant clock and backdates creation.
   *
   * A tenant created moments ago legitimately has nothing to close - its first business
   * date has not ended yet. Backdating gives it the history a real tenant would have by
   * the time a close matters.
   */
  async function setTenantClock(timezone: string, closeHour: number): Promise<void> {
    await withPlatform('maintenance', (tx) =>
      tx.query(
        `UPDATE identity.tenant
            SET timezone = $2, attendance_close_hour = $3, created_at = now() - INTERVAL '60 days'
          WHERE id = $1`,
        [tenant.tenantId, timezone, closeHour],
      ),
    );
  }

  async function clock(): Promise<TenantClock | undefined> {
    const clocks = await withPlatform('maintenance', (tx) => tenantClocks(tx));
    return clocks.find((c) => c.tenant_id === tenant.tenantId);
  }

  /** The dates the attendance close job would schedule for this tenant right now. */
  async function plannedDates(backfillDays = 7): Promise<string[]> {
    const c = await clock();
    assert.ok(c, 'the tenant must appear in the clock enumeration');
    return plannedCloseDates(c, backfillDays);
  }

  async function scheduleDates(dates: readonly string[]): Promise<number> {
    const c = await clock();
    return tenant.as((tx) =>
      scheduleJobs(
        tx,
        dates.map((date) => ({
          jobType: ATTENDANCE_CLOSE_JOB,
          executionDate: date,
          payload: { timezone: c!.timezone },
        })),
      ),
    );
  }

  it('has nothing to close until the tenant has lived through a business day', async () => {
    // The tenant from before() was created moments ago. Its first day is not over.
    assert.deepEqual(await plannedDates(), [], 'a brand-new tenant must not be scheduled for a close');
  });

  it('derives the business date from the tenant timezone, not the server', async () => {
    await setTenantClock('Asia/Kolkata', 2);
    const kolkata = await clock();

    await setTenantClock('Pacific/Kiritimati', 2); // UTC+14, furthest ahead
    const kiritimati = await clock();

    assert.ok(kolkata && kiritimati);
    // Two tenants, one instant, different local dates — so different closable days.
    assert.ok(
      kiritimati.close_through >= kolkata.close_through,
      `expected the UTC+14 tenant to be at or ahead of UTC+5:30 (${kiritimati.close_through} vs ${kolkata.close_through})`,
    );
  });

  it('will not close a day before the tenant local clock passes the cutoff', async () => {
    // A 23:00 cutoff means "yesterday" only becomes closable at the very end of today.
    await setTenantClock('Asia/Kolkata', 23);
    const late = await clock();

    await setTenantClock('Asia/Kolkata', 0);
    const early = await clock();

    assert.ok(late && early);
    assert.ok(
      late.close_through <= early.close_through,
      'a later cutoff must never make more days closable than an earlier one',
    );
  });

  it('bounds the backfill window so a long-quiet tenant is not flooded', async () => {
    await setTenantClock('Asia/Kolkata', 2);
    const dates = await plannedDates(7);
    assert.ok(dates.length > 0 && dates.length <= 8, `expected at most a week of dates, got ${dates.length}`);
  });

  it('schedules one job per business date and is idempotent', async () => {
    await setTenantClock('Asia/Kolkata', 2);
    const dates = ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05'];

    assert.equal(await scheduleDates(dates), 5);
    // A second scheduler instance, or the same one on its next tick.
    assert.equal(await scheduleDates(dates), 0, 'rescheduling the same dates must create nothing');

    const total = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM integration.scheduled_job
          WHERE job_type = $1 AND execution_date BETWEEN '2026-05-01' AND '2026-05-05'`,
        [ATTENDANCE_CLOSE_JOB],
      );
      return Number(rows[0]!.count);
    });
    assert.equal(total, 5);
  });

  it('claims each due job exactly once', async () => {
    const claimed = await tenant.as((tx) => claimDueJobs(tx, { jobTypes: TYPES, limit: 10 }));
    assert.equal(claimed.length, 5);
    assert.ok(claimed.every((j) => j.attempt_count === 1));
    assert.ok(claimed.every((j) => j.correlation_id), 'every attempt must be correlatable');

    // Already claimed and marked running: a second pass must find nothing.
    const again = await tenant.as((tx) => claimDueJobs(tx, { jobTypes: TYPES, limit: 10 }));
    assert.equal(again.length, 0, 'a running job must not be claimed twice');
  });

  it('does not claim a job again while it is still within its retry window', async () => {
    const due = await tenant.as((tx) => claimDueJobs(tx, { jobTypes: TYPES, limit: 10 }));
    assert.equal(due.length, 0);
  });

  it('reclaims a job whose worker died mid-run', async () => {
    await tenant.as((tx) =>
      tx.query(
        `UPDATE integration.scheduled_job
            SET started_at = now() - INTERVAL '2 hours', available_at = now() - INTERVAL '2 hours'
          WHERE job_type = $1 AND execution_date = '2026-05-01'`,
        [ATTENDANCE_CLOSE_JOB],
      ),
    );

    const reclaimed = await tenant.as((tx) => reclaimStaleJobs(tx, { jobTypes: TYPES, staleAfterMinutes: 30 }));
    assert.equal(reclaimed, 1);

    const status = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ status: string; last_error: string }>(
        `SELECT status, last_error FROM integration.scheduled_job
          WHERE job_type = $1 AND execution_date = '2026-05-01'`,
        [ATTENDANCE_CLOSE_JOB],
      );
      return rows[0]!;
    });
    assert.equal(status.status, 'failed');
    assert.match(status.last_error, /stale/);
  });

  it('retries a reclaimed job on the next tick', async () => {
    const retried = await tenant.as((tx) => claimDueJobs(tx, { jobTypes: TYPES, limit: 10 }));
    assert.equal(retried.length, 1);
    assert.equal(retried[0]!.execution_date, '2026-05-01');
    assert.equal(retried[0]!.attempt_count, 2, 'the retry must be counted');
  });

  it('backs off exponentially after a failure, and records the attempt', async () => {
    // Failure is recorded from a transaction of its own, because the executing transaction
    // has usually rolled back by then — taking its attempt increment with it.
    const job = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM integration.scheduled_job
          WHERE job_type = $1 AND execution_date = '2026-05-01'`,
        [ATTENDANCE_CLOSE_JOB],
      );
      return rows[0]!;
    });

    await tenant.as((tx) => failJob(tx, job.id, 'engine unreachable', 2));

    const row = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ status: string; attempt_count: number; seconds_out: string }>(
        `SELECT status, attempt_count,
                EXTRACT(EPOCH FROM (available_at - now()))::text AS seconds_out
           FROM integration.scheduled_job WHERE id = $1`,
        [job.id],
      );
      return rows[0]!;
    });
    assert.equal(row.status, 'failed');
    assert.equal(row.attempt_count, 2, 'the attempt must stick even though the executor rolled back');
    // 2^2 = 4 minutes.
    assert.ok(Number(row.seconds_out) > 200, `expected a backoff of minutes, got ${row.seconds_out}s`);
  });

  it('abandons a job that exhausts its attempts and audits it', async () => {
    await tenant.as((tx) =>
      tx.query(
        `UPDATE integration.scheduled_job
            SET status = 'failed', attempt_count = $2, last_error = 'persistent failure'
          WHERE job_type = $1 AND execution_date = '2026-05-02'`,
        [ATTENDANCE_CLOSE_JOB, DEFAULT_MAX_ATTEMPTS],
      ),
    );

    const abandoned = await tenant.as((tx) => abandonExhaustedJobs(tx, TYPES));
    assert.deepEqual(abandoned.map((a) => a.execution_date), ['2026-05-02']);

    // Abandoned means a day will never be evaluated without a human; it must be findable.
    const audited = await tenant.as(async (tx) => {
      const { rowCount } = await tx.query(
        `SELECT 1 FROM audit.audit_log WHERE action = 'scheduled_job.abandoned' AND is_sensitive`,
      );
      return rowCount;
    });
    assert.equal(audited, 1);
  });

  it('stops retrying an abandoned job', async () => {
    await tenant.as((tx) =>
      tx.query(`UPDATE integration.scheduled_job SET available_at = now() WHERE job_type = $1`, [
        ATTENDANCE_CLOSE_JOB,
      ]),
    );
    const claimed = await tenant.as((tx) => claimDueJobs(tx, { jobTypes: TYPES, limit: 10 }));
    assert.ok(!claimed.some((j) => j.execution_date === '2026-05-02'));
  });

  it('reports coverage with the days that were never closed', async () => {
    await tenant.as((tx) =>
      tx.query(
        `UPDATE integration.scheduled_job
            SET status = 'completed', completed_at = now(), result = '{"employee_count": 1}'::jsonb
          WHERE job_type = $1 AND execution_date IN ('2026-05-01', '2026-05-03')`,
        [ATTENDANCE_CLOSE_JOB],
      ),
    );

    const coverage = await tenant.as((tx) => closeCoverage(tx, '2026-05-01', '2026-05-05'));
    assert.equal(coverage.expected_days, 5);
    assert.equal(coverage.closed_days, 2);
    assert.deepEqual(coverage.missing_dates, ['2026-05-02', '2026-05-04', '2026-05-05']);
    assert.equal(coverage.complete, false);
  });

  it('reports complete coverage once every day is closed', async () => {
    await tenant.as((tx) =>
      tx.query(
        `UPDATE integration.scheduled_job
            SET status = 'completed', completed_at = now()
          WHERE job_type = $1 AND execution_date BETWEEN '2026-05-01' AND '2026-05-05'`,
        [ATTENDANCE_CLOSE_JOB],
      ),
    );

    const coverage = await tenant.as((tx) => closeCoverage(tx, '2026-05-01', '2026-05-05'));
    assert.equal(coverage.complete, true);
    assert.deepEqual(coverage.missing_dates, []);
  });
});

/**
 * Payroll must not silently pay on attendance that was never evaluated. Unevaluated is not
 * the same as evaluated-and-empty, and treating it as empty under-reports LOP.
 */
describe('payroll refuses incomplete attendance', skipWithoutDb, () => {
  let tenant: TestTenant;
  let periodId: string;

  before(async () => {
    tenant = await createTestTenant('incomplete');
    const employeeId = await createEmployee(tenant, { code: 'PAY001', joiningDate: '2025-01-01' });

    await tenant.as(async (tx) => {
      const component = await tx.query<{ id: string }>(
        `INSERT INTO compensation.salary_component (tenant_id, code, name, component_type, calculation_type)
         VALUES ($1, 'BASIC', 'Basic', 'earning', 'percentage') RETURNING id`,
        [tenant.tenantId],
      );
      const structure = await tx.query<{ id: string }>(
        `INSERT INTO compensation.salary_structure (tenant_id, name, version, effective_from)
         VALUES ($1, 'Std', 1, '2025-01-01') RETURNING id`,
        [tenant.tenantId],
      );
      await tx.query(
        `INSERT INTO compensation.salary_structure_component
           (tenant_id, salary_structure_id, salary_component_id, sequence_no, percentage, percentage_of_code)
         VALUES ($1, $2, $3, 1, 100, 'BASE')`,
        [tenant.tenantId, structure.rows[0]!.id, component.rows[0]!.id],
      );
      await tx.query(
        `INSERT INTO compensation.salary_assignment
           (tenant_id, employee_id, salary_structure_id, annual_ctc, base_amount, effective_from)
         VALUES ($1, $2, $3, 600000, 50000, '2025-01-01')`,
        [tenant.tenantId, employeeId, structure.rows[0]!.id],
      );
      const period = await createPeriod(tx, {
        companyId: tenant.companyId,
        name: 'May 2026',
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        payDate: '2026-06-01',
      });
      periodId = period.id;
    });
  });

  after(async () => {
    await dropTestTenant(tenant.tenantId);
    await closePools();
  });

  it('refuses a run when attendance has not been closed', async () => {
    await assert.rejects(
      tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: periodId })),
      /Attendance has not been closed/,
    );
  });

  it('names the days that are missing', async () => {
    try {
      await tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: periodId }));
      assert.fail('expected the run to be refused');
    } catch (err) {
      const details = (err as { details?: { missing_dates?: string[]; expected_days?: number } }).details;
      assert.equal(details?.expected_days, 31);
      assert.ok(details?.missing_dates?.includes('2026-05-10'));
    }
  });

  it('requires a reason to override', async () => {
    await assert.rejects(
      tenant.as((tx) =>
        payroll.createRun(tx, { payrollPeriodId: periodId, allowIncompleteAttendance: true }),
      ),
      /requires a reason/,
    );
  });

  it('allows an explicit, audited override', async () => {
    const run = await tenant.as((tx) =>
      payroll.createRun(tx, {
        payrollPeriodId: periodId,
        allowIncompleteAttendance: true,
        incompleteAttendanceReason: 'Historical migration; attendance predates the system',
      }),
    );

    assert.equal(run.attendanceCoverage.complete, false);
    assert.equal(run.attendanceCoverage.closed_days, 0);

    const override = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ after_state: { reason: string } }>(
        `SELECT after_state FROM audit.audit_log
          WHERE action = 'payroll.run.incomplete_attendance_override' AND is_sensitive`,
      );
      return rows[0];
    });
    assert.ok(override, 'the override must be audited as a sensitive action');
    assert.match(override!.after_state.reason, /Historical migration/);
  });

  it('accepts a run without override once every day is closed', async () => {
    await tenant.as((tx) => tx.query(`UPDATE payroll.payroll_run SET status = 'cancelled'`));
    await tenant.as((tx) =>
      tx.query(
        `INSERT INTO integration.scheduled_job
           (tenant_id, job_type, execution_date, status, completed_at, payload)
         SELECT $1, 'attendance.close', d::date, 'completed', now(), '{"timezone": "Asia/Kolkata"}'::jsonb
           FROM generate_series('2026-05-01'::date, '2026-05-31'::date, INTERVAL '1 day') AS d
         ON CONFLICT (tenant_id, job_type, execution_date, job_key)
         DO UPDATE SET status = 'completed', completed_at = now()`,
        [tenant.tenantId],
      ),
    );

    const run = await tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: periodId }));
    assert.equal(run.attendanceCoverage.complete, true);
    assert.equal(run.attendanceCoverage.closed_days, 31);
  });
});
