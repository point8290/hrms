import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/infra/db/pool.ts';
import { AppError } from '../../src/infra/errors.ts';
import * as payroll from '../../src/modules/payroll/service.ts';
import * as recovery from '../../src/modules/payroll/run-recovery.ts';
import * as taxOpening from '../../src/modules/payroll/tax-opening.ts';
import * as taxYear from '../../src/modules/payroll/tax-year.ts';
import { runSchedulerTick } from '../../src/infra/scheduler/registry.ts';
import { registerAllJobs } from '../../src/infra/scheduler/index.ts';
import {
  createEmployee,
  createTestTenant,
  dropTestTenant,
  skipWithoutDb,
  type TestTenant,
} from './helpers.ts';

/**
 * The tax year as its own record, and recovery for a run nobody is working on.
 *
 * Two things are being pinned down here. First, that a payroll period is assessed in a year
 * that *exists* — with boundaries, a status and a proof cutoff — rather than one derived on
 * the fly from a date and a start month, because every statutory rule that follows hangs off
 * the year rather than the month. Second, that a run whose engine never answered becomes
 * visible and retryable without anyone being able to kill a run that is still working.
 */

/** A tenant with one employee on a 100,000 structure. Periods are created per test. */
async function fixture(prefix: string) {
  const tenant = await createTestTenant(prefix);
  const employeeId = await createEmployee(tenant, { code: 'TY0001', joiningDate: '2025-01-01' });

  await tenant.as(async (tx) => {
    const basic = await tx.query<{ id: string }>(
      `INSERT INTO compensation.salary_component
         (tenant_id, code, name, component_type, calculation_type, taxable)
       VALUES ($1, 'BASIC', 'Basic', 'earning', 'percentage', true) RETURNING id`,
      [tenant.tenantId],
    );
    const structure = await tx.query<{ id: string }>(
      `INSERT INTO compensation.salary_structure (tenant_id, name, version, effective_from)
       VALUES ($1, 'Standard', 1, '2025-01-01') RETURNING id`,
      [tenant.tenantId],
    );
    await tx.query(
      `INSERT INTO compensation.salary_structure_component
         (tenant_id, salary_structure_id, salary_component_id, sequence_no, percentage, percentage_of_code)
       VALUES ($1, $2, $3, 1, 50, 'BASE')`,
      [tenant.tenantId, structure.rows[0]!.id, basic.rows[0]!.id],
    );
    await tx.query(
      `INSERT INTO compensation.salary_assignment
         (tenant_id, employee_id, salary_structure_id, annual_ctc, base_amount, effective_from)
       VALUES ($1, $2, $3, 1200000, 100000, '2025-01-01')`,
      [tenant.tenantId, employeeId, structure.rows[0]!.id],
    );
  });

  return { tenant, employeeId };
}

/** Closes attendance across a date range so payroll is not refused for the wrong reason. */
async function closeAttendance(tenant: TestTenant, from: string, to: string) {
  await tenant.as((tx) =>
    tx.query(
      `INSERT INTO integration.scheduled_job
         (tenant_id, job_type, execution_date, status, completed_at, payload)
       SELECT $1, 'attendance.close', d::date, 'completed', now(), '{"timezone":"Asia/Kolkata"}'::jsonb
         FROM generate_series($2::date, $3::date, INTERVAL '1 day') AS d
       ON CONFLICT (tenant_id, job_type, execution_date, job_key) DO NOTHING`,
      [tenant.tenantId, from, to],
    ),
  );
}

/** Pushes a run's last progress into the past, standing in for an engine that never answered. */
async function backdateProgress(tenant: TestTenant, runId: string, minutes: number) {
  await tenant.as((tx) =>
    tx.query(
      `UPDATE payroll.payroll_run
          SET last_progress_at = now() - make_interval(mins => $2)
        WHERE tenant_id = $1 AND id = $3`,
      [tenant.tenantId, minutes, runId],
    ),
  );
}

