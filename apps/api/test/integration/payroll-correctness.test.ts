import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closePools, withPlatform } from '../../src/infra/db/pool.ts';
import type { AppError } from '../../src/infra/errors.ts';
import * as payroll from '../../src/modules/payroll/service.ts';
import * as compensation from '../../src/modules/compensation/service.ts';
import * as periodJobs from '../../src/modules/leave/period-jobs.ts';
import * as taxOpening from '../../src/modules/payroll/tax-opening.ts';
import {
  financialYearOf,
  monthsRemainingInFinancialYear,
} from '../../src/modules/tenant/financial-year.ts';
import {
  createEmployee,
  createLeaveType,
  createTestTenant,
  dropTestTenant,
  skipWithoutDb,
  type TestTenant,
} from './helpers.ts';

/**
 * Payroll correctness.
 *
 * Every test here corresponds to a figure that was previously wrong, or to a situation the
 * system used to answer with a plausible number instead of a refusal. The Python engine has
 * its own suite for the arithmetic; this one covers what Node freezes into the snapshot and
 * what it refuses to do at all.
 */

/** Builds a tenant with one employee on a 100,000 structure and an open period. */
async function payrollFixture(prefix: string) {
  const tenant = await createTestTenant(prefix);
  const employeeId = await createEmployee(tenant, { code: 'PC0001', joiningDate: '2025-01-01' });

  const ids = await tenant.as(async (tx) => {
    const basic = await tx.query<{ id: string }>(
      `INSERT INTO compensation.salary_component
         (tenant_id, code, name, component_type, calculation_type, taxable)
       VALUES ($1, 'BASIC', 'Basic', 'earning', 'percentage', true) RETURNING id`,
      [tenant.tenantId],
    );
    const hra = await tx.query<{ id: string }>(
      `INSERT INTO compensation.salary_component
         (tenant_id, code, name, component_type, calculation_type, taxable)
       VALUES ($1, 'HRA', 'House Rent Allowance', 'earning', 'percentage', true) RETURNING id`,
      [tenant.tenantId],
    );
    const encash = await tx.query<{ id: string }>(
      `INSERT INTO compensation.salary_component
         (tenant_id, code, name, component_type, calculation_type, taxable, affects_lop)
       VALUES ($1, 'LEAVE_ENCASHMENT', 'Leave Encashment', 'earning', 'fixed', true, false)
       RETURNING id`,
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
       VALUES ($1, $2, $3, 1, 50, 'BASE'), ($1, $2, $4, 2, 40, 'BASIC')`,
      [tenant.tenantId, structure.rows[0]!.id, basic.rows[0]!.id, hra.rows[0]!.id],
    );
    await tx.query(
      `INSERT INTO compensation.salary_assignment
         (tenant_id, employee_id, salary_structure_id, annual_ctc, base_amount, effective_from,
          leave_encashment_amount_per_day)
       VALUES ($1, $2, $3, 1200000, 100000, '2025-01-01', 2000)`,
      [tenant.tenantId, employeeId, structure.rows[0]!.id],
    );

    const period = await payroll.createPeriod(tx, {
      companyId: tenant.companyId,
      name: 'Aug 2026',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      payDate: '2026-09-01',
    });

    // Attendance closed for the whole period, so payroll is not refused for the wrong reason.
    await tx.query(
      `INSERT INTO integration.scheduled_job
         (tenant_id, job_type, execution_date, status, completed_at, payload)
       SELECT $1, 'attendance.close', d::date, 'completed', now(), '{"timezone":"Asia/Kolkata"}'::jsonb
         FROM generate_series('2026-08-01'::date, '2026-08-31'::date, INTERVAL '1 day') AS d
       ON CONFLICT (tenant_id, job_type, execution_date, job_key) DO NOTHING`,
      [tenant.tenantId],
    );

    return {
      basicId: basic.rows[0]!.id,
      hraId: hra.rows[0]!.id,
      encashmentComponentId: encash.rows[0]!.id,
      structureId: structure.rows[0]!.id,
      periodId: period.id,
    };
  });

  return { tenant, employeeId, ...ids };
}

/**
 * Abandons a run that is still waiting on the engine.
 *
 * `calculating` may only move to `calculated` or `failed` — a run cannot be cancelled out
 * from under an engine that might be mid-calculation. Marking it failed first is the route
 * a real operator takes, and it is what these tests take too.
 */
async function abandonRun(tenant: TestTenant, runId: string, reason: string) {
  await tenant.as((tx) => payroll.markFailed(tx, runId, reason));
  await tenant.as((tx) => payroll.cancel(tx, runId, reason));
}

/** The latest snapshot the run froze for an employee. */
async function latestSnapshot(tenant: TestTenant, runId: string, employeeId: string) {
  return tenant.as(async (tx) => {
    const { rows } = await tx.query<{
      snapshot_version: number;
      tax_json: Record<string, unknown>;
      statutory_json: Record<string, unknown>;
      compensation_json: Record<string, unknown>;
      additional_json: Array<Record<string, unknown>>;
    }>(
      `SELECT snapshot_version, tax_json, statutory_json, compensation_json, additional_json
         FROM payroll.payroll_input_snapshot
        WHERE payroll_run_id = $1 AND employee_id = $2
        ORDER BY snapshot_version DESC LIMIT 1`,
      [runId, employeeId],
    );
    return rows[0]!;
  });
}

/**
 * A fixture whose employee has two overwrites of HRA on different dates in one period.
 *
 * Built through the normal path, because the point is that nothing earlier refuses it: the
 * partial unique index is per date, so both rows are legitimately accepted and the
 * ambiguity only appears when the snapshot is built.
 */
async function fixtureWithTwoOverwrites(prefix: string) {
  const f = await payrollFixture(prefix);
  for (const date of ['2026-08-05', '2026-08-25']) {
    await f.tenant.as((tx) =>
      compensation.addAdditionalSalary(tx, {
        employeeId: f.employeeId,
        salaryComponentId: f.hraId,
        amount: 5000,
        payrollDate: date,
        kind: 'one_time',
        overwritesStructure: true,
      }),
    );
  }
  return f;
}

/** Marks a run calculated and finalizes it, standing in for the Python engine. */
async function finalizeRun(
  tenant: TestTenant,
  runId: string,
  slip: { number: string; taxable?: number; tax?: number },
) {
  await tenant.as(async (tx) => {
    const employees = await tx.query<{ id: string; employee_id: string }>(
      'SELECT id, employee_id FROM payroll.payroll_employee WHERE payroll_run_id = $1',
      [runId],
    );
    const snapshot = await tx.query<{ id: string }>(
      'SELECT id FROM payroll.payroll_input_snapshot WHERE payroll_run_id = $1 ORDER BY snapshot_version DESC LIMIT 1',
      [runId],
    );
    const period = await tx.query<{ period_start: string; period_end: string }>(
      `SELECT to_char(p.period_start, 'YYYY-MM-DD') AS period_start,
              to_char(p.period_end, 'YYYY-MM-DD') AS period_end
         FROM payroll.payroll_run r JOIN payroll.payroll_period p ON p.id = r.payroll_period_id
        WHERE r.id = $1`,
      [runId],
    );

    for (const employee of employees.rows) {
      await tx.query(
        `INSERT INTO payroll.salary_slip
           (tenant_id, payroll_run_id, payroll_employee_id, employee_id, slip_number,
            period_start, period_end, total_days, payable_days, gross_amount, net_amount,
            taxable_earnings, tax_amount, calculation_version, snapshot_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,31,31,100000,90000,$8,$9,'v1',$10,'draft')`,
        [
          tenant.tenantId, runId, employee.id, employee.employee_id, slip.number,
          period.rows[0]!.period_start, period.rows[0]!.period_end,
          slip.taxable ?? 100000, slip.tax ?? 0, snapshot.rows[0]!.id,
        ],
      );
      await tx.query(
        `UPDATE payroll.payroll_employee SET status = 'calculated', gross_amount = 100000 WHERE id = $1`,
        [employee.id],
      );
    }
    await tx.query(`UPDATE payroll.payroll_run SET status = 'calculated' WHERE id = $1`, [runId]);
  });

  await tenant.as((tx) => payroll.submitForReview(tx, runId));
  await tenant.as((tx) => payroll.approve(tx, runId));
  await tenant.as((tx) => payroll.finalize(tx, runId));
}

// ---------------------------------------------------------------------------

describe('financial year arithmetic', () => {
  it('follows the tenant year start rather than assuming April', () => {
    assert.equal(financialYearOf('2026-03-31', 4).label, '2025-26');
    assert.equal(financialYearOf('2026-04-01', 4).label, '2026-27');
    // A January tenant labels the year by itself.
    assert.equal(financialYearOf('2026-07-15', 1).label, '2026-26');
    assert.equal(financialYearOf('2026-07-15', 1).start, '2026-01-01');
  });

  it('counts the months left from the tenant year start', () => {
    // April start: April is month 1 of 12, March is the last.
    assert.equal(monthsRemainingInFinancialYear('2026-04-30', 4), 12);
    assert.equal(monthsRemainingInFinancialYear('2026-09-30', 4), 7);
    assert.equal(monthsRemainingInFinancialYear('2027-03-31', 4), 1);
  });

  it('gives a January tenant a different answer from an April one', () => {
    // The bug this replaces: 13 - month, which was only right for an April year.
    assert.equal(monthsRemainingInFinancialYear('2026-09-30', 1), 4);
    assert.notEqual(
      monthsRemainingInFinancialYear('2026-09-30', 1),
      monthsRemainingInFinancialYear('2026-09-30', 4),
    );
  });

  it('refuses a start month that is not a month', () => {
    assert.throws(() => financialYearOf('2026-01-01', 0), /1-12/);
    assert.throws(() => financialYearOf('2026-01-01', 13), /1-12/);
  });
});

describe('payroll snapshot completeness', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof payrollFixture>>;

  before(async () => {
    f = await payrollFixture('snap');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('freezes the statutory rules the employee cannot be paid without', async () => {
    const run = await f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: f.periodId }));
    const snapshot = await latestSnapshot(f.tenant, run.id, f.employeeId);

    const required = snapshot.statutory_json.required as string[];
    assert.ok(Array.isArray(required));
    assert.ok(required.includes('income_tax'), 'income tax is required of everyone');
    assert.ok(required.includes('pf'), 'the default tax profile applies PF');
    assert.ok(!required.includes('esi'), 'ESI is off by default and must not be demanded');

    await abandonRun(f.tenant, run.id, 'test cleanup');
  });

  it('freezes the annualisation inputs, not just the deducted total', async () => {
    const run = await f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: f.periodId }));
    const snapshot = await latestSnapshot(f.tenant, run.id, f.employeeId);
    const tax = snapshot.tax_json;

    for (const key of [
      'opening_taxable_earnings',
      'opening_tds',
      'previous_taxable_earnings',
      'previous_tax_deducted',
      'tax_deducted_ytd',
      'financial_year',
    ]) {
      assert.ok(key in tax, `the snapshot must carry ${key}`);
    }
    assert.equal(tax.financial_year, '2026-27');

    await abandonRun(f.tenant, run.id, 'test cleanup');
  });

  it('records whether an opening balance was actually declared', async () => {
    const run = await f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: f.periodId }));
    const before = await latestSnapshot(f.tenant, run.id, f.employeeId);
    assert.equal(before.tax_json.opening_declared, false);
    assert.equal(before.tax_json.opening_taxable_earnings, '0');
    await abandonRun(f.tenant, run.id, 'test cleanup');

    await f.tenant.as((tx) =>
      taxOpening.recordOpening(tx, {
        employeeId: f.employeeId,
        financialYear: '2026-27',
        openingTaxableEarnings: 600000,
        openingTds: 40000,
      }),
    );

    const second = await f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: f.periodId }));
    const after = await latestSnapshot(f.tenant, second.id, f.employeeId);
    assert.equal(after.tax_json.opening_declared, true);
    assert.equal(Number(after.tax_json.opening_taxable_earnings), 600000);
    // Opening TDS is credited against what has been withheld, not collected twice.
    assert.equal(Number(after.tax_json.tax_deducted_ytd), 40000);

    await abandonRun(f.tenant, second.id, 'test cleanup');
  });

  it('does not move when the source records change afterwards', async () => {
    const run = await f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: f.periodId }));
    const before = await latestSnapshot(f.tenant, run.id, f.employeeId);

    // A raise, an opening-balance amendment and a structure change, all after the freeze.
    await f.tenant.as(async (tx) => {
      await tx.query(
        `UPDATE compensation.salary_assignment SET base_amount = 200000
          WHERE tenant_id = $1 AND employee_id = $2`,
        [f.tenant.tenantId, f.employeeId],
      );
      await tx.query(
        `UPDATE compensation.salary_structure_component SET percentage = 90
          WHERE tenant_id = $1 AND salary_structure_id = $2`,
        [f.tenant.tenantId, f.structureId],
      );
    });

    const after = await latestSnapshot(f.tenant, run.id, f.employeeId);
    assert.deepEqual(after.compensation_json, before.compensation_json);
    assert.equal(Number((after.compensation_json as { base_amount: string }).base_amount), 100000);

    await abandonRun(f.tenant, run.id, 'test cleanup');
    await f.tenant.as(async (tx) => {
      await tx.query(
        `UPDATE compensation.salary_assignment SET base_amount = 100000
          WHERE tenant_id = $1 AND employee_id = $2`,
        [f.tenant.tenantId, f.employeeId],
      );
      await tx.query(
        `UPDATE compensation.salary_structure_component SET percentage = 50
          WHERE tenant_id = $1 AND salary_component_id = $2`,
        [f.tenant.tenantId, f.basicId],
      );
    });
  });
});

describe('additional salary through a payroll run', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof payrollFixture>>;

  before(async () => {
    f = await payrollFixture('addl');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('carries a normal additional salary into the snapshot', async () => {
    await f.tenant.as((tx) =>
      compensation.addAdditionalSalary(tx, {
        employeeId: f.employeeId,
        salaryComponentId: f.basicId,
        amount: 25000,
        payrollDate: '2026-08-15',
        kind: 'bonus',
      }),
    );

    const run = await f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: f.periodId }));
    const snapshot = await latestSnapshot(f.tenant, run.id, f.employeeId);
    assert.equal(snapshot.additional_json.length, 1);
    assert.equal(snapshot.additional_json[0]!.overwrites_structure, false);

    await abandonRun(f.tenant, run.id, 'test cleanup');
  });

  it('keeps every one-off amount when the run is recalculated', async () => {
    // The defect this covers: createRun marked the rows `consumed`, and recalculate
    // re-queried only `approved` rows — so a recalculated payslip silently lost every
    // bonus, arrear and recovery.
    const run = await f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: f.periodId }));
    const first = await latestSnapshot(f.tenant, run.id, f.employeeId);
    assert.equal(first.additional_json.length, 1, 'setup: the bonus is in the first snapshot');

    await f.tenant.as((tx) => payroll.recalculate(tx, run.id));

    const second = await latestSnapshot(f.tenant, run.id, f.employeeId);
    assert.equal(second.snapshot_version, 2, 'a recalculation appends a new version');
    assert.equal(
      second.additional_json.length,
      1,
      'the bonus must survive recalculation, not vanish because it was already consumed',
    );

    await abandonRun(f.tenant, run.id, 'test cleanup');
  });

  it('releases one-off amounts when the run is cancelled, so a replacement can pay them', async () => {
    const claimed = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ status: string }>(
        'SELECT status FROM compensation.additional_salary WHERE employee_id = $1',
        [f.employeeId],
      );
      return rows[0]!.status;
    });
    assert.equal(claimed, 'approved', 'cancellation returned it to the pool');
  });

  it('flags an overwrite so the engine replaces rather than adds', async () => {
    await f.tenant.as((tx) =>
      compensation.addAdditionalSalary(tx, {
        employeeId: f.employeeId,
        salaryComponentId: f.hraId,
        amount: 5000,
        payrollDate: '2026-08-20',
        kind: 'one_time',
        overwritesStructure: true,
      }),
    );

    const run = await f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: f.periodId }));
    const snapshot = await latestSnapshot(f.tenant, run.id, f.employeeId);
    const overwrite = snapshot.additional_json.find((a) => a.overwrites_structure === true);
    assert.ok(overwrite, 'the overwrite must reach the engine flagged');
    assert.equal(overwrite!.code, 'HRA');

    await abandonRun(f.tenant, run.id, 'test cleanup');
  });

  it('refuses an overwrite for a component the employee does not have', async () => {
    const orphan = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO compensation.salary_component
           (tenant_id, code, name, component_type, calculation_type)
         VALUES ($1, 'PHANTOM', 'Phantom', 'earning', 'fixed') RETURNING id`,
        [f.tenant.tenantId],
      );
      return rows[0]!.id;
    });

    await assert.rejects(
      f.tenant.as((tx) =>
        compensation.addAdditionalSalary(tx, {
          employeeId: f.employeeId,
          salaryComponentId: orphan,
          amount: 1000,
          payrollDate: '2026-08-21',
          kind: 'one_time',
          overwritesStructure: true,
        }),
      ),
      /not in this employee's salary structure/,
    );
  });

  it('refuses a negative overwrite, which would set a component below zero', async () => {
    await assert.rejects(
      f.tenant.as((tx) =>
        compensation.addAdditionalSalary(tx, {
          employeeId: f.employeeId,
          salaryComponentId: f.hraId,
          amount: -500,
          payrollDate: '2026-08-22',
          kind: 'one_time',
          overwritesStructure: true,
        }),
      ),
      /cannot be negative/,
    );
  });

  it('refuses two overwrites of the same component on the same date', async () => {
    await assert.rejects(
      f.tenant.as((tx) =>
        compensation.addAdditionalSalary(tx, {
          employeeId: f.employeeId,
          salaryComponentId: f.hraId,
          amount: 7000,
          payrollDate: '2026-08-20',
          kind: 'one_time',
          overwritesStructure: true,
        }),
      ),
      // The partial unique index catches it; the error is translated to a 409.
      /already exists|duplicate/i,
    );
  });

  /**
   * Two overwrites of one component on *different* dates in the same period.
   *
   * The unique index cannot see this one — the dates differ, so the rows are distinct — but
   * the ambiguity is identical: the engine is told twice what HRA should be for August, and
   * there is no correct way to choose. It used to surface as a bare Error and therefore a
   * 500, which told the operator nothing about which records to look at.
   */
  it('refuses two overwrites of one component on different dates in a period, as a 409', async () => {
    const conflicted = await fixtureWithTwoOverwrites('overwrite-conflict');
    try {
      await assert.rejects(
        conflicted.tenant.as((tx) =>
          payroll.createRun(tx, { payrollPeriodId: conflicted.periodId }),
        ),
        (err: AppError) => {
          assert.equal(err.statusCode, 409, 'a data conflict the tenant must resolve, not a crash');
          assert.equal(err.code, 'additional_salary_overwrite_conflict');

          const details = err.details as {
            employee_id: string;
            salary_component_code: string;
            period_start: string;
            period_end: string;
            conflicting_records: Array<{ additional_salary_id: string; payroll_date: string }>;
          };
          // Everything needed to go and fix it, and nothing about how it is stored.
          assert.equal(details.employee_id, conflicted.employeeId);
          assert.equal(details.salary_component_code, 'HRA');
          assert.equal(details.period_start, '2026-08-01');
          assert.equal(details.period_end, '2026-08-31');
          assert.equal(details.conflicting_records.length, 2);
          assert.deepEqual(
            details.conflicting_records.map((r) => r.payroll_date).sort(),
            ['2026-08-05', '2026-08-25'],
          );
          assert.ok(
            details.conflicting_records.every((r) => typeof r.additional_salary_id === 'string'),
          );
          // No constraint names, no SQL, no table names.
          assert.doesNotMatch(err.message, /constraint|index|relation|column/i);
          return true;
        },
      );
    } finally {
      await dropTestTenant(conflicted.tenant.tenantId);
    }
  });

  it('allows overwrites of one component in different periods', async () => {
    const t = await payrollFixture('overwrite-periods');
    try {
      const september = await t.tenant.as((tx) =>
        payroll.createPeriod(tx, {
          companyId: t.tenant.companyId,
          name: 'Sep 2026',
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          payDate: '2026-10-01',
        }),
      );
      await t.tenant.as((tx) =>
        tx.query(
          `INSERT INTO integration.scheduled_job
             (tenant_id, job_type, execution_date, status, completed_at, payload)
           SELECT $1, 'attendance.close', d::date, 'completed', now(), '{"timezone":"Asia/Kolkata"}'::jsonb
             FROM generate_series('2026-09-01'::date, '2026-09-30'::date, INTERVAL '1 day') AS d
           ON CONFLICT (tenant_id, job_type, execution_date, job_key) DO NOTHING`,
          [t.tenant.tenantId],
        ),
      );

      for (const date of ['2026-08-10', '2026-09-10']) {
        await t.tenant.as((tx) =>
          compensation.addAdditionalSalary(tx, {
            employeeId: t.employeeId,
            salaryComponentId: t.hraId,
            amount: 5000,
            payrollDate: date,
            kind: 'one_time',
            overwritesStructure: true,
          }),
        );
      }

      // One correction per period is unambiguous, whatever the component.
      const august = await t.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: t.periodId }));
      assert.equal(august.employeeCount, 1);
      await abandonRun(t.tenant, august.id, 'test cleanup');

      const run = await t.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: september.id }));
      assert.equal(run.employeeCount, 1);
      await abandonRun(t.tenant, run.id, 'test cleanup');
    } finally {
      await dropTestTenant(t.tenant.tenantId);
    }
  });

  it('allows overwrites of different components in one period', async () => {
    const t = await payrollFixture('overwrite-components');
    try {
      for (const componentId of [t.basicId, t.hraId]) {
        await t.tenant.as((tx) =>
          compensation.addAdditionalSalary(tx, {
            employeeId: t.employeeId,
            salaryComponentId: componentId,
            amount: 5000,
            payrollDate: '2026-08-12',
            kind: 'one_time',
            overwritesStructure: true,
          }),
        );
      }

      const run = await t.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: t.periodId }));
      const snapshot = await latestSnapshot(t.tenant, run.id, t.employeeId);
      const codes = snapshot.additional_json
        .filter((a) => a.overwrites_structure === true)
        .map((a) => a.code)
        .sort();
      assert.deepEqual(codes, ['BASIC', 'HRA']);

      await abandonRun(t.tenant, run.id, 'test cleanup');
    } finally {
      await dropTestTenant(t.tenant.tenantId);
    }
  });

  it('allows two employees to each have an overwrite of the same component', async () => {
    const t = await payrollFixture('overwrite-employees');
    try {
      const second = await createEmployee(t.tenant, { code: 'PC0002', joiningDate: '2025-01-01' });
      await t.tenant.as((tx) =>
        tx.query(
          `INSERT INTO compensation.salary_assignment
             (tenant_id, employee_id, salary_structure_id, annual_ctc, base_amount, effective_from)
           VALUES ($1, $2, $3, 1200000, 100000, '2025-01-01')`,
          [t.tenant.tenantId, second, t.structureId],
        ),
      );

      for (const employeeId of [t.employeeId, second]) {
        await t.tenant.as((tx) =>
          compensation.addAdditionalSalary(tx, {
            employeeId,
            salaryComponentId: t.hraId,
            amount: 5000,
            payrollDate: '2026-08-14',
            kind: 'one_time',
            overwritesStructure: true,
          }),
        );
      }

      // One correction each. The conflict is per employee, and must not leak between them.
      const run = await t.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: t.periodId }));
      assert.equal(run.employeeCount, 2);
      await abandonRun(t.tenant, run.id, 'test cleanup');
    } finally {
      await dropTestTenant(t.tenant.tenantId);
    }
  });

  it('does not let one tenant overwrite record affect another tenant run', async () => {
    const a = await fixtureWithTwoOverwrites('overwrite-tenant-a');
    const b = await payrollFixture('overwrite-tenant-b');
    try {
      await b.tenant.as((tx) =>
        compensation.addAdditionalSalary(tx, {
          employeeId: b.employeeId,
          salaryComponentId: b.hraId,
          amount: 5000,
          payrollDate: '2026-08-05',
          kind: 'one_time',
          overwritesStructure: true,
        }),
      );

      // Tenant A is unambiguously broken. Tenant B has one overwrite and must run normally:
      // RLS scopes the query, so A's two rows are not even visible to B.
      await assert.rejects(
        a.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: a.periodId })),
        (err: AppError) => err.code === 'additional_salary_overwrite_conflict',
      );

      const run = await b.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: b.periodId }));
      assert.equal(run.employeeCount, 1);
      await abandonRun(b.tenant, run.id, 'test cleanup');
    } finally {
      await dropTestTenant(a.tenant.tenantId);
      await dropTestTenant(b.tenant.tenantId);
    }
  });
});

