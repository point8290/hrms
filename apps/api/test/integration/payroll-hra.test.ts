import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/infra/db/pool.ts';
import type { AppError } from '../../src/infra/errors.ts';
import * as payroll from '../../src/modules/payroll/service.ts';
import * as hra from '../../src/modules/payroll/hra.ts';
import * as taxYear from '../../src/modules/payroll/tax-year.ts';
import {
  createEmployee,
  createTestTenant,
  dropTestTenant,
  skipWithoutDb,
  type TestTenant,
} from './helpers.ts';

/**
 * HRA exemption: the inputs Node freezes, and the boundary it must not cross.
 *
 * The arithmetic lives in the Python suite, where it belongs. What is proved here is
 * everything the engine depends on Node getting right:
 *
 *   * the exemption's inputs are **frozen** — changing salary or rent after a run does not
 *     move a figure that has already been calculated (ADR-005)
 *   * the forward plan is built period by period, so a raise, a house move, a lease ending
 *     or an employee leaving each change the projection in the right place
 *   * one tenant's rent declaration is invisible to another, through RLS and not through a
 *     WHERE clause someone might forget
 */

const METRO_RENT = 25000;

async function hraFixture(prefix: string, options: { metro?: boolean } = {}) {
  const tenant = await createTestTenant(prefix);

  if (options.metro) {
    await tenant.as((tx) =>
      tx.query(
        `UPDATE core.location SET metro_classification = 'metro' WHERE tenant_id = $1`,
        [tenant.tenantId],
      ),
    );
  }

  const employeeId = await createEmployee(tenant, { code: 'HRA001', joiningDate: '2025-01-01' });

  const ids = await tenant.as(async (tx) => {
    // Deliberately *not* called BASIC or HRA. If anything anywhere matches on a code or a
    // display name instead of the role, these tests find it.
    const basic = await tx.query<{ id: string }>(
      `INSERT INTO compensation.salary_component
         (tenant_id, code, name, component_type, calculation_type, taxable, semantic_role)
       VALUES ($1, 'CORE_PAY', 'Core Pay', 'earning', 'percentage', true, 'basic') RETURNING id`,
      [tenant.tenantId],
    );
    const allowance = await tx.query<{ id: string }>(
      `INSERT INTO compensation.salary_component
         (tenant_id, code, name, component_type, calculation_type, taxable, semantic_role)
       VALUES ($1, 'ACCOM', 'Accommodation Allowance', 'earning', 'percentage', true,
               'house_rent_allowance') RETURNING id`,
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
       VALUES ($1, $2, $3, 1, 50, 'BASE'), ($1, $2, $4, 2, 40, 'CORE_PAY')`,
      [tenant.tenantId, structure.rows[0]!.id, basic.rows[0]!.id, allowance.rows[0]!.id],
    );
    await tx.query(
      `INSERT INTO compensation.salary_assignment
         (tenant_id, employee_id, salary_structure_id, annual_ctc, base_amount, effective_from)
       VALUES ($1, $2, $3, 1200000, 100000, '2025-01-01')`,
      [tenant.tenantId, employeeId, structure.rows[0]!.id],
    );

    // The old regime, which is the one that allows section 10(13A). PF and ESI off so the
    // figures under test depend on one statutory rule rather than three.
    await tx.query(
      `INSERT INTO core.tax_profile
         (tenant_id, employee_id, tax_regime, pf_applicable, esi_applicable, effective_from)
       VALUES ($1, $2, 'old', false, false, '2025-01-01')`,
      [tenant.tenantId, employeeId],
    );

    return { structureId: structure.rows[0]!.id, basicId: basic.rows[0]!.id };
  });

  return { tenant, employeeId, ...ids };
}

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

async function makePeriod(tenant: TestTenant, name: string, start: string, end: string, pay: string) {
  await closeAttendance(tenant, start, end);
  return tenant.as((tx) =>
    payroll.createPeriod(tx, {
      companyId: tenant.companyId,
      name,
      periodStart: start,
      periodEnd: end,
      payDate: pay,
    }),
  );
}

async function snapshotOf(tenant: TestTenant, runId: string) {
  return tenant.as(async (tx) => {
    const { rows } = await tx.query<{
      snapshot_version: number;
      hra_json: Record<string, any>;
      compensation_json: Record<string, any>;
    }>(
      `SELECT snapshot_version, hra_json, compensation_json
         FROM payroll.payroll_input_snapshot
        WHERE payroll_run_id = $1 ORDER BY snapshot_version DESC LIMIT 1`,
      [runId],
    );
    return rows[0]!;
  });
}

async function abandon(tenant: TestTenant, runId: string) {
  await tenant.as((tx) => payroll.markFailed(tx, runId, 'test cleanup'));
  await tenant.as((tx) => payroll.cancel(tx, runId, 'test cleanup'));
}

// ---------------------------------------------------------------------------

describe('rent declarations', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof hraFixture>>;

  before(async () => {
    f = await hraFixture('rent');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('records rent against the tax year the period falls in', async () => {
    const result = await f.tenant.as((tx) =>
      hra.recordRentDeclaration(tx, {
        employeeId: f.employeeId,
        periodStart: '2026-04-01',
        periodEnd: '2027-03-31',
        monthlyRent: METRO_RENT,
      }),
    );
    assert.equal(result.taxYearLabel, '2026-27');
    assert.equal(result.amended, false);
  });

  it('refuses two declarations covering the same day', async () => {
    // Rent for a given day has to have one answer: it decides how much tax is withheld.
    await assert.rejects(
      f.tenant.as((tx) =>
        hra.recordRentDeclaration(tx, {
          employeeId: f.employeeId,
          periodStart: '2026-09-01',
          periodEnd: '2026-12-31',
          monthlyRent: 30000,
        }),
      ),
      (err: AppError) => err.code === 'rent_declaration_overlaps' && err.statusCode === 409,
    );
  });

  it('refuses a declaration that straddles the tax year boundary', async () => {
    const other = await createEmployee(f.tenant, { code: 'HRA002', joiningDate: '2025-01-01' });
    await assert.rejects(
      f.tenant.as((tx) =>
        hra.recordRentDeclaration(tx, {
          employeeId: other,
          periodStart: '2026-01-01',
          periodEnd: '2026-12-31',
          monthlyRent: 20000,
        }),
      ),
      (err: AppError) => err.code === 'rent_period_crosses_tax_year',
    );
  });

  it('refuses negative rent', async () => {
    const other = await createEmployee(f.tenant, { code: 'HRA003', joiningDate: '2025-01-01' });
    await assert.rejects(
      f.tenant.as((tx) =>
        hra.recordRentDeclaration(tx, {
          employeeId: other,
          periodStart: '2026-04-01',
          periodEnd: '2027-03-31',
          monthlyRent: -1,
        }),
      ),
      (err: AppError) => err.code === 'negative_rent',
    );
  });

  it('amending resets the proof lifecycle', async () => {
    const declarations = await f.tenant.as((tx) =>
      hra.listRentDeclarations(tx, { employeeId: f.employeeId }),
    );
    const declaration = declarations[0]!;

    await f.tenant.as((tx) =>
      hra.setRentProofOutcome(tx, declaration.id, {
        status: 'verified',
        verifiedMonthlyRent: 24000,
      }),
    );

    await f.tenant.as((tx) =>
      hra.recordRentDeclaration(tx, {
        employeeId: f.employeeId,
        periodStart: declaration.period_start,
        periodEnd: declaration.period_end,
        monthlyRent: 26000,
      }),
    );

    const [after] = await f.tenant.as((tx) =>
      hra.listRentDeclarations(tx, { employeeId: f.employeeId }),
    );
    // A figure that has changed has not been proved. Leaving it `verified` would let an
    // employee raise their rent after verification and keep the tick.
    assert.equal(after!.status, 'declared');
    assert.equal(after!.verified_monthly_rent, null);
    assert.equal(Number(after!.monthly_rent), 26000);
  });

  it('a verified declaration is calculated on the amount actually proved', async () => {
    const [declaration] = await f.tenant.as((tx) =>
      hra.listRentDeclarations(tx, { employeeId: f.employeeId }),
    );
    await f.tenant.as((tx) =>
      hra.setRentProofOutcome(tx, declaration!.id, {
        status: 'verified',
        verifiedMonthlyRent: 18000,
      }),
    );

    const period = await makePeriod(f.tenant, 'Apr 2026', '2026-04-01', '2026-04-30', '2026-05-01');
    const run = await f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: period.id }));
    const snapshot = await snapshotOf(f.tenant, run.id);

    assert.equal(snapshot.hra_json.rent_amount, '18000.00');
    assert.equal(snapshot.hra_json.rent_status, 'verified');
    await abandon(f.tenant, run.id);
  });

  it('a rejected declaration contributes nothing', async () => {
    const [declaration] = await f.tenant.as((tx) =>
      hra.listRentDeclarations(tx, { employeeId: f.employeeId }),
    );
    await f.tenant.as((tx) =>
      hra.setRentProofOutcome(tx, declaration!.id, { status: 'rejected' }),
    );

    const period = await makePeriod(f.tenant, 'May 2026', '2026-05-01', '2026-05-31', '2026-06-01');
    const run = await f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: period.id }));
    const snapshot = await snapshotOf(f.tenant, run.id);

    // Proof was examined and refused, so there is no rent to calculate on. Distinct from
    // "never declared", which the status also records.
    assert.equal(snapshot.hra_json.rent_amount, '0');
    assert.equal(snapshot.hra_json.rent_status, 'rejected');
    await abandon(f.tenant, run.id);
  });

  it('refuses to verify without saying what was proved', async () => {
    const [declaration] = await f.tenant.as((tx) =>
      hra.listRentDeclarations(tx, { employeeId: f.employeeId }),
    );
    await assert.rejects(
      f.tenant.as((tx) =>
        hra.setRentProofOutcome(tx, declaration!.id, { status: 'verified' }),
      ),
      (err: AppError) => err.code === 'verified_amount_required',
    );
  });
});

// ---------------------------------------------------------------------------

describe('HRA snapshot freezing', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof hraFixture>>;

  before(async () => {
    f = await hraFixture('hra-freeze', { metro: true });
    await f.tenant.as((tx) =>
      hra.recordRentDeclaration(tx, {
        employeeId: f.employeeId,
        periodStart: '2026-04-01',
        periodEnd: '2027-03-31',
        monthlyRent: METRO_RENT,
      }),
    );
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('freezes every HRA input the engine needs', async () => {
    const period = await makePeriod(f.tenant, 'Jun 2026', '2026-06-01', '2026-06-30', '2026-07-01');
    const run = await f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: period.id }));
    const snapshot = await snapshotOf(f.tenant, run.id);
    const year = await f.tenant.as((tx) => taxYear.taxYearForPeriod(tx, period.id));

    assert.equal(snapshot.hra_json.applicable, true);
    assert.equal(snapshot.hra_json.rent_amount, '25000.00');
    assert.equal(snapshot.hra_json.metro_classification, 'metro');
    assert.equal(snapshot.hra_json.work_location_classification, 'metro');
    assert.equal(snapshot.hra_json.tax_year_id, year.id);
    assert.deepEqual(snapshot.hra_json.rent_declaration_period, {
      start: '2026-04-01',
      end: '2027-03-31',
    });

    // The basic and the allowance are not copied into hra_json: they are resolved by the
    // engine from the structure it is already given, by role, so there is exactly one place
    // a salary figure can come from.
    const roles = snapshot.compensation_json.components.map((c: any) => c.semantic_role);
    assert.ok(roles.includes('basic'));
    assert.ok(roles.includes('house_rent_allowance'));

    await abandon(f.tenant, run.id);
  });

  it('the engine sees no live table: changing salary and rent afterwards moves nothing', async () => {
    const period = await makePeriod(f.tenant, 'Jul 2026', '2026-07-01', '2026-07-31', '2026-08-01');
    const run = await f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: period.id }));
    const frozen = await snapshotOf(f.tenant, run.id);

    assert.equal(frozen.hra_json.rent_amount, '25000.00');
    assert.equal(frozen.compensation_json.base_amount, '100000.00');

    // Now change everything the exemption depends on, behind the run's back.
    await f.tenant.as(async (tx) => {
      await tx.query(
        `UPDATE compensation.rent_declaration SET monthly_rent = 90000
          WHERE tenant_id = $1 AND employee_id = $2`,
        [f.tenant.tenantId, f.employeeId],
      );
      await tx.query(
        `UPDATE compensation.salary_assignment SET base_amount = 500000
          WHERE tenant_id = $1 AND employee_id = $2`,
        [f.tenant.tenantId, f.employeeId],
      );
      await tx.query(
        `UPDATE core.location SET metro_classification = 'non_metro' WHERE tenant_id = $1`,
        [f.tenant.tenantId],
      );
    });

    // The snapshot is what it was. Nothing re-reads the live tables.
    const stillFrozen = await snapshotOf(f.tenant, run.id);
    assert.equal(stillFrozen.hra_json.rent_amount, '25000.00');
    assert.equal(stillFrozen.hra_json.metro_classification, 'metro');
    assert.equal(stillFrozen.compensation_json.base_amount, '100000.00');
    await abandon(f.tenant, run.id);

    // A *new* run sees the new world, which is the other half of the guarantee: frozen is
    // not the same as stale.
    const next = await makePeriod(f.tenant, 'Aug 2026', '2026-08-01', '2026-08-31', '2026-09-01');
    const nextRun = await f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: next.id }));
    const fresh = await snapshotOf(f.tenant, nextRun.id);

    assert.equal(fresh.hra_json.rent_amount, '90000.00');
    assert.equal(fresh.hra_json.metro_classification, 'non_metro');
    assert.equal(fresh.compensation_json.base_amount, '500000.00');
    await abandon(f.tenant, nextRun.id);

    // Restore, so later tests in this file start from the documented fixture.
    await f.tenant.as(async (tx) => {
      await tx.query(
        `UPDATE compensation.rent_declaration SET monthly_rent = $3
          WHERE tenant_id = $1 AND employee_id = $2`,
        [f.tenant.tenantId, f.employeeId, METRO_RENT],
      );
      await tx.query(
        `UPDATE compensation.salary_assignment SET base_amount = 100000
          WHERE tenant_id = $1 AND employee_id = $2`,
        [f.tenant.tenantId, f.employeeId],
      );
      await tx.query(
        `UPDATE core.location SET metro_classification = 'metro' WHERE tenant_id = $1`,
        [f.tenant.tenantId],
      );
    });
  });

  it('a recalculation rebuilds from the live tables, as it always has', async () => {
    const period = await makePeriod(f.tenant, 'Sep 2026', '2026-09-01', '2026-09-30', '2026-10-01');
    const run = await f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: period.id }));
    assert.equal((await snapshotOf(f.tenant, run.id)).hra_json.rent_amount, '25000.00');

    await f.tenant.as((tx) =>
      tx.query(
        `UPDATE compensation.rent_declaration SET monthly_rent = 31000
          WHERE tenant_id = $1 AND employee_id = $2`,
        [f.tenant.tenantId, f.employeeId],
      ),
    );
    await f.tenant.as((tx) => payroll.recalculate(tx, run.id));

    const after = await snapshotOf(f.tenant, run.id);
    assert.equal(after.snapshot_version, 2, 'a recalculation appends a version');
    assert.equal(after.hra_json.rent_amount, '31000.00');

    await f.tenant.as((tx) =>
      tx.query(
        `UPDATE compensation.rent_declaration SET monthly_rent = $3
          WHERE tenant_id = $1 AND employee_id = $2`,
        [f.tenant.tenantId, f.employeeId, METRO_RENT],
      ),
    );
    await abandon(f.tenant, run.id);
  });

  it('a supplementary run pays no structure, so it exempts nothing', async () => {
    // A regular run first, finalized, so there is something to supplement.
    const period = await makePeriod(f.tenant, 'Oct 2026', '2026-10-01', '2026-10-31', '2026-11-01');
    const regular = await f.tenant.as((tx) =>
      payroll.createRun(tx, { payrollPeriodId: period.id }),
    );
    assert.equal(
      (await snapshotOf(f.tenant, regular.id)).hra_json.applicable,
      true,
      'setup: a regular run does have an exemption',
    );
    await finalizeRun(f.tenant, regular.id, 'REG-HRA-OCT');

    await f.tenant.as((tx) =>
      tx.query(
        `INSERT INTO compensation.additional_salary
           (tenant_id, employee_id, salary_component_id, amount, payroll_date, kind, status)
         SELECT $1, $2, id, 5000, '2026-10-15', 'bonus', 'approved'
           FROM compensation.salary_component
          WHERE tenant_id = $1 AND code = 'ACCOM'`,
        [f.tenant.tenantId, f.employeeId],
      ),
    );

    const supplementary = await f.tenant.as((tx) =>
      payroll.createRun(tx, { payrollPeriodId: period.id, runType: 'supplementary' }),
    );
    const snapshot = await snapshotOf(f.tenant, supplementary.id);

    // No salary structure is paid, so no allowance is received and there is nothing to
    // exempt. Projecting the structure's exemption here would exempt income this run does
    // not pay, on top of the exemption the regular run already took.
    assert.equal(snapshot.hra_json.applicable, false);
    assert.match(snapshot.hra_json.reason, /supplementary/);
    await abandon(f.tenant, supplementary.id);
  });
});

/** Marks a run calculated and finalizes it, standing in for the Python engine. */
async function finalizeRun(tenant: TestTenant, runId: string, slipNumber: string) {
  await tenant.as(async (tx) => {
    const employees = await tx.query<{ id: string; employee_id: string }>(
      'SELECT id, employee_id FROM payroll.payroll_employee WHERE payroll_run_id = $1',
      [runId],
    );
    const snapshot = await tx.query<{ id: string }>(
      `SELECT id FROM payroll.payroll_input_snapshot WHERE payroll_run_id = $1
        ORDER BY snapshot_version DESC LIMIT 1`,
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
            taxable_earnings, hra_exemption, tax_amount, calculation_version, snapshot_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,31,31,70000,70000,50000,20000,0,'v1',$8,'draft')`,
        [
          tenant.tenantId, runId, employee.id, employee.employee_id, slipNumber,
          period.rows[0]!.period_start, period.rows[0]!.period_end, snapshot.rows[0]!.id,
        ],
      );
      await tx.query(
        `UPDATE payroll.payroll_employee SET status = 'calculated', gross_amount = 70000
          WHERE id = $1`,
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

describe('HRA tax-year projection', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof hraFixture>>;

  before(async () => {
    f = await hraFixture('hra-project', { metro: true });
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('plans one segment per stretch where nothing changes', async () => {
    await f.tenant.as((tx) =>
      hra.recordRentDeclaration(tx, {
        employeeId: f.employeeId,
        periodStart: '2026-04-01',
        periodEnd: '2027-03-31',
        monthlyRent: METRO_RENT,
      }),
    );

    const period = await makePeriod(f.tenant, 'Apr 2026', '2026-04-01', '2026-04-30', '2026-05-01');
    const run = await f.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: period.id }));
    const snapshot = await snapshotOf(f.tenant, run.id);

    const projection = snapshot.hra_json.projection as any[];
    assert.equal(projection.length, 1, 'nothing changes all year, so one segment');
    // Eleven periods left after April. A count, not an assumption of twelve.
    assert.equal(projection[0].periods, 11);
    assert.equal(projection[0].rent_amount, '25000.00');
    assert.equal(projection[0].base_amount, '100000.00');
    await abandon(f.tenant, run.id);
  });

  it('splits the plan where rent changes mid-year', async () => {
    const employeeId = await createEmployee(f.tenant, { code: 'HRAP2', joiningDate: '2025-01-01' });
    await assignSalary(f, employeeId, '100000', '2025-01-01');

    // Rent until September, then a move to a cheaper place.
    await f.tenant.as(async (tx) => {
      await hra.recordRentDeclaration(tx, {
        employeeId, periodStart: '2026-04-01', periodEnd: '2026-09-30', monthlyRent: 40000,
      });
      await hra.recordRentDeclaration(tx, {
        employeeId, periodStart: '2026-10-01', periodEnd: '2027-03-31', monthlyRent: 12000,
        metroClassification: 'non_metro',
      });
    });

    const period = await makePeriod(f.tenant, 'May2 2026', '2026-05-01', '2026-05-31', '2026-06-01');
    const run = await f.tenant.as((tx) =>
      payroll.createRun(tx, { payrollPeriodId: period.id, employeeIds: [employeeId] }),
    );
    const { rows } = await f.tenant.as((tx) =>
      tx.query<{ hra_json: any }>(
        `SELECT hra_json FROM payroll.payroll_input_snapshot
          WHERE payroll_run_id = $1 AND employee_id = $2`,
        [run.id, employeeId],
      ),
    );
    const projection = rows[0]!.hra_json.projection as any[];

    assert.equal(projection.length, 2);
    // Calculating May: June-September on the old rent, October-March on the new one.
    assert.equal(projection[0].periods, 4);
    assert.equal(projection[0].rent_amount, '40000.00');
    assert.equal(projection[0].metro_classification, 'metro');
    assert.equal(projection[1].periods, 6);
    assert.equal(projection[1].rent_amount, '12000.00');
    assert.equal(projection[1].metro_classification, 'non_metro');
    assert.equal(
      projection.reduce((sum, s) => sum + s.periods, 0),
      10,
      'every remaining period is accounted for exactly once',
    );
    await abandon(f.tenant, run.id);
  });

  it('projects a future raise at the future salary', async () => {
    const employeeId = await createEmployee(f.tenant, { code: 'HRAP3', joiningDate: '2025-01-01' });
    await assignSalary(f, employeeId, '80000', '2025-01-01', '2026-06-30');
    await assignSalary(f, employeeId, '100000', '2026-07-01');
    await f.tenant.as((tx) =>
      hra.recordRentDeclaration(tx, {
        employeeId, periodStart: '2026-04-01', periodEnd: '2027-03-31', monthlyRent: METRO_RENT,
      }),
    );

    const period = await makePeriod(f.tenant, 'Jun3 2026', '2026-06-01', '2026-06-30', '2026-07-01');
    const run = await f.tenant.as((tx) =>
      payroll.createRun(tx, { payrollPeriodId: period.id, employeeIds: [employeeId] }),
    );
    const { rows } = await f.tenant.as((tx) =>
      tx.query<{ hra_json: any; compensation_json: any }>(
        `SELECT hra_json, compensation_json FROM payroll.payroll_input_snapshot
          WHERE payroll_run_id = $1 AND employee_id = $2`,
        [run.id, employeeId],
      ),
    );

    // June is still on the old assignment, which ends on 30 June.
    assert.equal(rows[0]!.compensation_json.base_amount, '80000.00');
    const projection = rows[0]!.hra_json.projection as any[];
    // July onward is one stretch at the new salary. Projecting June's figure across it would
    // understate the exemption and over-deduct for nine months.
    assert.equal(projection.length, 1);
    assert.equal(projection[0].periods, 9);
    assert.equal(projection[0].base_amount, '100000.00');
    await abandon(f.tenant, run.id);
  });

  it('stops the plan at a leaver last day', async () => {
    const employeeId = await createEmployee(f.tenant, { code: 'HRAP4', joiningDate: '2025-01-01' });
    await assignSalary(f, employeeId, '100000', '2025-01-01');
    await f.tenant.as(async (tx) => {
      await hra.recordRentDeclaration(tx, {
        employeeId, periodStart: '2026-04-01', periodEnd: '2027-03-31', monthlyRent: METRO_RENT,
      });
      await tx.query(
        `UPDATE core.employee SET exit_date = '2026-09-30' WHERE tenant_id = $1 AND id = $2`,
        [f.tenant.tenantId, employeeId],
      );
    });

    const period = await makePeriod(f.tenant, 'Jul4 2026', '2026-07-01', '2026-07-31', '2026-08-01');
    const run = await f.tenant.as((tx) =>
      payroll.createRun(tx, { payrollPeriodId: period.id, employeeIds: [employeeId] }),
    );
    const { rows } = await f.tenant.as((tx) =>
      tx.query<{ hra_json: any }>(
        `SELECT hra_json FROM payroll.payroll_input_snapshot
          WHERE payroll_run_id = $1 AND employee_id = $2`,
        [run.id, employeeId],
      ),
    );
    const projection = rows[0]!.hra_json.projection as any[];

    // August and September, then nothing: two periods rather than the eight left in the
    // year. Projecting past someone's last day would exempt income they will never earn.
    assert.equal(projection.reduce((sum, s) => sum + s.periods, 0), 2);
    await abandon(f.tenant, run.id);
  });

  it('plans nothing in the last period of the year', async () => {
    const employeeId = await createEmployee(f.tenant, { code: 'HRAP5', joiningDate: '2025-01-01' });
    await assignSalary(f, employeeId, '100000', '2025-01-01');
    await f.tenant.as((tx) =>
      hra.recordRentDeclaration(tx, {
        employeeId, periodStart: '2026-04-01', periodEnd: '2027-03-31', monthlyRent: METRO_RENT,
      }),
    );

    const period = await makePeriod(f.tenant, 'Mar 2027', '2027-03-01', '2027-03-31', '2027-04-01');
    const run = await f.tenant.as((tx) =>
      payroll.createRun(tx, { payrollPeriodId: period.id, employeeIds: [employeeId] }),
    );
    const { rows } = await f.tenant.as((tx) =>
      tx.query<{ hra_json: any }>(
        `SELECT hra_json FROM payroll.payroll_input_snapshot
          WHERE payroll_run_id = $1 AND employee_id = $2`,
        [run.id, employeeId],
      ),
    );
    assert.deepEqual(rows[0]!.hra_json.projection, []);
    await abandon(f.tenant, run.id);
  });

  it('records why there is no exemption when no rent was declared', async () => {
    const employeeId = await createEmployee(f.tenant, { code: 'HRAP6', joiningDate: '2025-01-01' });
    await assignSalary(f, employeeId, '100000', '2025-01-01');

    const period = await makePeriod(f.tenant, 'Aug6 2026', '2026-08-01', '2026-08-31', '2026-09-01');
    const run = await f.tenant.as((tx) =>
      payroll.createRun(tx, { payrollPeriodId: period.id, employeeIds: [employeeId] }),
    );
    const { rows } = await f.tenant.as((tx) =>
      tx.query<{ hra_json: any }>(
        `SELECT hra_json FROM payroll.payroll_input_snapshot
          WHERE payroll_run_id = $1 AND employee_id = $2`,
        [run.id, employeeId],
      ),
    );

    // "No exemption" and "nobody asked them for rent" must not look the same a year later.
    assert.equal(rows[0]!.hra_json.applicable, false);
    assert.match(rows[0]!.hra_json.reason, /no rent declared/);
    await abandon(f.tenant, run.id);
  });
});

async function assignSalary(
  f: Awaited<ReturnType<typeof hraFixture>>,
  employeeId: string,
  base: string,
  from: string,
  to?: string,
) {
  await f.tenant.as((tx) =>
    tx.query(
      `INSERT INTO compensation.salary_assignment
         (tenant_id, employee_id, salary_structure_id, annual_ctc, base_amount,
          effective_from, effective_to)
       VALUES ($1, $2, $3, 1200000, $4, $5::date, $6::date)`,
      [f.tenant.tenantId, employeeId, f.structureId, base, from, to ?? null],
    ),
  );
}

// ---------------------------------------------------------------------------

describe('HRA tenant isolation', skipWithoutDb, () => {
  let a: Awaited<ReturnType<typeof hraFixture>>;
  let b: Awaited<ReturnType<typeof hraFixture>>;

  before(async () => {
    a = await hraFixture('hra-iso-a', { metro: true });
    b = await hraFixture('hra-iso-b');
    await a.tenant.as((tx) =>
      hra.recordRentDeclaration(tx, {
        employeeId: a.employeeId,
        periodStart: '2026-04-01',
        periodEnd: '2027-03-31',
        monthlyRent: 45000,
      }),
    );
  });

  after(async () => {
    await dropTestTenant(a.tenant.tenantId);
    await dropTestTenant(b.tenant.tenantId);
    await closePools();
  });

  it('one tenant cannot read another rent declarations', async () => {
    const mine = await b.tenant.as((tx) => hra.listRentDeclarations(tx, {}));
    assert.equal(mine.length, 0);

    // Not even asking for the row by its primary key: RLS scopes the read, not a WHERE
    // clause someone could forget.
    const [theirs] = await a.tenant.as((tx) => hra.listRentDeclarations(tx, {}));
    const direct = await b.tenant.as(async (tx) => {
      const { rows } = await tx.query(
        'SELECT id FROM compensation.rent_declaration WHERE id = $1',
        [theirs!.id],
      );
      return rows;
    });
    assert.equal(direct.length, 0);
  });

  it('one tenant cannot declare rent for another employee', async () => {
    await assert.rejects(
      b.tenant.as((tx) =>
        hra.recordRentDeclaration(tx, {
          employeeId: a.employeeId,
          periodStart: '2026-04-01',
          periodEnd: '2027-03-31',
          monthlyRent: 10000,
        }),
      ),
      // The employee is not visible, so it is a not-found rather than a leak of existence.
      (err: AppError) => err.statusCode === 404,
    );
  });

  it('one tenant rent never reaches another tenant snapshot', async () => {
    const period = await makePeriod(b.tenant, 'Nov 2026', '2026-11-01', '2026-11-30', '2026-12-01');
    const run = await b.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: period.id }));
    const snapshot = await snapshotOf(b.tenant, run.id);

    assert.equal(snapshot.hra_json.applicable, false);
    assert.equal(snapshot.hra_json.rent_amount, '0');
    await abandon(b.tenant, run.id);
  });

  it('metro classification does not cross tenants either', async () => {
    const period = await makePeriod(a.tenant, 'Nov 2026', '2026-11-01', '2026-11-30', '2026-12-01');
    const run = await a.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: period.id }));
    assert.equal((await snapshotOf(a.tenant, run.id)).hra_json.work_location_classification, 'metro');
    await abandon(a.tenant, run.id);

    const other = await makePeriod(b.tenant, 'Dec 2026', '2026-12-01', '2026-12-31', '2027-01-01');
    const otherRun = await b.tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: other.id }));
    assert.equal(
      (await snapshotOf(b.tenant, otherRun.id)).hra_json.work_location_classification,
      'non_metro',
    );
    await abandon(b.tenant, otherRun.id);
  });
});
