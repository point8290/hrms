import type { TenantTx } from '../../infra/db/pool.ts';
import { audit } from '../../infra/audit.ts';
import { conflict, isPgError, notFound, unprocessable, PG_EXCLUSION_VIOLATION } from '../../infra/errors.ts';

export type StructureComponent = {
  component_id: string;
  code: string;
  name: string;
  component_type: 'earning' | 'deduction';
  calculation_type: 'fixed' | 'percentage' | 'formula' | 'statutory' | 'variable';
  statutory_type: string | null;
  /**
   * What this component is to the statute, independent of its code or name.
   *
   * HRA exemption needs the basic and the allowance by their legal meaning, and matching on
   * a code would give no exemption at all to a tenant who calls theirs `BASIC_PAY`.
   */
  semantic_role: 'basic' | 'house_rent_allowance' | null;
  taxable: boolean;
  affects_lop: boolean;
  sequence_no: number;
  fixed_amount: string | null;
  percentage: string | null;
  percentage_of_code: string | null;
  formula: string | null;
  max_amount: string | null;
};

export type ResolvedCompensation = {
  salary_assignment_id: string;
  salary_structure_id: string;
  structure_name: string;
  annual_ctc: string;
  base_amount: string;
  currency: string;
  effective_from: string;
  effective_to: string | null;
  components: StructureComponent[];
};

/**
 * The salary configuration that was in force on a given date.
 *
 * Payroll always resolves by period date, never "the latest row". A revision dated after
 * the period must not change what that period pays — that is the whole point of
 * effective dating (§19, ADR-005).
 */
export async function resolveAsOf(
  tx: TenantTx,
  employeeId: string,
  asOf: string,
): Promise<ResolvedCompensation | null> {
  const { rows } = await tx.query<{
    id: string;
    salary_structure_id: string;
    structure_name: string;
    annual_ctc: string;
    base_amount: string;
    currency: string;
    effective_from: string;
    effective_to: string | null;
  }>(
    `SELECT sa.id, sa.salary_structure_id, ss.name AS structure_name, sa.annual_ctc, sa.base_amount,
            ss.currency,
            to_char(sa.effective_from, 'YYYY-MM-DD') AS effective_from,
            to_char(sa.effective_to, 'YYYY-MM-DD') AS effective_to
       FROM compensation.salary_assignment sa
       JOIN compensation.salary_structure ss ON ss.id = sa.salary_structure_id
      WHERE sa.tenant_id = $1 AND sa.employee_id = $2
        AND sa.effective_from <= $3::date
        AND (sa.effective_to IS NULL OR sa.effective_to >= $3::date)
      ORDER BY sa.effective_from DESC
      LIMIT 1`,
    [tx.tenantId, employeeId, asOf],
  );

  const assignment = rows[0];
  if (!assignment) return null;

  const components = await tx.query<StructureComponent>(
    `SELECT sc.id AS component_id, c.code, c.name, c.component_type, c.calculation_type,
            c.statutory_type, c.semantic_role, c.taxable, c.affects_lop, sc.sequence_no,
            sc.fixed_amount, sc.percentage, sc.percentage_of_code, sc.formula, sc.max_amount
       FROM compensation.salary_structure_component sc
       JOIN compensation.salary_component c ON c.id = sc.salary_component_id
      WHERE sc.tenant_id = $1 AND sc.salary_structure_id = $2 AND c.status = 'active'
      ORDER BY sc.sequence_no`,
    [tx.tenantId, assignment.salary_structure_id],
  );

  return { ...assignment, salary_assignment_id: assignment.id, components: components.rows };
}

/**
 * Assigns or revises compensation.
 *
 * A revision closes the previous assignment the day before the new one starts rather
 * than overwriting it, so historical payroll keeps resolving the salary that was actually
 * in force. The database exclusion constraint is the backstop if this logic is ever
 * bypassed.
 */
