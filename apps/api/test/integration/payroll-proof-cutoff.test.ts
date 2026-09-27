import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/infra/db/pool.ts';
import type { AppError } from '../../src/infra/errors.ts';
import * as payroll from '../../src/modules/payroll/service.ts';
import * as exemptions from '../../src/modules/payroll/exemptions.ts';
import * as taxYear from '../../src/modules/payroll/tax-year.ts';
import { SYSTEM_ROLES } from '../../src/modules/identity/service.ts';
import {
  createEmployee,
  createTestTenant,
  dropTestTenant,
  skipWithoutDb,
  type TestTenant,
} from './helpers.ts';

/**
 * The proof cutoff, and the distinction it turns on.
 *
 *     finalized payroll  = immutable
 *     tax declaration    = amendable during the tax year
 *
 * Those two must both hold at once, and the tempting simplification — freezing declarations
 * once a payslip exists — breaks the second. An employee declares an intention in April and
 * proves it in January, by which time most of the year is finalized. Phase 3 established
 * that; this phase must not quietly undo it while adding the cutoff.
 *
 * The cutoff comparison happens once, in Node, against the **payroll period's end** rather
 * than `now()`, and is frozen as a boolean. That is what makes recalculating an April run in
 * December reach April's answer.
 */

const CUTOFF = '2027-01-31';

