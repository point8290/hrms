import type { TenantTx } from '../../infra/db/pool.ts';
import { audit } from '../../infra/audit.ts';
import { conflict, notFound, unprocessable } from '../../infra/errors.ts';
import * as compensation from '../compensation/service.ts';
import { computeCarryForward, deriveBalance, proRateAllocation, round2 } from './leave-math.ts';

/**
 * Periodic leave operations: accrual, carry-forward and expiry.
 *
 * All three move entitlement, so all three are ledger writes — never edits to a balance.
 * Each run is recorded in `leave_period_job`, whose UNIQUE constraint is what makes the
 * job idempotent: a retried carry-forward cannot grant the same days twice.
 *
 * Semantics follow mature HR behaviour:
 * carry-forward is capped by policy and the excess expires rather than rolling on, and an
 * expiry is a negative ledger entry rather than a deletion.
 */

type JobKind = 'accrual' | 'carry_forward' | 'expiry';

export type JobResult = {
  jobId: string;
  employeesProcessed: number;
  unitsMoved: number;
  alreadyRun: boolean;
};

/**
 * Claims the job, or reports that it already ran.
 *
 * The insert is the lock. Two schedulers racing produce one winner and one `alreadyRun`,
 * which is exactly the behaviour a periodic job needs.
 */
async function claimJob(
  tx: TenantTx,
  kind: JobKind,
  periodStart: string,
  periodEnd: string,
  leaveTypeId: string | null,
): Promise<{ id: string; claimed: boolean }> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO leave_mgmt.leave_period_job
       (tenant_id, job_kind, period_start, period_end, leave_type_id, status, started_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 'running', now(), $6)
     -- Inference must mirror leave_period_job_key exactly: it is an expression index, and
     -- the COALESCE is what makes a tenant-wide job (NULL leave_type_id) conflict at all.
     ON CONFLICT (
       tenant_id, job_kind, period_start, period_end,
       COALESCE(leave_type_id, '00000000-0000-0000-0000-000000000000'::uuid)
     ) DO NOTHING
     RETURNING id`,
    [tx.tenantId, kind, periodStart, periodEnd, leaveTypeId, tx.actor.userId],
  );

  if (rows[0]) return { id: rows[0].id, claimed: true };

  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM leave_mgmt.leave_period_job
      WHERE tenant_id = $1 AND job_kind = $2 AND period_start = $3 AND period_end = $4
        AND leave_type_id IS NOT DISTINCT FROM $5`,
    [tx.tenantId, kind, periodStart, periodEnd, leaveTypeId],
  );
  return { id: existing.rows[0]!.id, claimed: false };
}

