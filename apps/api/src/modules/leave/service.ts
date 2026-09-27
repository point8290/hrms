import type { TenantTx } from '../../infra/db/pool.ts';
import { audit } from '../../infra/audit.ts';
import { emitEvent } from '../../infra/events/outbox.ts';
import { conflict, notFound, unprocessable } from '../../infra/errors.ts';
import * as workflow from '../workflow/service.ts';
import {
  checkSufficientBalance,
  computeLeaveBreakdown,
  deriveBalance,
  parseDateKey,
  proRateAllocation,
  round2,
  type LeaveBalance,
} from './leave-math.ts';

export type LeaveTypeRow = {
  id: string;
  code: string;
  name: string;
  is_paid: boolean;
  allow_half_day: boolean;
  allow_negative_balance: boolean;
  max_negative_balance: string;
  include_holidays: boolean;
  requires_approval: boolean;
  is_lop: boolean;
  max_consecutive_days: number | null;
  carry_forward_enabled: boolean;
  max_carry_forward: string | null;
  status: string;
};

async function loadLeaveType(tx: TenantTx, leaveTypeId: string): Promise<LeaveTypeRow> {
  const { rows } = await tx.query<LeaveTypeRow>(
    `SELECT id, code, name, is_paid, allow_half_day, allow_negative_balance, max_negative_balance,
            include_holidays, requires_approval, is_lop, max_consecutive_days,
            carry_forward_enabled, max_carry_forward, status
       FROM leave_mgmt.leave_type
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, leaveTypeId],
  );
  const row = rows[0];
  if (!row) throw notFound('Leave type');
  if (row.status !== 'active') {
    throw unprocessable('leave_type_inactive', `Leave type ${row.code} is not active`);
  }
  return row;
}

/**
 * Resolves the holiday calendar and weekly offs that apply to one employee.
 *
 * Preference order: the calendar attached to the employee's shift assignment, then the
 * tenant default. Weekly offs live on the holiday list rather than being hard-coded,
 * because a six-day working week is common in India and must not require a code change.
 */
export async function resolveCalendar(
  tx: TenantTx,
  employeeId: string,
  from: string,
  to: string,
): Promise<{ holidays: Set<string>; weeklyOffs: Set<number>; holidayListId: string | null }> {
  const { rows } = await tx.query<{ id: string; weekly_offs: number[] }>(
    `SELECT hl.id, hl.weekly_offs
       FROM workforce.shift_assignment sa
       JOIN workforce.holiday_list hl ON hl.id = sa.holiday_list_id
      WHERE sa.tenant_id = $1
        AND sa.employee_id = $2
        AND sa.status = 'active'
        AND sa.effective_from <= $4::date
        AND (sa.effective_to IS NULL OR sa.effective_to >= $3::date)
      ORDER BY sa.effective_from DESC
      LIMIT 1`,
    [tx.tenantId, employeeId, from, to],
  );

  let list = rows[0];
  if (!list) {
    const fallback = await tx.query<{ id: string; weekly_offs: number[] }>(
      `SELECT id, weekly_offs
         FROM workforce.holiday_list
        WHERE tenant_id = $1 AND is_default
        ORDER BY year DESC
        LIMIT 1`,
      [tx.tenantId],
    );
    list = fallback.rows[0];
  }

  if (!list) {
    // No calendar configured: treat every day as working rather than guessing a weekend,
    // and let the tenant notice the missing configuration explicitly.
    return { holidays: new Set(), weeklyOffs: new Set(), holidayListId: null };
  }

  const holidays = await tx.query<{ holiday_date: string }>(
    `SELECT to_char(holiday_date, 'YYYY-MM-DD') AS holiday_date
       FROM workforce.holiday
      WHERE tenant_id = $1 AND holiday_list_id = $2
        AND holiday_date BETWEEN $3::date AND $4::date
        AND NOT is_optional`,
    [tx.tenantId, list.id, from, to],
  );

  return {
    holidays: new Set(holidays.rows.map((r) => r.holiday_date)),
    weeklyOffs: new Set(list.weekly_offs ?? []),
    holidayListId: list.id,
  };
}

export async function getBalance(
  tx: TenantTx,
  employeeId: string,
  leaveTypeId: string,
  asOf: string,
): Promise<LeaveBalance> {
  const { rows } = await tx.query<{ entry_type: string; quantity: string }>(
    `SELECT entry_type, quantity
       FROM leave_mgmt.leave_ledger_entry
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
        AND effective_date <= $4::date`,
    [tx.tenantId, employeeId, leaveTypeId, asOf],
  );
  return deriveBalance(
    rows.map((r) => ({ entryType: r.entry_type as never, quantity: Number(r.quantity) })),
  );
}

export async function getBalanceSummary(
  tx: TenantTx,
  employeeId: string,
  asOf: string,
): Promise<Array<{ leave_type_id: string; code: string; name: string } & LeaveBalance>> {
  const { rows } = await tx.query<{
    leave_type_id: string;
    code: string;
    name: string;
    entry_type: string;
    quantity: string;
  }>(
    `SELECT lt.id AS leave_type_id, lt.code, lt.name, l.entry_type, l.quantity
       FROM leave_mgmt.leave_type lt
       LEFT JOIN leave_mgmt.leave_ledger_entry l
              ON l.tenant_id = lt.tenant_id
             AND l.leave_type_id = lt.id
             AND l.employee_id = $2
             AND l.effective_date <= $3::date
      WHERE lt.tenant_id = $1 AND lt.status = 'active'`,
    [tx.tenantId, employeeId, asOf],
  );

  const grouped = new Map<string, { code: string; name: string; entries: Array<{ entryType: never; quantity: number }> }>();
  for (const row of rows) {
    const bucket = grouped.get(row.leave_type_id) ?? { code: row.code, name: row.name, entries: [] };
    if (row.entry_type) {
      bucket.entries.push({ entryType: row.entry_type as never, quantity: Number(row.quantity) });
    }
    grouped.set(row.leave_type_id, bucket);
  }

  return [...grouped.entries()].map(([leave_type_id, bucket]) => ({
    leave_type_id,
    code: bucket.code,
    name: bucket.name,
    ...deriveBalance(bucket.entries),
  }));
}

export type AllocateInput = {
  employeeId: string;
  leaveTypeId: string;
  periodStart: string;
  periodEnd: string;
  quantity?: number;
  /** When set, the annual figure is pro-rated from the employee's joining date. */
  proRateFromJoining?: boolean;
  source?: 'policy' | 'manual' | 'carry_forward' | 'comp_off' | 'pro_rata';
  idempotencyKey?: string;
  notes?: string;
};

/**
 * Grants entitlement. Writes the allocation record and its ledger entry in one
 * transaction — an allocation that never reached the ledger would be invisible to every
 * balance calculation.
 */
export async function allocate(tx: TenantTx, input: AllocateInput): Promise<{ allocationId: string; quantity: number }> {
  const leaveType = await loadLeaveType(tx, input.leaveTypeId);

  let quantity = input.quantity ?? 0;
  if (input.proRateFromJoining) {
    const { rows } = await tx.query<{ joining_date: string; exit_date: string | null }>(
      `SELECT to_char(joining_date, 'YYYY-MM-DD') AS joining_date,
              to_char(exit_date, 'YYYY-MM-DD') AS exit_date
         FROM core.employee WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, input.employeeId],
    );
    const employee = rows[0];
    if (!employee) throw notFound('Employee');
    quantity = proRateAllocation(
      input.quantity ?? 0,
      input.periodStart,
      input.periodEnd,
      employee.joining_date,
      employee.exit_date ?? undefined,
    );
  }

  if (quantity <= 0) {
    throw unprocessable('allocation_not_positive', 'Allocation quantity must be greater than zero');
  }

  const source = input.source ?? 'policy';
  const allocation = await tx.query<{ id: string }>(
    `INSERT INTO leave_mgmt.leave_allocation
       (tenant_id, employee_id, leave_type_id, quantity, period_start, period_end, source, idempotency_key, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      tx.tenantId,
      input.employeeId,
      input.leaveTypeId,
      quantity,
      input.periodStart,
      input.periodEnd,
      source,
      input.idempotencyKey ?? null,
      input.notes ?? null,
      tx.actor.userId,
    ],
  );

  // A repeated accrual run hits the idempotency key and must not post a second ledger entry.
  const allocationId = allocation.rows[0]?.id;
  if (!allocationId) {
    throw conflict('allocation_already_exists', 'This allocation has already been granted');
  }

  await tx.query(
    `INSERT INTO leave_mgmt.leave_ledger_entry
       (tenant_id, employee_id, leave_type_id, entry_type, quantity, effective_date,
        period_start, period_end, source_type, source_id, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 'leave_allocation', $8, $9, $10)`,
    [
      tx.tenantId,
      input.employeeId,
      input.leaveTypeId,
      source === 'carry_forward' ? 'carry_forward' : 'allocation',
      quantity,
      input.periodStart,
      input.periodEnd,
      allocationId,
      input.notes ?? null,
      tx.actor.userId,
    ],
  );

  await audit(tx, {
    entityType: 'leave_allocation',
    entityId: allocationId,
    action: 'leave.allocated',
    after: { employee_id: input.employeeId, leave_type: leaveType.code, quantity },
  });

  return { allocationId, quantity };
}

export type ApplyInput = {
  employeeId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  startHalfDay: boolean;
  endHalfDay: boolean;
  reason?: string;
};

export type ApplyResult = {
  id: string;
  status: string;
  quantity: number;
  workflowInstanceId: string | null;
  excludedDays: number;
};

/**
 * Submits a leave application.
 *
 * Validation, balance check, persistence, workflow start and the outbox event all happen
 * in the caller's single transaction. Auto-approval (no configured workflow, or a type
 * that needs none) posts the ledger entry immediately, because an approved application
 * without a ledger entry would misreport the balance.
 */
export async function apply(tx: TenantTx, input: ApplyInput): Promise<ApplyResult> {
  const leaveType = await loadLeaveType(tx, input.leaveTypeId);

  const employee = await tx.query<{ joining_date: string; exit_date: string | null; employment_status: string }>(
    `SELECT to_char(joining_date, 'YYYY-MM-DD') AS joining_date,
            to_char(exit_date, 'YYYY-MM-DD') AS exit_date,
            employment_status
       FROM core.employee WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, input.employeeId],
  );
  const emp = employee.rows[0];
  if (!emp) throw notFound('Employee');
  if (emp.employment_status === 'separated') {
    throw unprocessable('employee_separated', 'A separated employee cannot apply for leave');
  }
  if (parseDateKey(input.startDate) < parseDateKey(emp.joining_date)) {
    throw unprocessable('before_joining', 'Leave cannot start before the joining date');
  }
  if (emp.exit_date && parseDateKey(input.endDate) > parseDateKey(emp.exit_date)) {
    throw unprocessable('after_exit', 'Leave cannot extend beyond the exit date');
  }

  const calendar = await resolveCalendar(tx, input.employeeId, input.startDate, input.endDate);
  const breakdown = computeLeaveBreakdown({
    startDate: input.startDate,
    endDate: input.endDate,
    startHalfDay: input.startHalfDay,
    endHalfDay: input.endHalfDay,
    holidays: calendar.holidays,
    weeklyOffs: calendar.weeklyOffs,
    includeHolidays: leaveType.include_holidays,
    allowHalfDay: leaveType.allow_half_day,
  });

  if (breakdown.quantity <= 0) {
    throw unprocessable(
      'no_working_days',
      'The selected range contains no working days for this employee',
      { excluded_days: breakdown.excludedDays },
    );
  }
  if (leaveType.max_consecutive_days && breakdown.countedDays > leaveType.max_consecutive_days) {
    throw unprocessable(
      'exceeds_max_consecutive',
      `${leaveType.name} allows at most ${leaveType.max_consecutive_days} consecutive days`,
    );
  }

  // LOP is recorded, never balance-checked: it has no entitlement to consume.
  if (!leaveType.is_lop) {
    // Serialise balance checks for this employee and leave type.
    //
    // Without this, two applications for non-overlapping dates submitted at the same time
    // both read the pre-consumption balance, both pass the sufficiency check, and both
    // commit - overdrawing entitlement that the ledger then faithfully records. The
    // date-overlap exclusion constraint does not help, because the dates do not overlap.
    //
    // An advisory lock rather than a row lock: it is scoped to leave for one employee, so
    // it does not serialise against unrelated HR edits. A hash collision only costs extra
    // serialisation, never correctness.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `leave:${tx.tenantId}:${input.employeeId}:${input.leaveTypeId}`,
    ]);

    const balance = await getBalance(tx, input.employeeId, input.leaveTypeId, input.endDate);
    const sufficiency = checkSufficientBalance({
      balance: balance.balance,
      requested: breakdown.quantity,
      allowNegative: leaveType.allow_negative_balance,
      maxNegative: Number(leaveType.max_negative_balance),
    });
    if (!sufficiency.ok) {
      throw unprocessable(
        'insufficient_leave_balance',
        `Insufficient ${leaveType.name} balance`,
        { available: balance.balance, requested: breakdown.quantity, shortfall: sufficiency.shortfall },
      );
    }
  }

  const autoApprove = !leaveType.requires_approval;
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO leave_mgmt.leave_application
       (tenant_id, employee_id, leave_type_id, start_date, end_date, start_half_day, end_half_day,
        quantity, reason, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      tx.tenantId,
      input.employeeId,
      input.leaveTypeId,
      input.startDate,
      input.endDate,
      input.startHalfDay,
      input.endHalfDay,
      breakdown.quantity,
      input.reason ?? null,
      autoApprove ? 'approved' : 'submitted',
      tx.actor.userId,
    ],
  );
  const applicationId = inserted.rows[0]!.id;

  let workflowInstanceId: string | null = null;
  let status = autoApprove ? 'approved' : 'submitted';

  if (!autoApprove) {
    const started = await workflow.startWorkflow(tx, 'leave_application', applicationId, input.employeeId);
    workflowInstanceId = started.instanceId;
    status = started.status === 'approved' ? 'approved' : 'pending_approval';
    await tx.query(
      'UPDATE leave_mgmt.leave_application SET status = $3, workflow_instance_id = $4 WHERE tenant_id = $1 AND id = $2',
      [tx.tenantId, applicationId, status, workflowInstanceId],
    );
  }

  if (status === 'approved') {
    await postConsumption(tx, applicationId);
  }

  await audit(tx, {
    entityType: 'leave_application',
    entityId: applicationId,
    action: 'leave.applied',
    after: {
      employee_id: input.employeeId,
      leave_type: leaveType.code,
      start_date: input.startDate,
      end_date: input.endDate,
      quantity: breakdown.quantity,
      status,
    },
  });

  await emitEvent(tx, 'LeaveApplied', {
    aggregateType: 'leave_application',
    aggregateId: applicationId,
    payload: {
      leave_application_id: applicationId,
      employee_id: input.employeeId,
      leave_type_id: input.leaveTypeId,
      start_date: input.startDate,
      end_date: input.endDate,
      quantity: String(breakdown.quantity),
      status,
    },
  });

  if (status === 'approved') {
    await emitApproved(tx, applicationId);
  }

  return {
    id: applicationId,
    status,
    quantity: breakdown.quantity,
    workflowInstanceId,
    excludedDays: breakdown.excludedDays,
  };
}

