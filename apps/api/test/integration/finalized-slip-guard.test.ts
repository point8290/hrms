import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/infra/db/pool.ts';
import * as payroll from '../../src/modules/payroll/service.ts';
import {
  createEmployee,
  createTestTenant,
  dropTestTenant,
  skipWithoutDb,
  type TestTenant,
} from './helpers.ts';

/**
 * Every protection on a finalized payslip, from every phase that added one.
 *
 * This file exists because of a specific near-miss. Migration 0029 needed to add one column
 * to `payroll.guard_finalized_slip`, and did it by copying the function body out of
 * migration 0006 and appending to it. `CREATE OR REPLACE FUNCTION` replaces whatever is
 * *live*, not whatever the author was reading — so that copy silently reverted 0010's purge
 * escape and 0023's `snapshot_id` and `calculation_version` clauses. Nothing failed. The
 * protections were simply gone, and stayed gone until a purge in an unrelated test happened
 * to break.
 *
 * So the invariants are asserted here rather than trusted to survive the next migration that
 * touches the function. Each test names the migration that introduced what it protects, and
 * a migration that drops one of them now fails loudly instead of silently.
 */

async function guardFixture(prefix: string) {
  const tenant = await createTestTenant(prefix);
  const employeeId = await createEmployee(tenant, { code: 'GRD001', joiningDate: '2025-01-01' });

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
       VALUES ($1, $2, $3, 1200000, 100000, '2025-01-01')`,
      [tenant.tenantId, employeeId, structure.rows[0]!.id],
    );
    await tx.query(
      `INSERT INTO integration.scheduled_job
         (tenant_id, job_type, execution_date, status, completed_at, payload)
       SELECT $1, 'attendance.close', d::date, 'completed', now(), '{"timezone":"Asia/Kolkata"}'::jsonb
         FROM generate_series('2026-04-01'::date, '2026-04-30'::date, INTERVAL '1 day') AS d
       ON CONFLICT (tenant_id, job_type, execution_date, job_key) DO NOTHING`,
      [tenant.tenantId],
    );
  });

  const period = await tenant.as((tx) =>
    payroll.createPeriod(tx, {
      companyId: tenant.companyId,
      name: 'Apr 2026',
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
      payDate: '2026-05-01',
    }),
  );
  const run = await tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: period.id }));

  const slipId = await tenant.as(async (tx) => {
    const employees = await tx.query<{ id: string; employee_id: string }>(
      'SELECT id, employee_id FROM payroll.payroll_employee WHERE payroll_run_id = $1',
      [run.id],
    );
    const snapshot = await tx.query<{ id: string }>(
      `SELECT id FROM payroll.payroll_input_snapshot WHERE payroll_run_id = $1
        ORDER BY snapshot_version DESC LIMIT 1`,
      [run.id],
    );
    const employee = employees.rows[0]!;
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO payroll.salary_slip
         (tenant_id, payroll_run_id, payroll_employee_id, employee_id, slip_number,
          period_start, period_end, total_days, payable_days, lop_days,
          gross_amount, deduction_amount, tax_amount, net_amount,
          taxable_earnings, hra_exemption, section_exemption_total,
          calculation_version, snapshot_id, status)
       VALUES ($1,$2,$3,$4,'GRD-APR-01','2026-04-01','2026-04-30',30,30,0,
               50000,1000,2000,47000,45000,3000,150000,'in-payroll-2025.4',$5,'draft')
       RETURNING id`,
      [tenant.tenantId, run.id, employee.id, employee.employee_id, snapshot.rows[0]!.id],
    );
    await tx.query(
      `INSERT INTO payroll.salary_slip_component
         (tenant_id, salary_slip_id, component_code_snapshot, component_name_snapshot,
          component_type, amount, calculation_detail, display_order)
       VALUES ($1, $2, 'EXEMPTION_80C', 'Section 80C', 'exemption', 150000,
               '{"declared_amount":"200000.00","allowed_exemption":"150000.00"}'::jsonb, 0)`,
      [tenant.tenantId, rows[0]!.id],
    );
    await tx.query(
      `UPDATE payroll.payroll_employee SET status = 'calculated', gross_amount = 50000
        WHERE id = $1`,
      [employee.id],
    );
    await tx.query(`UPDATE payroll.payroll_run SET status = 'calculated' WHERE id = $1`, [run.id]);
    return rows[0]!.id;
  });

  await tenant.as((tx) => payroll.submitForReview(tx, run.id));
  await tenant.as((tx) => payroll.approve(tx, run.id));
  await tenant.as((tx) => payroll.finalize(tx, run.id));

  return { tenant, employeeId, runId: run.id, slipId };
}

/** Every rejection here is the same trigger refusing; assert the code, not the prose. */
const restrictViolation = (err: { code?: string }) => err.code === '23001';

async function expectImmutable(tenant: TestTenant, slipId: string, sql: string, value: unknown) {
  await assert.rejects(
    tenant.as((tx) =>
      tx.query(`UPDATE payroll.salary_slip SET ${sql} WHERE tenant_id = $1 AND id = $2`, [
        tenant.tenantId,
        slipId,
        value,
      ]),
    ),
    restrictViolation,
  );
}

// ---------------------------------------------------------------------------

