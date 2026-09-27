import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/infra/db/pool.ts';
import * as leave from '../../src/modules/leave/service.ts';
import * as periodJobs from '../../src/modules/leave/period-jobs.ts';
import * as payment from '../../src/modules/payroll/payment.ts';
import * as coreHr from '../../src/modules/core-hr/service.ts';
import { createEmployee, createTestTenant, dropTestTenant, skipWithoutDb, type TestTenant } from './helpers.ts';
import { createPeriod } from '../../src/modules/payroll/service.ts';

/**
 * Leave period jobs and payroll payment.
 *
 * Both move things people care about — entitlement and money — so the properties under
 * test are idempotency, caps, and never silently losing someone.
 */
describe('leave period jobs', skipWithoutDb, () => {
  let tenant: TestTenant;
  let employeeId: string;
  let midYearJoinerId: string;
  let leaveTypeId: string;
  let policyId: string;

  before(async () => {
    tenant = await createTestTenant('leavejobs');
    employeeId = await createEmployee(tenant, { code: 'LJ001', joiningDate: '2025-01-01' });
    midYearJoinerId = await createEmployee(tenant, { code: 'LJ002', joiningDate: '2026-07-01' });

    await tenant.as(async (tx) => {
      const type = await tx.query<{ id: string }>(
        `INSERT INTO leave_mgmt.leave_type
           (tenant_id, name, code, carry_forward_enabled, max_carry_forward, encashment_enabled)
         VALUES ($1, 'Earned Leave', 'EL', true, 5, true) RETURNING id`,
        [tenant.tenantId],
      );
      leaveTypeId = type.rows[0]!.id;

      const policy = await tx.query<{ id: string }>(
        `INSERT INTO leave_mgmt.leave_policy (tenant_id, name, effective_from)
         VALUES ($1, 'Standard', '2025-01-01') RETURNING id`,
        [tenant.tenantId],
      );
      policyId = policy.rows[0]!.id;

      await tx.query(
        `INSERT INTO leave_mgmt.leave_policy_rule
           (tenant_id, leave_policy_id, leave_type_id, annual_allocation, accrual_frequency)
         VALUES ($1, $2, $3, 12, 'annual')`,
        [tenant.tenantId, policyId, leaveTypeId],
      );
    });
  });

  after(async () => {
    await dropTestTenant(tenant.tenantId);
    await closePools();
  });

  it('assigns a policy to an employee', async () => {
    for (const id of [employeeId, midYearJoinerId]) {
      await tenant.as((tx) =>
        periodJobs.assignPolicy(tx, { employeeId: id, leavePolicyId: policyId, effectiveFrom: '2026-01-01' }),
      );
    }

    const count = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ count: string }>(
        'SELECT count(*) AS count FROM leave_mgmt.leave_policy_assignment',
      );
      return Number(rows[0]!.count);
    });
    assert.equal(count, 2);
  });

  it('refuses an overlapping policy assignment', async () => {
    await assert.rejects(
      tenant.as((tx) =>
        periodJobs.assignPolicy(tx, { employeeId, leavePolicyId: policyId, effectiveFrom: '2026-06-01' }),
      ),
      /already has a leave policy/,
    );
  });

  it('accrues the annual entitlement, pro-rated for a mid-year joiner', async () => {
    const result = await tenant.as((tx) =>
      periodJobs.runAccrual(tx, { periodStart: '2026-01-01', periodEnd: '2026-12-31' }),
    );
    assert.equal(result.employeesProcessed, 2);
    assert.equal(result.alreadyRun, false);

    const full = await tenant.as((tx) => leave.getBalance(tx, employeeId, leaveTypeId, '2026-12-31'));
    const partial = await tenant.as((tx) => leave.getBalance(tx, midYearJoinerId, leaveTypeId, '2026-12-31'));

    assert.equal(full.allocated, 12, 'a full-year employee gets the whole entitlement');
    assert.equal(partial.allocated, 6, 'joining on 1 July earns half the year');
  });

  it('does not accrue twice when the job is re-run', async () => {
    const rerun = await tenant.as((tx) =>
      periodJobs.runAccrual(tx, { periodStart: '2026-01-01', periodEnd: '2026-12-31' }),
    );
    assert.equal(rerun.alreadyRun, true);

    const balance = await tenant.as((tx) => leave.getBalance(tx, employeeId, leaveTypeId, '2026-12-31'));
    assert.equal(balance.allocated, 12, 'a retried accrual must not double-allocate');
  });

  it('carries forward up to the cap and expires the rest', async () => {
    // 12 allocated, 2 consumed, so 10 remain against a cap of 5.
    await tenant.as((tx) =>
      leave.adjust(tx, {
        employeeId,
        leaveTypeId,
        quantity: -2,
        effectiveDate: '2026-06-01',
        reason: 'Leave taken',
      }),
    );

    const result = await tenant.as((tx) =>
      periodJobs.runCarryForward(tx, {
        fromPeriodStart: '2026-01-01',
        fromPeriodEnd: '2026-12-31',
        toPeriodStart: '2027-01-01',
        toPeriodEnd: '2027-12-31',
      }),
    );
    assert.equal(result.alreadyRun, false);

    const balance = await tenant.as((tx) => leave.getBalance(tx, employeeId, leaveTypeId, '2027-12-31'));
    assert.equal(balance.carriedForward, 5, 'capped at the policy maximum');
    assert.equal(balance.expired, 5, 'the excess expires rather than rolling on');
    // 12 allocated - 2 adjusted - 5 expired + 5 carried = 10
    assert.equal(balance.balance, 10);
  });

  it('records both movements in the ledger rather than editing a balance', async () => {
    const entries = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ entry_type: string; quantity: string }>(
        `SELECT entry_type, quantity FROM leave_mgmt.leave_ledger_entry
          WHERE employee_id = $1 AND source_type = 'carry_forward_job'
          ORDER BY entry_type`,
        [employeeId],
      );
      return rows;
    });

    assert.deepEqual(
      entries.map((e) => e.entry_type),
      ['carry_forward', 'expiry'],
      'carrying without expiring the excess would inflate entitlement year on year',
    );
  });

  it('does not carry forward twice', async () => {
    const rerun = await tenant.as((tx) =>
      periodJobs.runCarryForward(tx, {
        fromPeriodStart: '2026-01-01',
        fromPeriodEnd: '2026-12-31',
        toPeriodStart: '2027-01-01',
        toPeriodEnd: '2027-12-31',
      }),
    );
    assert.equal(rerun.alreadyRun, true);

    const balance = await tenant.as((tx) => leave.getBalance(tx, employeeId, leaveTypeId, '2027-12-31'));
    assert.equal(balance.balance, 10);
  });

  it('encashes leave, deducts the balance and creates the compensation that pays it', async () => {
    const before = await tenant.as((tx) => leave.getBalance(tx, employeeId, leaveTypeId, '2027-12-31'));

    // What one encashed day is worth, and the earning it posts against. Without both, the
    // request is refused rather than debiting a balance nobody gets paid for.
    await tenant.as(async (tx) => {
      const structure = await tx.query<{ id: string }>(
        `INSERT INTO compensation.salary_structure (tenant_id, name, version, effective_from)
         VALUES ($1, 'Encashment Std', 1, '2026-01-01')
         ON CONFLICT (tenant_id, name, version) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [tenant.tenantId],
      );
      await tx.query(
        `INSERT INTO compensation.salary_assignment
           (tenant_id, employee_id, salary_structure_id, annual_ctc, base_amount, effective_from,
            leave_encashment_amount_per_day)
         VALUES ($1, $2, $3, 600000, 50000, '2026-01-01', 1500)`,
        [tenant.tenantId, employeeId, structure.rows[0]!.id],
      );
      await tx.query(
        `INSERT INTO compensation.salary_component
           (tenant_id, code, name, component_type, calculation_type, affects_lop)
         VALUES ($1, 'LEAVE_ENCASHMENT', 'Leave Encashment', 'earning', 'fixed', false)
         ON CONFLICT (tenant_id, code) DO NOTHING`,
        [tenant.tenantId],
      );
    });

    const result = await tenant.as((tx) =>
      periodJobs.requestEncashment(tx, {
        employeeId,
        leaveTypeId,
        quantity: 3,
        periodStart: '2027-01-01',
        periodEnd: '2027-12-31',
      }),
    );

    const after = await tenant.as((tx) => leave.getBalance(tx, employeeId, leaveTypeId, '2027-12-31'));
    assert.equal(after.encashed, 3);
    assert.equal(after.balance, before.balance - 3, 'the days cannot also be taken as leave');

    // The half that used to be missing entirely: the employee is actually owed the money.
    assert.equal(result.amount, 4500);
    const paid = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ amount: string; source_id: string }>(
        `SELECT amount, source_id FROM compensation.additional_salary
          WHERE source_type = 'leave_encashment' AND source_id = $1`,
        [result.id],
      );
      return rows[0];
    });
    assert.ok(paid, 'encashment must create the compensation that pays it');
    assert.equal(Number(paid!.amount), 4500);
  });

  it('refuses to encash more than the balance', async () => {
    await assert.rejects(
      tenant.as((tx) =>
        periodJobs.requestEncashment(tx, {
          employeeId,
          leaveTypeId,
          quantity: 999,
          periodStart: '2027-01-01',
          periodEnd: '2027-12-31',
        }),
      ),
      /Not enough balance/,
    );
  });

  it('refuses to encash a leave type that does not allow it', async () => {
    const sickId = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO leave_mgmt.leave_type (tenant_id, name, code, encashment_enabled)
         VALUES ($1, 'Sick Leave', 'SL', false) RETURNING id`,
        [tenant.tenantId],
      );
      return rows[0]!.id;
    });

    await assert.rejects(
      tenant.as((tx) =>
        periodJobs.requestEncashment(tx, {
          employeeId,
          leaveTypeId: sickId,
          quantity: 1,
          periodStart: '2027-01-01',
          periodEnd: '2027-12-31',
        }),
      ),
      /cannot be encashed/,
    );
  });
});

