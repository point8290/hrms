import type { Queryable } from '../../infra/db/pool.ts';

/**
 * The report catalogue.
 *
 * One definition per report PRD s.22 names, and nothing else: each declares the permission
 * that protects the data it reads, the filters it honours, and the single SQL statement that
 * produces it. The runner, the export, the job lifecycle and the audit trail are shared, so
 * adding a report is adding a row here rather than another architecture.
 *
 * Two rules hold across all of them.
 *
 * **The permission is the domain's, not reporting's.** There is no `report.run`. A headcount
 * report needs `employee.read`, a payroll cost report needs `payroll.read` — the same
 * permission that guards the underlying records. That is what stops the reporting endpoint
 * from becoming a way to read salary without `payroll.read` (PRD s.7), and it means a report
 * over sensitive data inherits the MFA requirement that already attaches to sensitive
 * permissions (ADR-012) without anything here knowing about MFA.
 *
 * **Every statement carries its own tenant predicate**, on top of RLS. The predicate is what
 * the query planner uses; RLS is what makes a mistake in it harmless.
 */

export const REPORT_TYPES = [
  'headcount',
  'attendance',
  'absence',
  'overtime',
  'leave',
  'payroll_cost',
  'compensation',
  'expenses',
  'audit_activity',
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

export type ReportParameters = {
  /** Inclusive. For point-in-time reports this is ignored and `dateTo` is the "as of" date. */
  dateFrom: string;
  /** Inclusive. */
  dateTo: string;
  departmentId?: string;
  locationId?: string;
};

export type ReportDefinition = {
  type: ReportType;
  /** The existing permission that already protects this data. */
  permission: string;
  /** True when the export carries salary, tax or audit detail; sets `is_sensitive` on the document. */
  sensitive: boolean;
  /** Column order for the CSV, and the keys read off each row. */
  columns: readonly string[];
  /**
   * Point-in-time reports answer "as of `dateTo`"; period reports answer "between `dateFrom`
   * and `dateTo`". Stated per report because it changes what the date range means.
   */
  grain: 'point_in_time' | 'period';
  run(tx: Queryable, tenantId: string, params: ReportParameters): Promise<Record<string, unknown>[]>;
};

/** Org filters, applied identically wherever a report exposes them. */
function orgFilter(alias: string) {
  return `AND ($4::uuid IS NULL OR ${alias}.department_id = $4)
          AND ($5::uuid IS NULL OR ${alias}.location_id = $5)`;
}

function orgArgs(params: ReportParameters): [string | null, string | null] {
  return [params.departmentId ?? null, params.locationId ?? null];
}

/**
 * Headcount, as of a date, from effective-dated history.
 *
 * `core.employment_history` — not `core.employee` — is the authoritative source, because it
 * is the effective-dated record and `core.employee` only holds the employee's *current*
 * placement. Asking "how many people were in Engineering in June" against `core.employee`
 * would answer with today's departments, which is the misleading historical data PRD s.35
 * ("effective-dated history") exists to prevent. History rows are non-overlapping per
 * employee by exclusion constraint, so exactly one row matches any given date.
 *
 * Employment status is taken from the same row, so someone who was on notice in June counts
 * as on notice in June, not as separated because they have since left.
 */
const headcount: ReportDefinition = {
  type: 'headcount',
  permission: 'employee.read',
  sensitive: false,
  grain: 'point_in_time',
  columns: ['department', 'location', 'employment_status', 'headcount'],
  async run(tx, tenantId, params) {
    const { rows } = await tx.query(
      `SELECT COALESCE(d.name, '(unassigned)') AS department,
              COALESCE(l.name, '(unassigned)') AS location,
              h.employment_status,
              count(*)::int AS headcount
         FROM core.employment_history h
         LEFT JOIN core.department d ON d.id = h.department_id AND d.tenant_id = h.tenant_id
         LEFT JOIN core.location   l ON l.id = h.location_id   AND l.tenant_id = h.tenant_id
        WHERE h.tenant_id = $1
          -- A point-in-time report answers "as of $3"; $2 (dateFrom) has no part in it.
          -- Cast anyway: an unreferenced parameter has no inferable type and Postgres
          -- refuses to prepare the statement at all.
          AND $2::date IS NOT NULL
          AND h.effective_from <= $3::date
          AND (h.effective_to IS NULL OR h.effective_to >= $3::date)
          ${orgFilter('h')}
        GROUP BY 1, 2, 3
        ORDER BY 1, 2, 3`,
      [tenantId, params.dateFrom, params.dateTo, ...orgArgs(params)],
    );
    return rows;
  },
};

/**
 * Payroll cost, from finalized slips only.
 *
 * The source is `payroll.salary_slip` where `status = 'finalized'`. Draft slips are excluded
 * because a draft is a calculation that nobody has approved and which recalculation may
 * replace; reporting cost from one would report a number that can still change. Finalized
 * slips are immutable by trigger, so this report is reproducible.
 *
 * The composition is not invented here — every column is a figure the payroll model already
 * stores and names, reported as itself:
 *
 *   * `gross_amount`            — what the employee earned
 *   * `deduction_amount`        — employee deductions (PF, ESI, PT) withheld from that
 *   * `tax_amount`              — TDS withheld
 *   * `net_amount`              — what the employee is paid
 *   * `employer_contribution`   — employer PF/ESI, which ADR-021/022 establish sits *outside*
 *                                 net pay and is an employer cost rather than a deduction
 *
 * They are reported side by side rather than summed into one "cost" number, because the PRD
 * does not define what payroll cost comprises and any single total would be an accounting
 * definition invented here. `gross + employer_contribution` is the usual reading, and a
 * reader who wants it can add two columns that are labelled; this report will not decide it
 * for them.
 */
const payrollCost: ReportDefinition = {
  type: 'payroll_cost',
  permission: 'payroll.read',
  sensitive: true,
  grain: 'period',
  columns: [
    'period_start', 'period_end', 'department', 'employees',
    'gross_amount', 'deduction_amount', 'tax_amount', 'net_amount', 'employer_contribution',
  ],
  async run(tx, tenantId, params) {
    const { rows } = await tx.query(
      `SELECT to_char(s.period_start, 'YYYY-MM-DD') AS period_start,
              to_char(s.period_end,   'YYYY-MM-DD') AS period_end,
              COALESCE(d.name, '(unassigned)') AS department,
              count(*)::int                   AS employees,
              sum(s.gross_amount)::numeric(14,2)          AS gross_amount,
              sum(s.deduction_amount)::numeric(14,2)      AS deduction_amount,
              sum(s.tax_amount)::numeric(14,2)            AS tax_amount,
              sum(s.net_amount)::numeric(14,2)            AS net_amount,
              sum(s.employer_contribution)::numeric(14,2) AS employer_contribution
         FROM payroll.salary_slip s
         JOIN core.employee e ON e.id = s.employee_id AND e.tenant_id = s.tenant_id
         LEFT JOIN core.department d ON d.id = e.department_id AND d.tenant_id = e.tenant_id
        WHERE s.tenant_id = $1
          AND s.status = 'finalized'
          AND s.period_start >= $2::date
          AND s.period_end   <= $3::date
          ${orgFilter('e')}
        GROUP BY 1, 2, 3
        ORDER BY 1, 3`,
      [tenantId, params.dateFrom, params.dateTo, ...orgArgs(params)],
    );
    return rows;
  },
};

/**
 * Attendance, from calculated attendance rows.
 *
 * `workforce.attendance` is the derived result the workforce engine writes; raw check-ins are
 * not re-paired here. Reconstructing attendance from `employee_checkin` would be a second
 * implementation of the engine's pairing rules, free to disagree with the one that produced
 * the payroll everyone was paid from.
 */
const attendance: ReportDefinition = {
  type: 'attendance',
  permission: 'attendance.read',
  sensitive: false,
  grain: 'period',
  columns: ['department', 'status', 'days', 'employees', 'total_working_minutes'],
  async run(tx, tenantId, params) {
    const { rows } = await tx.query(
      `SELECT COALESCE(d.name, '(unassigned)') AS department,
              a.status,
              count(*)::int                             AS days,
              count(DISTINCT a.employee_id)::int        AS employees,
              COALESCE(sum(a.working_minutes), 0)::int  AS total_working_minutes
         FROM workforce.attendance a
         JOIN core.employee e ON e.id = a.employee_id AND e.tenant_id = a.tenant_id
         LEFT JOIN core.department d ON d.id = e.department_id AND d.tenant_id = e.tenant_id
        WHERE a.tenant_id = $1
          AND a.attendance_date BETWEEN $2::date AND $3::date
          ${orgFilter('e')}
        GROUP BY 1, 2
        ORDER BY 1, 2`,
      [tenantId, params.dateFrom, params.dateTo, ...orgArgs(params)],
    );
    return rows;
  },
};

/**
 * Absence, from the same calculated attendance rows.
 *
 * Absence is not redefined here: it is the `absent` status the engine already assigns, plus
 * the loss-of-pay units it already computes. Inventing a broader notion of absence — counting
 * approved leave, say — would make this report disagree with the LOP that payroll used.
 */
const absence: ReportDefinition = {
  type: 'absence',
  permission: 'attendance.read',
  sensitive: false,
  grain: 'period',
  columns: ['department', 'absent_days', 'employees_absent', 'lop_units'],
  async run(tx, tenantId, params) {
    const { rows } = await tx.query(
      `SELECT COALESCE(d.name, '(unassigned)') AS department,
              count(*) FILTER (WHERE a.status = 'absent')::int                   AS absent_days,
              count(DISTINCT a.employee_id) FILTER (WHERE a.status = 'absent')::int AS employees_absent,
              COALESCE(sum(a.lop_units), 0)::numeric(10,2)                       AS lop_units
         FROM workforce.attendance a
         JOIN core.employee e ON e.id = a.employee_id AND e.tenant_id = a.tenant_id
         LEFT JOIN core.department d ON d.id = e.department_id AND d.tenant_id = e.tenant_id
        WHERE a.tenant_id = $1
          AND a.attendance_date BETWEEN $2::date AND $3::date
          ${orgFilter('e')}
        GROUP BY 1
        ORDER BY 1`,
      [tenantId, params.dateFrom, params.dateTo, ...orgArgs(params)],
    );
    return rows;
  },
};

/** Overtime, read from the minutes the engine already calculated. Never recomputed here. */
const overtime: ReportDefinition = {
  type: 'overtime',
  permission: 'attendance.read',
  sensitive: false,
  grain: 'period',
  columns: ['department', 'employees_with_overtime', 'overtime_days', 'total_overtime_minutes'],
  async run(tx, tenantId, params) {
    const { rows } = await tx.query(
      `SELECT COALESCE(d.name, '(unassigned)') AS department,
              count(DISTINCT a.employee_id)::int      AS employees_with_overtime,
              count(*)::int                           AS overtime_days,
              COALESCE(sum(a.overtime_minutes), 0)::int AS total_overtime_minutes
         FROM workforce.attendance a
         JOIN core.employee e ON e.id = a.employee_id AND e.tenant_id = a.tenant_id
         LEFT JOIN core.department d ON d.id = e.department_id AND d.tenant_id = e.tenant_id
        WHERE a.tenant_id = $1
          AND a.attendance_date BETWEEN $2::date AND $3::date
          AND a.overtime_minutes > 0
          ${orgFilter('e')}
        GROUP BY 1
        ORDER BY 1`,
      [tenantId, params.dateFrom, params.dateTo, ...orgArgs(params)],
    );
    return rows;
  },
};

/**
 * Leave, from the ledger.
 *
 * The ledger is the authoritative source by product invariant — PRD s.29 requires that leave
 * balance be reconstructable from it — so this report sums the same entries balance
 * calculation reads, per entry type. Reading `leave_application` instead would count
 * requested days rather than the days that actually moved a balance.
 */
const leave: ReportDefinition = {
  type: 'leave',
  permission: 'leave.read',
  sensitive: false,
  grain: 'period',
  columns: ['leave_type', 'entry_type', 'entries', 'employees', 'units'],
  async run(tx, tenantId, params) {
    const { rows } = await tx.query(
      `SELECT lt.name        AS leave_type,
              le.entry_type,
              count(*)::int  AS entries,
              count(DISTINCT le.employee_id)::int AS employees,
              sum(le.quantity)::numeric(10,2)     AS units
         FROM leave_mgmt.leave_ledger_entry le
         JOIN leave_mgmt.leave_type lt ON lt.id = le.leave_type_id AND lt.tenant_id = le.tenant_id
         JOIN core.employee e ON e.id = le.employee_id AND e.tenant_id = le.tenant_id
        WHERE le.tenant_id = $1
          AND le.effective_date BETWEEN $2::date AND $3::date
          ${orgFilter('e')}
        GROUP BY 1, 2
        ORDER BY 1, 2`,
      [tenantId, params.dateFrom, params.dateTo, ...orgArgs(params)],
    );
    return rows;
  },
};

/**
 * Compensation, from current effective assignments.
 *
 * Sensitive: this is salary. It reports the assignment rows compensation already maintains,
 * as of `dateTo`, and does not reinterpret them — no annualisation, no derived CTC, no
 * component arithmetic. Those would be a second opinion about pay, competing with the
 * structure payroll actually calculates from.
 */
const compensation: ReportDefinition = {
  type: 'compensation',
  permission: 'compensation.read',
  sensitive: true,
  grain: 'point_in_time',
  columns: ['department', 'employees', 'total_annual_ctc', 'total_base_amount'],
  async run(tx, tenantId, params) {
    const { rows } = await tx.query(
      `SELECT COALESCE(d.name, '(unassigned)') AS department,
              count(*)::int                        AS employees,
              sum(sa.annual_ctc)::numeric(14,2)    AS total_annual_ctc,
              sum(sa.base_amount)::numeric(14,2)   AS total_base_amount
         FROM compensation.salary_assignment sa
         JOIN core.employee e ON e.id = sa.employee_id AND e.tenant_id = sa.tenant_id
         LEFT JOIN core.department d ON d.id = e.department_id AND d.tenant_id = e.tenant_id
        WHERE sa.tenant_id = $1
          -- A point-in-time report answers "as of $3"; $2 (dateFrom) has no part in it.
          -- Cast anyway: an unreferenced parameter has no inferable type and Postgres
          -- refuses to prepare the statement at all.
          AND $2::date IS NOT NULL
          AND sa.effective_from <= $3::date
          AND (sa.effective_to IS NULL OR sa.effective_to >= $3::date)
          ${orgFilter('e')}
        GROUP BY 1
        ORDER BY 1`,
      [tenantId, params.dateFrom, params.dateTo, ...orgArgs(params)],
    );
    return rows;
  },
};

/** Expenses, by claim status, from the claims themselves. Sanctioned amount, not claimed. */
const expenses: ReportDefinition = {
  type: 'expenses',
  permission: 'expense.read',
  sensitive: false,
  grain: 'period',
  columns: ['department', 'status', 'claims', 'employees', 'claimed_amount', 'sanctioned_amount'],
  async run(tx, tenantId, params) {
    const { rows } = await tx.query(
      `SELECT COALESCE(d.name, '(unassigned)') AS department,
              c.status,
              count(*)::int                                  AS claims,
              count(DISTINCT c.employee_id)::int             AS employees,
              COALESCE(sum(c.total_claimed_amount), 0)::numeric(14,2)    AS claimed_amount,
              COALESCE(sum(c.total_sanctioned_amount), 0)::numeric(14,2) AS sanctioned_amount
         FROM expense.expense_claim c
         JOIN core.employee e ON e.id = c.employee_id AND e.tenant_id = c.tenant_id
         LEFT JOIN core.department d ON d.id = e.department_id AND d.tenant_id = e.tenant_id
        WHERE c.tenant_id = $1
          AND c.claim_date BETWEEN $2::date AND $3::date
          ${orgFilter('e')}
        GROUP BY 1, 2
        ORDER BY 1, 2`,
      [tenantId, params.dateFrom, params.dateTo, ...orgArgs(params)],
    );
    return rows;
  },
};

/**
 * Audit activity, from the append-only trail.
 *
 * Sensitive, and gated on `audit.read` — the same permission the audit endpoint uses. It
 * reports counts of actions, never the before/after states, which are the payload the
 * permission exists to protect. Org filters do not apply: an audit entry is about an actor
 * and a record, not about a department.
 */
const auditActivity: ReportDefinition = {
  type: 'audit_activity',
  permission: 'audit.read',
  sensitive: true,
  grain: 'period',
  columns: ['action', 'entity_type', 'is_sensitive', 'events', 'actors'],
  async run(tx, tenantId, params) {
    const { rows } = await tx.query(
      `SELECT al.action,
              al.entity_type,
              al.is_sensitive,
              count(*)::int AS events,
              count(DISTINCT COALESCE(al.actor_user_id::text, al.actor_label))::int AS actors
         FROM audit.audit_log al
        WHERE al.tenant_id = $1
          AND al.created_at >= $2::date
          AND al.created_at < ($3::date + INTERVAL '1 day')
        GROUP BY 1, 2, 3
        ORDER BY 1, 2`,
      [tenantId, params.dateFrom, params.dateTo],
    );
    return rows;
  },
};

const DEFINITIONS: Record<ReportType, ReportDefinition> = {
  headcount,
  attendance,
  absence,
  overtime,
  leave,
  payroll_cost: payrollCost,
  compensation,
  expenses,
  audit_activity: auditActivity,
};

export function reportDefinition(type: ReportType): ReportDefinition {
  return DEFINITIONS[type];
}

export function allReportDefinitions(): ReportDefinition[] {
  return REPORT_TYPES.map((t) => DEFINITIONS[t]);
}