async function runStatus(tenant: TestTenant, runId: string) {
  return tenant.as(async (tx) => {
    const { rows } = await tx.query<{
      status: string;
      calculation_attempts: number;
      recovery_reason: string | null;
      recovered_at: string | null;
    }>(
      `SELECT status, calculation_attempts, recovery_reason, recovered_at
         FROM payroll.payroll_run WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, runId],
    );
    return rows[0]!;
  });
}

// ---------------------------------------------------------------------------

describe('tax year', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof fixture>>;

  before(async () => {
    f = await fixture('taxyear');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('creates the year a period falls in, from the tenant financial year start', async () => {
    const period = await f.tenant.as((tx) =>
      payroll.createPeriod(tx, {
        companyId: f.tenant.companyId,
        name: 'Aug 2026',
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        payDate: '2026-09-01',
      }),
    );

    // April start, so August 2026 is assessed in 2026-27, not in the calendar year.
    assert.equal(period.taxYear.label, '2026-27');
    assert.equal(period.taxYear.start_date, '2026-04-01');
    assert.equal(period.taxYear.end_date, '2027-03-31');
    assert.equal(period.taxYear.status, 'open');
  });

  it('puts every period of one year into the same year record', async () => {
    const september = await f.tenant.as((tx) =>
      payroll.createPeriod(tx, {
        companyId: f.tenant.companyId,
        name: 'Sep 2026',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        payDate: '2026-10-01',
      }),
    );
    const march = await f.tenant.as((tx) =>
      payroll.createPeriod(tx, {
        companyId: f.tenant.companyId,
        name: 'Mar 2027',
        periodStart: '2027-03-01',
        periodEnd: '2027-03-31',
        payDate: '2027-04-01',
      }),
    );

    // March 2027 is the last month of 2026-27, not the first of 2027-28.
    assert.equal(september.taxYear.id, march.taxYear.id);
    assert.equal(march.taxYear.label, '2026-27');
  });

  it('assesses a period straddling the year boundary in the year it ends in', async () => {
    const straddling = await f.tenant.as((tx) =>
      payroll.createPeriod(tx, {
        companyId: f.tenant.companyId,
        name: 'Mar-Apr 2027',
        periodStart: '2027-03-25',
        periodEnd: '2027-04-05',
        payDate: '2027-04-10',
      }),
    );
    // Where the income is taxed is where the period ends.
    assert.equal(straddling.taxYear.label, '2027-28');
  });

  it('refuses two years that overlap', async () => {
    await assert.rejects(
      f.tenant.as((tx) =>
        tx.query(
          `INSERT INTO payroll.tax_year (tenant_id, label, start_date, end_date)
           VALUES ($1, '2026-27', '2026-06-01', '2027-05-31')`,
          [f.tenant.tenantId],
        ),
      ),
      // Either the label is taken or the range collides; both are the database refusing to
      // let "which year is this period in" become ambiguous.
      (err: { code?: string }) => err.code === '23505' || err.code === '23P01',
    );
  });

  it('annualises over months until the whole year has been laid out', async () => {
    const result = await f.tenant.as(async (tx) => {
      const year = await taxYear.ensureTaxYear(tx, '2026-08-31', 4);
      return taxYear.periodsRemainingInYear(tx, year.id, '2026-08-31');
    });

    // Four periods defined out of twelve. Trusting the defined count would annualise August
    // over the two periods that happen to exist and deduct a year of tax in two months.
    assert.equal(result.basis, 'months');
    assert.equal(result.remaining, 8);
  });

  it('counts the defined periods once the year is complete', async () => {
    const tenant = await createTestTenant('taxyear-full');
    try {
      // A tenant paying quarterly, with the whole year laid out in advance.
      const quarters = [
        ['2026-04-01', '2026-06-30', '2026-07-05'],
        ['2026-07-01', '2026-09-30', '2026-10-05'],
        ['2026-10-01', '2026-12-31', '2027-01-05'],
        ['2027-01-01', '2027-03-31', '2027-04-05'],
      ];
      for (const [start, end, pay] of quarters) {
        await tenant.as((tx) =>
          payroll.createPeriod(tx, {
            companyId: tenant.companyId,
            name: `Q ${start!}`,
            periodStart: start!,
            periodEnd: end!,
            payDate: pay!,
          }),
        );
      }

      const result = await tenant.as(async (tx) => {
        const year = await taxYear.ensureTaxYear(tx, '2026-07-01', 4);
        return taxYear.periodsRemainingInYear(tx, year.id, '2026-09-30');
      });

      // Four quarters cover twelve months, so the tenant's own cycle is trusted: the second
      // quarter has three periods left including itself, not seven months.
      assert.equal(result.basis, 'defined_periods');
      assert.equal(result.remaining, 3);
    } finally {
      await dropTestTenant(tenant.tenantId);
    }
  });

  it('freezes the resolved year into the snapshot rather than re-deriving it', async () => {
    await closeAttendance(f.tenant, '2026-08-01', '2026-08-31');
    const periodId = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM payroll.payroll_period WHERE tenant_id = $1 AND name = 'Aug 2026'`,
        [f.tenant.tenantId],
      );
      return rows[0]!.id;
    });

    const run = await f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: periodId }));

    const snapshot = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ tax_json: Record<string, unknown>; attendance_json: Record<string, unknown> }>(
        `SELECT tax_json, attendance_json FROM payroll.payroll_input_snapshot
          WHERE payroll_run_id = $1 ORDER BY snapshot_version DESC LIMIT 1`,
        [run.id],
      );
      return rows[0]!;
    });

    const year = await f.tenant.as((tx) => taxYear.taxYearForPeriod(tx, periodId));
    assert.equal(snapshot.tax_json.tax_year_id, year.id);
    assert.equal(snapshot.tax_json.financial_year, '2026-27');
    assert.equal(snapshot.tax_json.tax_year_status, 'open');
    // The annualisation divisor is snapshotted with the reasoning that produced it, so a
    // finalized slip can be explained without guessing which rule was in force.
    assert.equal(snapshot.attendance_json.months_remaining_in_fy, 8);
    assert.equal(snapshot.attendance_json.months_remaining_basis, 'months');

    await f.tenant.as((tx) => payroll.markFailed(tx, run.id, 'test teardown'));
    await f.tenant.as((tx) => payroll.cancel(tx, run.id, 'test teardown'));
  });

  it('keys opening balances on the year record, not on a label', async () => {
    await f.tenant.as((tx) =>
      taxOpening.recordOpening(tx, {
        employeeId: f.employeeId,
        financialYear: '2026-27',
        openingTaxableEarnings: 400000,
        openingTds: 20000,
      }),
    );

    const stored = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ label: string; opening_tds: string }>(
        `SELECT ty.label, o.opening_tds
           FROM payroll.employee_tax_opening o
           JOIN payroll.tax_year ty ON ty.id = o.tax_year_id
          WHERE o.tenant_id = $1 AND o.employee_id = $2`,
        [f.tenant.tenantId, f.employeeId],
      );
      return rows[0]!;
    });

    assert.equal(stored.label, '2026-27');
    assert.equal(Number(stored.opening_tds), 20000);

    // And the snapshot reads it back through the same key.
    const loaded = await f.tenant.as(async (tx) => {
      const year = await taxYear.ensureTaxYear(tx, '2026-08-31', 4);
      return taxOpening.loadOpening(tx, f.employeeId, year.id);
    });
    assert.equal(loaded.declared, true);
    assert.equal(Number(loaded.taxableEarnings), 400000);
  });

  it('refuses a period in a closed year', async () => {
    const tenant = await createTestTenant('taxyear-closed');
    try {
      await tenant.as((tx) =>
        payroll.createPeriod(tx, {
          companyId: tenant.companyId,
          name: 'Apr 2026',
          periodStart: '2026-04-01',
          periodEnd: '2026-04-30',
          payDate: '2026-05-01',
        }),
      );
      await tenant.as((tx) =>
        tx.query(
          `UPDATE payroll.tax_year SET status = 'closed' WHERE tenant_id = $1 AND label = '2026-27'`,
          [tenant.tenantId],
        ),
      );

      await assert.rejects(
        tenant.as((tx) =>
          payroll.createPeriod(tx, {
            companyId: tenant.companyId,
            name: 'May 2026',
            periodStart: '2026-05-01',
            periodEnd: '2026-05-31',
            payDate: '2026-06-01',
          }),
        ),
        (err: AppError) => err.code === 'tax_year_closed' && err.statusCode === 422,
      );
    } finally {
      await dropTestTenant(tenant.tenantId);
    }
  });

  it('records a proof cutoff and refuses one outside the year', async () => {
    const year = await f.tenant.as((tx) => taxYear.ensureTaxYear(tx, '2026-08-31', 4));

    const updated = await f.tenant.as((tx) =>
      taxYear.setProofCutoff(tx, year.id, '2027-01-31'),
    );
    assert.equal(updated.proof_cutoff_date, '2027-01-31');

    await assert.rejects(
      f.tenant.as((tx) => taxYear.setProofCutoff(tx, year.id, '2027-06-30')),
      // The database owns this: a cutoff outside the year it belongs to is meaningless.
      (err: { code?: string }) => err.code === '23514',
    );
  });
});

