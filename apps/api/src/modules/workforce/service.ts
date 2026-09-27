import type { TenantTx } from '../../infra/db/pool.ts';
import { audit } from '../../infra/audit.ts';
import { emitEvent } from '../../infra/events/outbox.ts';
import {
  conflict,
  isPgError,
  notFound,
  unprocessable,
  PG_EXCLUSION_VIOLATION,
  PG_UNIQUE_VIOLATION,
} from '../../infra/errors.ts';
import * as workflow from '../workflow/service.ts';

export type CheckinInput = {
  employeeId: string;
  checkinAt: string;
  direction: 'in' | 'out' | 'unknown';
  source: 'web' | 'mobile' | 'biometric' | 'api' | 'import';
  deviceId?: string;
  latitude?: number;
  longitude?: number;
  externalEventId?: string;
  deviceRecordedAt?: string;
};

export type CheckinResult = {
  id: string;
  duplicate: boolean;
  attendanceDate: string;
};

/**
 * Records a raw check-in.
 *
 * This is an append of an observed fact, nothing more: no shift resolution, no status
 * decision, no working-hours arithmetic. All of that is derived later by the workforce
 * engine, which is what makes recalculation after a policy change possible without
 * losing what the device actually saw (§16).
 *
 * Devices retry, replay offline batches and duplicate pushes. external_event_id makes
 * re-delivery a no-op rather than a second observation.
 */