async function completeJob(
  tx: TenantTx,
  jobId: string,
  employees: number,
  units: number,
): Promise<void> {
  await tx.query(
    `UPDATE leave_mgmt.leave_period_job
        SET status = 'completed', completed_at = now(),
            employees_processed = $3, units_moved = $4
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, jobId, employees, units],
  );
}

/**
 * Grants the annual entitlement for a period, pro-rated for mid-period joiners.
 *
 * Driven by the leave policy assigned to each employee, so two employees on different
 * policies get different entitlements from one run.
 */
export async function runAccrual(
  tx: TenantTx,
  input: { periodStart: string; periodEnd: string; leaveTypeId?: string },
): Promise<JobResult> {
  const job = await claimJob(tx, 'accrual', input.periodStart, input.periodEnd, input.leaveTypeId ?? null);
  if (!job.claimed) {
    return { jobId: job.id, employeesProcessed: 0, unitsMoved: 0, alreadyRun: true };
  }

  const { rows } = await tx.query<{
    employee_id: string;
    leave_type_id: string;
    annual_allocation: string;
    min_service_days: number;
    joining_date: string;
    exit_date: string | null;
  }>(
    `SELECT DISTINCT ON (e.id, r.leave_type_id)
            e.id AS employee_id, r.leave_type_id, r.annual_allocation, r.min_service_days,
            to_char(e.joining_date, 'YYYY-MM-DD') AS joining_date,
            to_char(e.exit_date, 'YYYY-MM-DD') AS exit_date
       FROM core.employee e
       JOIN leave_mgmt.leave_policy_assignment pa
         ON pa.tenant_id = e.tenant_id AND pa.employee_id = e.id
        AND pa.effective_from <= $3::date
        AND (pa.effective_to IS NULL OR pa.effective_to >= $2::date)
       JOIN leave_mgmt.leave_policy_rule r
         ON r.tenant_id = e.tenant_id AND r.leave_policy_id = pa.leave_policy_id
      WHERE e.tenant_id = $1
        AND e.employment_status <> 'separated'
        AND e.joining_date <= $3::date
        AND ($4::uuid IS NULL OR r.leave_type_id = $4)
      ORDER BY e.id, r.leave_type_id, pa.effective_from DESC`,
    [tx.tenantId, input.periodStart, input.periodEnd, input.leaveTypeId ?? null],
  );

  let employees = 0;
  let units = 0;

  for (const row of rows) {
    // Probationary waiting periods: someone who has not served long enough accrues nothing.
    const serviceDays = daysBetween(row.joining_date, input.periodEnd);
    if (serviceDays < row.min_service_days) continue;

    const quantity = proRateAllocation(
      Number(row.annual_allocation),
      input.periodStart,
      input.periodEnd,
      row.joining_date,
      row.exit_date ?? undefined,
    );
    if (quantity <= 0) continue;

    const allocation = await tx.query<{ id: string }>(
      `INSERT INTO leave_mgmt.leave_allocation
         (tenant_id, employee_id, leave_type_id, quantity, period_start, period_end,
          source, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'policy',$7,$8)
       ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        tx.tenantId, row.employee_id, row.leave_type_id, quantity,
        input.periodStart, input.periodEnd,
        // Keyed so a rerun for the same employee, type and period is a no-op.
        `accrual:${input.periodStart}:${row.employee_id}:${row.leave_type_id}`,
        tx.actor.userId,
      ],
    );
    if (!allocation.rows[0]) continue;

    await tx.query(
      `INSERT INTO leave_mgmt.leave_ledger_entry
         (tenant_id, employee_id, leave_type_id, entry_type, quantity, effective_date,
          period_start, period_end, source_type, source_id, created_by)
       VALUES ($1,$2,$3,'allocation',$4,$5::date,$5::date,$6::date,'leave_allocation',$7,$8)`,
      [
        tx.tenantId, row.employee_id, row.leave_type_id, quantity,
        input.periodStart, input.periodEnd, allocation.rows[0].id, tx.actor.userId,
      ],
    );

    employees += 1;
    units = round2(units + quantity);
  }

  await completeJob(tx, job.id, employees, units);
  await audit(tx, {
    entityType: 'leave_period_job',
    entityId: job.id,
    action: 'leave.accrual.completed',
    after: { period: `${input.periodStart}..${input.periodEnd}`, employees, units },
  });

  return { jobId: job.id, employeesProcessed: employees, unitsMoved: units, alreadyRun: false };
}

/**
 * Carries unused balance into the next period, capped by policy, and expires the rest.
 *
 * Both movements are ledger entries in the same transaction. Carrying without expiring the
 * excess would quietly inflate entitlement year on year.
 */