// ---------------------------------------------------------------------------

describe('stalled payroll run recovery', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof fixture>>;

  before(async () => {
    f = await fixture('recover');
    await closeAttendance(f.tenant, '2026-04-01', '2027-03-31');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  /** A fresh run sitting in `calculating`, as createRun leaves it. */
  async function startRun(month: string) {
    const period = await f.tenant.as((tx) =>
      payroll.createPeriod(tx, {
        companyId: f.tenant.companyId,
        name: month,
        periodStart: `${month}-01`,
        periodEnd: `${month}-28`,
        payDate: `${month}-28`,
      }),
    );
    return f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: period.id }));
  }

  it('does not treat a run that just started as stalled', async () => {
    const run = await startRun('2026-04');
    const stalled = await f.tenant.as((tx) => recovery.findStalledRuns(tx));
    assert.equal(stalled.find((r) => r.id === run.id), undefined);
  });

  it('refuses to recover a run that may still be calculating', async () => {
    const run = await startRun('2026-05');
    await assert.rejects(
      f.tenant.as((tx) => recovery.recoverRun(tx, run.id)),
      (err: AppError) =>
        err.code === 'run_not_stalled'
        && err.statusCode === 409
        // The operator is told how far off the threshold it is, so "wait" is actionable.
        && (err.details as { threshold_minutes: number }).threshold_minutes
          === recovery.STALL_THRESHOLD_MINUTES,
    );
    assert.equal((await runStatus(f.tenant, run.id)).status, 'calculating');
  });

  it('fails a run that has made no progress, and records why', async () => {
    const run = await startRun('2026-06');
    await backdateProgress(f.tenant, run.id, recovery.STALL_THRESHOLD_MINUTES + 10);

    const outcome = await f.tenant.as((tx) => recovery.recoverRun(tx, run.id));
    assert.equal(outcome.recovered, true);
    assert.equal(outcome.exhausted, false);

    const after = await runStatus(f.tenant, run.id);
    assert.equal(after.status, 'failed');
    assert.equal(after.calculation_attempts, 1);
    assert.match(after.recovery_reason!, /stalled/);
    assert.notEqual(after.recovered_at, null);
  });

  it('audits the recovery as something a person has to look at', async () => {
    const run = await startRun('2026-07');
    await backdateProgress(f.tenant, run.id, recovery.STALL_THRESHOLD_MINUTES + 1);
    await f.tenant.as((tx) => recovery.recoverRun(tx, run.id));

    const entry = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ is_sensitive: boolean; metadata: Record<string, unknown> }>(
        `SELECT is_sensitive, metadata FROM audit.audit_log
          WHERE tenant_id = $1 AND entity_id = $2 AND action = 'payroll.run.recovered'`,
        [f.tenant.tenantId, run.id],
      );
      return rows[0]!;
    });

    assert.equal(entry.is_sensitive, true);
    assert.equal(entry.metadata.requires_operator_attention, true);
  });

  it('is idempotent: recovering twice does not count two attempts', async () => {
    const run = await startRun('2026-08');
    await backdateProgress(f.tenant, run.id, recovery.STALL_THRESHOLD_MINUTES + 1);

    const first = await f.tenant.as((tx) => recovery.recoverRun(tx, run.id));
    const second = await f.tenant.as((tx) => recovery.recoverRun(tx, run.id));

    assert.equal(first.recovered, true);
    assert.equal(second.recovered, false);
    assert.equal((await runStatus(f.tenant, run.id)).calculation_attempts, 1);
  });

  it('lets only one of two simultaneous recoveries take effect', async () => {
    const run = await startRun('2026-09');
    await backdateProgress(f.tenant, run.id, recovery.STALL_THRESHOLD_MINUTES + 1);

    // Two operators, or an operator and the sweep, arriving at the same moment. The row lock
    // serialises them; the loser must see a run that is already recovered, not recover it a
    // second time and push it towards its retry limit.
    const [a, b] = await Promise.all([
      f.tenant.as((tx) => recovery.recoverRun(tx, run.id)),
      f.tenant.as((tx) => recovery.recoverRun(tx, run.id)),
    ]);

    assert.equal([a, b].filter((o) => o.recovered).length, 1);
    assert.equal((await runStatus(f.tenant, run.id)).calculation_attempts, 1);
  });

  it('stops retrying a run that keeps stalling', async () => {
    const run = await startRun('2026-10');

    // Three stalls. The third is not bad luck, so it is reported as exhausted and stays put.
    for (let attempt = 1; attempt <= recovery.MAX_CALCULATION_ATTEMPTS; attempt += 1) {
      await f.tenant.as((tx) =>
        tx.query(
          `UPDATE payroll.payroll_run
              SET status = 'calculating', last_progress_at = now() - make_interval(mins => $3)
            WHERE tenant_id = $1 AND id = $2`,
          [f.tenant.tenantId, run.id, recovery.STALL_THRESHOLD_MINUTES + 1],
        ),
      );
      const outcome = await f.tenant.as((tx) => recovery.recoverRun(tx, run.id));
      assert.equal(outcome.recovered, true);
      assert.equal(outcome.exhausted, attempt === recovery.MAX_CALCULATION_ATTEMPTS);
    }

    const after = await runStatus(f.tenant, run.id);
    assert.equal(after.calculation_attempts, recovery.MAX_CALCULATION_ATTEMPTS);
    assert.match(after.recovery_reason!, /no further automatic retry/);
  });

  it('restarts the clock when a run moves state', async () => {
    const run = await startRun('2026-11');
    await backdateProgress(f.tenant, run.id, recovery.STALL_THRESHOLD_MINUTES + 1);

    // A recalculation re-enters `calculating`. The run is working again and the previous
    // silence must not carry over, or the sweep would fail it immediately.
    await f.tenant.as((tx) => payroll.recalculate(tx, run.id));

    const stalled = await f.tenant.as((tx) => recovery.findStalledRuns(tx));
    assert.equal(stalled.find((r) => r.id === run.id), undefined);

    await f.tenant.as((tx) => payroll.markFailed(tx, run.id, 'test teardown'));
  });

  it('sweeps stalled runs through the scheduled-job framework', async () => {
    const run = await startRun('2026-12');
    await backdateProgress(f.tenant, run.id, recovery.STALL_THRESHOLD_MINUTES + 5);

    registerAllJobs();
    await runSchedulerTick({ jobTypes: [recovery.PAYROLL_RECOVERY_JOB], backfillDays: 0 });

    assert.equal((await runStatus(f.tenant, run.id)).status, 'failed');

    const job = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ status: string; result: Record<string, unknown> }>(
        `SELECT status, result FROM integration.scheduled_job
          WHERE tenant_id = $1 AND job_type = $2 ORDER BY created_at DESC LIMIT 1`,
        [f.tenant.tenantId, recovery.PAYROLL_RECOVERY_JOB],
      );
      return rows[0]!;
    });
    assert.equal(job.status, 'completed');
    assert.ok(Number(job.result.recovered) >= 1);
  });
});