type ApplicationRow = {
  id: string;
  employee_id: string;
  leave_type_id: string;
  start_date: string;
  end_date: string;
  quantity: string;
  status: string;
  workflow_instance_id: string | null;
  is_lop: boolean;
};

async function loadApplication(tx: TenantTx, id: string, forUpdate = false): Promise<ApplicationRow> {
  const { rows } = await tx.query<ApplicationRow>(
    `SELECT la.id, la.employee_id, la.leave_type_id,
            to_char(la.start_date, 'YYYY-MM-DD') AS start_date,
            to_char(la.end_date, 'YYYY-MM-DD') AS end_date,
            la.quantity, la.status, la.workflow_instance_id, lt.is_lop
       FROM leave_mgmt.leave_application la
       JOIN leave_mgmt.leave_type lt ON lt.id = la.leave_type_id
      WHERE la.tenant_id = $1 AND la.id = $2
      ${forUpdate ? 'FOR UPDATE OF la' : ''}`,
    [tx.tenantId, id],
  );
  const row = rows[0];
  if (!row) throw notFound('Leave application');
  return row;
}

/** Writes the negative ledger entry that actually consumes the balance. */
async function postConsumption(tx: TenantTx, applicationId: string): Promise<void> {
  const app = await loadApplication(tx, applicationId);

  const existing = await tx.query<{ count: string }>(
    `SELECT count(*) AS count
       FROM leave_mgmt.leave_ledger_entry
      WHERE tenant_id = $1 AND source_type = 'leave_application' AND source_id = $2
        AND entry_type = 'consumption'`,
    [tx.tenantId, applicationId],
  );
  if (Number(existing.rows[0]?.count ?? 0) > 0) return; // idempotent: already consumed

  await tx.query(
    `INSERT INTO leave_mgmt.leave_ledger_entry
       (tenant_id, employee_id, leave_type_id, entry_type, quantity, effective_date,
        period_start, period_end, source_type, source_id, created_by)
     VALUES ($1, $2, $3, 'consumption', $4, $5::date, $5::date, $6::date, 'leave_application', $7, $8)`,
    [
      tx.tenantId,
      app.employee_id,
      app.leave_type_id,
      -Number(app.quantity),
      app.start_date,
      app.end_date,
      applicationId,
      tx.actor.userId,
    ],
  );
}