export async function runCarryForward(
  tx: TenantTx,
  input: { fromPeriodStart: string; fromPeriodEnd: string; toPeriodStart: string; toPeriodEnd: string },
): Promise<JobResult> {
  const job = await claimJob(tx, 'carry_forward', input.fromPeriodStart, input.fromPeriodEnd, null);
  if (!job.claimed) {
    return { jobId: job.id, employeesProcessed: 0, unitsMoved: 0, alreadyRun: true };
  }

  const { rows } = await tx.query<{
    employee_id: string;
    leave_type_id: string;
    max_carry_forward: string | null;
    type_max: string | null;
  }>(
    `SELECT DISTINCT e.id AS employee_id, lt.id AS leave_type_id,
            r.max_carry_forward, lt.max_carry_forward AS type_max
       FROM core.employee e
       JOIN leave_mgmt.leave_policy_assignment pa
         ON pa.tenant_id = e.tenant_id AND pa.employee_id = e.id
       JOIN leave_mgmt.leave_policy_rule r
         ON r.tenant_id = e.tenant_id AND r.leave_policy_id = pa.leave_policy_id
       JOIN leave_mgmt.leave_type lt ON lt.id = r.leave_type_id
      WHERE e.tenant_id = $1
        AND e.employment_status <> 'separated'
        AND lt.carry_forward_enabled`,
    [tx.tenantId],
  );

  let employees = 0;
  let carried = 0;

  for (const row of rows) {
    const ledger = await tx.query<{ entry_type: string; quantity: string }>(
      `SELECT entry_type, quantity FROM leave_mgmt.leave_ledger_entry
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
          AND effective_date <= $4::date`,
      [tx.tenantId, row.employee_id, row.leave_type_id, input.fromPeriodEnd],
    );
    const balance = deriveBalance(
      ledger.rows.map((r) => ({ entryType: r.entry_type as never, quantity: Number(r.quantity) })),
    );
    if (balance.balance <= 0) continue;

    // The policy rule wins over the leave type default when both set a cap.
    const cap = row.max_carry_forward !== null
      ? Number(row.max_carry_forward)
      : row.type_max !== null ? Number(row.type_max) : null;

    const { carried: toCarry, expired } = computeCarryForward(balance.balance, cap);

    if (expired > 0) {
      await tx.query(
        `INSERT INTO leave_mgmt.leave_ledger_entry
           (tenant_id, employee_id, leave_type_id, entry_type, quantity, effective_date,
            period_start, period_end, source_type, notes, created_by)
         VALUES ($1,$2,$3,'expiry',$4,$5::date,$6::date,$5::date,'carry_forward_job',$7,$8)`,
        [
          tx.tenantId, row.employee_id, row.leave_type_id, -expired,
          input.fromPeriodEnd, input.fromPeriodStart,
          `Above the carry-forward cap of ${cap}`, tx.actor.userId,
        ],
      );
    }

    if (toCarry > 0) {
      await tx.query(
        `INSERT INTO leave_mgmt.leave_ledger_entry
           (tenant_id, employee_id, leave_type_id, entry_type, quantity, effective_date,
            period_start, period_end, source_type, notes, created_by)
         VALUES ($1,$2,$3,'carry_forward',$4,$5::date,$5::date,$6::date,'carry_forward_job',$7,$8)`,
        [
          tx.tenantId, row.employee_id, row.leave_type_id, toCarry,
          input.toPeriodStart, input.toPeriodEnd,
          `Carried from ${input.fromPeriodStart}..${input.fromPeriodEnd}`, tx.actor.userId,
        ],
      );
      carried = round2(carried + toCarry);
    }

    if (toCarry > 0 || expired > 0) employees += 1;
  }

  await completeJob(tx, job.id, employees, carried);
  await audit(tx, {
    entityType: 'leave_period_job',
    entityId: job.id,
    action: 'leave.carry_forward.completed',
    after: { from: input.fromPeriodStart, to: input.toPeriodStart, employees, carried },
  });

  return { jobId: job.id, employeesProcessed: employees, unitsMoved: carried, alreadyRun: false };
}

export type EncashmentInput = {
  employeeId: string;
  leaveTypeId: string;
  quantity: number;
  periodStart: string;
  periodEnd: string;
  /**
   * The earning the encashment is paid against.
   *
   * Optional: when omitted, a component coded `LEAVE_ENCASHMENT` is used. If neither
   * exists the request is refused, because there is no defensible default — posting the
   * money against an arbitrary earning would misstate the payslip and, depending on the
   * component's flags, its tax.
   */
  salaryComponentId?: string;
  /** When the money should be paid. Defaults to the end of the encashed period. */
  payrollDate?: string;
};