describe('payroll payment', skipWithoutDb, () => {
  let tenant: TestTenant;
  let paidEmployeeId: string;
  let noBankEmployeeId: string;
  let runId: string;
  let batchId: string;

  before(async () => {
    tenant = await createTestTenant('payment');
    paidEmployeeId = await createEmployee(tenant, { code: 'PAY001', joiningDate: '2025-01-01' });
    noBankEmployeeId = await createEmployee(tenant, { code: 'PAY002', joiningDate: '2025-01-01' });

    await tenant.as((tx) =>
      coreHr.setBankAccount(tx, {
        employeeId: paidEmployeeId,
        accountHolder: 'Paid Employee',
        accountNumber: '123456789012',
        bankName: 'HDFC Bank',
        ifsc: 'HDFC0001234',
        effectiveFrom: '2025-01-01',
      }),
    );

    // Stand in for a finalized run: the engine's output, already approved and finalized.
    await tenant.as(async (tx) => {
      const period = await createPeriod(tx, {
        companyId: tenant.companyId,
        name: 'Aug 2026',
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        payDate: '2026-09-01',
      });
      const run = await tx.query<{ id: string }>(
        `INSERT INTO payroll.payroll_run
           (tenant_id, payroll_period_id, company_id, status, calculation_version,
            run_sequence, finalized_at)
         VALUES ($1, $2, $3, 'finalized', 'test', 1, now()) RETURNING id`,
        [tenant.tenantId, period.id, tenant.companyId],
      );
      runId = run.rows[0]!.id;

      for (const [employeeId, net, code] of [
        [paidEmployeeId, 50000, 'PAY001'],
        [noBankEmployeeId, 40000, 'PAY002'],
      ] as const) {
        const pe = await tx.query<{ id: string }>(
          `INSERT INTO payroll.payroll_employee (tenant_id, payroll_run_id, employee_id, status, net_amount)
           VALUES ($1, $2, $3, 'calculated', $4) RETURNING id`,
          [tenant.tenantId, runId, employeeId, net],
        );
        const snapshot = await tx.query<{ id: string }>(
          `INSERT INTO payroll.payroll_input_snapshot
             (tenant_id, payroll_run_id, employee_id, employee_json, attendance_json, leave_json,
              compensation_json, tax_json, statutory_json)
           VALUES ($1,$2,$3,'{}','{}','{}','{}','{}','{}') RETURNING id`,
          [tenant.tenantId, runId, employeeId],
        );
        await tx.query(
          `INSERT INTO payroll.salary_slip
             (tenant_id, payroll_run_id, payroll_employee_id, employee_id, slip_number,
              period_start, period_end, total_days, payable_days, net_amount,
              calculation_version, snapshot_id, status, finalized_at)
           VALUES ($1,$2,$3,$4,$5,'2026-08-01','2026-08-31',31,31,$6,'test',$7,'finalized',now())`,
          [tenant.tenantId, runId, pe.rows[0]!.id, employeeId, `2026-08-${code}`, net, snapshot.rows[0]!.id],
        );
      }
    });
  });

  after(async () => {
    await dropTestTenant(tenant.tenantId);
    await closePools();
  });

  it('builds a batch and reports who was excluded', async () => {
    const batch = await tenant.as((tx) =>
      payment.createBatch(tx, { payrollRunId: runId, valueDate: '2026-09-01' }),
    );
    batchId = batch.id;

    assert.match(batch.batchNumber, /^PAY-202609-\d{3}$/);
    assert.equal(batch.employeeCount, 1);
    assert.equal(batch.totalAmount, 50000);
    assert.deepEqual(batch.excluded, [
      { employee_code: 'PAY002', reason: 'no bank account on record for this period' },
    ]);
  });

  it('moves the run to payment pending, not paid', async () => {
    const status = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ status: string }>(
        'SELECT status FROM payroll.payroll_run WHERE id = $1',
        [runId],
      );
      return rows[0]!.status;
    });
    assert.equal(status, 'payment_pending', 'money has not moved yet');
  });

  it('refuses a second live batch for the same run', async () => {
    await assert.rejects(
      tenant.as((tx) => payment.createBatch(tx, { payrollRunId: runId, valueDate: '2026-09-02' })),
      /already covers this run/,
    );
  });

  it('refuses to pay a run that is not finalized', async () => {
    const draftRunId = await tenant.as(async (tx) => {
      const period = await createPeriod(tx, {
        companyId: tenant.companyId,
        name: 'Sep 2026',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        payDate: '2026-10-01',
      });
      const run = await tx.query<{ id: string }>(
        `INSERT INTO payroll.payroll_run
           (tenant_id, payroll_period_id, company_id, status, calculation_version, run_sequence)
         VALUES ($1, $2, $3, 'calculated', 'test', 1) RETURNING id`,
        [tenant.tenantId, period.id, tenant.companyId],
      );
      return run.rows[0]!.id;
    });

    await assert.rejects(
      tenant.as((tx) => payment.createBatch(tx, { payrollRunId: draftRunId, valueDate: '2026-10-01' })),
      /cannot be paid/,
    );
  });

  it('generates a bank file containing the real account number', async () => {
    const file = await tenant.as((tx) => payment.renderBatchFile(tx, batchId));

    assert.match(file.filename, /^PAY-202609-\d{3}\.csv$/);
    const lines = file.content.split('\n');
    assert.equal(lines.length, 2, 'one header and one payable employee');
    assert.match(lines[0]!, /^employee_code,/);
    assert.ok(lines[1]!.includes('123456789012'), 'the bank needs the full account number');
    assert.ok(lines[1]!.includes('HDFC0001234'));
    assert.ok(lines[1]!.includes('50000.00'));
  });

  it('keeps only the last four digits on the batch itself', async () => {
    const stored = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ account_number_last4: string }>(
        'SELECT account_number_last4 FROM payroll.payment_line WHERE payment_batch_id = $1',
        [batchId],
      );
      return rows[0]!.account_number_last4;
    });
    assert.equal(stored, '9012', 'the full number lives only in the encrypted bank account row');
  });

  it('marks the run paid when the whole batch settles', async () => {
    const result = await tenant.as((tx) =>
      payment.recordSettlement(tx, batchId, { reference: 'UTR20260901001' }),
    );
    assert.equal(result.settled, 1);
    assert.equal(result.returned, 0);
    assert.equal(result.runPaid, true);

    const status = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ status: string }>(
        'SELECT status FROM payroll.payroll_run WHERE id = $1',
        [runId],
      );
      return rows[0]!.status;
    });
    assert.equal(status, 'paid');
  });

  it('refuses to settle the same batch twice', async () => {
    await assert.rejects(
      tenant.as((tx) => payment.recordSettlement(tx, batchId, { reference: 'UTR-DUPLICATE' })),
      /already been settled/,
    );
  });

  it('does not mark a run paid when the bank returns a payment', async () => {
    const { returnRunId, returnBatchId } = await tenant.as(async (tx) => {
      const period = await createPeriod(tx, {
        companyId: tenant.companyId,
        name: 'Oct 2026',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        payDate: '2026-11-01',
      });
      const run = await tx.query<{ id: string }>(
        `INSERT INTO payroll.payroll_run
           (tenant_id, payroll_period_id, company_id, status, calculation_version,
            run_sequence, finalized_at)
         VALUES ($1, $2, $3, 'finalized', 'test', 1, now()) RETURNING id`,
        [tenant.tenantId, period.id, tenant.companyId],
      );
      const pe = await tx.query<{ id: string }>(
        `INSERT INTO payroll.payroll_employee (tenant_id, payroll_run_id, employee_id, status, net_amount)
         VALUES ($1, $2, $3, 'calculated', 30000) RETURNING id`,
        [tenant.tenantId, run.rows[0]!.id, paidEmployeeId],
      );
      const snapshot = await tx.query<{ id: string }>(
        `INSERT INTO payroll.payroll_input_snapshot
           (tenant_id, payroll_run_id, employee_id, employee_json, attendance_json, leave_json,
            compensation_json, tax_json, statutory_json)
         VALUES ($1,$2,$3,'{}','{}','{}','{}','{}','{}') RETURNING id`,
        [tenant.tenantId, run.rows[0]!.id, paidEmployeeId],
      );
      await tx.query(
        `INSERT INTO payroll.salary_slip
           (tenant_id, payroll_run_id, payroll_employee_id, employee_id, slip_number,
            period_start, period_end, total_days, payable_days, net_amount,
            calculation_version, snapshot_id, status, finalized_at)
         VALUES ($1,$2,$3,$4,'2026-10-PAY001','2026-10-01','2026-10-31',31,31,30000,'test',$5,'finalized',now())`,
        [tenant.tenantId, run.rows[0]!.id, pe.rows[0]!.id, paidEmployeeId, snapshot.rows[0]!.id],
      );
      return { returnRunId: run.rows[0]!.id, returnBatchId: null as string | null };
    });

    const batch = await tenant.as((tx) =>
      payment.createBatch(tx, { payrollRunId: returnRunId, valueDate: '2026-11-01' }),
    );

    const result = await tenant.as((tx) =>
      payment.recordSettlement(tx, batch.id, {
        reference: 'UTR20261101001',
        returned: [{ employeeCode: 'PAY001', reason: 'account closed' }],
      }),
    );

    assert.equal(result.returned, 1);
    assert.equal(result.runPaid, false, 'someone is still owed money');

    const status = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ status: string }>(
        'SELECT status FROM payroll.payroll_run WHERE id = $1',
        [returnRunId],
      );
      return rows[0]!.status;
    });
    assert.equal(status, 'payment_pending');
    void returnBatchId;
  });
});
