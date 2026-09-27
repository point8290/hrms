import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/infra/db/pool.ts';
import * as compensation from '../../src/modules/compensation/service.ts';
import * as leave from '../../src/modules/leave/service.ts';
import * as payroll from '../../src/modules/payroll/service.ts';
import * as workforce from '../../src/modules/workforce/service.ts';
import {
  createEmployee,
  createLeaveType,
  createTestTenant,
  dropTestTenant,
  skipWithoutDb,
  type TestTenant,
} from './helpers.ts';

/**
 * The critical end-to-end journey from PRD s.30:
 *
 *   Create Tenant -> Organization -> Employee -> Assign Shift -> Check In ->
 *   Apply Leave -> Assign Salary -> Run Payroll -> Snapshot -> Finalize
 *
 * Attendance and payroll *calculation* belong to the Python engines and are covered by
 * their own test suites; this asserts the orchestration, persistence and invariants that
 * Node owns.
 */
describe('MVP journey', skipWithoutDb, () => {
  let tenant: TestTenant;
  let employeeId: string;
  let managerId: string;
  let leaveTypeId: string;
  let shiftTypeId: string;
  let structureId: string;
  let periodId: string;

  before(async () => {
    tenant = await createTestTenant('mvp');
    managerId = await createEmployee(tenant, { code: 'MGR001' });
    employeeId = await createEmployee(tenant, { code: 'EMP001', managerId });
    leaveTypeId = await createLeaveType(tenant, { code: 'EL', requiresApproval: false });
  });

  after(async () => {
    await dropTestTenant(tenant.tenantId);
    await closePools();
  });

  it('records an employee with an opening employment history row', async () => {
    const history = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ change_reason: string; effective_to: string | null }>(
        `SELECT change_reason, to_char(effective_to, 'YYYY-MM-DD') AS effective_to
           FROM core.employment_history WHERE employee_id = $1`,
        [employeeId],
      );
      return rows;
    });
    assert.equal(history.length, 1);
    assert.equal(history[0]!.change_reason, 'joining');
    assert.equal(history[0]!.effective_to, null, 'the opening record must stay open');
  });

  it('assigns a shift', async () => {
    await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO workforce.shift_type
           (tenant_id, name, code, start_time, end_time, break_minutes, grace_in_minutes,
            full_day_threshold_minutes, half_day_threshold_minutes)
         VALUES ($1, 'General', 'GEN', '09:00', '18:00', 60, 10, 480, 240)
         RETURNING id`,
        [tenant.tenantId],
      );
      shiftTypeId = rows[0]!.id;

      await workforce.assignShift(tx, {
        employeeId,
        shiftTypeId,
        holidayListId: tenant.holidayListId,
        effectiveFrom: '2026-01-01',
      });
    });

    const count = await tenant.as(async (tx) => {
      const { rowCount } = await tx.query(
        `SELECT 1 FROM workforce.shift_assignment WHERE employee_id = $1 AND status = 'active'`,
        [employeeId],
      );
      return rowCount;
    });
    assert.equal(count, 1);
  });

  it('refuses an overlapping shift assignment', async () => {
    await assert.rejects(
      tenant.as((tx) =>
        workforce.assignShift(tx, { employeeId, shiftTypeId, effectiveFrom: '2026-06-01' }),
      ),
      /already has an active shift assignment/,
    );
  });

  it('records an immutable check-in and emits CheckinRecorded', async () => {
    const result = await tenant.as((tx) =>
      workforce.recordCheckin(tx, {
        employeeId,
        checkinAt: '2026-03-10T03:30:00Z', // 09:00 IST
        direction: 'in',
        source: 'web',
      }),
    );
    assert.equal(result.duplicate, false);
    assert.equal(result.attendanceDate, '2026-03-10', 'attendance date must use the employee timezone');

    const events = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ event_type: string }>(
        `SELECT event_type FROM integration.event_outbox WHERE aggregate_id = $1`,
        [result.id],
      );
      return rows.map((r) => r.event_type);
    });
    assert.deepEqual(events, ['CheckinRecorded']);
  });

  it('treats a redelivered device event as a duplicate, not a second observation', async () => {
    const first = await tenant.as((tx) =>
      workforce.recordCheckin(tx, {
        employeeId,
        checkinAt: '2026-03-10T12:30:00Z',
        direction: 'out',
        source: 'biometric',
        externalEventId: 'device-a:998877',
      }),
    );
    const replay = await tenant.as((tx) =>
      workforce.recordCheckin(tx, {
        employeeId,
        checkinAt: '2026-03-10T12:30:00Z',
        direction: 'out',
        source: 'biometric',
        externalEventId: 'device-a:998877',
      }),
    );

    assert.equal(replay.duplicate, true);
    assert.equal(replay.id, first.id);
  });

  it('refuses to modify a raw check-in', async () => {
    await assert.rejects(
      tenant.as((tx) =>
        tx.query(`UPDATE workforce.employee_checkin SET direction = 'out' WHERE employee_id = $1`, [
          employeeId,
        ]),
      ),
      /append-only/,
      'raw observations must not be editable',
    );
  });

  it('allocates leave and derives the balance from the ledger', async () => {
    await tenant.as((tx) =>
      leave.allocate(tx, {
        employeeId,
        leaveTypeId,
        quantity: 12,
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
        source: 'policy',
      }),
    );

    const balance = await tenant.as((tx) => leave.getBalance(tx, employeeId, leaveTypeId, '2026-12-31'));
    assert.equal(balance.allocated, 12);
    assert.equal(balance.balance, 12);
  });

  it('does not grant the same allocation twice when an accrual job is replayed', async () => {
    const input = {
      employeeId,
      leaveTypeId,
      quantity: 1,
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      source: 'policy' as const,
      idempotencyKey: 'accrual:2026-01:EMP001',
    };
    await tenant.as((tx) => leave.allocate(tx, input));
    await assert.rejects(tenant.as((tx) => leave.allocate(tx, input)), /already been granted/);

    const balance = await tenant.as((tx) => leave.getBalance(tx, employeeId, leaveTypeId, '2026-12-31'));
    assert.equal(balance.balance, 13, 'a replayed accrual must not add entitlement twice');
  });

  it('consumes balance when leave is approved', async () => {
    const application = await tenant.as((tx) =>
      leave.apply(tx, {
        employeeId,
        leaveTypeId,
        startDate: '2026-03-16', // Monday
        endDate: '2026-03-18',
        startHalfDay: false,
        endHalfDay: false,
        reason: 'Family event',
      }),
    );
    assert.equal(application.status, 'approved');
    assert.equal(application.quantity, 3);

    const balance = await tenant.as((tx) => leave.getBalance(tx, employeeId, leaveTypeId, '2026-12-31'));
    assert.equal(balance.consumed, 3);
    assert.equal(balance.balance, 10);
  });

  it('rejects leave that exceeds the available balance', async () => {
    await assert.rejects(
      tenant.as((tx) =>
        leave.apply(tx, {
          employeeId,
          leaveTypeId,
          startDate: '2026-05-04',
          endDate: '2026-06-30',
          startHalfDay: false,
          endHalfDay: false,
        }),
      ),
      /Insufficient/,
    );
  });

  it('refuses overlapping leave for the same employee', async () => {
    await assert.rejects(
      tenant.as((tx) =>
        leave.apply(tx, {
          endDate: '2026-03-17',
          startDate: '2026-03-17',
          employeeId,
          leaveTypeId,
          startHalfDay: false,
          endHalfDay: false,
        }),
      ),
      /overlap|exclusion/i,
    );
  });

  it('reverses rather than deletes when approved leave is cancelled', async () => {
    const application = await tenant.as((tx) =>
      leave.apply(tx, {
        employeeId,
        leaveTypeId,
        startDate: '2026-04-06',
        endDate: '2026-04-07',
        startHalfDay: false,
        endHalfDay: false,
      }),
    );

    await tenant.as((tx) => leave.cancel(tx, application.id, 'Plans changed'));

    const entries = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ entry_type: string; quantity: string }>(
        `SELECT entry_type, quantity FROM leave_mgmt.leave_ledger_entry
          WHERE source_id = $1 ORDER BY created_at`,
        [application.id],
      );
      return rows;
    });

    assert.equal(entries.length, 2, 'the consumption must remain and be offset by a reversal');
    assert.equal(entries[0]!.entry_type, 'consumption');
    assert.equal(entries[1]!.entry_type, 'reversal');

    const balance = await tenant.as((tx) => leave.getBalance(tx, employeeId, leaveTypeId, '2026-12-31'));
    assert.equal(balance.balance, 10, 'the cancelled days return to the balance');
  });

  it('refuses to modify a ledger entry', async () => {
    await assert.rejects(
      tenant.as((tx) =>
        tx.query(`UPDATE leave_mgmt.leave_ledger_entry SET quantity = 999 WHERE employee_id = $1`, [
          employeeId,
        ]),
      ),
      /append-only/,
    );
  });

  it('assigns compensation with an effective-dated structure', async () => {
    await tenant.as(async (tx) => {
      const basic = await tx.query<{ id: string }>(
        `INSERT INTO compensation.salary_component
           (tenant_id, code, name, component_type, calculation_type, display_order)
         VALUES ($1, 'BASIC', 'Basic', 'earning', 'percentage', 1) RETURNING id`,
        [tenant.tenantId],
      );
      const hra = await tx.query<{ id: string }>(
        `INSERT INTO compensation.salary_component
           (tenant_id, code, name, component_type, calculation_type, display_order)
         VALUES ($1, 'HRA', 'House Rent Allowance', 'earning', 'percentage', 2) RETURNING id`,
        [tenant.tenantId],
      );
      const structure = await tx.query<{ id: string }>(
        `INSERT INTO compensation.salary_structure (tenant_id, name, version, effective_from)
         VALUES ($1, 'Standard', 1, '2026-01-01') RETURNING id`,
        [tenant.tenantId],
      );
      structureId = structure.rows[0]!.id;

      await tx.query(
        `INSERT INTO compensation.salary_structure_component
           (tenant_id, salary_structure_id, salary_component_id, sequence_no, percentage, percentage_of_code)
         VALUES ($1, $2, $3, 1, 50, 'BASE'), ($1, $2, $4, 2, 40, 'BASIC')`,
        [tenant.tenantId, structureId, basic.rows[0]!.id, hra.rows[0]!.id],
      );

      await compensation.assign(tx, {
        employeeId,
        salaryStructureId: structureId,
        annualCtc: 1_200_000,
        baseAmount: 100_000,
        effectiveFrom: '2026-01-01',
      });
    });

    const resolved = await tenant.as((tx) => compensation.resolveAsOf(tx, employeeId, '2026-03-31'));
    assert.ok(resolved);
    assert.equal(resolved!.components.length, 2);
  });

  it('keeps history intact when compensation is revised', async () => {
    await tenant.as((tx) =>
      compensation.assign(tx, {
        employeeId,
        salaryStructureId: structureId,
        annualCtc: 1_500_000,
        baseAmount: 125_000,
        effectiveFrom: '2026-07-01',
        reason: 'Annual revision',
      }),
    );

    const march = await tenant.as((tx) => compensation.resolveAsOf(tx, employeeId, '2026-03-31'));
    const august = await tenant.as((tx) => compensation.resolveAsOf(tx, employeeId, '2026-08-31'));

    assert.equal(march!.base_amount, '100000.00', 'a July raise must not change March pay');
    assert.equal(august!.base_amount, '125000.00');
  });

  /**
   * Marks a date range as closed.
   *
   * Stands in for the scheduled daily close, which runs in the workforce engine. Payroll
   * refuses to build a snapshot over days that were never evaluated (ADR-007), so this is
   * now a required step in the journey rather than an optional one.
   */
  async function closeAttendance(from: string, to: string): Promise<void> {
    await tenant.as((tx) =>
      tx.query(
        `INSERT INTO integration.scheduled_job
           (tenant_id, job_type, execution_date, status, completed_at, payload, result)
         SELECT $1, 'attendance.close', d::date, 'completed', now(),
                '{"timezone": "Asia/Kolkata"}'::jsonb, '{"employee_count": 1}'::jsonb
           FROM generate_series($2::date, $3::date, INTERVAL '1 day') AS d
         ON CONFLICT (tenant_id, job_type, execution_date, job_key)
         DO UPDATE SET status = 'completed', completed_at = now()`,
        [tenant.tenantId, from, to],
      ),
    );
  }

  it('refuses payroll until attendance has been closed for the period', async () => {
    await tenant.as(async (tx) => {
      const period = await payroll.createPeriod(tx, {
        companyId: tenant.companyId,
        name: 'March 2026',
        periodStart: '2026-03-01',
        periodEnd: '2026-03-31',
        payDate: '2026-04-01',
      });
      periodId = period.id;
    });

    await assert.rejects(
      tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: periodId, employeeIds: [employeeId] })),
      /Attendance has not been closed/,
      'paying on unevaluated attendance would under-report LOP',
    );
  });

  it('creates a payroll run that freezes its inputs', async () => {
    await closeAttendance('2026-03-01', '2026-03-31');

    const run = await tenant.as((tx) =>
      payroll.createRun(tx, { payrollPeriodId: periodId, employeeIds: [employeeId] }),
    );
    assert.equal(run.attendanceCoverage.complete, true);

    assert.equal(run.status, 'calculating');
    assert.equal(run.employeeCount, 1);

    const snapshot = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ compensation_json: Record<string, unknown>; attendance_json: Record<string, unknown> }>(
        `SELECT compensation_json, attendance_json FROM payroll.payroll_input_snapshot
          WHERE payroll_run_id = $1`,
        [run.id],
      );
      return rows[0]!;
    });

    assert.equal(
      (snapshot.compensation_json as { base_amount: string }).base_amount,
      '100000.00',
      'the snapshot must carry the salary effective during the period',
    );
    assert.equal((snapshot.attendance_json as { total_days: number }).total_days, 31);
  });

  it('skips an employee with no salary and says why', async () => {
    const unpaid = await createEmployee(tenant, { code: 'NOPAY001' });
    await closeAttendance('2026-04-01', '2026-04-30');

    const run = await tenant.as(async (tx) => {
      const period = await payroll.createPeriod(tx, {
        companyId: tenant.companyId,
        name: 'April 2026',
        periodStart: '2026-04-01',
        periodEnd: '2026-04-30',
        payDate: '2026-05-01',
      });
      return payroll.createRun(tx, {
        payrollPeriodId: period.id,
        employeeIds: [employeeId, unpaid],
      });
    });

    assert.equal(run.employeeCount, 1);
    assert.equal(run.skipped.length, 1);
    assert.match(run.skipped[0]!.reason, /no salary assignment/);
  });

  it('refuses a second regular run for the same period', async () => {
    await assert.rejects(
      tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: periodId })),
      /already exists for this period/,
    );
  });

  it('refuses an illegal state transition', async () => {
    const runId = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM payroll.payroll_run WHERE payroll_period_id = $1`,
        [periodId],
      );
      return rows[0]!.id;
    });

    // calculating -> finalized skips review and approval entirely.
    await assert.rejects(
      tenant.as((tx) => payroll.finalize(tx, runId)),
      /cannot move from calculating to finalized/,
    );
  });

  it('makes a finalized payslip immutable', async () => {
    const { runId, slipId } = await tenant.as(async (tx) => {
      const run = await tx.query<{ id: string }>(
        `SELECT id FROM payroll.payroll_run WHERE payroll_period_id = $1`,
        [periodId],
      );
      const id = run.rows[0]!.id;

      // Stand in for the Python engine's output so the finalization path can be tested
      // without running the engine.
      const employee = await tx.query<{ id: string }>(
        `SELECT id FROM payroll.payroll_employee WHERE payroll_run_id = $1`,
        [id],
      );
      const snapshot = await tx.query<{ id: string }>(
        `SELECT id FROM payroll.payroll_input_snapshot WHERE payroll_run_id = $1`,
        [id],
      );
      const slip = await tx.query<{ id: string }>(
        `INSERT INTO payroll.salary_slip
           (tenant_id, payroll_run_id, payroll_employee_id, employee_id, slip_number,
            period_start, period_end, total_days, payable_days, lop_days,
            gross_amount, deduction_amount, tax_amount, net_amount,
            calculation_version, snapshot_id, status)
         VALUES ($1,$2,$3,$4,'2026-03-EMP001','2026-03-01','2026-03-31',31,31,0,
                 100000,1800,0,98200,'test',$5,'draft')
         RETURNING id`,
        [tenant.tenantId, id, employee.rows[0]!.id, employeeId, snapshot.rows[0]!.id],
      );
      await tx.query(
        `UPDATE payroll.payroll_employee SET status = 'calculated', gross_amount = 100000, net_amount = 98200
          WHERE id = $1`,
        [employee.rows[0]!.id],
      );
      await tx.query(`UPDATE payroll.payroll_run SET status = 'calculated' WHERE id = $1`, [id]);
      return { runId: id, slipId: slip.rows[0]!.id };
    });

    await tenant.as((tx) => payroll.submitForReview(tx, runId));
    await tenant.as((tx) => payroll.approve(tx, runId));
    const result = await tenant.as((tx) => payroll.finalize(tx, runId));
    assert.equal(result.slipCount, 1);

    await assert.rejects(
      tenant.as((tx) =>
        tx.query(`UPDATE payroll.salary_slip SET net_amount = 1 WHERE id = $1`, [slipId]),
      ),
      /immutable/,
      'a finalized payslip must not be editable',
    );

    await assert.rejects(
      tenant.as((tx) => tx.query(`DELETE FROM payroll.salary_slip WHERE id = $1`, [slipId])),
      /cannot be deleted/,
    );
  });

  it('refuses to recalculate a finalized run', async () => {
    const runId = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM payroll.payroll_run WHERE payroll_period_id = $1`,
        [periodId],
      );
      return rows[0]!.id;
    });
    await assert.rejects(
      tenant.as((tx) => payroll.recalculate(tx, runId)),
      /finalized payroll run cannot be recalculated/,
    );
  });

  it('locks the payroll period on finalization', async () => {
    const status = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ status: string }>(
        `SELECT status FROM payroll.payroll_period WHERE id = $1`,
        [periodId],
      );
      return rows[0]!.status;
    });
    assert.equal(status, 'locked');
  });

  it('audits every sensitive action along the way', async () => {
    const actions = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ action: string }>(
        `SELECT DISTINCT action FROM audit.audit_log WHERE is_sensitive ORDER BY action`,
      );
      return rows.map((r) => r.action);
    });
    assert.ok(actions.includes('compensation.assigned'));
    assert.ok(actions.includes('compensation.revised'));
    assert.ok(actions.includes('payroll.run.approved'));
    assert.ok(actions.includes('payroll.run.finalized'));
  });
});