describe('leave encashment reaches payroll', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof payrollFixture>>;
  let leaveTypeId: string;

  before(async () => {
    f = await payrollFixture('encash');
    leaveTypeId = await createLeaveType(f.tenant, { code: 'ELENC', requiresApproval: false });
    await f.tenant.as(async (tx) => {
      await tx.query(
        `UPDATE leave_mgmt.leave_type SET encashment_enabled = true WHERE tenant_id = $1 AND id = $2`,
        [f.tenant.tenantId, leaveTypeId],
      );
      await tx.query(
        `INSERT INTO leave_mgmt.leave_ledger_entry
           (tenant_id, employee_id, leave_type_id, entry_type, quantity, effective_date,
            period_start, period_end, source_type)
         VALUES ($1,$2,$3,'allocation',20,'2026-04-01','2026-04-01','2027-03-31','leave_allocation')`,
        [f.tenant.tenantId, f.employeeId, leaveTypeId],
      );
    });
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('creates the compensation that actually pays the employee', async () => {
    const result = await f.tenant.as((tx) =>
      periodJobs.requestEncashment(tx, {
        employeeId: f.employeeId,
        leaveTypeId,
        quantity: 5,
        periodStart: '2026-04-01',
        periodEnd: '2027-03-31',
        payrollDate: '2026-08-31',
      }),
    );

    // 5 days at the 2,000/day rate on the salary assignment.
    assert.equal(result.amount, 10000);
    assert.ok(result.additionalSalaryId, 'the encashment must name the row that pays it');

    const linked = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{
        amount: string;
        source_type: string;
        source_id: string;
        per_day_amount: string;
        additional_salary_id: string;
      }>(
        `SELECT a.amount, a.source_type, a.source_id, e.per_day_amount, e.additional_salary_id
           FROM leave_mgmt.leave_encashment e
           JOIN compensation.additional_salary a ON a.id = e.additional_salary_id
          WHERE e.id = $1`,
        [result.id],
      );
      return rows[0]!;
    });
    assert.equal(Number(linked.amount), 10000);
    assert.equal(linked.source_type, 'leave_encashment');
    assert.equal(linked.source_id, result.id);
    assert.equal(Number(linked.per_day_amount), 2000);
  });

  it('includes the encashment in the next payroll run for that date', async () => {
    const run = await f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: f.periodId }));
    const snapshot = await latestSnapshot(f.tenant, run.id, f.employeeId);

    const line = snapshot.additional_json.find((a) => a.source_type === 'leave_encashment');
    assert.ok(line, 'the encashment must reach the calculation as compensation');
    assert.equal(line!.code, 'LEAVE_ENCASHMENT');
    assert.equal(Number(line!.amount), 10000);

    await abandonRun(f.tenant, run.id, 'test cleanup');
  });

  it('is audited with the amount and the row that pays it', async () => {
    const audited = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ after_state: Record<string, unknown> }>(
        `SELECT after_state FROM audit.audit_log
          WHERE action = 'leave.encashed' ORDER BY created_at DESC LIMIT 1`,
      );
      return rows[0]!.after_state;
    });
    assert.equal(Number(audited.amount), 10000);
    assert.ok(audited.additional_salary_id);
  });

  it('refuses when the employee has no configured encashment rate', async () => {
    const other = await createEmployee(f.tenant, { code: 'PC0002', joiningDate: '2025-01-01' });
    await f.tenant.as(async (tx) => {
      await tx.query(
        `INSERT INTO compensation.salary_assignment
           (tenant_id, employee_id, salary_structure_id, annual_ctc, base_amount, effective_from)
         VALUES ($1, $2, $3, 600000, 50000, '2025-01-01')`,
        [f.tenant.tenantId, other, f.structureId],
      );
      await tx.query(
        `INSERT INTO leave_mgmt.leave_ledger_entry
           (tenant_id, employee_id, leave_type_id, entry_type, quantity, effective_date,
            period_start, period_end, source_type)
         VALUES ($1,$2,$3,'allocation',10,'2026-04-01','2026-04-01','2027-03-31','leave_allocation')`,
        [f.tenant.tenantId, other, leaveTypeId],
      );
    });

    await assert.rejects(
      f.tenant.as((tx) =>
        periodJobs.requestEncashment(tx, {
          employeeId: other,
          leaveTypeId,
          quantity: 2,
          periodStart: '2026-04-01',
          periodEnd: '2027-03-31',
        }),
      ),
      /no leave encashment rate/,
    );

    // And nothing was written: the balance must not be debited for a payment that failed.
    const balance = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ total: string }>(
        `SELECT COALESCE(SUM(quantity), 0)::text AS total FROM leave_mgmt.leave_ledger_entry
          WHERE employee_id = $1`,
        [other],
      );
      return Number(rows[0]!.total);
    });
    assert.equal(balance, 10, 'a refused encashment must not consume the balance');
  });

  it('pays once when the same encashment is processed twice', async () => {
    // The compensation row is keyed by source, so a retry finds what it already created.
    const encashmentId = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM leave_mgmt.leave_encashment WHERE employee_id = $1 ORDER BY created_at LIMIT 1`,
        [f.employeeId],
      );
      return rows[0]!.id;
    });

    const again = await f.tenant.as((tx) =>
      compensation.addAdditionalSalary(tx, {
        employeeId: f.employeeId,
        salaryComponentId: f.encashmentComponentId,
        amount: 10000,
        payrollDate: '2026-08-31',
        kind: 'one_time',
        source: { type: 'leave_encashment', id: encashmentId },
      }),
    );
    assert.equal(again.created, false, 'a redelivered encashment must not create a second row');

    const count = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM compensation.additional_salary
          WHERE source_type = 'leave_encashment' AND source_id = $1`,
        [encashmentId],
      );
      return Number(rows[0]!.count);
    });
    assert.equal(count, 1);
  });

  it('refuses when no component is configured to pay it against', async () => {
    await f.tenant.as((tx) =>
      tx.query(`UPDATE compensation.salary_component SET status = 'inactive'
                 WHERE tenant_id = $1 AND code = 'LEAVE_ENCASHMENT'`, [f.tenant.tenantId]),
    );

    await assert.rejects(
      f.tenant.as((tx) =>
        periodJobs.requestEncashment(tx, {
          employeeId: f.employeeId,
          leaveTypeId,
          quantity: 1,
          periodStart: '2026-04-01',
          periodEnd: '2027-03-31',
        }),
      ),
      /No salary component to pay leave encashment against/,
    );

    await f.tenant.as((tx) =>
      tx.query(`UPDATE compensation.salary_component SET status = 'active'
                 WHERE tenant_id = $1 AND code = 'LEAVE_ENCASHMENT'`, [f.tenant.tenantId]),
    );
  });
});