/**
 * Encashes unused leave.
 *
 * Writes the negative ledger entry immediately, so the balance cannot be spent twice while
 * the payment is pending. The money itself reaches the employee through payroll as an
 * additional salary line, which is why this returns the encashment for payroll to pick up
 * rather than paying anything here.
 */
export async function requestEncashment(
  tx: TenantTx,
  input: EncashmentInput,
): Promise<{ id: string; quantity: number; amount: number; additionalSalaryId: string }> {
  const type = await tx.query<{ encashment_enabled: boolean; name: string }>(
    'SELECT encashment_enabled, name FROM leave_mgmt.leave_type WHERE tenant_id = $1 AND id = $2',
    [tx.tenantId, input.leaveTypeId],
  );
  const leaveType = type.rows[0];
  if (!leaveType) throw notFound('Leave type');
  if (!leaveType.encashment_enabled) {
    throw unprocessable('encashment_not_allowed', `${leaveType.name} cannot be encashed`);
  }

  // Same lock as a leave application: without it two concurrent requests could both pass
  // the balance check and encash the same days.
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `leave:${tx.tenantId}:${input.employeeId}:${input.leaveTypeId}`,
  ]);

  const ledger = await tx.query<{ entry_type: string; quantity: string }>(
    `SELECT entry_type, quantity FROM leave_mgmt.leave_ledger_entry
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
        AND effective_date <= $4::date`,
    [tx.tenantId, input.employeeId, input.leaveTypeId, input.periodEnd],
  );
  const balance = deriveBalance(
    ledger.rows.map((r) => ({ entryType: r.entry_type as never, quantity: Number(r.quantity) })),
  );

  if (balance.balance < input.quantity) {
    throw unprocessable('insufficient_balance_to_encash', 'Not enough balance to encash', {
      available: balance.balance,
      requested: input.quantity,
    });
  }

  // Price it before anything is written. An encashment that debits the balance and pays
  // nothing is worse than one that is refused: the employee loses the days either way, but
  // only the refusal is visible.
  const payrollDate = input.payrollDate ?? input.periodEnd;
  const ratePerDay = await compensation.encashmentRatePerDay(tx, input.employeeId, payrollDate);
  if (ratePerDay === null) {
    throw unprocessable(
      'encashment_rate_not_configured',
      'This employee has no leave encashment rate. Set leave_encashment_amount_per_day on their '
        + 'salary assignment before encashing leave.',
      { employee_id: input.employeeId, as_of: payrollDate },
    );
  }

  const componentId = await resolveEncashmentComponent(tx, input.salaryComponentId);
  const amount = round2(Number(ratePerDay) * input.quantity);

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO leave_mgmt.leave_encashment
       (tenant_id, employee_id, leave_type_id, quantity, amount, period_start, period_end,
        status, salary_component_id, per_day_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'approved',$8,$9)
     RETURNING id`,
    [
      tx.tenantId, input.employeeId, input.leaveTypeId, input.quantity, amount,
      input.periodStart, input.periodEnd, componentId, ratePerDay,
    ],
  );
  const encashmentId = rows[0]!.id;

  await tx.query(
    `INSERT INTO leave_mgmt.leave_ledger_entry
       (tenant_id, employee_id, leave_type_id, entry_type, quantity, effective_date,
        period_start, period_end, source_type, source_id, created_by)
     VALUES ($1,$2,$3,'encashment',$4,CURRENT_DATE,$5::date,$6::date,'leave_encashment',$7,$8)`,
    [
      tx.tenantId, input.employeeId, input.leaveTypeId, -input.quantity,
      input.periodStart, input.periodEnd, encashmentId, tx.actor.userId,
    ],
  );

  // The compensation row is what actually pays the employee. Created in the same
  // transaction as the ledger debit, so the balance can never be spent without the money
  // being owed — and keyed by source, so a retry pays once.
  const additional = await compensation.addAdditionalSalary(tx, {
    employeeId: input.employeeId,
    salaryComponentId: componentId,
    amount,
    payrollDate,
    kind: 'one_time',
    reason: `Encashment of ${input.quantity} day(s) of ${leaveType.name}`,
    source: { type: 'leave_encashment', id: encashmentId },
  });

  await tx.query(
    `UPDATE leave_mgmt.leave_encashment SET additional_salary_id = $3
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, encashmentId, additional.id],
  );

  await audit(tx, {
    entityType: 'leave_encashment',
    entityId: encashmentId,
    action: 'leave.encashed',
    after: {
      employee_id: input.employeeId,
      quantity: input.quantity,
      leave_type: leaveType.name,
      per_day_amount: ratePerDay,
      amount,
      additional_salary_id: additional.id,
      payroll_date: payrollDate,
    },
  });

  return { id: encashmentId, quantity: input.quantity, amount, additionalSalaryId: additional.id };
}