async function emitApproved(tx: TenantTx, applicationId: string): Promise<void> {
  const app = await loadApplication(tx, applicationId);
  await emitEvent(tx, 'LeaveApproved', {
    aggregateType: 'leave_application',
    aggregateId: applicationId,
    payload: {
      leave_application_id: applicationId,
      employee_id: app.employee_id,
      leave_type_id: app.leave_type_id,
      start_date: app.start_date,
      end_date: app.end_date,
      quantity: app.quantity,
    },
  });
}

/**
 * Applies a workflow decision to the leave application it belongs to.
 *
 * Called by the approvals endpoint after workflow.decide() settles the instance, so the
 * ledger entry and the status change commit together with the approval itself.
 */
export async function applyWorkflowOutcome(
  tx: TenantTx,
  applicationId: string,
  outcome: workflow.WorkflowOutcome,
  note: string | undefined,
): Promise<void> {
  if (outcome === 'in_progress') return;

  const app = await loadApplication(tx, applicationId, true);
  if (app.status === 'approved' || app.status === 'rejected' || app.status === 'cancelled') {
    return; // already settled; a duplicate decision must not double-post
  }

  const status = outcome === 'approved' ? 'approved' : 'rejected';
  await tx.query(
    `UPDATE leave_mgmt.leave_application
        SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, applicationId, status, tx.actor.userId, note ?? null],
  );

  if (status === 'approved') {
    await postConsumption(tx, applicationId);
    await emitApproved(tx, applicationId);
  } else {
    await emitEvent(tx, 'LeaveRejected', {
      aggregateType: 'leave_application',
      aggregateId: applicationId,
      payload: { leave_application_id: applicationId, employee_id: app.employee_id },
    });
  }

  await audit(tx, {
    entityType: 'leave_application',
    entityId: applicationId,
    action: `leave.${status}`,
    before: { status: app.status },
    after: { status, note: note ?? null },
  });
}

/**
 * Cancels leave. An approved cancellation appends a reversal entry rather than deleting
 * the consumption, so the ledger still shows that the leave existed and was returned.
 */
export async function cancel(tx: TenantTx, applicationId: string, reason?: string): Promise<void> {
  const app = await loadApplication(tx, applicationId, true);

  if (app.status === 'cancelled') return;
  if (app.status === 'rejected') {
    throw conflict('already_rejected', 'A rejected application cannot be cancelled');
  }

  if (app.status === 'approved') {
    const { rows } = await tx.query<{ id: string; quantity: string }>(
      `SELECT id, quantity
         FROM leave_mgmt.leave_ledger_entry
        WHERE tenant_id = $1 AND source_type = 'leave_application' AND source_id = $2
          AND entry_type = 'consumption'`,
      [tx.tenantId, applicationId],
    );
    for (const entry of rows) {
      await tx.query(
        `INSERT INTO leave_mgmt.leave_ledger_entry
           (tenant_id, employee_id, leave_type_id, entry_type, quantity, effective_date,
            period_start, period_end, source_type, source_id, reverses_entry_id, notes, created_by)
         VALUES ($1, $2, $3, 'reversal', $4, CURRENT_DATE, $5::date, $6::date,
                 'leave_application', $7, $8, $9, $10)`,
        [
          tx.tenantId,
          app.employee_id,
          app.leave_type_id,
          -Number(entry.quantity),
          app.start_date,
          app.end_date,
          applicationId,
          entry.id,
          reason ?? 'Leave cancelled',
          tx.actor.userId,
        ],
      );
    }
  }

  await workflow.cancelWorkflow(tx, app.workflow_instance_id);
  await tx.query(
    `UPDATE leave_mgmt.leave_application
        SET status = 'cancelled', cancelled_at = now(), decision_note = COALESCE($3, decision_note)
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, applicationId, reason ?? null],
  );

  await audit(tx, {
    entityType: 'leave_application',
    entityId: applicationId,
    action: 'leave.cancelled',
    before: { status: app.status },
    after: { status: 'cancelled', reason: reason ?? null },
  });

  await emitEvent(tx, 'LeaveCancelled', {
    aggregateType: 'leave_application',
    aggregateId: applicationId,
    payload: { leave_application_id: applicationId, employee_id: app.employee_id },
  });
}