describe('tax-year opening balances', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof payrollFixture>>;

  before(async () => {
    f = await payrollFixture('opening');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('records and then amends the same year', async () => {
    const first = await f.tenant.as((tx) =>
      taxOpening.recordOpening(tx, {
        employeeId: f.employeeId,
        financialYear: '2026-27',
        openingTaxableEarnings: 500000,
        openingTds: 30000,
      }),
    );
    assert.equal(first.amended, false);

    const second = await f.tenant.as((tx) =>
      taxOpening.recordOpening(tx, {
        employeeId: f.employeeId,
        financialYear: '2026-27',
        openingTaxableEarnings: 550000,
        openingTds: 33000,
        source: 'correction',
      }),
    );
    assert.equal(second.amended, true);
    assert.equal(second.id, first.id, 'one row per employee per year, amended in place');
  });

  it('audits an amendment with what it replaced', async () => {
    const entry = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{
        before_state: Record<string, unknown>;
        after_state: Record<string, unknown>;
      }>(
        `SELECT before_state, after_state FROM audit.audit_log
          WHERE action = 'tax.opening.amended' ORDER BY created_at DESC LIMIT 1`,
      );
      return rows[0]!;
    });
    assert.equal(Number(entry.before_state.taxable_earnings), 500000);
    assert.equal(Number(entry.after_state.taxable_earnings), 550000);
  });

  it('refuses a financial year that is not one', async () => {
    await assert.rejects(
      f.tenant.as((tx) =>
        taxOpening.recordOpening(tx, {
          employeeId: f.employeeId,
          financialYear: '2026-28',
          openingTaxableEarnings: 1,
          openingTds: 0,
        }),
      ),
      /not a financial year for this tenant/,
    );
  });

  it('refuses TDS larger than the income it was withheld from', async () => {
    await assert.rejects(
      f.tenant.as((tx) =>
        taxOpening.recordOpening(tx, {
          employeeId: f.employeeId,
          financialYear: '2026-27',
          openingTaxableEarnings: 100,
          openingTds: 5000,
        }),
      ),
      /exceeds opening taxable earnings/,
    );
  });

  it('refuses a negative balance', async () => {
    await assert.rejects(
      f.tenant.as((tx) =>
        taxOpening.recordOpening(tx, {
          employeeId: f.employeeId,
          financialYear: '2026-27',
          openingTaxableEarnings: -1,
          openingTds: 0,
        }),
      ),
      /cannot be negative/,
    );
  });

  it('refuses an unknown employee', async () => {
    await assert.rejects(
      f.tenant.as((tx) =>
        taxOpening.recordOpening(tx, {
          employeeId: '00000000-0000-0000-0000-000000000000',
          financialYear: '2026-27',
          openingTaxableEarnings: 1,
          openingTds: 0,
        }),
      ),
      /Employee not found/,
    );
  });

  it('refuses an amendment once a payslip in that year is finalized', async () => {
    const run = await f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: f.periodId }));
    await finalizeRun(f.tenant, run.id, { number: 'REG-2026-08-PC0001-01' });

    await assert.rejects(
      f.tenant.as((tx) =>
        taxOpening.recordOpening(tx, {
          employeeId: f.employeeId,
          financialYear: '2026-27',
          openingTaxableEarnings: 900000,
          openingTds: 80000,
        }),
      ),
      /already been finalized/,
    );
  });
});