describe('finalized salary slip immutability', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof guardFixture>>;

  before(async () => {
    f = await guardFixture('slipguard');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('is finalized, as the fixture assumes', async () => {
    const status = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ status: string }>(
        'SELECT status FROM payroll.salary_slip WHERE id = $1',
        [f.slipId],
      );
      return rows[0]!.status;
    });
    assert.equal(status, 'finalized');
  });

  // --- 0006: the money ------------------------------------------------------

  it('refuses a change to gross (0006)', async () => {
    await expectImmutable(f.tenant, f.slipId, 'gross_amount = $3', 99999);
  });

  it('refuses a change to deductions (0006)', async () => {
    await expectImmutable(f.tenant, f.slipId, 'deduction_amount = $3', 0);
  });

  it('refuses a change to tax (0006)', async () => {
    await expectImmutable(f.tenant, f.slipId, 'tax_amount = $3', 0);
  });

  it('refuses a change to net (0006)', async () => {
    await expectImmutable(f.tenant, f.slipId, 'net_amount = $3', 1);
  });

  it('refuses a change to payable or LOP days (0006)', async () => {
    await expectImmutable(f.tenant, f.slipId, 'payable_days = $3', 10);
    await expectImmutable(f.tenant, f.slipId, 'lop_days = $3', 10);
  });

  it('refuses a change to status (0006)', async () => {
    await expectImmutable(f.tenant, f.slipId, 'status = $3', 'draft');
  });

  // --- 0023: the tax base and its provenance --------------------------------

  it('refuses a change to taxable earnings (0023)', async () => {
    await expectImmutable(f.tenant, f.slipId, 'taxable_earnings = $3', 1);
  });

  it('refuses re-pointing the slip at a different snapshot (0023)', async () => {
    // The clause 0029 silently dropped. A finalized slip that could be re-pointed at another
    // snapshot would be explainable by inputs that never produced it.
    const other = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO payroll.payroll_input_snapshot
           (tenant_id, payroll_run_id, employee_id, snapshot_version, employee_json,
            attendance_json, leave_json, compensation_json, tax_json, statutory_json)
         VALUES ($1, $2, $3, 99, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                 '{}'::jsonb, '{}'::jsonb)
         RETURNING id`,
        [f.tenant.tenantId, f.runId, f.employeeId],
      );
      return rows[0]!.id;
    });
    await expectImmutable(f.tenant, f.slipId, 'snapshot_id = $3', other);
  });

  it('refuses relabelling the engine version that produced it (0023)', async () => {
    // The other clause 0029 dropped. Relabelling would make a slip claim to have been
    // computed by rules it never saw.
    await expectImmutable(f.tenant, f.slipId, 'calculation_version = $3', 'in-payroll-1999.1');
  });

  // --- 0029 and 0031: the exemptions ---------------------------------------

  it('refuses a change to the HRA exemption (0029)', async () => {
    await expectImmutable(f.tenant, f.slipId, 'hra_exemption = $3', 0);
  });

  it('refuses a change to the section exemption total (0031)', async () => {
    await expectImmutable(f.tenant, f.slipId, 'section_exemption_total = $3', 0);
  });

  // --- 0029: the explanation ------------------------------------------------

  it('refuses editing a component line of a finalized slip (0029)', async () => {
    // An explanation that can be quietly rewritten after the fact is worth nothing in a
    // dispute.
    await assert.rejects(
      f.tenant.as((tx) =>
        tx.query(
          `UPDATE payroll.salary_slip_component SET amount = 1
            WHERE tenant_id = $1 AND salary_slip_id = $2`,
          [f.tenant.tenantId, f.slipId],
        ),
      ),
      restrictViolation,
    );
  });

  it('refuses deleting a component line of a finalized slip (0029)', async () => {
    await assert.rejects(
      f.tenant.as((tx) =>
        tx.query(
          `DELETE FROM payroll.salary_slip_component
            WHERE tenant_id = $1 AND salary_slip_id = $2`,
          [f.tenant.tenantId, f.slipId],
        ),
      ),
      restrictViolation,
    );
  });

  // --- 0006: deletion, and 0010's one exception -----------------------------

  it('refuses deleting a finalized slip (0006)', async () => {
    await assert.rejects(
      f.tenant.as((tx) =>
        tx.query('DELETE FROM payroll.salary_slip WHERE tenant_id = $1 AND id = $2', [
          f.tenant.tenantId,
          f.slipId,
        ]),
      ),
      restrictViolation,
    );
  });

  it('still allows the document link to be attached (0006)', async () => {
    // The one field deliberately left mutable: the payslip PDF is produced after
    // finalization, so attaching it must not be blocked.
    await f.tenant.as((tx) =>
      tx.query(
        'UPDATE payroll.salary_slip SET document_id = gen_random_uuid() WHERE tenant_id = $1 AND id = $2',
        [f.tenant.tenantId, f.slipId],
      ),
    );
  });
});

describe('finalized slips can still be purged', skipWithoutDb, () => {
  /**
   * Migration 0010's escape, and the one 0029 removed.
   *
   * Erasing a tenant is a separately authorised operation that must be able to complete: a
   * half-purged tenant is worse than either outcome. Without this, `dropTestTenant` fails for
   * any tenant that has ever finalized a payslip — which is how the regression was noticed at
   * all, and only by luck.
   */
  it('purges a tenant that has finalized payroll', async () => {
    const f = await guardFixture('slipguard-purge');
    const finalized = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM payroll.salary_slip
          WHERE tenant_id = $1 AND status = 'finalized'`,
        [f.tenant.tenantId],
      );
      return Number(rows[0]!.count);
    });
    assert.equal(finalized, 1, 'setup: there is a finalized slip to be blocked by');

    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });
});