/**
 * Manual ledger correction. Separate permission (`leave.adjust`) and always audited:
 * it is the only sanctioned way to change a balance without an application behind it.
 */
export async function adjust(
  tx: TenantTx,
  input: { employeeId: string; leaveTypeId: string; quantity: number; effectiveDate: string; reason: string },
): Promise<void> {
  if (input.quantity === 0) {
    throw unprocessable('adjustment_zero', 'An adjustment must be non-zero');
  }
  await loadLeaveType(tx, input.leaveTypeId);

  await tx.query(
    `INSERT INTO leave_mgmt.leave_ledger_entry
       (tenant_id, employee_id, leave_type_id, entry_type, quantity, effective_date,
        period_start, period_end, source_type, notes, created_by)
     VALUES ($1, $2, $3, 'adjustment', $4, $5::date, $5::date, $5::date, 'manual_adjustment', $6, $7)`,
    [
      tx.tenantId,
      input.employeeId,
      input.leaveTypeId,
      round2(input.quantity),
      input.effectiveDate,
      input.reason,
      tx.actor.userId,
    ],
  );

  await audit(tx, {
    entityType: 'leave_ledger_entry',
    entityId: input.employeeId,
    action: 'leave.ledger.adjusted',
    after: { leave_type_id: input.leaveTypeId, quantity: input.quantity, reason: input.reason },
  });
}