describe('supplementary payroll semantics', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof payrollFixture>>;
  let regularRunId: string;

  before(async () => {
    f = await payrollFixture('supp');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('refuses a supplementary run before anything has been finalized', async () => {
    await assert.rejects(
      f.tenant.as((tx) =>
        payroll.createRun(tx, { payrollPeriodId: f.periodId, runType: 'supplementary' }),
      ),
      /corrects a finalized regular run, and this period has none/,
    );
  });

  it('numbers the first run in a period as sequence one', async () => {
    const run = await f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: f.periodId }));
    regularRunId = run.id;

    const sequence = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ run_sequence: number; run_type: string }>(
        'SELECT run_sequence, run_type FROM payroll.payroll_run WHERE id = $1',
        [run.id],
      );
      return rows[0]!;
    });
    assert.equal(sequence.run_sequence, 1);
    assert.equal(sequence.run_type, 'regular');

    await finalizeRun(f.tenant, run.id, { number: 'REG-2026-08-PC0001-01' });
  });

  it('refuses a second regular run for an employee already finalized', async () => {
    await assert.rejects(
      f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: f.periodId })),
      // The one-live-regular-run index catches it first; either refusal is correct.
      /run_already_exists|already exists|no_eligible_employees|not eligible/i,
    );
  });

  it('accepts a supplementary run and gives it the next sequence', async () => {
    await f.tenant.as((tx) =>
      compensation.addAdditionalSalary(tx, {
        employeeId: f.employeeId,
        salaryComponentId: f.basicId,
        amount: 12000,
        payrollDate: '2026-08-31',
        kind: 'arrear',
      }),
    );

    const supplementary = await f.tenant.as((tx) =>
      payroll.createRun(tx, { payrollPeriodId: f.periodId, runType: 'supplementary', parentRunId: regularRunId }),
    );
    assert.equal(supplementary.employeeCount, 1);

    const row = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ run_sequence: number; parent_run_id: string }>(
        'SELECT run_sequence, parent_run_id FROM payroll.payroll_run WHERE id = $1',
        [supplementary.id],
      );
      return rows[0]!;
    });
    assert.equal(row.run_sequence, 2, 'a supplementary run takes the next slot in the period');
    assert.equal(row.parent_run_id, regularRunId);
  });

  it('tells the engine not to pay the structure again', async () => {
    const supplementary = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM payroll.payroll_run
          WHERE payroll_period_id = $1 AND run_type = 'supplementary' AND status <> 'cancelled'`,
        [f.periodId],
      );
      return rows[0]!.id;
    });

    const snapshot = await latestSnapshot(f.tenant, supplementary, f.employeeId);
    assert.equal(
      (snapshot.compensation_json as { pay_structure: boolean }).pay_structure,
      false,
      'a supplementary run must not re-pay the salary structure',
    );
    assert.equal(snapshot.additional_json.length, 1, 'it pays the arrear and nothing else');
  });

  it('skips an employee with nothing to supplement, and says why', async () => {
    const other = await createEmployee(f.tenant, { code: 'PC0003', joiningDate: '2025-01-01' });
    await f.tenant.as((tx) =>
      tx.query(
        `INSERT INTO compensation.salary_assignment
           (tenant_id, employee_id, salary_structure_id, annual_ctc, base_amount, effective_from)
         VALUES ($1, $2, $3, 600000, 50000, '2025-01-01')`,
        [f.tenant.tenantId, other, f.structureId],
      ),
    );

    const existing = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM payroll.payroll_run
          WHERE payroll_period_id = $1 AND run_type = 'supplementary' AND status <> 'cancelled'`,
        [f.periodId],
      );
      return rows[0]!.id;
    });
    await abandonRun(f.tenant, existing, 'reissue for this test');

    const run = await f.tenant.as((tx) =>
      payroll.createRun(tx, {
        payrollPeriodId: f.periodId,
        runType: 'supplementary',
        parentRunId: regularRunId,
      }),
    );

    const skipped = run.skipped.find((s) => s.employee_id === 'PC0003');
    assert.ok(skipped, 'the unpaid employee must be reported, not silently included');
    assert.match(skipped!.reason, /no finalized payslip for this period/);
  });
});

