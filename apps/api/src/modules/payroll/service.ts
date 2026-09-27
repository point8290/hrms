import type { TenantTx } from '../../infra/db/pool.ts';
import { audit } from '../../infra/audit.ts';
import { emitEvent } from '../../infra/events/outbox.ts';
import { conflict, isPgError, notFound, unprocessable, PG_UNIQUE_VIOLATION } from '../../infra/errors.ts';
import { buildEmployeeSnapshot, loadStatutoryRules } from './snapshot.ts';
import { tenantFinancialYearStart } from './tax-opening.ts';
import { ensureTaxYear, periodsRemainingInYear, taxYearForPeriod, type TaxYear } from './tax-year.ts';
import { closeCoverage } from '../workforce/close-schedule.ts';

export const CALCULATION_VERSION = 'in-payroll-2025.1';

export type RunStatus =
  | 'draft'
  | 'validating'
  | 'calculating'
  | 'calculated'
  | 'under_review'
  | 'approved'
  | 'finalized'
  | 'payment_pending'
  | 'paid'
  | 'failed'
  | 'cancelled';

/**
 * Legal payroll state transitions (ArchitectureDiagram/12-state-machines).
 *
 * Encoded as data rather than scattered `if` checks so that "can this run be finalized?"
 * has exactly one answer, and an illegal transition is impossible to express.
 */
const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  draft: ['validating', 'cancelled'],
  validating: ['calculating', 'failed', 'cancelled'],
  calculating: ['calculated', 'failed'],
  calculated: ['under_review', 'calculating', 'cancelled'],
  under_review: ['approved', 'calculating', 'cancelled'],
  approved: ['finalized', 'under_review', 'cancelled'],
  finalized: ['payment_pending'],
  payment_pending: ['paid'],
  paid: [],
  failed: ['validating', 'calculating', 'cancelled'],
  cancelled: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

async function transition(tx: TenantTx, runId: string, to: RunStatus, extra: Record<string, unknown> = {}): Promise<RunStatus> {
  const { rows } = await tx.query<{ status: RunStatus }>(
    'SELECT status FROM payroll.payroll_run WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
    [tx.tenantId, runId],
  );
  const current = rows[0];
  if (!current) throw notFound('Payroll run');
  if (current.status === to) {
    // A no-op transition still means someone did something — a recalculation re-entering
    // `calculating` is the case that matters. Stamping progress here is what stops the
    // stale sweep failing a run that has just been restarted.
    await tx.query(
      'UPDATE payroll.payroll_run SET last_progress_at = now() WHERE tenant_id = $1 AND id = $2',
      [tx.tenantId, runId],
    );
    return to;
  }
  if (!canTransition(current.status, to)) {
    throw conflict(
      'invalid_payroll_transition',
      `A payroll run cannot move from ${current.status} to ${to}`,
      { from: current.status, to, allowed: TRANSITIONS[current.status] },
    );
  }

  // Every transition is progress. The stale sweep measures from here, so a run that is
  // moving through its states — even slowly — is never mistaken for one nobody is working
  // on, and the clock restarts each time a retry re-enters `calculating`.
  const sets = ['status = $3', 'last_progress_at = now()'];
  const values: unknown[] = [tx.tenantId, runId, to];
  for (const [column, value] of Object.entries(extra)) {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }

  await tx.query(
    `UPDATE payroll.payroll_run SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2`,
    values,
  );
  return current.status;
}

/**
 * Creates a payroll period, attaching it to the tax year it will be assessed in.
 *
 * A period is no longer a bare row: every one belongs to exactly one tax year, and the
 * year is created on first use rather than requiring the tenant to open it in advance.
 * The year is chosen by the period **end** date, which is where the income is taxed — a
 * period straddling 31 March belongs to the year it finishes in.
 */