/**
 * The earning an encashment is paid against.
 *
 * An explicit choice wins. Otherwise a component coded `LEAVE_ENCASHMENT` is used, which is
 * the convention the seed data establishes. Refusing when neither exists is deliberate:
 * there is no earning that is obviously correct to post leave encashment against, and
 * guessing would misstate both the payslip and its tax.
 */
async function resolveEncashmentComponent(tx: TenantTx, explicit?: string): Promise<string> {
  if (explicit) {
    const { rows } = await tx.query<{ id: string; component_type: string }>(
      'SELECT id, component_type FROM compensation.salary_component WHERE tenant_id = $1 AND id = $2',
      [tx.tenantId, explicit],
    );
    const component = rows[0];
    if (!component) throw notFound('Salary component');
    if (component.component_type !== 'earning') {
      throw unprocessable(
        'encashment_component_must_be_earning',
        'Leave encashment pays the employee, so it must post against an earning',
      );
    }
    return component.id;
  }

  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM compensation.salary_component
      WHERE tenant_id = $1 AND code = 'LEAVE_ENCASHMENT'
        AND component_type = 'earning' AND status = 'active'`,
    [tx.tenantId],
  );
  if (!rows[0]) {
    throw unprocessable(
      'encashment_component_not_configured',
      'No salary component to pay leave encashment against. Create an active earning component '
        + "coded LEAVE_ENCASHMENT, or name one explicitly on the request.",
    );
  }
  return rows[0].id;
}

/** Assigns a leave policy to an employee for a period. */
export async function assignPolicy(
  tx: TenantTx,
  input: { employeeId: string; leavePolicyId: string; effectiveFrom: string; effectiveTo?: string },
): Promise<{ id: string }> {
  const policy = await tx.query('SELECT 1 FROM leave_mgmt.leave_policy WHERE tenant_id = $1 AND id = $2', [
    tx.tenantId,
    input.leavePolicyId,
  ]);
  if (!policy.rowCount) throw notFound('Leave policy');

  try {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO leave_mgmt.leave_policy_assignment
         (tenant_id, employee_id, leave_policy_id, effective_from, effective_to)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id`,
      [tx.tenantId, input.employeeId, input.leavePolicyId, input.effectiveFrom, input.effectiveTo ?? null],
    );

    await audit(tx, {
      entityType: 'leave_policy_assignment',
      entityId: rows[0]!.id,
      action: 'leave.policy.assigned',
      after: { employee_id: input.employeeId, policy_id: input.leavePolicyId, effective_from: input.effectiveFrom },
    });

    return { id: rows[0]!.id };
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23P01') {
      throw conflict(
        'overlapping_policy_assignment',
        'This employee already has a leave policy covering part of that period',
      );
    }
    throw err;
  }
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((b - a) / 86_400_000);
}
