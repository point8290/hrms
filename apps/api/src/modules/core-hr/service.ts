import type { TenantTx } from '../../infra/db/pool.ts';
import { audit } from '../../infra/audit.ts';
import { emitEvent } from '../../infra/events/outbox.ts';
import { encryptField } from '../../infra/crypto.ts';
import {
  conflict,
  isPgError,
  notFound,
  pgConstraint,
  unprocessable,
  PG_EXCLUSION_VIOLATION,
  PG_UNIQUE_VIOLATION,
} from '../../infra/errors.ts';

export type EmployeeInput = {
  employeeCode?: string;
  companyId: string;
  branchId?: string;
  locationId?: string;
  departmentId?: string;
  designationId?: string;
  managerEmployeeId?: string;
  firstName: string;
  lastName: string;
  personalEmail?: string;
  workEmail?: string;
  phone?: string;
  dateOfBirth?: string;
  gender?: 'male' | 'female' | 'other' | 'undisclosed';
  employmentType?: 'full_time' | 'part_time' | 'contract' | 'intern';
  employmentStatus?: 'onboarding' | 'probation' | 'active';
  joiningDate: string;
  userId?: string;
};

/**
 * Generates the next employee code for a tenant when the caller does not supply one.
 *
 * Derived from the highest existing numeric suffix rather than a counter table: it stays
 * correct if codes are imported or created out of band, and the unique index on
 * (tenant_id, employee_code) is the real guard against a race.
 */
async function nextEmployeeCode(tx: TenantTx): Promise<string> {
  const { rows } = await tx.query<{ next: number }>(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(employee_code, '\\D', '', 'g'), '')::bigint), 0) + 1 AS next
       FROM core.employee
      WHERE tenant_id = $1 AND employee_code ~ '^EMP[0-9]+$'`,
    [tx.tenantId],
  );
  return `EMP${String(rows[0]?.next ?? 1).padStart(4, '0')}`;
}

/**
 * Creates an employee together with the opening row of their employment history.
 *
 * Both writes happen here because employment_history — not core.employee — is what
 * payroll and reporting read for "what was true on this date". An employee without an
 * opening history row would be invisible to any historical query.
 */
export async function createEmployee(tx: TenantTx, input: EmployeeInput): Promise<{ id: string; employeeCode: string }> {
  const employeeCode = input.employeeCode ?? (await nextEmployeeCode(tx));

  if (input.managerEmployeeId) {
    await assertEmployeeExists(tx, input.managerEmployeeId, 'Manager');
  }
  await assertOrgReferences(tx, input);

  let employeeId: string;
  try {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO core.employee
         (tenant_id, employee_code, user_id, company_id, branch_id, location_id, department_id,
          designation_id, manager_employee_id, first_name, last_name, personal_email, work_email,
          phone, date_of_birth, gender, employment_type, employment_status, joining_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING id`,
      [
        tx.tenantId,
        employeeCode,
        input.userId ?? null,
        input.companyId,
        input.branchId ?? null,
        input.locationId ?? null,
        input.departmentId ?? null,
        input.designationId ?? null,
        input.managerEmployeeId ?? null,
        input.firstName,
        input.lastName,
        input.personalEmail ?? null,
        input.workEmail ?? null,
        input.phone ?? null,
        input.dateOfBirth ?? null,
        input.gender ?? null,
        input.employmentType ?? 'full_time',
        input.employmentStatus ?? 'onboarding',
        input.joiningDate,
      ],
    );
    employeeId = rows[0]!.id;
  } catch (err) {
    if (isPgError(err, PG_UNIQUE_VIOLATION)) {
      throw conflict('employee_code_taken', `Employee code ${employeeCode} already exists in this tenant`);
    }
    throw err;
  }

  await tx.query(
    `INSERT INTO core.employment_history
       (tenant_id, employee_id, company_id, department_id, designation_id, location_id,
        manager_employee_id, employment_type, employment_status, change_reason, effective_from, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'joining', $10, $11)`,
    [
      tx.tenantId,
      employeeId,
      input.companyId,
      input.departmentId ?? null,
      input.designationId ?? null,
      input.locationId ?? null,
      input.managerEmployeeId ?? null,
      input.employmentType ?? 'full_time',
      input.employmentStatus ?? 'onboarding',
      input.joiningDate,
      tx.actor.userId,
    ],
  );

  await audit(tx, {
    entityType: 'employee',
    entityId: employeeId,
    action: 'employee.created',
    after: { employee_code: employeeCode, name: `${input.firstName} ${input.lastName}`, joining_date: input.joiningDate },
  });

  await emitEvent(tx, 'EmployeeCreated', {
    aggregateType: 'employee',
    aggregateId: employeeId,
    payload: {
      employee_id: employeeId,
      employee_code: employeeCode,
      company_id: input.companyId,
      joining_date: input.joiningDate,
      work_email: input.workEmail ?? null,
    },
  });

  return { id: employeeId, employeeCode };
}