export async function createPeriod(
  tx: TenantTx,
  input: {
    companyId: string;
    name: string;
    periodStart: string;
    periodEnd: string;
    payDate: string;
  },
): Promise<{ id: string; taxYear: TaxYear }> {
  if (input.periodEnd < input.periodStart) {
    throw unprocessable('invalid_period', 'A payroll period must end on or after it starts');
  }

  // The foreign key is not enough on its own: PostgreSQL evaluates referential integrity
  // with row security bypassed, so another tenant's company id satisfies the constraint and
  // the period is created pointing outside this tenant. Nothing leaks — the row carries this
  // tenant_id — but the period can never resolve its own company again.
  const { rowCount: companyExists } = await tx.query(
    'SELECT 1 FROM core.company WHERE tenant_id = $1 AND id = $2',
    [tx.tenantId, input.companyId],
  );
  if (!companyExists) throw notFound('Company');

  const fyStartMonth = await tenantFinancialYearStart(tx);
  const taxYear = await ensureTaxYear(tx, input.periodEnd, fyStartMonth);
  if (taxYear.status === 'closed') {
    throw unprocessable(
      'tax_year_closed',
      `Tax year ${taxYear.label} is closed; a period cannot be added to it.`,
    );
  }

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO payroll.payroll_period
       (tenant_id, company_id, name, period_start, period_end, pay_date, tax_year_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [tx.tenantId, input.companyId, input.name, input.periodStart, input.periodEnd,
     input.payDate, taxYear.id],
  );
  return { id: rows[0]!.id, taxYear };
}

export type CreateRunInput = {
  payrollPeriodId: string;
  runType?: 'regular' | 'supplementary' | 'off_cycle';
  employeeIds?: string[];
  parentRunId?: string;
  /**
   * Proceed even though attendance has not been closed for every day in the period.
   *
   * Requires a reason, is audited, and is recorded on the run. Paying on unevaluated
   * attendance under-reports LOP, so it is a deliberate, attributable decision - never a
   * default.
   */
  allowIncompleteAttendance?: boolean;
  incompleteAttendanceReason?: string;
};

export type CreateRunResult = {
  id: string;
  status: RunStatus;
  employeeCount: number;
  skipped: Array<{ employee_id: string; reason: string }>;
  attendanceCoverage: { expected_days: number; closed_days: number; missing_dates: string[]; complete: boolean };
};

/**
 * Creates a payroll run and freezes its inputs.
 *
 * Order matters: snapshots are written and committed inside this transaction, and the
 * PayrollRunCreated event goes into the same transaction's outbox. The engine therefore
 * cannot start before its inputs exist, and cannot see a half-built run.
 */