async function cutoffFixture(prefix: string) {
  const tenant = await createTestTenant(prefix);
  const employeeId = await createEmployee(tenant, { code: 'PC0001', joiningDate: '2025-01-01' });

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

  // The cutoff lives on the tax year, which migration 0024 already provided.
  const year = await tenant.as((tx) => taxYear.ensureTaxYear(tx, '2026-08-31', 4));
  await tenant.as((tx) => taxYear.setProofCutoff(tx, year.id, CUTOFF));

  await tenant.as((tx) =>
    exemptions.declareSection(tx, {
      employeeId,
      financialYear: '2026-27',
      regime: 'old',
      sectionCode: '80C',
      declaredAmount: 150000,
    }),
  );

  return { tenant, employeeId, taxYearId: year.id };
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

async function sectionOf(tenant: TestTenant, runId: string, code = '80C') {
  return tenant.as(async (tx) => {
    const { rows } = await tx.query<{ exemption_json: any }>(
      `SELECT exemption_json FROM payroll.payroll_input_snapshot
        WHERE payroll_run_id = $1 ORDER BY snapshot_version DESC LIMIT 1`,
      [runId],
    );
    return rows[0]!.exemption_json.sections.find((s: any) => s.section_code === code);
  });
}

async function abandon(tenant: TestTenant, runId: string) {
  await tenant.as((tx) => payroll.markFailed(tx, runId, 'test cleanup'));
  await tenant.as((tx) => payroll.cancel(tx, runId, 'test cleanup'));
}

async function onlyItem(tenant: TestTenant, employeeId: string) {
  const items = await tenant.as((tx) => exemptions.listDeclarationItems(tx, { employeeId }));
  return items.find((i) => i.section_code === '80C')!;
}

/** Marks a run calculated and finalizes it, standing in for the Python engine. */
async function finalizeRun(
  tenant: TestTenant,
  runId: string,
  slipNumber: string,
  sectionTotal: number,
) {
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
         VALUES ($1,$2,$3,$4,$5,$6,$7,30,30,100000,100000,100000,0,$8,0,'in-payroll-2025.5',$9,'draft')`,
        [
          tenant.tenantId, runId, employee.id, employee.employee_id, slipNumber,
          period.rows[0]!.period_start, period.rows[0]!.period_end, sectionTotal,
          snapshot.rows[0]!.id,
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

describe('cutoff boundary', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof cutoffFixture>>;

  before(async () => {
    f = await cutoffFixture('cutoff');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('has not passed for a period ending before the cutoff', async () => {
    const run = await makeRun(f.tenant, 'Dec 2026', '2026-12-01', '2026-12-31');
    const section = await sectionOf(f.tenant, run.id);

    assert.equal(section.cutoff_passed, false);
    assert.equal(section.effective_status, 'declared');
    assert.equal(section.proof_cutoff_date, CUTOFF);
    assert.equal(section.cutoff_reference_date, '2026-12-31');
    await abandon(f.tenant, run.id);
  });

  it('has passed for a period ending exactly on the cutoff', async () => {
    // The documented convention: the cutoff has passed *on* the date itself. A cutoff of
    // 31 January means proof must be in before it, and the stricter reading is chosen
    // because under-deduction is the employer's liability.
    const run = await makeRun(f.tenant, 'Jan 2027', '2027-01-01', CUTOFF);
    const section = await sectionOf(f.tenant, run.id);

    assert.equal(section.cutoff_reference_date, CUTOFF);
    assert.equal(section.cutoff_passed, true);
    assert.equal(section.effective_status, 'unverified');
    await abandon(f.tenant, run.id);
  });

  it('has passed for a period ending after the cutoff', async () => {
    const run = await makeRun(f.tenant, 'Feb 2027', '2027-02-01', '2027-02-28');
    const section = await sectionOf(f.tenant, run.id);

    assert.equal(section.cutoff_passed, true);
    assert.equal(section.effective_status, 'unverified');
    // The declared figure is untouched: nothing is deleted, only made ineligible.
    assert.equal(section.declared_amount, '150000.00');
    await abandon(f.tenant, run.id);
  });

  it('is judged against the period end, not today, so recalculation reproduces', async () => {
    const run = await makeRun(f.tenant, 'Nov 2026', '2026-11-01', '2026-11-30');
    assert.equal((await sectionOf(f.tenant, run.id)).cutoff_passed, false);

    await f.tenant.as((tx) => payroll.recalculate(tx, run.id));

    // Recalculated now — which by wall-clock is well past a 2027 cutoff — and still answers
    // as at November. `now()` here would have silently changed a historical run.
    const after = await sectionOf(f.tenant, run.id);
    assert.equal(after.cutoff_reference_date, '2026-11-30');
    assert.equal(after.cutoff_passed, false);
    assert.equal(after.effective_status, 'declared');
    await abandon(f.tenant, run.id);
  });

  it('never passes when the year has no cutoff configured', async () => {
    const tenant = await createTestTenant('cutoff-none');
    try {
      const employeeId = await createEmployee(tenant, { code: 'NC1', joiningDate: '2025-01-01' });
      await tenant.as((tx) =>
        exemptions.declareSection(tx, {
          employeeId,
          financialYear: '2026-27',
          regime: 'old',
          sectionCode: '80C',
          declaredAmount: 100000,
        }),
      );
      const year = await tenant.as((tx) => taxYear.ensureTaxYear(tx, '2026-08-31', 4));
      assert.equal(year.proof_cutoff_date, null, 'setup: no cutoff configured');

      const snapshot = await tenant.as((tx) =>
        exemptions.buildExemptionSnapshot(tx, employeeId, {
          taxYear: year,
          regime: 'old',
          referenceDate: '2099-12-31',
        }),
      );
      // No date means no cutoff, which is migration 0024's documented behaviour. Not a
      // failure, and emphatically not a guessed default.
      assert.equal(snapshot.cutoff_passed, false);
      assert.equal(snapshot.sections[0]!.effective_status, 'declared');
    } finally {
      await dropTestTenant(tenant.tenantId);
    }
  });

  it('keeps one tax year cutoff out of another', async () => {
    const nextYear = await f.tenant.as((tx) => taxYear.ensureTaxYear(tx, '2027-08-31', 4));
    await f.tenant.as((tx) => taxYear.setProofCutoff(tx, nextYear.id, '2028-02-15'));

    const thisYear = await f.tenant.as((tx) => taxYear.ensureTaxYear(tx, '2026-08-31', 4));
    assert.equal(thisYear.proof_cutoff_date, CUTOFF);
    assert.equal(nextYear.proof_cutoff_date, null, 'returned before the update');

    const reloaded = await f.tenant.as((tx) => taxYear.listTaxYears(tx));
    const y2027 = reloaded.find((y) => y.label === '2027-28')!;
    // FY 2027-28 has its own date; 2026-27's must not leak into it.
    assert.equal(y2027.proof_cutoff_date, '2028-02-15');
    assert.notEqual(y2027.proof_cutoff_date, CUTOFF);
  });
});

// ---------------------------------------------------------------------------

describe('proof outcomes', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof cutoffFixture>>;

  before(async () => {
    f = await cutoffFixture('proof');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('records the verifier, the moment and the previous state', async () => {
    const item = await onlyItem(f.tenant, f.employeeId);
    const verified = await f.tenant.as((tx) =>
      exemptions.setProofOutcome(tx, item.id, {
        status: 'verified',
        eligibleAmount: 140000,
        reason: 'ELSS statements for 1.4L sighted',
      }),
    );

    assert.equal(verified.status, 'verified');
    assert.equal(verified.previous_status, 'declared');
    assert.equal(Number(verified.verified_amount), 140000);
    assert.ok(verified.verified_at, 'the moment of the decision is recorded');
    assert.equal(verified.proof_outcome_reason, 'ELSS statements for 1.4L sighted');
  });

  it('audits the transition with both statuses and the reason', async () => {
    const entry = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ is_sensitive: boolean; after_state: any }>(
        `SELECT is_sensitive, after_state FROM audit.audit_log
          WHERE tenant_id = $1 AND action = 'tax.exemption.proof_reviewed'
          ORDER BY created_at DESC LIMIT 1`,
        [f.tenant.tenantId],
      );
      return rows[0]!;
    });

    assert.equal(entry.is_sensitive, true);
    assert.equal(entry.after_state.old_status, 'declared');
    assert.equal(entry.after_state.new_status, 'verified');
    assert.equal(entry.after_state.section_code, '80C');
    assert.match(entry.after_state.reason, /ELSS/);
  });

  it('refuses to verify more than was declared', async () => {
    const item = await onlyItem(f.tenant, f.employeeId);
    await assert.rejects(
      f.tenant.as((tx) =>
        exemptions.setProofOutcome(tx, item.id, {
          status: 'verified',
          eligibleAmount: 500000,
        }),
      ),
      // Raising the figure is something the employee asserts, not something a verifier does
      // on their behalf.
      (err: AppError) => err.code === 'verified_exceeds_declared' && err.statusCode === 422,
    );
  });

  it('rejects proof without destroying the declaration', async () => {
    const item = await onlyItem(f.tenant, f.employeeId);
    const rejected = await f.tenant.as((tx) =>
      exemptions.setProofOutcome(tx, item.id, {
        status: 'rejected',
        reason: 'receipts are for the previous tax year',
      }),
    );

    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.previous_status, 'verified');
    assert.equal(rejected.verified_amount, null);
    // What the employee said survives; only what it is worth changed.
    assert.equal(Number(rejected.declared_amount), 150000);
    assert.match(rejected.proof_outcome_reason!, /previous tax year/);
  });

  it('allows a rejection to be revisited when better proof arrives', async () => {
    const item = await onlyItem(f.tenant, f.employeeId);
    const verified = await f.tenant.as((tx) =>
      exemptions.setProofOutcome(tx, item.id, {
        status: 'verified',
        eligibleAmount: 150000,
        reason: 'correct year statements produced',
      }),
    );
    assert.equal(verified.status, 'verified');
    assert.equal(verified.previous_status, 'rejected');
  });

  it('amending clears the proof outcome entirely', async () => {
    await f.tenant.as((tx) =>
      exemptions.declareSection(tx, {
        employeeId: f.employeeId,
        financialYear: '2026-27',
        sectionCode: '80C',
        declaredAmount: 120000,
      }),
    );
    const item = await onlyItem(f.tenant, f.employeeId);

    assert.equal(item.status, 'declared');
    assert.equal(item.verified_amount, null);
    // Leaving a verifier's name against a number they never saw would be worse than none.
    assert.equal(item.verified_by, null);
    assert.equal(item.verified_at, null);
    assert.equal(item.proof_outcome_reason, null);
  });

  it('accepts proof after the cutoff, which restores eligibility', async () => {
    const item = await onlyItem(f.tenant, f.employeeId);
    await f.tenant.as((tx) =>
      exemptions.setProofOutcome(tx, item.id, {
        status: 'verified',
        eligibleAmount: 120000,
        reason: 'late submission accepted under HR policy',
      }),
    );

    // February, well past the January cutoff. The cutoff governs what an *unproved*
    // declaration is worth; this one is proved, so it stands.
    const run = await makeRun(f.tenant, 'Feb 2027', '2027-02-01', '2027-02-28');
    const section = await sectionOf(f.tenant, run.id);

    assert.equal(section.cutoff_passed, true);
    assert.equal(section.effective_status, 'verified');
    assert.equal(section.eligible_amount, '120000.00');
    await abandon(f.tenant, run.id);
  });
});

// ---------------------------------------------------------------------------

describe('finalized payroll versus amendable declarations', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof cutoffFixture>>;

  before(async () => {
    f = await cutoffFixture('amend');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('lets a declaration be amended after payroll is finalized', async () => {
    // The distinction this whole phase turns on. April is paid and immutable; the employee
    // may still revise what they intend to invest, and the revision lands in May.
    const april = await makeRun(f.tenant, 'Apr 2026', '2026-04-01', '2026-04-30');
    assert.equal((await sectionOf(f.tenant, april.id)).declared_amount, '150000.00');
    await finalizeRun(f.tenant, april.id, 'REG-PC-APR', 150000);

    await f.tenant.as((tx) =>
      exemptions.declareSection(tx, {
        employeeId: f.employeeId,
        financialYear: '2026-27',
        sectionCode: '80C',
        declaredAmount: 50000,
      }),
    );

    const may = await makeRun(f.tenant, 'May 2026', '2026-05-01', '2026-05-31');
    // May sees the amendment...
    assert.equal((await sectionOf(f.tenant, may.id)).declared_amount, '50000.00');

    // ...and April is exactly as it was.
    const aprilAfter = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ section_exemption_total: string; status: string }>(
        `SELECT section_exemption_total, status FROM payroll.salary_slip
          WHERE tenant_id = $1 AND slip_number = 'REG-PC-APR'`,
        [f.tenant.tenantId],
      );
      return rows[0]!;
    });
    assert.equal(aprilAfter.status, 'finalized');
    assert.equal(Number(aprilAfter.section_exemption_total), 150000);
    assert.equal((await sectionOf(f.tenant, april.id)).declared_amount, '150000.00',
      'the April snapshot is frozen');
    await abandon(f.tenant, may.id);
  });

  it('lets proof be recorded after payroll is finalized', async () => {
    const item = await onlyItem(f.tenant, f.employeeId);
    const verified = await f.tenant.as((tx) =>
      exemptions.setProofOutcome(tx, item.id, { status: 'verified', eligibleAmount: 50000 }),
    );
    assert.equal(verified.status, 'verified');

    const aprilStillFinalized = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ status: string; section_exemption_total: string }>(
        `SELECT status, section_exemption_total FROM payroll.salary_slip
          WHERE tenant_id = $1 AND slip_number = 'REG-PC-APR'`,
        [f.tenant.tenantId],
      );
      return rows[0]!;
    });
    assert.equal(aprilStillFinalized.status, 'finalized');
    assert.equal(Number(aprilStillFinalized.section_exemption_total), 150000);
  });

  it('freezes proof state into the snapshot so a later change does not move it', async () => {
    const june = await makeRun(f.tenant, 'Jun 2026', '2026-06-01', '2026-06-30');
    const frozen = await sectionOf(f.tenant, june.id);
    assert.equal(frozen.status, 'verified');
    assert.equal(frozen.eligible_amount, '50000.00');

    // Reject it afterwards, behind the run's back.
    const item = await onlyItem(f.tenant, f.employeeId);
    await f.tenant.as((tx) =>
      exemptions.setProofOutcome(tx, item.id, { status: 'rejected', reason: 'on review' }),
    );

    const stillFrozen = await sectionOf(f.tenant, june.id);
    assert.equal(stillFrozen.status, 'verified');
    assert.equal(stillFrozen.eligible_amount, '50000.00');
    await abandon(f.tenant, june.id);

    // A new run sees the rejection: frozen is not the same as stale.
    const july = await makeRun(f.tenant, 'Jul 2026', '2026-07-01', '2026-07-31');
    assert.equal((await sectionOf(f.tenant, july.id)).status, 'rejected');
    await abandon(f.tenant, july.id);
  });
});

// ---------------------------------------------------------------------------

describe('missing cutoff configuration fails closed', skipWithoutDb, () => {
  it('refuses when the tenant requires a cutoff and the year has none', async () => {
    const tenant = await createTestTenant('cutoff-required');
    try {
      const employeeId = await createEmployee(tenant, { code: 'RC1', joiningDate: '2025-01-01' });
      await tenant.as(async (tx) => {
        await exemptions.declareSection(tx, {
          employeeId,
          financialYear: '2026-27',
          regime: 'old',
          sectionCode: '80C',
          declaredAmount: 100000,
        });
        // The tenant asserts every year must have a cutoff. Opt-in, so no existing tenant
        // is failed closed by a flag they never set.
        await tx.query(
          `INSERT INTO payroll.tenant_payroll_policy (tenant_id, require_proof_cutoff)
           VALUES ($1, true)
           ON CONFLICT (tenant_id) DO UPDATE SET require_proof_cutoff = true`,
          [tenant.tenantId],
        );
      });

      const year = await tenant.as((tx) => taxYear.ensureTaxYear(tx, '2026-08-31', 4));
      const snapshot = await tenant.as((tx) =>
        exemptions.buildExemptionSnapshot(tx, employeeId, {
          taxYear: year,
          regime: 'old',
          referenceDate: '2026-08-31',
        }),
      );

      // Carried as an unresolved reason, so the engine fails this one employee with
      // something an administrator can act on — never a guessed date.
      const section = snapshot.sections[0]!;
      assert.match(section.unresolved_reason!, /requires a proof cutoff/);
      assert.match(section.unresolved_reason!, /2026-27/);
      assert.equal(snapshot.require_proof_cutoff, true);
    } finally {
      await dropTestTenant(tenant.tenantId);
    }
  });

  it('does not fail a tenant that has not asked for one', async () => {
    const tenant = await createTestTenant('cutoff-optional');
    try {
      const employeeId = await createEmployee(tenant, { code: 'OC1', joiningDate: '2025-01-01' });
      await tenant.as((tx) =>
        exemptions.declareSection(tx, {
          employeeId,
          financialYear: '2026-27',
          regime: 'old',
          sectionCode: '80C',
          declaredAmount: 100000,
        }),
      );
      const year = await tenant.as((tx) => taxYear.ensureTaxYear(tx, '2026-08-31', 4));
      const snapshot = await tenant.as((tx) =>
        exemptions.buildExemptionSnapshot(tx, employeeId, {
          taxYear: year,
          regime: 'old',
          referenceDate: '2026-08-31',
        }),
      );
      assert.equal(snapshot.sections[0]!.unresolved_reason, undefined);
      assert.equal(snapshot.require_proof_cutoff, false);
    } finally {
      await dropTestTenant(tenant.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------

describe('proof authorization and isolation', skipWithoutDb, () => {
  let a: Awaited<ReturnType<typeof cutoffFixture>>;
  let b: Awaited<ReturnType<typeof cutoffFixture>>;

  before(async () => {
    a = await cutoffFixture('proof-iso-a');
    b = await cutoffFixture('proof-iso-b');
  });

  after(async () => {
    await dropTestTenant(a.tenant.tenantId);
    await dropTestTenant(b.tenant.tenantId);
    await closePools();
  });

  it('does not let an employee verify their own proof', async () => {
    // The Employee role may declare and may read its own payslip. Verifying is what turns a
    // statement into a deduction, so it is deliberately not theirs to do.
    const employee = SYSTEM_ROLES.Employee!;
    assert.ok(employee.includes('tax.declare.self'));
    assert.equal(employee.includes('tax.proof.verify'), false);
    assert.equal(employee.includes('tax.manage'), false);
  });

  it('gives proof verification to Payroll Admin', async () => {
    assert.ok(SYSTEM_ROLES['Payroll Admin']!.includes('tax.proof.verify'));
  });

  it('keeps one tenant declarations and proof out of another', async () => {
    const theirs = await onlyItem(a.tenant, a.employeeId);

    const visible = await b.tenant.as(async (tx) => {
      const { rows } = await tx.query(
        'SELECT id FROM compensation.tax_declaration_item WHERE id = $1',
        [theirs.id],
      );
      return rows;
    });
    assert.equal(visible.length, 0);

    // And it cannot be acted on either: RLS scopes the UPDATE, so the row is simply not
    // there to be found.
    await assert.rejects(
      b.tenant.as((tx) =>
        exemptions.setProofOutcome(tx, theirs.id, {
          status: 'verified',
          eligibleAmount: 1,
        }),
      ),
      (err: AppError) => err.statusCode === 404,
    );
  });

  it('keeps one tenant cutoff out of another tenant snapshot', async () => {
    await b.tenant.as((tx) => taxYear.setProofCutoff(tx, b.taxYearId, '2026-06-30'));

    const yearA = await a.tenant.as((tx) => taxYear.ensureTaxYear(tx, '2026-08-31', 4));
    const snapshotA = await a.tenant.as((tx) =>
      exemptions.buildExemptionSnapshot(tx, a.employeeId, {
        taxYear: yearA,
        regime: 'old',
        referenceDate: '2026-08-31',
      }),
    );
    // Tenant B's June cutoff has passed by August; tenant A's January one has not.
    assert.equal(snapshotA.proof_cutoff_date, CUTOFF);
    assert.equal(snapshotA.cutoff_passed, false);

    const yearB = await b.tenant.as((tx) => taxYear.ensureTaxYear(tx, '2026-08-31', 4));
    const snapshotB = await b.tenant.as((tx) =>
      exemptions.buildExemptionSnapshot(tx, b.employeeId, {
        taxYear: yearB,
        regime: 'old',
        referenceDate: '2026-08-31',
      }),
    );
    assert.equal(snapshotB.proof_cutoff_date, '2026-06-30');
    assert.equal(snapshotB.cutoff_passed, true);
  });
});