export async function recordCheckin(tx: TenantTx, input: CheckinInput): Promise<CheckinResult> {
  const { rows: employeeRows } = await tx.query<{ employment_status: string; timezone: string }>(
    `SELECT e.employment_status, COALESCE(l.timezone, t.timezone) AS timezone
       FROM core.employee e
       JOIN identity.tenant t ON t.id = e.tenant_id
       LEFT JOIN core.location l ON l.id = e.location_id
      WHERE e.tenant_id = $1 AND e.id = $2`,
    [tx.tenantId, input.employeeId],
  );
  const employee = employeeRows[0];
  if (!employee) throw notFound('Employee');
  if (employee.employment_status === 'separated') {
    throw unprocessable('employee_separated', 'A separated employee cannot check in');
  }

  // ON CONFLICT rather than catching the unique violation: a raised constraint error
  // aborts the surrounding transaction, and this insert shares a transaction with the
  // caller's other work. Letting the database absorb the duplicate keeps the bulk-import
  // path (where duplicates are routine) from failing every subsequent row.
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO workforce.employee_checkin
       (tenant_id, employee_id, checkin_at, direction, source, device_id, latitude, longitude,
        external_event_id, device_recorded_at)
     VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10::timestamptz)
     ON CONFLICT (tenant_id, employee_id, external_event_id)
       WHERE external_event_id IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [
      tx.tenantId,
      input.employeeId,
      input.checkinAt,
      input.direction,
      input.source,
      input.deviceId ?? null,
      input.latitude ?? null,
      input.longitude ?? null,
      input.externalEventId ?? null,
      input.deviceRecordedAt ?? null,
    ],
  );

  const inserted = rows[0];
  if (!inserted) {
    // The device has sent this observation before. Return the original so the caller can
    // acknowledge it, and emit nothing: the day was already derived from it.
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM workforce.employee_checkin
        WHERE tenant_id = $1 AND employee_id = $2 AND external_event_id = $3`,
      [tx.tenantId, input.employeeId, input.externalEventId],
    );
    return {
      id: existing.rows[0]?.id ?? '',
      duplicate: true,
      attendanceDate: await localDate(tx, input.employeeId, input.checkinAt),
    };
  }

  const checkinId = inserted.id;
  const attendanceDate = await localDate(tx, input.employeeId, input.checkinAt);

  await emitEvent(tx, 'CheckinRecorded', {
    aggregateType: 'employee_checkin',
    aggregateId: checkinId,
    payload: {
      checkin_id: checkinId,
      employee_id: input.employeeId,
      checkin_at: input.checkinAt,
      attendance_date_hint: attendanceDate,
    },
  });

  return { id: checkinId, duplicate: false, attendanceDate };
}

/**
 * Converts an instant to the employee's local calendar date.
 *
 * The employee's location timezone wins over the tenant default, and the server's own
 * timezone is never used: a 23:30 check-in in Asia/Kolkata belongs to that day locally,
 * whatever the container clock is set to.
 */
async function localDate(tx: TenantTx, employeeId: string, instant: string): Promise<string> {
  const { rows } = await tx.query<{ d: string }>(
    `SELECT to_char(($3::timestamptz AT TIME ZONE COALESCE(l.timezone, t.timezone))::date, 'YYYY-MM-DD') AS d
       FROM core.employee e
       JOIN identity.tenant t ON t.id = e.tenant_id
       LEFT JOIN core.location l ON l.id = e.location_id
      WHERE e.tenant_id = $1 AND e.id = $2`,
    [tx.tenantId, employeeId, instant],
  );
  return rows[0]!.d;
}

export async function assignShift(
  tx: TenantTx,
  input: {
    employeeId: string;
    shiftTypeId: string;
    holidayListId?: string;
    effectiveFrom: string;
    effectiveTo?: string;
  },
): Promise<{ id: string }> {
  const shift = await tx.query('SELECT 1 FROM workforce.shift_type WHERE tenant_id = $1 AND id = $2', [
    tx.tenantId,
    input.shiftTypeId,
  ]);
  if (!shift.rowCount) throw notFound('Shift type');

  try {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO workforce.shift_assignment
         (tenant_id, employee_id, shift_type_id, holiday_list_id, effective_from, effective_to, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        tx.tenantId,
        input.employeeId,
        input.shiftTypeId,
        input.holidayListId ?? null,
        input.effectiveFrom,
        input.effectiveTo ?? null,
        tx.actor.userId,
      ],
    );

    await audit(tx, {
      entityType: 'shift_assignment',
      entityId: rows[0]!.id,
      action: 'shift.assigned',
      after: { employee_id: input.employeeId, shift_type_id: input.shiftTypeId, effective_from: input.effectiveFrom },
    });

    return { id: rows[0]!.id };
  } catch (err) {
    if (isPgError(err, PG_EXCLUSION_VIOLATION)) {
      throw conflict(
        'overlapping_shift_assignment',
        'This employee already has an active shift assignment covering part of that period',
      );
    }
    throw err;
  }
}

/**
 * Asks the workforce engine to (re)derive attendance for a date range.
 *
 * Node never computes attendance itself — that rule keeps a single implementation of the
 * pairing and overtime logic (§11). Recalculation is safe at any time because attendance
 * is derived state and the raw check-ins are untouched.
 */
export async function requestRecalculation(
  tx: TenantTx,
  input: { employeeIds: string[]; fromDate: string; toDate: string; reason: string },
): Promise<{ jobs: number }> {
  if (input.employeeIds.length === 0) {
    throw unprocessable('no_employees', 'Select at least one employee to recalculate');
  }

  for (const employeeId of input.employeeIds) {
    await emitEvent(tx, 'AttendanceCorrectionApproved', {
      aggregateType: 'employee',
      aggregateId: employeeId,
      payload: {
        employee_id: employeeId,
        from_date: input.fromDate,
        to_date: input.toDate,
        reason: input.reason,
      },
    });
  }

  await audit(tx, {
    entityType: 'attendance',
    action: 'attendance.recalculated',
    after: {
      employee_count: input.employeeIds.length,
      from_date: input.fromDate,
      to_date: input.toDate,
      reason: input.reason,
    },
  });

  return { jobs: input.employeeIds.length };
}

/**
 * Raises an attendance correction request.
 *
 * The request never edits a check-in or an attendance row. On approval the engine
 * re-derives the day using the correction as an additional input, so the original device
 * observation survives (§16, invariants.md#attendance).
 */
export async function requestCorrection(
  tx: TenantTx,
  input: {
    employeeId: string;
    attendanceDate: string;
    reason: string;
    proposedInAt?: string;
    proposedOutAt?: string;
    proposedStatus?: string;
  },
): Promise<{ id: string; status: string; workflowInstanceId: string | null }> {
  if (!input.proposedInAt && !input.proposedOutAt && !input.proposedStatus) {
    throw unprocessable('empty_correction', 'A correction must propose a time or a status');
  }

  const attendance = await tx.query<{ id: string }>(
    `SELECT id FROM workforce.attendance
      WHERE tenant_id = $1 AND employee_id = $2 AND attendance_date = $3::date`,
    [tx.tenantId, input.employeeId, input.attendanceDate],
  );

  let correctionId: string;
  try {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO workforce.attendance_correction
         (tenant_id, employee_id, attendance_date, attendance_id, requested_by, reason,
          proposed_in_at, proposed_out_at, proposed_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9)
       RETURNING id`,
      [
        tx.tenantId,
        input.employeeId,
        input.attendanceDate,
        attendance.rows[0]?.id ?? null,
        tx.actor.userId,
        input.reason,
        input.proposedInAt ?? null,
        input.proposedOutAt ?? null,
        input.proposedStatus ?? null,
      ],
    );
    correctionId = rows[0]!.id;
  } catch (err) {
    if (isPgError(err, PG_UNIQUE_VIOLATION)) {
      throw conflict('correction_pending', 'A correction request for this date is already awaiting a decision');
    }
    throw err;
  }

  const started = await workflow.startWorkflow(tx, 'attendance_correction', correctionId, input.employeeId);
  const status = started.status === 'approved' ? 'approved' : 'pending';

  await tx.query(
    'UPDATE workforce.attendance_correction SET status = $3, workflow_instance_id = $4 WHERE tenant_id = $1 AND id = $2',
    [tx.tenantId, correctionId, status, started.instanceId],
  );

  if (status === 'approved') {
    await finaliseCorrection(tx, correctionId, 'approved', undefined);
  }

  return { id: correctionId, status, workflowInstanceId: started.instanceId };
}