/**
 * Checks that every organization reference belongs to this tenant.
 *
 * A foreign key alone is not enough here. PostgreSQL evaluates referential integrity with row
 * security bypassed, so `company_id` pointing at *another tenant's* company satisfies the
 * constraint and the insert succeeds. The row that results is worse than a rejection: it
 * carries this tenant's `tenant_id`, so nothing leaks, but every read inner-joins
 * `core.company`, RLS hides the foreign row, and the employee HR just created silently
 * disappears from the directory.
 *
 * The manager is already checked this way a few lines above; these are the references that
 * were not.
 */
async function assertOrgReferences(
  tx: TenantTx,
  input: {
    companyId: string;
    branchId?: string;
    locationId?: string;
    departmentId?: string;
    designationId?: string;
  },
): Promise<void> {
  const checks: Array<[string | undefined, string, string]> = [
    [input.companyId, 'core.company', 'Company'],
    [input.branchId, 'core.branch', 'Branch'],
    [input.locationId, 'core.location', 'Location'],
    [input.departmentId, 'core.department', 'Department'],
    [input.designationId, 'core.designation', 'Designation'],
  ];

  for (const [id, table, label] of checks) {
    if (!id) continue;
    const { rowCount } = await tx.query(
      `SELECT 1 FROM ${table} WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, id],
    );
    if (!rowCount) throw notFound(label);
  }
}

async function assertEmployeeExists(tx: TenantTx, employeeId: string, label = 'Employee'): Promise<void> {
  const { rowCount } = await tx.query('SELECT 1 FROM core.employee WHERE tenant_id = $1 AND id = $2', [
    tx.tenantId,
    employeeId,
  ]);
  if (!rowCount) throw notFound(label);
}

export type LifecycleChange = {
  employeeId: string;
  effectiveFrom: string;
  changeReason: 'confirmation' | 'promotion' | 'transfer' | 'demotion' | 'manager_change' | 'status_change' | 'correction';
  departmentId?: string | null;
  designationId?: string | null;
  locationId?: string | null;
  managerEmployeeId?: string | null;
  employmentType?: string;
  employmentStatus?: string;
};

/**
 * Records an effective-dated org change.
 *
 * Closes the open history row the day before the change and opens a new one. This is why
 * a promotion today cannot alter last month's payroll: payroll reads the row that was
 * effective during the period, not the employee's current state (§19, ADR-005).
 */
export async function recordLifecycleChange(tx: TenantTx, change: LifecycleChange): Promise<{ historyId: string }> {
  const current = await tx.query<{
    id: string;
    company_id: string;
    department_id: string | null;
    designation_id: string | null;
    location_id: string | null;
    manager_employee_id: string | null;
    employment_type: string;
    employment_status: string;
    effective_from: string;
  }>(
    `SELECT id, company_id, department_id, designation_id, location_id, manager_employee_id,
            employment_type, employment_status, to_char(effective_from, 'YYYY-MM-DD') AS effective_from
       FROM core.employment_history
      WHERE tenant_id = $1 AND employee_id = $2 AND effective_to IS NULL
      ORDER BY effective_from DESC
      LIMIT 1
      FOR UPDATE`,
    [tx.tenantId, change.employeeId],
  );

  const open = current.rows[0];
  if (!open) throw notFound('Employment history for this employee');
  if (change.effectiveFrom <= open.effective_from) {
    throw unprocessable(
      'effective_date_not_after_current',
      `Effective date must be after the current record's start (${open.effective_from})`,
    );
  }
  if (change.managerEmployeeId) {
    if (change.managerEmployeeId === change.employeeId) {
      throw unprocessable('self_manager', 'An employee cannot report to themselves');
    }
    await assertEmployeeExists(tx, change.managerEmployeeId, 'Manager');
  }

  const next = {
    company_id: open.company_id,
    department_id: change.departmentId === undefined ? open.department_id : change.departmentId,
    designation_id: change.designationId === undefined ? open.designation_id : change.designationId,
    location_id: change.locationId === undefined ? open.location_id : change.locationId,
    manager_employee_id:
      change.managerEmployeeId === undefined ? open.manager_employee_id : change.managerEmployeeId,
    employment_type: change.employmentType ?? open.employment_type,
    employment_status: change.employmentStatus ?? open.employment_status,
  };

  await tx.query(
    `UPDATE core.employment_history
        SET effective_to = ($3::date - INTERVAL '1 day')::date
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, open.id, change.effectiveFrom],
  );

  let historyId: string;
  try {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO core.employment_history
         (tenant_id, employee_id, company_id, department_id, designation_id, location_id,
          manager_employee_id, employment_type, employment_status, change_reason, effective_from, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        tx.tenantId,
        change.employeeId,
        next.company_id,
        next.department_id,
        next.designation_id,
        next.location_id,
        next.manager_employee_id,
        next.employment_type,
        next.employment_status,
        change.changeReason,
        change.effectiveFrom,
        tx.actor.userId,
      ],
    );
    historyId = inserted.rows[0]!.id;
  } catch (err) {
    if (isPgError(err, PG_EXCLUSION_VIOLATION)) {
      throw conflict('overlapping_history', 'This change overlaps an existing employment history record');
    }
    throw err;
  }

  // core.employee is the current-state projection; keep it aligned once the change is live.
  await tx.query(
    `UPDATE core.employee
        SET department_id = $3, designation_id = $4, location_id = $5,
            manager_employee_id = $6, employment_type = $7, employment_status = $8,
            confirmation_date = CASE WHEN $9 = 'confirmation' THEN $10::date ELSE confirmation_date END
      WHERE tenant_id = $1 AND id = $2`,
    [
      tx.tenantId,
      change.employeeId,
      next.department_id,
      next.designation_id,
      next.location_id,
      next.manager_employee_id,
      next.employment_type,
      next.employment_status,
      change.changeReason,
      change.effectiveFrom,
    ],
  );

  await audit(tx, {
    entityType: 'employee',
    entityId: change.employeeId,
    action: `employee.${change.changeReason}`,
    before: open,
    after: { ...next, effective_from: change.effectiveFrom },
  });

  const eventType = change.changeReason === 'transfer' ? 'EmployeeTransferred' : 'EmployeeUpdated';
  await emitEvent(tx, eventType, {
    aggregateType: 'employee',
    aggregateId: change.employeeId,
    payload: { employee_id: change.employeeId, change_reason: change.changeReason, effective_from: change.effectiveFrom },
  });

  return { historyId };
}

/**
 * Separation. Closes employment history, freezes the employee record and announces it so
 * leave, payroll and document retention can react.
 *
 * Downstream effects are deliberately events rather than inline writes: a separation must
 * not silently mutate an in-flight payroll run.
 */
export async function separate(
  tx: TenantTx,
  input: { employeeId: string; exitDate: string; reason: string },
): Promise<void> {
  const { rows } = await tx.query<{ employment_status: string; joining_date: string }>(
    `SELECT employment_status, to_char(joining_date, 'YYYY-MM-DD') AS joining_date
       FROM core.employee WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tx.tenantId, input.employeeId],
  );
  const employee = rows[0];
  if (!employee) throw notFound('Employee');
  if (employee.employment_status === 'separated') {
    throw conflict('already_separated', 'This employee is already separated');
  }
  if (input.exitDate < employee.joining_date) {
    throw unprocessable('exit_before_joining', 'Exit date cannot precede the joining date');
  }

  await tx.query(
    `UPDATE core.employment_history
        SET effective_to = $3::date
      WHERE tenant_id = $1 AND employee_id = $2 AND effective_to IS NULL`,
    [tx.tenantId, input.employeeId, input.exitDate],
  );

  await tx.query(
    `UPDATE core.employee
        SET employment_status = 'separated', exit_date = $3::date, exit_reason = $4
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, input.employeeId, input.exitDate, input.reason],
  );

  // Open shift assignments would otherwise keep generating attendance expectations.
  await tx.query(
    `UPDATE workforce.shift_assignment
        SET effective_to = $3::date
      WHERE tenant_id = $1 AND employee_id = $2 AND status = 'active'
        AND (effective_to IS NULL OR effective_to > $3::date)`,
    [tx.tenantId, input.employeeId, input.exitDate],
  );

  await audit(tx, {
    entityType: 'employee',
    entityId: input.employeeId,
    action: 'employee.separated',
    before: { employment_status: employee.employment_status },
    after: { employment_status: 'separated', exit_date: input.exitDate, reason: input.reason },
  });

  await emitEvent(tx, 'EmployeeSeparated', {
    aggregateType: 'employee',
    aggregateId: input.employeeId,
    payload: { employee_id: input.employeeId, exit_date: input.exitDate, reason: input.reason },
  });
}

/**
 * Stores a bank account with the account number encrypted at the application layer.
 * Only the last four digits are ever returned by an API.
 */
export async function setBankAccount(
  tx: TenantTx,
  input: {
    employeeId: string;
    accountHolder: string;
    accountNumber: string;
    bankName: string;
    ifsc: string;
    effectiveFrom: string;
  },
): Promise<{ id: string; last4: string }> {
  await assertEmployeeExists(tx, input.employeeId);

  const digits = input.accountNumber.replace(/\s+/g, '');
  if (!/^\d{6,20}$/.test(digits)) {
    throw unprocessable('invalid_account_number', 'Account number must be 6 to 20 digits');
  }
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(input.ifsc)) {
    throw unprocessable('invalid_ifsc', 'IFSC must be 11 characters, e.g. HDFC0001234');
  }

  const previous = await tx.query<{ id: string; account_number_last4: string }>(
    `SELECT id, account_number_last4
       FROM core.bank_account
      WHERE tenant_id = $1 AND employee_id = $2 AND is_primary AND effective_to IS NULL
      FOR UPDATE`,
    [tx.tenantId, input.employeeId],
  );

  if (previous.rows[0]) {
    await tx.query(
      `UPDATE core.bank_account
          SET is_primary = false, effective_to = ($3::date - INTERVAL '1 day')::date
        WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, previous.rows[0].id, input.effectiveFrom],
    );
  }

  const last4 = digits.slice(-4);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO core.bank_account
       (tenant_id, employee_id, account_holder, account_number_encrypted, account_number_last4,
        bank_name, ifsc, is_primary, effective_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)
     RETURNING id`,
    [
      tx.tenantId,
      input.employeeId,
      input.accountHolder,
      encryptField(digits),
      last4,
      input.bankName,
      input.ifsc,
      input.effectiveFrom,
    ],
  );

  await audit(tx, {
    entityType: 'bank_account',
    entityId: rows[0]!.id,
    action: previous.rows[0] ? 'employee.bank_account.updated' : 'employee.bank_account.created',
    before: previous.rows[0] ? { last4: previous.rows[0].account_number_last4 } : undefined,
    after: { employee_id: input.employeeId, last4, bank_name: input.bankName, ifsc: input.ifsc },
  });

  return { id: rows[0]!.id, last4 };
}

/** The org placement that was in force on a given date. Used by payroll snapshots. */
export async function employmentAsOf(
  tx: TenantTx,
  employeeId: string,
  date: string,
): Promise<{
  company_id: string;
  department_id: string | null;
  designation_id: string | null;
  location_id: string | null;
  employment_type: string;
  employment_status: string;
} | null> {
  const { rows } = await tx.query<{
    company_id: string;
    department_id: string | null;
    designation_id: string | null;
    location_id: string | null;
    employment_type: string;
    employment_status: string;
  }>(
    `SELECT company_id, department_id, designation_id, location_id, employment_type, employment_status
       FROM core.employment_history
      WHERE tenant_id = $1 AND employee_id = $2
        AND effective_from <= $3::date
        AND (effective_to IS NULL OR effective_to >= $3::date)
      ORDER BY effective_from DESC
      LIMIT 1`,
    [tx.tenantId, employeeId, date],
  );
  return rows[0] ?? null;
}

export function describeConstraintViolation(err: unknown): string | null {
  const constraint = pgConstraint(err);
  if (!constraint) return null;
  const map: Record<string, string> = {
    employment_history_no_overlap: 'Overlapping employment history records are not allowed',
    shift_assignment_no_overlap: 'This employee already has a shift assigned for part of that period',
    salary_assignment_no_overlap: 'This employee already has salary assigned for part of that period',
    leave_application_no_overlap: 'This employee already has leave booked for part of that range',
    leave_policy_assignment_no_overlap: 'This employee already has a leave policy for part of that period',
  };
  return map[constraint] ?? null;
}