/**
 * Approved leave days for a date range, used when building payroll and attendance input.
 * Returns per-day units so half days are represented honestly.
 */
export async function approvedLeaveDays(
  tx: TenantTx,
  employeeId: string,
  from: string,
  to: string,
): Promise<Array<{ date: string; leave_type_id: string; code: string; is_paid: boolean; is_lop: boolean; units: number }>> {
  const { rows } = await tx.query<{
    id: string;
    leave_type_id: string;
    code: string;
    is_paid: boolean;
    is_lop: boolean;
    include_holidays: boolean;
    allow_half_day: boolean;
    start_date: string;
    end_date: string;
    start_half_day: boolean;
    end_half_day: boolean;
  }>(
    `SELECT la.id, la.leave_type_id, lt.code, lt.is_paid, lt.is_lop, lt.include_holidays, lt.allow_half_day,
            to_char(la.start_date, 'YYYY-MM-DD') AS start_date,
            to_char(la.end_date, 'YYYY-MM-DD') AS end_date,
            la.start_half_day, la.end_half_day
       FROM leave_mgmt.leave_application la
       JOIN leave_mgmt.leave_type lt ON lt.id = la.leave_type_id
      WHERE la.tenant_id = $1 AND la.employee_id = $2 AND la.status = 'approved'
        AND la.start_date <= $4::date AND la.end_date >= $3::date`,
    [tx.tenantId, employeeId, from, to],
  );

  if (rows.length === 0) return [];

  const calendar = await resolveCalendar(tx, employeeId, from, to);
  const out: Array<{ date: string; leave_type_id: string; code: string; is_paid: boolean; is_lop: boolean; units: number }> = [];

  for (const app of rows) {
    const breakdown = computeLeaveBreakdown({
      startDate: app.start_date,
      endDate: app.end_date,
      startHalfDay: app.start_half_day,
      endHalfDay: app.end_half_day,
      holidays: calendar.holidays,
      weeklyOffs: calendar.weeklyOffs,
      includeHolidays: app.include_holidays,
      allowHalfDay: app.allow_half_day,
    });
    for (const day of breakdown.days) {
      if (day.units > 0 && day.date >= from && day.date <= to) {
        out.push({
          date: day.date,
          leave_type_id: app.leave_type_id,
          code: app.code,
          is_paid: app.is_paid,
          is_lop: app.is_lop,
          units: day.units,
        });
      }
    }
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}