describe('payroll tenant isolation', skipWithoutDb, () => {
  let a: Awaited<ReturnType<typeof payrollFixture>>;
  let b: Awaited<ReturnType<typeof payrollFixture>>;

  before(async () => {
    a = await payrollFixture('iso-a');
    b = await payrollFixture('iso-b');
  });

  after(async () => {
    await dropTestTenant(a.tenant.tenantId);
    await dropTestTenant(b.tenant.tenantId);
    await closePools();
  });

  it('keeps one tenant opening balances invisible to another', async () => {
    await a.tenant.as((tx) =>
      taxOpening.recordOpening(tx, {
        employeeId: a.employeeId,
        financialYear: '2026-27',
        openingTaxableEarnings: 777777,
        openingTds: 1000,
      }),
    );

    const seenByB = await b.tenant.as((tx) => taxOpening.listOpenings(tx, {}));
    assert.equal(seenByB.length, 0, 'tenant B must not see tenant A tax facts');

    const rawCount = await b.tenant.as(async (tx) => {
      // No tenant predicate at all: RLS, not the WHERE clause, is what protects this.
      const { rows } = await tx.query<{ count: string }>(
        'SELECT count(*) AS count FROM payroll.employee_tax_opening',
      );
      return Number(rows[0]!.count);
    });
    assert.equal(rawCount, 0);
  });

  it('will not let one tenant record an opening balance for another tenant employee', async () => {
    await assert.rejects(
      b.tenant.as((tx) =>
        taxOpening.recordOpening(tx, {
          employeeId: a.employeeId,
          financialYear: '2026-27',
          openingTaxableEarnings: 1,
          openingTds: 0,
        }),
      ),
      /Employee not found/,
    );
  });

  it('keeps run sequences independent per tenant', async () => {
    const runA = await a.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: a.periodId }));
    const runB = await b.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: b.periodId }));

    const sequences = await withPlatform('maintenance', async (tx) => {
      const { rows } = await tx.query<{ id: string; run_sequence: number }>(
        'SELECT id, run_sequence FROM payroll.payroll_run WHERE id = ANY($1::uuid[])',
        [[runA.id, runB.id]],
      );
      return rows;
    });
    assert.equal(sequences.length, 2);
    assert.ok(sequences.every((r) => r.run_sequence === 1), 'each tenant starts at one');

    await abandonRun(a.tenant, runA.id, 'test cleanup');
    await abandonRun(b.tenant, runB.id, 'test cleanup');
  });
});