export async function createRun(tx: TenantTx, input: CreateRunInput): Promise<CreateRunResult> {
  const period = await tx.query<{
    id: string;
    company_id: string;
    period_start: string;
    period_end: string;
    pay_date: string;
    status: string;
  }>(
    `SELECT id, company_id,
            to_char(period_start, 'YYYY-MM-DD') AS period_start,
            to_char(period_end, 'YYYY-MM-DD') AS period_end,
            to_char(pay_date, 'YYYY-MM-DD') AS pay_date,
            status
       FROM payroll.payroll_period
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, input.payrollPeriodId],
  );
  const periodRow = period.rows[0];
  if (!periodRow) throw notFound('Payroll period');
  if (periodRow.status === 'closed') {
    throw unprocessable('period_closed', 'This payroll period is closed');
  }

  const runType = input.runType ?? 'regular';

  // ADR-007: attendance that was never evaluated is not the same as attendance that was
  // evaluated and found empty. Refusing here is what stops a run silently under-paying LOP
  // because the daily close did not run.
  const coverage = await closeCoverage(tx, periodRow.period_start, periodRow.period_end);
  if (!coverage.complete && !input.allowIncompleteAttendance) {
    throw unprocessable(
      'attendance_not_closed',
      `Attendance has not been closed for ${coverage.missing_dates.length} day(s) in this period. `
        + 'Running payroll now would under-report loss of pay.',
      {
        expected_days: coverage.expected_days,
        closed_days: coverage.closed_days,
        missing_dates: coverage.missing_dates.slice(0, 31),
        override: 'set allowIncompleteAttendance with a reason to proceed anyway',
      },
    );
  }
  if (!coverage.complete && input.allowIncompleteAttendance && !input.incompleteAttendanceReason) {
    throw unprocessable(
      'override_reason_required',
      'Overriding the attendance completeness check requires a reason',
    );
  }

  // A supplementary run corrects a period that was already paid, so it needs something to
  // correct. Refusing here, rather than producing an empty run, is what makes the run type
  // mean something.
  if (runType === 'supplementary') {
    const finalized = await tx.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM payroll.payroll_run r
        WHERE r.tenant_id = $1 AND r.payroll_period_id = $2
          AND r.run_type = 'regular' AND r.status IN ('finalized', 'payment_pending', 'paid')`,
      [tx.tenantId, periodRow.id],
    );
    if (Number(finalized.rows[0]?.count ?? 0) === 0) {
      throw unprocessable(
        'no_run_to_supplement',
        'A supplementary run corrects a finalized regular run, and this period has none yet.',
      );
    }
  }

  // The sequence is part of every slip number, so it must be assigned before any slip is
  // produced and must not move afterwards. Cancelled runs release their slot.
  const sequence = await tx.query<{ next: number }>(
    `SELECT COALESCE(MAX(run_sequence), 0) + 1 AS next
       FROM payroll.payroll_run
      WHERE tenant_id = $1 AND payroll_period_id = $2 AND status <> 'cancelled'`,
    [tx.tenantId, periodRow.id],
  );

  let runId: string;
  try {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO payroll.payroll_run
         (tenant_id, payroll_period_id, company_id, run_type, parent_run_id, status,
          calculation_version, run_sequence, created_by, started_at)
       VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, now())
       RETURNING id`,
      [
        tx.tenantId,
        periodRow.id,
        periodRow.company_id,
        runType,
        input.parentRunId ?? null,
        CALCULATION_VERSION,
        sequence.rows[0]!.next,
        tx.actor.userId,
      ],
    );
    runId = rows[0]!.id;
  } catch (err) {
    if (isPgError(err, PG_UNIQUE_VIOLATION)) {
      throw conflict(
        'run_already_exists',
        'A regular payroll run already exists for this period. Cancel it or use a supplementary run.',
      );
    }
    throw err;
  }

  await transition(tx, runId, 'validating');

  const eligible = await selectEligibleEmployees(tx, periodRow, {
    restrictTo: input.employeeIds,
    runType,
  });
  if (eligible.included.length === 0) {
    await transition(tx, runId, 'failed', { failure_reason: 'No eligible employees for this period' });
    throw unprocessable('no_eligible_employees', 'No employees are eligible for this payroll run', {
      skipped: eligible.skipped,
    });
  }

  const stateCodes = [...new Set(eligible.included.map((e) => e.state_code).filter(Boolean))] as string[];
  const statutory = await loadStatutoryRules(tx, periodRow.period_end, stateCodes);
  const fyStartMonth = await tenantFinancialYearStart(tx);
  const taxYear = await taxYearForPeriod(tx, periodRow.id);
  if (taxYear.status === 'closed') {
    throw unprocessable(
      'tax_year_closed',
      `Tax year ${taxYear.label} is closed; no further payroll can be assessed in it.`,
    );
  }
  const periodsRemaining = await periodsRemainingInYear(tx, taxYear.id, periodRow.period_end);

  for (const employee of eligible.included) {
    const snapshot = await buildEmployeeSnapshot(tx, employee.id, {
      periodStart: periodRow.period_start,
      periodEnd: periodRow.period_end,
      payDate: periodRow.pay_date,
      companyId: periodRow.company_id,
      statutory,
      fyStartMonth,
      taxYear,
      periodsRemaining,
      runType,
      runId,
    });

    await tx.query(
      `INSERT INTO payroll.payroll_employee (tenant_id, payroll_run_id, employee_id, status)
       VALUES ($1, $2, $3, 'pending')`,
      [tx.tenantId, runId, employee.id],
    );

    await tx.query(
      `INSERT INTO payroll.payroll_input_snapshot
         (tenant_id, payroll_run_id, employee_id, snapshot_version, employee_json, attendance_json,
          leave_json, compensation_json, tax_json, statutory_json, additional_json, hra_json,
          exemption_json)
       VALUES ($1, $2, $3, 1, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
               $10::jsonb, $11::jsonb, $12::jsonb)`,
      [
        tx.tenantId,
        runId,
        employee.id,
        JSON.stringify(snapshot.employee_json),
        JSON.stringify(snapshot.attendance_json),
        JSON.stringify(snapshot.leave_json),
        JSON.stringify(snapshot.compensation_json),
        JSON.stringify(snapshot.tax_json),
        JSON.stringify(snapshot.statutory_json),
        JSON.stringify(snapshot.additional_json),
        JSON.stringify(snapshot.hra_json),
        JSON.stringify(snapshot.exemption_json),
      ],
    );
  }

  // Claim the one-off amounts this run has snapshotted so a later run cannot pay them again.
  await tx.query(
    `UPDATE compensation.additional_salary
        SET status = 'consumed', consumed_by_run_id = $2
      WHERE tenant_id = $1
        AND status = 'approved'
        AND employee_id = ANY($3::uuid[])
        AND payroll_date BETWEEN $4::date AND $5::date`,
    [tx.tenantId, runId, eligible.included.map((e) => e.id), periodRow.period_start, periodRow.period_end],
  );

  await tx.query(
    'UPDATE payroll.payroll_run SET employee_count = $3 WHERE tenant_id = $1 AND id = $2',
    [tx.tenantId, runId, eligible.included.length],
  );

  await transition(tx, runId, 'calculating');

  await audit(tx, {
    entityType: 'payroll_run',
    entityId: runId,
    action: 'payroll.run.created',
    after: {
      period: `${periodRow.period_start}..${periodRow.period_end}`,
      run_type: runType,
      employee_count: eligible.included.length,
      skipped: eligible.skipped,
      calculation_version: CALCULATION_VERSION,
      attendance_closed_days: coverage.closed_days,
      attendance_expected_days: coverage.expected_days,
    },
  });

  if (!coverage.complete) {
    // Separately audited and marked sensitive: someone chose to pay on an incomplete
    // picture, and a later dispute needs to find that decision, not infer it.
    await audit(tx, {
      entityType: 'payroll_run',
      entityId: runId,
      action: 'payroll.run.incomplete_attendance_override',
      after: {
        missing_dates: coverage.missing_dates,
        reason: input.incompleteAttendanceReason,
      },
      metadata: { requires_operator_attention: true },
    });
  }

  await emitEvent(tx, 'PayrollRunCreated', {
    aggregateType: 'payroll_run',
    aggregateId: runId,
    payload: {
      payroll_run_id: runId,
      payroll_period_id: periodRow.id,
      employee_count: eligible.included.length,
    },
  });

  return {
    id: runId,
    status: 'calculating',
    employeeCount: eligible.included.length,
    skipped: eligible.skipped,
    attendanceCoverage: coverage,
  };
}

/**
 * Chooses who is in the run and records, per exclusion, why someone is out.
 *
 * Silently dropping an employee from payroll is the kind of bug that surfaces as an
 * unpaid person, so every skip carries a reason back to the caller.
 */
async function selectEligibleEmployees(
  tx: TenantTx,
  period: { id: string; company_id: string; period_start: string; period_end: string },
  options: { restrictTo?: string[]; runType: 'regular' | 'supplementary' | 'off_cycle' },
): Promise<{
  included: Array<{ id: string; state_code: string | null }>;
  skipped: Array<{ employee_id: string; reason: string }>;
}> {
  const restrictTo = options.restrictTo;
  const { rows } = await tx.query<{
    id: string;
    employee_code: string;
    state_code: string | null;
    has_salary: boolean;
    joined_after_period: boolean;
    left_before_period: boolean;
    already_paid: boolean;
  }>(
    `SELECT e.id, e.employee_code,
            COALESCE(tp.pt_state_code, l.state_code) AS state_code,
            EXISTS (
              SELECT 1 FROM compensation.salary_assignment sa
               WHERE sa.tenant_id = e.tenant_id AND sa.employee_id = e.id
                 AND sa.effective_from <= $4::date
                 AND (sa.effective_to IS NULL OR sa.effective_to >= $3::date)
            ) AS has_salary,
            e.joining_date > $4::date AS joined_after_period,
            (e.exit_date IS NOT NULL AND e.exit_date < $3::date) AS left_before_period,
            EXISTS (
              -- A finalized slip for this period means this employee has already been paid
              -- for it. A second regular or off-cycle run must not pay them again, and a
              -- supplementary run has nothing to correct without one.
              SELECT 1 FROM payroll.salary_slip s
               WHERE s.tenant_id = e.tenant_id AND s.employee_id = e.id
                 AND s.status = 'finalized'
                 AND s.period_start = $3::date AND s.period_end = $4::date
            ) AS already_paid
       FROM core.employee e
       LEFT JOIN core.location l ON l.id = e.location_id
       LEFT JOIN LATERAL (
         SELECT pt_state_code FROM core.tax_profile
          WHERE tenant_id = e.tenant_id AND employee_id = e.id
            AND effective_from <= $4::date
            AND (effective_to IS NULL OR effective_to >= $4::date)
          ORDER BY effective_from DESC LIMIT 1
       ) tp ON true
      WHERE e.tenant_id = $1
        AND e.company_id = $2
        AND ($5::uuid[] IS NULL OR e.id = ANY($5::uuid[]))
      ORDER BY e.employee_code`,
    [
      tx.tenantId,
      period.company_id,
      period.period_start,
      period.period_end,
      restrictTo && restrictTo.length > 0 ? restrictTo : null,
    ],
  );

  const included: Array<{ id: string; state_code: string | null }> = [];
  const skipped: Array<{ employee_id: string; reason: string }> = [];

  for (const row of rows) {
    if (row.joined_after_period) {
      skipped.push({ employee_id: row.employee_code, reason: 'joined after the payroll period' });
    } else if (row.left_before_period) {
      skipped.push({ employee_id: row.employee_code, reason: 'left before the payroll period' });
    } else if (!row.has_salary) {
      skipped.push({ employee_id: row.employee_code, reason: 'no salary assignment covering this period' });
    } else if (options.runType === 'supplementary' && !row.already_paid) {
      // Nothing to supplement. Including them would pay a full second salary for a period
      // they were never paid for in the first place.
      skipped.push({
        employee_id: row.employee_code,
        reason: 'no finalized payslip for this period to supplement',
      });
    } else if (options.runType !== 'supplementary' && row.already_paid) {
      skipped.push({
        employee_id: row.employee_code,
        reason: 'already has a finalized payslip for this period; use a supplementary run',
      });
    } else {
      included.push({ id: row.id, state_code: row.state_code });
    }
  }

  return { included, skipped };
}

export async function markCalculated(
  tx: TenantTx,
  runId: string,
  totals: { gross: number; deduction: number; net: number; succeeded: number; failed: number },
): Promise<void> {
  await transition(tx, runId, 'calculated', {
    total_gross: totals.gross,
    total_deduction: totals.deduction,
    total_net: totals.net,
    calculated_at: new Date(),
  });

  await emitEvent(tx, 'PayrollCalculated', {
    aggregateType: 'payroll_run',
    aggregateId: runId,
    payload: {
      payroll_run_id: runId,
      calculation_version: CALCULATION_VERSION,
      succeeded: totals.succeeded,
      failed: totals.failed,
    },
  });
}

export async function markFailed(tx: TenantTx, runId: string, reason: string): Promise<void> {
  await transition(tx, runId, 'failed', { failure_reason: reason.slice(0, 1000) });
}

export async function submitForReview(tx: TenantTx, runId: string): Promise<void> {
  await transition(tx, runId, 'under_review');
}

export async function approve(tx: TenantTx, runId: string): Promise<void> {
  const failed = await tx.query<{ count: string }>(
    `SELECT count(*) AS count FROM payroll.payroll_employee
      WHERE tenant_id = $1 AND payroll_run_id = $2 AND status = 'failed'`,
    [tx.tenantId, runId],
  );
  if (Number(failed.rows[0]?.count ?? 0) > 0) {
    throw unprocessable(
      'failed_employees_present',
      'Resolve the failed employees and recalculate before approving this run',
    );
  }

  const before = await transition(tx, runId, 'approved', {
    approved_by: tx.actor.userId,
    approved_at: new Date(),
  });

  await audit(tx, {
    entityType: 'payroll_run',
    entityId: runId,
    action: 'payroll.run.approved',
    before: { status: before },
    after: { status: 'approved' },
  });
}

/**
 * Finalizes a run.
 *
 * This is the point of no return: slips become immutable (enforced by a database trigger,
 * not just by this code) and the period is locked. Corrections after this use a
 * supplementary run or an adjustment, never an edit (ADR-005).
 */
export async function finalize(tx: TenantTx, runId: string): Promise<{ slipCount: number }> {
  const before = await transition(tx, runId, 'finalized', {
    finalized_by: tx.actor.userId,
    finalized_at: new Date(),
  });

  const { rowCount } = await tx.query(
    `UPDATE payroll.salary_slip
        SET status = 'finalized', finalized_at = now()
      WHERE tenant_id = $1 AND payroll_run_id = $2 AND status = 'draft'`,
    [tx.tenantId, runId],
  );

  await tx.query(
    `UPDATE payroll.payroll_period p
        SET status = 'locked'
       FROM payroll.payroll_run r
      WHERE r.id = $2 AND r.tenant_id = $1 AND p.id = r.payroll_period_id AND p.tenant_id = $1
        AND p.status = 'open'`,
    [tx.tenantId, runId],
  );

  await audit(tx, {
    entityType: 'payroll_run',
    entityId: runId,
    action: 'payroll.run.finalized',
    before: { status: before },
    after: { status: 'finalized', slips_finalized: rowCount ?? 0 },
  });

  await emitEvent(tx, 'PayrollFinalized', {
    aggregateType: 'payroll_run',
    aggregateId: runId,
    payload: { payroll_run_id: runId },
  });

  return { slipCount: rowCount ?? 0 };
}

export async function cancel(tx: TenantTx, runId: string, reason: string): Promise<void> {
  const before = await transition(tx, runId, 'cancelled', { failure_reason: reason.slice(0, 1000) });

  // Release the one-off amounts this run had claimed so a replacement run can pick them up.
  await tx.query(
    `UPDATE compensation.additional_salary
        SET status = 'approved', consumed_by_run_id = NULL
      WHERE tenant_id = $1 AND consumed_by_run_id = $2 AND status = 'consumed'`,
    [tx.tenantId, runId],
  );

  await audit(tx, {
    entityType: 'payroll_run',
    entityId: runId,
    action: 'payroll.run.cancelled',
    before: { status: before },
    after: { status: 'cancelled', reason },
  });
}

/**
 * Recalculates a run that has not been finalized.
 *
 * Snapshots are rebuilt with a new version rather than overwritten — payroll_input_snapshot
 * is append-only — so the inputs behind the earlier attempt remain inspectable.
 */
export async function recalculate(tx: TenantTx, runId: string): Promise<{ employeeCount: number }> {
  const { rows } = await tx.query<{
    status: RunStatus;
    payroll_period_id: string;
    company_id: string;
    run_type: 'regular' | 'supplementary' | 'off_cycle';
    period_start: string;
    period_end: string;
    pay_date: string;
  }>(
    `SELECT r.status, r.payroll_period_id, r.company_id, r.run_type,
            to_char(p.period_start, 'YYYY-MM-DD') AS period_start,
            to_char(p.period_end, 'YYYY-MM-DD') AS period_end,
            to_char(p.pay_date, 'YYYY-MM-DD') AS pay_date
       FROM payroll.payroll_run r
       JOIN payroll.payroll_period p ON p.id = r.payroll_period_id
      WHERE r.tenant_id = $1 AND r.id = $2
      FOR UPDATE OF r`,
    [tx.tenantId, runId],
  );
  const run = rows[0];
  if (!run) throw notFound('Payroll run');
  if (run.status === 'finalized' || run.status === 'paid' || run.status === 'payment_pending') {
    throw conflict('run_finalized', 'A finalized payroll run cannot be recalculated');
  }

  const employees = await tx.query<{ employee_id: string }>(
    'SELECT employee_id FROM payroll.payroll_employee WHERE tenant_id = $1 AND payroll_run_id = $2',
    [tx.tenantId, runId],
  );

  const stateRows = await tx.query<{ state_code: string | null }>(
    `SELECT DISTINCT l.state_code
       FROM payroll.payroll_employee pe
       JOIN core.employee e ON e.id = pe.employee_id
       LEFT JOIN core.location l ON l.id = e.location_id
      WHERE pe.tenant_id = $1 AND pe.payroll_run_id = $2`,
    [tx.tenantId, runId],
  );
  const statutory = await loadStatutoryRules(
    tx,
    run.period_end,
    stateRows.rows.map((r) => r.state_code).filter(Boolean) as string[],
  );
  const fyStartMonth = await tenantFinancialYearStart(tx);
  // The year the period is already attached to, not one re-derived from today's tenant
  // configuration. A recalculation must reproduce the run, not reinterpret it.
  const taxYear = await taxYearForPeriod(tx, run.payroll_period_id);
  const periodsRemaining = await periodsRemainingInYear(tx, taxYear.id, run.period_end);

  for (const { employee_id } of employees.rows) {
    const snapshot = await buildEmployeeSnapshot(tx, employee_id, {
      periodStart: run.period_start,
      periodEnd: run.period_end,
      payDate: run.pay_date,
      companyId: run.company_id,
      statutory,
      fyStartMonth,
      taxYear,
      periodsRemaining,
      runType: run.run_type,
      // Passing the run id is what stops a recalculation losing every bonus and arrear:
      // createRun marked those rows `consumed` by this run, and the snapshot builder must
      // still be able to see its own inputs.
      runId,
    });

    await tx.query(
      `INSERT INTO payroll.payroll_input_snapshot
         (tenant_id, payroll_run_id, employee_id, snapshot_version, employee_json, attendance_json,
          leave_json, compensation_json, tax_json, statutory_json, additional_json, hra_json,
          exemption_json)
       SELECT $1, $2, $3,
              COALESCE(MAX(s.snapshot_version), 0) + 1,
              $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
              $11::jsonb, $12::jsonb
         FROM payroll.payroll_input_snapshot s
        WHERE s.tenant_id = $1 AND s.payroll_run_id = $2 AND s.employee_id = $3`,
      [
        tx.tenantId,
        runId,
        employee_id,
        JSON.stringify(snapshot.employee_json),
        JSON.stringify(snapshot.attendance_json),
        JSON.stringify(snapshot.leave_json),
        JSON.stringify(snapshot.compensation_json),
        JSON.stringify(snapshot.tax_json),
        JSON.stringify(snapshot.statutory_json),
        JSON.stringify(snapshot.additional_json),
        JSON.stringify(snapshot.hra_json),
        JSON.stringify(snapshot.exemption_json),
      ],
    );

    await tx.query(
      `UPDATE payroll.payroll_employee
          SET status = 'pending', failure_reason = NULL
        WHERE tenant_id = $1 AND payroll_run_id = $2 AND employee_id = $3`,
      [tx.tenantId, runId, employee_id],
    );
  }

  // Draft slips from the previous attempt are superseded; finalized ones are untouchable
  // and cannot be here because the status check above already excluded finalized runs.
  await tx.query(
    `DELETE FROM payroll.salary_slip
      WHERE tenant_id = $1 AND payroll_run_id = $2 AND status = 'draft'`,
    [tx.tenantId, runId],
  );

  await transition(tx, runId, 'calculating');

  await emitEvent(tx, 'PayrollRunCreated', {
    aggregateType: 'payroll_run',
    aggregateId: runId,
    payload: {
      payroll_run_id: runId,
      payroll_period_id: run.payroll_period_id,
      employee_count: employees.rowCount ?? 0,
    },
  });

  return { employeeCount: employees.rowCount ?? 0 };
}