export async function assign(
  tx: TenantTx,
  input: {
    employeeId: string;
    salaryStructureId: string;
    annualCtc: number;
    baseAmount: number;
    effectiveFrom: string;
    reason?: string;
  },
): Promise<{ id: string; supersededId: string | null }> {
  const employee = await tx.query('SELECT 1 FROM core.employee WHERE tenant_id = $1 AND id = $2', [
    tx.tenantId,
    input.employeeId,
  ]);
  if (!employee.rowCount) throw notFound('Employee');

  const structure = await tx.query<{ effective_from: string; status: string }>(
    `SELECT to_char(effective_from, 'YYYY-MM-DD') AS effective_from, status
       FROM compensation.salary_structure WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, input.salaryStructureId],
  );
  const structureRow = structure.rows[0];
  if (!structureRow) throw notFound('Salary structure');
  if (structureRow.status !== 'active') {
    throw unprocessable('structure_inactive', 'That salary structure is not active');
  }
  if (input.effectiveFrom < structureRow.effective_from) {
    throw unprocessable(
      'before_structure_effective',
      `The structure only takes effect from ${structureRow.effective_from}`,
    );
  }

  const open = await tx.query<{ id: string; effective_from: string; annual_ctc: string }>(
    `SELECT id, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, annual_ctc
       FROM compensation.salary_assignment
      WHERE tenant_id = $1 AND employee_id = $2 AND effective_to IS NULL
      ORDER BY effective_from DESC
      LIMIT 1
      FOR UPDATE`,
    [tx.tenantId, input.employeeId],
  );

  const previous = open.rows[0];
  if (previous) {
    if (input.effectiveFrom <= previous.effective_from) {
      throw unprocessable(
        'revision_not_after_current',
        `A revision must start after the current assignment (${previous.effective_from})`,
      );
    }
    await tx.query(
      `UPDATE compensation.salary_assignment
          SET effective_to = ($3::date - INTERVAL '1 day')::date
        WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, previous.id, input.effectiveFrom],
    );
  }

  let assignmentId: string;
  try {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO compensation.salary_assignment
         (tenant_id, employee_id, salary_structure_id, annual_ctc, base_amount, effective_from, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        tx.tenantId,
        input.employeeId,
        input.salaryStructureId,
        input.annualCtc,
        input.baseAmount,
        input.effectiveFrom,
        tx.actor.userId,
      ],
    );
    assignmentId = rows[0]!.id;
  } catch (err) {
    if (isPgError(err, PG_EXCLUSION_VIOLATION)) {
      throw conflict(
        'overlapping_salary_assignment',
        'This employee already has salary assigned covering part of that period',
      );
    }
    throw err;
  }

  if (previous) {
    await tx.query(
      `INSERT INTO compensation.compensation_revision
         (tenant_id, employee_id, previous_assignment_id, new_assignment_id, effective_date, reason, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        tx.tenantId,
        input.employeeId,
        previous.id,
        assignmentId,
        input.effectiveFrom,
        input.reason ?? 'Compensation revision',
        tx.actor.userId,
      ],
    );
  }

  await audit(tx, {
    entityType: 'salary_assignment',
    entityId: assignmentId,
    action: previous ? 'compensation.revised' : 'compensation.assigned',
    before: previous ? { annual_ctc: previous.annual_ctc, effective_from: previous.effective_from } : undefined,
    after: {
      employee_id: input.employeeId,
      annual_ctc: input.annualCtc,
      base_amount: input.baseAmount,
      effective_from: input.effectiveFrom,
      reason: input.reason ?? null,
    },
  });

  return { id: assignmentId, supersededId: previous?.id ?? null };
}

/**
 * One-off amounts (bonus, arrears, recovery) that a specific payroll run should pick up.
 * They are marked consumed when a run snapshots them, so a later run cannot pay them twice.
 */
export type AdditionalSalaryInput = {
  employeeId: string;
  salaryComponentId: string;
  amount: number;
  payrollDate: string;
  kind: 'one_time' | 'arrear' | 'bonus' | 'incentive' | 'recovery';
  reason?: string;
  /**
   * Replace the structure component's amount for this period instead of adding to it.
   *
   * Applied before pro-rating, so a percentage component that depends on the overwritten
   * one resolves against the corrected figure rather than the structure's.
   */
  overwritesStructure?: boolean;
  /**
   * The document that caused this amount — a leave encashment, later a gratuity.
   *
   * Unique per source, so however many times the event that creates it is delivered, the
   * employee is paid once.
   */
  source?: { type: 'leave_encashment' | 'gratuity' | 'expense_claim'; id: string };
};

export async function addAdditionalSalary(
  tx: TenantTx,
  input: AdditionalSalaryInput,
): Promise<{ id: string; created: boolean }> {
  const component = await tx.query<{ component_type: string; code: string }>(
    'SELECT component_type, code FROM compensation.salary_component WHERE tenant_id = $1 AND id = $2',
    [tx.tenantId, input.salaryComponentId],
  );
  const componentRow = component.rows[0];
  if (!componentRow) throw notFound('Salary component');

  if (input.kind === 'recovery' && input.amount > 0) {
    throw unprocessable('recovery_must_be_negative', 'A recovery amount must be negative');
  }

  // An overwrite replaces a *structure* component, so the employee must actually have one
  // to replace. Overwriting a component that is not in their structure would silently
  // become an ordinary addition, which is not what the caller asked for.
  if (input.overwritesStructure) {
    const inStructure = await tx.query(
      `SELECT 1
         FROM compensation.salary_assignment sa
         JOIN compensation.salary_structure_component ssc
           ON ssc.tenant_id = sa.tenant_id AND ssc.salary_structure_id = sa.salary_structure_id
        WHERE sa.tenant_id = $1 AND sa.employee_id = $2
          AND ssc.salary_component_id = $3
          AND sa.effective_from <= $4::date
          AND (sa.effective_to IS NULL OR sa.effective_to >= $4::date)`,
      [tx.tenantId, input.employeeId, input.salaryComponentId, input.payrollDate],
    );
    if (!inStructure.rowCount) {
      throw unprocessable(
        'component_not_in_structure',
        `${componentRow.code} is not in this employee's salary structure for that date, so there is `
          + 'nothing to overwrite. Add it without the overwrite flag to pay it as a one-off.',
      );
    }
    if (input.amount < 0) {
      throw unprocessable(
        'overwrite_must_not_be_negative',
        'An overwrite sets the component to this amount, so it cannot be negative',
      );
    }
  }

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO compensation.additional_salary
       (tenant_id, employee_id, salary_component_id, amount, payroll_date, kind, reason,
        overwrites_structure, source_type, source_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     -- Idempotent per source document: a redelivered encashment event finds the row it
     -- already created instead of paying the employee a second time.
     ON CONFLICT (tenant_id, source_type, source_id) WHERE source_type IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [
      tx.tenantId,
      input.employeeId,
      input.salaryComponentId,
      input.amount,
      input.payrollDate,
      input.kind,
      input.reason ?? null,
      input.overwritesStructure ?? false,
      input.source?.type ?? null,
      input.source?.id ?? null,
      tx.actor.userId,
    ],
  );

  if (!rows[0]) {
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM compensation.additional_salary
        WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3`,
      [tx.tenantId, input.source!.type, input.source!.id],
    );
    return { id: existing.rows[0]!.id, created: false };
  }

  await audit(tx, {
    entityType: 'additional_salary',
    entityId: rows[0].id,
    action: 'compensation.additional_added',
    after: {
      employee_id: input.employeeId,
      component: componentRow.code,
      amount: input.amount,
      kind: input.kind,
      overwrites_structure: input.overwritesStructure ?? false,
      source: input.source ? `${input.source.type}:${input.source.id}` : null,
    },
  });

  return { id: rows[0].id, created: true };
}

/**
 * What one encashed leave day is worth for this employee.
 *
 * Returns null when nothing is configured. The caller refuses the encashment rather than
 * inventing a daily rate — a guessed figure here under- or over-pays a real person, and
 * nothing downstream would flag it.
 */
export async function encashmentRatePerDay(
  tx: TenantTx,
  employeeId: string,
  asOf: string,
): Promise<string | null> {
  const { rows } = await tx.query<{ rate: string | null }>(
    `SELECT leave_encashment_amount_per_day AS rate
       FROM compensation.salary_assignment
      WHERE tenant_id = $1 AND employee_id = $2
        AND effective_from <= $3::date
        AND (effective_to IS NULL OR effective_to >= $3::date)
      ORDER BY effective_from DESC
      LIMIT 1`,
    [tx.tenantId, employeeId, asOf],
  );
  return rows[0]?.rate ?? null;
}
