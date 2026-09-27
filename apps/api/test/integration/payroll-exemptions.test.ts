import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/infra/db/pool.ts';
import type { AppError } from '../../src/infra/errors.ts';
import * as payroll from '../../src/modules/payroll/service.ts';
import * as exemptions from '../../src/modules/payroll/exemptions.ts';
import * as taxYear from '../../src/modules/payroll/tax-year.ts';
import {
  createEmployee,
  createTestTenant,
  dropTestTenant,
  skipWithoutDb,
  type TestTenant,
} from './helpers.ts';

/**
 * Section exemption caps: what Node resolves and freezes.
 *
 * The arithmetic is in the Python suite. What is proved here is the part Node owns and the
 * engine depends on:
 *
 *   * a ceiling is resolved by **tax year**, not by section code alone, and changing the
 *     year changes the answer when the statute differs
 *   * the resolved rule is *frozen*, so a cap changed afterwards cannot re-price a run
 *   * a section nobody configured never silently enters a calculation
 *   * one tenant's declaration is invisible to another, through RLS
 */

async function exemptionFixture(prefix: string) {
  const tenant = await createTestTenant(prefix);
  const employeeId = await createEmployee(tenant, { code: 'EX0001', joiningDate: '2025-01-01' });

  await tenant.as(async (tx) => {
    const basic = await tx.query<{ id: string }>(
      `INSERT INTO compensation.salary_component
         (tenant_id, code, name, component_type, calculation_type, taxable, semantic_role)
       VALUES ($1, 'BASIC', 'Basic', 'earning', 'percentage', true, 'basic') RETURNING id`,
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
       VALUES ($1, $2, $3, 2400000, 200000, '2025-01-01')`,
      [tenant.tenantId, employeeId, structure.rows[0]!.id],
    );
    await tx.query(
      `INSERT INTO core.tax_profile
         (tenant_id, employee_id, tax_regime, pf_applicable, esi_applicable, effective_from)
       VALUES ($1, $2, 'old', false, false, '2025-01-01')`,
      [tenant.tenantId, employeeId],
    );
  });

  return { tenant, employeeId };
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

async function makeRun(tenant: TestTenant, name: string, start: string, end: string) {
  await closeAttendance(tenant, start, end);
  const period = await tenant.as((tx) =>
    payroll.createPeriod(tx, {
      companyId: tenant.companyId,
      name,
      periodStart: start,
      periodEnd: end,
      payDate: end,
    }),
  );
  return tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: period.id }));
}

async function exemptionSnapshot(tenant: TestTenant, runId: string) {
  return tenant.as(async (tx) => {
    const { rows } = await tx.query<{ snapshot_version: number; exemption_json: any }>(
      `SELECT snapshot_version, exemption_json FROM payroll.payroll_input_snapshot
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

/** A tenant-scoped ceiling override, which outranks the platform default. */
async function overrideCap(
  tenant: TestTenant,
  section: string,
  amount: number,
  from: string,
  to: string | null,
  version = 1,
) {
  await tenant.as((tx) =>
    tx.query(
      `INSERT INTO payroll.tax_exemption_rule
         (tenant_id, country_code, section_code, name, version, effective_from, effective_to,
          max_amount, applicable_regimes)
       VALUES ($1, 'IN', $2, $3, $4, $5::date, $6::date, $7, ARRAY['old'])`,
      [tenant.tenantId, section, `${section} override`, version, from, to, amount],
    ),
  );
}

// ---------------------------------------------------------------------------

describe('exemption rule resolution', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof exemptionFixture>>;

  before(async () => {
    f = await exemptionFixture('exrule');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('ships platform ceilings every tenant can see', async () => {
    const year = await f.tenant.as((tx) => taxYear.ensureTaxYear(tx, '2026-08-31', 4));
    const rules = await f.tenant.as((tx) => exemptions.resolveExemptionRules(tx, year));

    assert.equal(rules['80C']!.max_amount, '150000.00');
    assert.equal(rules['80C']!.source, 'platform');
    assert.deepEqual(rules['80C']!.applicable_regimes, ['old']);
    assert.equal(rules['80D']!.max_amount, '25000.00');
    assert.equal(rules['80CCD(1B)']!.max_amount, '50000.00');
  });

  it('resolves by tax year, so a later year can differ', async () => {
    // 80C halved from 2027-28 onward. The platform default is closed off on the day before
    // so the two do not overlap.
    await f.tenant.as((tx) =>
      tx.query(
        `INSERT INTO payroll.tax_exemption_rule
           (tenant_id, country_code, section_code, name, version, effective_from,
            max_amount, applicable_regimes)
         VALUES ($1, 'IN', '80C', '80C from 2027-28', 2, '2027-04-01', 75000, ARRAY['old'])`,
        [f.tenant.tenantId],
      ),
    );

    const y2026 = await f.tenant.as((tx) => taxYear.ensureTaxYear(tx, '2026-08-31', 4));
    const y2027 = await f.tenant.as((tx) => taxYear.ensureTaxYear(tx, '2027-08-31', 4));

    const in2026 = await f.tenant.as((tx) => exemptions.resolveExemptionRules(tx, y2026));
    const in2027 = await f.tenant.as((tx) => exemptions.resolveExemptionRules(tx, y2027));

    // Same section code, different year, different ceiling. Resolving by code alone would
    // give one answer for both.
    assert.equal(in2026['80C']!.max_amount, '150000.00');
    assert.equal(in2026['80C']!.source, 'platform');
    assert.equal(in2027['80C']!.max_amount, '75000.00');
    assert.equal(in2027['80C']!.source, 'tenant');
  });

  it('resolves against the year start, so a mid-year rule cannot move an annual cap', async () => {
    // A rule effective 1 October 2026 does not govern 2026-27: the ceiling is an annual
    // figure the Finance Act sets for the whole year, and letting it move in October would
    // change an employee's allowance between September and October payslips.
    const employee = await createEmployee(f.tenant, { code: 'EX0002', joiningDate: '2025-01-01' });
    await overrideCap(f.tenant, '80D', 99000, '2026-10-01', null, 5);

    const year = await f.tenant.as((tx) => taxYear.ensureTaxYear(tx, '2026-08-31', 4));
    const rules = await f.tenant.as((tx) => exemptions.resolveExemptionRules(tx, year));

    assert.equal(rules['80D']!.max_amount, '25000.00', 'the year keeps the rule it started with');
    assert.ok(employee);
  });

  it('refuses two rules whose effective ranges overlap for one section', async () => {
    await assert.rejects(
      overrideCap(f.tenant, '80CCD(1B)', 10000, '2026-04-01', '2027-03-31', 11).then(() =>
        overrideCap(f.tenant, '80CCD(1B)', 20000, '2026-06-01', '2026-12-31', 12),
      ),
      // "What is the ceiling on 1 July 2026" must have one answer; the database settles it.
      (err: { code?: string }) => err.code === '23P01',
    );
  });

  it('a tenant override outranks the platform default', async () => {
    const tenant = await createTestTenant('exrule-override');
    try {
      const year = await tenant.as((tx) => taxYear.ensureTaxYear(tx, '2026-08-31', 4));
      const before = await tenant.as((tx) => exemptions.resolveExemptionRules(tx, year));
      assert.equal(before['80D']!.source, 'platform');

      await overrideCap(tenant, '80D', 50000, '2025-04-01', null, 9);

      const after = await tenant.as((tx) => exemptions.resolveExemptionRules(tx, year));
      assert.equal(after['80D']!.source, 'tenant');
      assert.equal(after['80D']!.max_amount, '50000.00');
    } finally {
      await dropTestTenant(tenant.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------

describe('exemption declarations', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof exemptionFixture>>;

  before(async () => {
    f = await exemptionFixture('exdecl');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('records a declaration against a configured section', async () => {
    const result = await f.tenant.as((tx) =>
      exemptions.declareSection(tx, {
        employeeId: f.employeeId,
        financialYear: '2026-27',
        regime: 'old',
        sectionCode: '80C',
        declaredAmount: 200000,
      }),
    );
    assert.equal(result.amended, false);
    assert.equal(result.sectionCode, '80C');
    assert.equal(result.taxYearLabel, '2026-27');
  });

  it('refuses a section nobody configured, naming what is available', async () => {
    // An uncapped deduction under an arbitrary key is the defect this phase closes. Caught
    // at the door, so the employee can fix it rather than discovering it on a payslip.
    await assert.rejects(
      f.tenant.as((tx) =>
        exemptions.declareSection(tx, {
          employeeId: f.employeeId,
          financialYear: '2026-27',
          sectionCode: '80ZZZ',
          declaredAmount: 500000,
        }),
      ),
      (err: AppError) => {
        assert.equal(err.code, 'unknown_exemption_section');
        assert.equal(err.statusCode, 422);
        const details = err.details as { configured: string[] };
        assert.ok(details.configured.includes('80C'));
        return true;
      },
    );
  });

  it('amending replaces rather than adding a second row', async () => {
    const first = await f.tenant.as((tx) =>
      exemptions.declareSection(tx, {
        employeeId: f.employeeId,
        financialYear: '2026-27',
        sectionCode: '80C',
        declaredAmount: 120000,
      }),
    );
    assert.equal(first.amended, true);

    const items = await f.tenant.as((tx) =>
      exemptions.listDeclarationItems(tx, { employeeId: f.employeeId }),
    );
    const c80 = items.filter((i) => i.section_code === '80C');
    // One live row. Two would have to be summed or chosen between, and neither rule exists.
    assert.equal(c80.length, 1);
    assert.equal(Number(c80[0]!.declared_amount), 120000);
  });

  it('amending resets eligibility, because a changed figure has not been verified', async () => {
    const [item] = await f.tenant.as((tx) =>
      exemptions.listDeclarationItems(tx, { employeeId: f.employeeId }),
    );
    await f.tenant.as((tx) =>
      exemptions.setProofOutcome(tx, item!.id, {
        status: 'verified',
        eligibleAmount: 100000,
      }),
    );

    await f.tenant.as((tx) =>
      exemptions.declareSection(tx, {
        employeeId: f.employeeId,
        financialYear: '2026-27',
        sectionCode: '80C',
        declaredAmount: 140000,
      }),
    );

    const [after] = await f.tenant.as((tx) =>
      exemptions.listDeclarationItems(tx, { employeeId: f.employeeId }),
    );
    assert.equal(after!.status, 'declared');
    assert.equal(after!.verified_amount, null);
  });

  it('keeps sections independent within a year', async () => {
    await f.tenant.as((tx) =>
      exemptions.declareSection(tx, {
        employeeId: f.employeeId,
        financialYear: '2026-27',
        sectionCode: '80D',
        declaredAmount: 18000,
      }),
    );
    const items = await f.tenant.as((tx) =>
      exemptions.listDeclarationItems(tx, { employeeId: f.employeeId }),
    );
    assert.deepEqual(items.map((i) => i.section_code).sort(), ['80C', '80D']);
  });

  it('keeps the same section in different years apart', async () => {
    await f.tenant.as((tx) =>
      exemptions.declareSection(tx, {
        employeeId: f.employeeId,
        financialYear: '2027-28',
        sectionCode: '80C',
        declaredAmount: 60000,
      }),
    );

    const y2026 = await f.tenant.as((tx) => taxYear.ensureTaxYear(tx, '2026-08-31', 4));
    const y2027 = await f.tenant.as((tx) => taxYear.ensureTaxYear(tx, '2027-08-31', 4));

    const in2026 = await f.tenant.as((tx) =>
      exemptions.listDeclarationItems(tx, { employeeId: f.employeeId, taxYearId: y2026.id }),
    );
    const in2027 = await f.tenant.as((tx) =>
      exemptions.listDeclarationItems(tx, { employeeId: f.employeeId, taxYearId: y2027.id }),
    );

    assert.equal(in2026.filter((i) => i.section_code === '80C').length, 1);
    assert.equal(in2027.filter((i) => i.section_code === '80C').length, 1);
    assert.equal(Number(in2027.find((i) => i.section_code === '80C')!.declared_amount), 60000);
  });

  it('refuses a negative declaration', async () => {
    await assert.rejects(
      f.tenant.as((tx) =>
        exemptions.declareSection(tx, {
          employeeId: f.employeeId,
          financialYear: '2026-27',
          sectionCode: '80D',
          declaredAmount: -1,
        }),
      ),
      (err: AppError) => err.code === 'negative_declaration',
    );
  });

  it('refuses a financial year that is not one of this tenant years', async () => {
    await assert.rejects(
      f.tenant.as((tx) =>
        exemptions.declareSection(tx, {
          employeeId: f.employeeId,
          financialYear: '2026-28',
          sectionCode: '80C',
          declaredAmount: 1000,
        }),
      ),
      (err: AppError) => err.code === 'invalid_financial_year',
    );
  });

  it('records eligibility separately from the declared figure', async () => {
    const items = await f.tenant.as((tx) =>
      exemptions.listDeclarationItems(tx, { employeeId: f.employeeId }),
    );
    const item = items.find((i) => i.section_code === '80D')!;

    const updated = await f.tenant.as((tx) =>
      exemptions.setProofOutcome(tx, item.id, {
        status: 'verified',
        eligibleAmount: 12000,
      }),
    );
    // Eligibility narrows what was declared. The cap is a separate, later step.
    assert.equal(Number(updated.declared_amount), 18000);
    assert.equal(Number(updated.verified_amount), 12000);
  });

  it('refuses to verify without saying what was found eligible', async () => {
    const [item] = await f.tenant.as((tx) =>
      exemptions.listDeclarationItems(tx, { employeeId: f.employeeId }),
    );
    await assert.rejects(
      f.tenant.as((tx) =>
        exemptions.setProofOutcome(tx, item!.id, { status: 'verified' }),
      ),
      (err: AppError) => err.code === 'eligible_amount_required',
    );
  });
});

// ---------------------------------------------------------------------------

describe('exemption snapshot reproducibility', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof exemptionFixture>>;

  before(async () => {
    f = await exemptionFixture('exsnap');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('freezes the rule and the declaration, and a later change moves neither', async () => {
    await f.tenant.as((tx) =>
      exemptions.declareSection(tx, {
        employeeId: f.employeeId,
        financialYear: '2026-27',
        regime: 'old',
        sectionCode: '80C',
        declaredAmount: 200000,
      }),
    );

    const run = await makeRun(f.tenant, 'Apr 2026', '2026-04-01', '2026-04-30');
    const frozen = await exemptionSnapshot(f.tenant, run.id);
    const section = frozen.exemption_json.sections.find((s: any) => s.section_code === '80C');

    assert.equal(section.declared_amount, '200000.00');
    assert.equal(section.max_amount, '150000.00');
    assert.equal(section.rule_version, 1);
    assert.equal(section.rule_source, 'platform');
    assert.equal(frozen.exemption_json.tax_year_label, '2026-27');

    // Now change both the ceiling and the declaration behind the run's back.
    await overrideCap(f.tenant, '80C', 999999, '2025-04-01', null, 42);
    await f.tenant.as((tx) =>
      exemptions.declareSection(tx, {
        employeeId: f.employeeId,
        financialYear: '2026-27',
        sectionCode: '80C',
        declaredAmount: 10,
      }),
    );

    const stillFrozen = await exemptionSnapshot(f.tenant, run.id);
    const stillSection = stillFrozen.exemption_json.sections.find(
      (s: any) => s.section_code === '80C',
    );
    assert.equal(stillSection.declared_amount, '200000.00');
    assert.equal(stillSection.max_amount, '150000.00');
    assert.equal(stillSection.rule_version, 1);
    await abandon(f.tenant, run.id);

    // A new run sees the new world: frozen is not the same as stale.
    const next = await makeRun(f.tenant, 'May 2026', '2026-05-01', '2026-05-31');
    const fresh = await exemptionSnapshot(f.tenant, next.id);
    const freshSection = fresh.exemption_json.sections.find(
      (s: any) => s.section_code === '80C',
    );
    assert.equal(freshSection.declared_amount, '10.00');
    assert.equal(freshSection.max_amount, '999999.00');
    assert.equal(freshSection.rule_version, 42);
    assert.equal(freshSection.rule_source, 'tenant');
    await abandon(f.tenant, next.id);
  });

  it('carries the reason forward when a rule cannot be resolved', async () => {
    const tenant = await createTestTenant('exsnap-gap');
    try {
      const employeeId = await createEmployee(tenant, { code: 'GAP1', joiningDate: '2025-01-01' });
      await tenant.as(async (tx) => {
        const basic = await tx.query<{ id: string }>(
          `INSERT INTO compensation.salary_component
             (tenant_id, code, name, component_type, calculation_type, taxable, semantic_role)
           VALUES ($1, 'BASIC', 'Basic', 'earning', 'percentage', true, 'basic') RETURNING id`,
          [tenant.tenantId],
        );
        const structure = await tx.query<{ id: string }>(
          `INSERT INTO compensation.salary_structure (tenant_id, name, version, effective_from)
           VALUES ($1, 'S', 1, '2025-01-01') RETURNING id`,
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

        // A section this tenant configured for itself, with no platform default behind
        // it. 80E is not one of the three the platform ships, so when the tenant rule goes
        // there is nothing to fall back to — which is the gap being tested. (An expiring
        // *override* of 80C or 80D would simply fall back to the platform ceiling, and
        // correctly so.)
        const rule = await tx.query<{ id: string }>(
          `INSERT INTO payroll.tax_exemption_rule
             (tenant_id, country_code, section_code, name, version, effective_from,
              max_amount, applicable_regimes)
           VALUES ($1, 'IN', '80E', 'Education loan interest', 1, '2025-04-01', 40000,
                   ARRAY['old'])
           RETURNING id`,
          [tenant.tenantId],
        );

        await exemptions.declareSection(tx, {
          employeeId,
          financialYear: '2026-27',
          regime: 'old',
          sectionCode: '80E',
          declaredAmount: 20000,
        });

        // Withdrawn after the declaration was accepted — a configuration gap that only
        // appears at run time.
        await tx.query('DELETE FROM payroll.tax_exemption_rule WHERE tenant_id = $1 AND id = $2',
          [tenant.tenantId, rule.rows[0]!.id]);
      });

      const run = await makeRun(tenant, 'Jun 2026', '2026-06-01', '2026-06-30');
      const snapshot = await exemptionSnapshot(tenant, run.id);
      const section = snapshot.exemption_json.sections.find((s: any) => s.section_code === '80E');

      // Carried forward with the reason rather than dropped. Dropping it would mean the
      // employee quietly received no exemption; this way the engine fails that one employee
      // with something an administrator can act on.
      assert.equal(section.max_amount, null);
      assert.match(section.unresolved_reason, /no exemption rule is in force for section 80E/);
      await abandon(tenant, run.id);
    } finally {
      await dropTestTenant(tenant.tenantId);
    }
  });

  it('a declaration stays revisable after a payslip in the year is finalized', async () => {
    // Employees declare an intention in April and revise it in January when they have
    // actually invested. By then most of the year is finalized, so refusing here would make
    // revision impossible — while the finalized slips themselves must not move.
    const run = await makeRun(f.tenant, 'Sep 2026', '2026-09-01', '2026-09-30');
    await finalizeRun(f.tenant, run.id, 'REG-EX-SEP');

    const before = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ section_exemption_total: string; status: string }>(
        `SELECT section_exemption_total, status FROM payroll.salary_slip
          WHERE tenant_id = $1 AND slip_number = 'REG-EX-SEP'`,
        [f.tenant.tenantId],
      );
      return rows[0]!;
    });
    assert.equal(before.status, 'finalized');

    await f.tenant.as((tx) =>
      exemptions.declareSection(tx, {
        employeeId: f.employeeId,
        financialYear: '2026-27',
        sectionCode: '80C',
        declaredAmount: 90000,
      }),
    );

    const after = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ section_exemption_total: string }>(
        `SELECT section_exemption_total FROM payroll.salary_slip
          WHERE tenant_id = $1 AND slip_number = 'REG-EX-SEP'`,
        [f.tenant.tenantId],
      );
      return rows[0]!;
    });
    // The revision is accepted and the finalized slip is untouched: the correction lands in
    // the periods still to be paid, which is what the annualisation is for.
    assert.equal(after.section_exemption_total, before.section_exemption_total);
  });

  it('a supplementary run does not re-apply the year exemptions', async () => {
    const run = await makeRun(f.tenant, 'Jul 2026', '2026-07-01', '2026-07-31');
    await finalizeRun(f.tenant, run.id, 'REG-EX-JUL');

    await f.tenant.as((tx) =>
      tx.query(
        `INSERT INTO compensation.additional_salary
           (tenant_id, employee_id, salary_component_id, amount, payroll_date, kind, status)
         SELECT $1, $2, id, 5000, '2026-07-15', 'bonus', 'approved'
           FROM compensation.salary_component WHERE tenant_id = $1 AND code = 'BASIC'`,
        [f.tenant.tenantId, f.employeeId],
      ),
    );

    const period = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM payroll.payroll_period WHERE tenant_id = $1 AND name = 'Jul 2026'`,
        [f.tenant.tenantId],
      );
      return rows[0]!.id;
    });
    const supplementary = await f.tenant.as((tx) =>
      payroll.createRun(tx, { payrollPeriodId: period, runType: 'supplementary' }),
    );

    const snapshot = await exemptionSnapshot(f.tenant, supplementary.id);
    // The regular run already applied the year's exemptions. Applying them again would
    // exempt the same income twice.
    assert.deepEqual(snapshot.exemption_json.sections, []);
    assert.match(snapshot.exemption_json.reason, /supplementary/);
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
            taxable_earnings, hra_exemption, section_exemption_total, tax_amount,
            calculation_version, snapshot_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,30,30,100000,100000,100000,0,150000,0,'v1',$8,'draft')`,
        [
          tenant.tenantId, runId, employee.id, employee.employee_id, slipNumber,
          period.rows[0]!.period_start, period.rows[0]!.period_end, snapshot.rows[0]!.id,
        ],
      );
      await tx.query(
        `UPDATE payroll.payroll_employee SET status = 'calculated', gross_amount = 100000
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

describe('exemption tenant isolation', skipWithoutDb, () => {
  let a: Awaited<ReturnType<typeof exemptionFixture>>;
  let b: Awaited<ReturnType<typeof exemptionFixture>>;

  before(async () => {
    a = await exemptionFixture('exiso-a');
    b = await exemptionFixture('exiso-b');
    await a.tenant.as((tx) =>
      exemptions.declareSection(tx, {
        employeeId: a.employeeId,
        financialYear: '2026-27',
        regime: 'old',
        sectionCode: '80C',
        declaredAmount: 150000,
      }),
    );
  });

  after(async () => {
    await dropTestTenant(a.tenant.tenantId);
    await dropTestTenant(b.tenant.tenantId);
    await closePools();
  });

  it('one tenant cannot read another declarations', async () => {
    assert.equal((await b.tenant.as((tx) => exemptions.listDeclarationItems(tx, {}))).length, 0);

    const [theirs] = await a.tenant.as((tx) => exemptions.listDeclarationItems(tx, {}));
    const direct = await b.tenant.as(async (tx) => {
      const { rows } = await tx.query(
        'SELECT id FROM compensation.tax_declaration_item WHERE id = $1',
        [theirs!.id],
      );
      return rows;
    });
    // RLS scopes the read, not a WHERE clause someone could forget.
    assert.equal(direct.length, 0);
  });

  it('one tenant cannot declare for another employee', async () => {
    await assert.rejects(
      b.tenant.as((tx) =>
        exemptions.declareSection(tx, {
          employeeId: a.employeeId,
          financialYear: '2026-27',
          sectionCode: '80C',
          declaredAmount: 1000,
        }),
      ),
      (err: AppError) => err.statusCode === 404,
    );
  });

  it('one tenant ceiling override does not reach another tenant', async () => {
    await overrideCap(a.tenant, '80C', 777777, '2025-04-01', null, 31);

    const year = await b.tenant.as((tx) => taxYear.ensureTaxYear(tx, '2026-08-31', 4));
    const rules = await b.tenant.as((tx) => exemptions.resolveExemptionRules(tx, year));
    assert.equal(rules['80C']!.max_amount, '150000.00');
    assert.equal(rules['80C']!.source, 'platform');
  });

  it('one tenant declaration never reaches another tenant snapshot', async () => {
    const run = await makeRun(b.tenant, 'Aug 2026', '2026-08-01', '2026-08-31');
    const snapshot = await exemptionSnapshot(b.tenant, run.id);
    assert.deepEqual(snapshot.exemption_json.sections, []);
    await abandon(b.tenant, run.id);
  });

  it('one tenant cannot write a ceiling owned by another', async () => {
    // The policy's WITH CHECK pins the row to the writing tenant, so tenant A cannot plant a
    // rule under tenant B's id even though it can see the platform rows alongside its own.
    await assert.rejects(
      a.tenant.as((tx) =>
        tx.query(
          `INSERT INTO payroll.tax_exemption_rule
             (tenant_id, country_code, section_code, name, version, effective_from,
              max_amount, applicable_regimes)
           VALUES ($1, 'IN', '80D', 'smuggled', 99, '2025-04-01', 1, ARRAY['old'])`,
          [b.tenant.tenantId],
        ),
      ),
      (err: { code?: string }) => err.code === '42501',
    );
  });

  it('one tenant cannot write a platform-wide ceiling', async () => {
    // A tenant-scoped write with a NULL tenant_id would be a rule every other tenant reads.
    await assert.rejects(
      a.tenant.as((tx) =>
        tx.query(
          `INSERT INTO payroll.tax_exemption_rule
             (tenant_id, country_code, section_code, name, version, effective_from,
              max_amount, applicable_regimes)
           VALUES (NULL, 'IN', '80D', 'global', 98, '2025-04-01', 1, ARRAY['old'])`,
        ),
      ),
      (err: { code?: string }) => err.code === '42501',
    );
  });
});