/**
 * Settles a correction after its workflow decides. Approval emits a recalculation job
 * rather than writing attendance directly: derived state has exactly one producer.
 */
export async function finaliseCorrection(
  tx: TenantTx,
  correctionId: string,
  outcome: 'approved' | 'rejected',
  note: string | undefined,
): Promise<void> {
  const { rows } = await tx.query<{
    employee_id: string;
    attendance_date: string;
    status: string;
    proposed_in_at: string | null;
    proposed_out_at: string | null;
    proposed_status: string | null;
  }>(
    `SELECT employee_id, to_char(attendance_date, 'YYYY-MM-DD') AS attendance_date, status,
            proposed_in_at, proposed_out_at, proposed_status
       FROM workforce.attendance_correction
      WHERE tenant_id = $1 AND id = $2
      FOR UPDATE`,
    [tx.tenantId, correctionId],
  );
  const correction = rows[0];
  if (!correction) throw notFound('Attendance correction');
  if (correction.status !== 'pending') return;

  await tx.query(
    `UPDATE workforce.attendance_correction
        SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, correctionId, outcome, tx.actor.userId, note ?? null],
  );

  await audit(tx, {
    entityType: 'attendance_correction',
    entityId: correctionId,
    action: `attendance.correction.${outcome}`,
    after: {
      employee_id: correction.employee_id,
      attendance_date: correction.attendance_date,
      proposed_in_at: correction.proposed_in_at,
      proposed_out_at: correction.proposed_out_at,
      proposed_status: correction.proposed_status,
      note: note ?? null,
    },
  });

  if (outcome === 'approved') {
    await emitEvent(tx, 'AttendanceCorrectionApproved', {
      aggregateType: 'attendance_correction',
      aggregateId: correctionId,
      payload: {
        correction_id: correctionId,
        employee_id: correction.employee_id,
        from_date: correction.attendance_date,
        to_date: correction.attendance_date,
        reason: 'correction_approved',
      },
    });
  }
}

export type AttendanceSummary = {
  present: number;
  absent: number;
  half_day: number;
  on_leave: number;
  weekly_off: number;
  holiday: number;
  not_marked: number;
  lop_units: number;
  working_minutes: number;
  overtime_minutes: number;
};

/** Attendance totals for a period. Payroll reads this shape when building a snapshot. */
export async function summarise(
  tx: TenantTx,
  employeeId: string,
  from: string,
  to: string,
): Promise<AttendanceSummary> {
  const { rows } = await tx.query<{
    status: string;
    days: string;
    lop: string;
    working: string;
    overtime: string;
  }>(
    `SELECT status,
            count(*)::text AS days,
            COALESCE(SUM(lop_units), 0)::text AS lop,
            COALESCE(SUM(working_minutes), 0)::text AS working,
            COALESCE(SUM(overtime_minutes), 0)::text AS overtime
       FROM workforce.attendance
      WHERE tenant_id = $1 AND employee_id = $2 AND attendance_date BETWEEN $3::date AND $4::date
      GROUP BY status`,
    [tx.tenantId, employeeId, from, to],
  );

  const summary: AttendanceSummary = {
    present: 0,
    absent: 0,
    half_day: 0,
    on_leave: 0,
    weekly_off: 0,
    holiday: 0,
    not_marked: 0,
    lop_units: 0,
    working_minutes: 0,
    overtime_minutes: 0,
  };

  for (const row of rows) {
    if (row.status in summary) {
      (summary as unknown as Record<string, number>)[row.status] = Number(row.days);
    }
    summary.lop_units += Number(row.lop);
    summary.working_minutes += Number(row.working);
    summary.overtime_minutes += Number(row.overtime);
  }

  summary.lop_units = Math.round(summary.lop_units * 100) / 100;
  return summary;
}
