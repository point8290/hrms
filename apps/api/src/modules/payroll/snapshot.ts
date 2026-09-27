import type { TenantTx } from '../../infra/db/pool.ts';
import { conflict, notFound } from '../../infra/errors.ts';
import * as compensation from '../compensation/service.ts';
import * as leave from '../leave/service.ts';
import * as workforce from '../workforce/service.ts';
import { eachDate } from '../leave/leave-math.ts';
import {
  financialYearOf,
  monthsRemainingInFinancialYear,
} from '../tenant/financial-year.ts';
import type { TaxYear } from './tax-year.ts';
import { loadOpening } from './tax-opening.ts';
import { buildHraSnapshot, type MetroClassification } from './hra.ts';
import { buildExemptionSnapshot } from './exemptions.ts';
import { buildProfessionalTaxContext, requireProfessionalTax } from './professional-tax.ts';

/**
 * Builds the frozen input a payroll calculation runs against (ADR-005).
 *
 * Everything the engine needs is copied here at run-creation time: employment, salary
 * structure, attendance, leave, tax configuration, opening tax-year balances and statutory
 * rule versions. After this commits, the engine reads only the snapshot — so recalculating
 * the run tomorrow, after a salary revision or an attendance correction, still reproduces
 * the same numbers.
 *
 * Two things are snapshotted here that the engine cannot obtain any other way, and both are
 * new:
 *
 *   * **what the year looks like so far** — opening balances from a previous employer plus
 *     the taxable earnings and tax actually taken by our own finalized slips. Annualisation
 *     is wrong without them, and they are facts about the past that must not move.
 *   * **which statutory rules this employee requires** — derived from their tax profile, so
 *     the engine can refuse an employee whose configuration is missing instead of quietly
 *     deducting zero.
 */

export type EmployeeSnapshot = {
  employee_json: Record<string, unknown>;
  /**
   * Everything the HRA exemption depends on, for this period and for the rest of the year.
   *
   * Its own top-level section rather than a corner of `tax_json`, because it carries a
   * forward plan as well as the period's figures and the two have different lifetimes: the
   * period figures explain this payslip, the plan explains this payslip's *annualisation*.
   */
  hra_json: Record<string, unknown>;
  /**
   * Section exemptions (chapter VI-A), frozen with the rule that governs each one.
   *
   * Separate from `hra_json` because the two are different calculations that must not be
   * merged: HRA is a period-level least-of-three the tax year accumulates, a section
   * exemption is an annual declaration against an annual ceiling. Sharing a structure would
   * invite one to be computed like the other.
   */
  exemption_json: Record<string, unknown>;
  attendance_json: Record<string, unknown>;
  leave_json: Record<string, unknown>;
  compensation_json: Record<string, unknown>;
  tax_json: Record<string, unknown>;
  statutory_json: Record<string, unknown>;
  additional_json: unknown[];
};

export type SnapshotContext = {
  periodStart: string;
  periodEnd: string;
  payDate: string;
  companyId: string;
  statutory: Record<string, unknown>;
  /** The tenant's financial-year start month. Read once per run, not per employee. */
  fyStartMonth: number;
  /**
   * The tax year this period is assessed in, resolved once per run.
   *
   * Passed in rather than derived here from `periodEnd` and `fyStartMonth`, because the
   * year is now a record with boundaries, a status and a proof cutoff of its own. Deriving
   * it per employee would also mean re-deriving it at recalculation time, when the tenant's
   * start month may have moved — and the whole point of the snapshot is that it does not.
   */
  taxYear: TaxYear;
  /**
   * Payroll periods left in the tax year, counting this one, and how that was arrived at.
   *
   * The divisor for annualisation. Resolved once per run because it costs a query and is
   * the same for every employee in the period.
   */
  periodsRemaining: { remaining: number; basis: 'defined_periods' | 'months' };
  /**
   * What kind of run this is. A supplementary run pays only the one-off amounts attached to
   * the period; it must not re-pay the salary structure the regular run already paid.
   */
  runType: 'regular' | 'supplementary' | 'off_cycle';
  /**
   * The run being built or rebuilt.
   *
   * Needed because `createRun` marks one-off amounts `consumed` by the run that snapshotted
   * them; without the id, a recalculation of that same run would query only `approved` rows
   * and silently drop every bonus, arrear and recovery it had already claimed.
   */
  runId?: string;
};

/**
 * Loads the statutory rule versions effective at period end, once per run.
 *
 * Pinned into the snapshot so a mid-month slab change cannot retroactively alter a run that
 * is already under review, and so a finalized slip can always be explained by the exact
 * rule version that produced it.
 */
export async function loadStatutoryRules(
  tx: TenantTx,
  asOf: string,
  stateCodes: readonly string[],
): Promise<Record<string, unknown>> {
  const { rows } = await tx.query<{
    id: string;
    rule_type: string;
    state_code: string | null;
    version: number;
    rule_config: Record<string, unknown>;
    tenant_id: string | null;
  }>(
    `SELECT DISTINCT ON (rule_type, state_code)
            id, rule_type, state_code, version, rule_config, tenant_id
       FROM payroll.statutory_rule
      WHERE country_code = 'IN'
        AND effective_from <= $1::date
        AND (effective_to IS NULL OR effective_to >= $1::date)
        AND (state_code IS NULL OR state_code = ANY($2::text[]))
      -- a tenant override outranks the platform default for the same rule
      ORDER BY rule_type, state_code, (tenant_id IS NOT NULL) DESC, effective_from DESC, version DESC`,
    [asOf, stateCodes],
  );

  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.state_code ? `${row.rule_type}:${row.state_code}` : row.rule_type;
    // The id as well as the version: a version number is only unique within a scope, and
    // reconstructing which exact row produced a two-year-old payslip should not require
    // guessing whether it was the platform default or a tenant override.
    out[key] = {
      rule_id: row.id,
      version: row.version,
      source: row.tenant_id ? 'tenant' : 'platform',
      config: row.rule_config,
    };
  }
  return out;
}

/**
 * The statutory rules this particular employee cannot be paid without.
 *
 * Derived from explicit assertions on their tax profile, never from the presence or absence
 * of configuration — "no PF rule is loaded" must not be allowed to mean "this employee has
 * no PF". Income tax is required unconditionally: every employee has a tax position, and a
 * missing slab table means we do not know what it is.
 *
 * Professional tax is the one genuinely optional case. Several Indian states levy none at
 * all, so PT is required only when someone has explicitly set `pt_state_code` on the tax
 * profile — which is an assertion that this employee is liable in that state. A state code
 * inherited from the work location is a location fact, not a tax assertion, and does not
 * make PT mandatory.
 */
export function requiredStatutoryRules(input: {
  pfApplicable: boolean;
  esiApplicable: boolean;
  ptStateCode: string | null;
}): string[] {
  const required = ['income_tax'];
  if (input.pfApplicable) required.push('pf');
  if (input.esiApplicable) required.push('esi');
  if (input.ptStateCode) required.push(`professional_tax:${input.ptStateCode}`);
  return required;
}

export async function buildEmployeeSnapshot(
  tx: TenantTx,
  employeeId: string,
  ctx: SnapshotContext,
): Promise<EmployeeSnapshot> {
  const { rows } = await tx.query<{
    id: string;
    employee_code: string;
    first_name: string;
    last_name: string;
    work_email: string | null;
    joining_date: string;
    exit_date: string | null;
    employment_status: string;
    employment_type: string;
    location_state: string | null;
    location_timezone: string | null;
    location_metro: MetroClassification | null;
    tax_regime: string | null;
    pf_applicable: boolean | null;
    esi_applicable: boolean | null;
    pt_state_code: string | null;
    uan: string | null;
  }>(
    `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.work_email,
            to_char(e.joining_date, 'YYYY-MM-DD') AS joining_date,
            to_char(e.exit_date, 'YYYY-MM-DD') AS exit_date,
            e.employment_status, e.employment_type,
            l.state_code AS location_state, l.timezone AS location_timezone,
            l.metro_classification AS location_metro,
            tp.tax_regime, tp.pf_applicable, tp.esi_applicable, tp.pt_state_code, tp.uan
       FROM core.employee e
       LEFT JOIN core.location l ON l.id = e.location_id
       LEFT JOIN LATERAL (
         SELECT tax_regime, pf_applicable, esi_applicable, pt_state_code, uan
           FROM core.tax_profile
          WHERE tenant_id = e.tenant_id AND employee_id = e.id
            AND effective_from <= $3::date
            AND (effective_to IS NULL OR effective_to >= $3::date)
          ORDER BY effective_from DESC
          LIMIT 1
       ) tp ON true
      WHERE e.tenant_id = $1 AND e.id = $2`,
    [tx.tenantId, employeeId, ctx.periodEnd],
  );

  const employee = rows[0];
  if (!employee) throw notFound('Employee');

  const employment = await tx.query<{
    department_id: string | null;
    designation_id: string | null;
    employment_type: string;
  }>(
    `SELECT department_id, designation_id, employment_type
       FROM core.employment_history
      WHERE tenant_id = $1 AND employee_id = $2
        AND effective_from <= $3::date
        AND (effective_to IS NULL OR effective_to >= $3::date)
      ORDER BY effective_from DESC
      LIMIT 1`,
    [tx.tenantId, employeeId, ctx.periodEnd],
  );

  const totalDays = eachDate(ctx.periodStart, ctx.periodEnd).length;

  // Someone who joins or leaves mid-month is only paid for the days they were employed.
  const paidFrom = employee.joining_date > ctx.periodStart ? employee.joining_date : ctx.periodStart;
  const paidTo =
    employee.exit_date && employee.exit_date < ctx.periodEnd ? employee.exit_date : ctx.periodEnd;
  const employedDays = paidTo >= paidFrom ? eachDate(paidFrom, paidTo).length : 0;

  const attendance = await workforce.summarise(tx, employeeId, paidFrom, paidTo);
  const leaveDays = await leave.approvedLeaveDays(tx, employeeId, paidFrom, paidTo);
  const comp = await compensation.resolveAsOf(tx, employeeId, ctx.periodEnd);

  // Derived attendance already folds approved leave into its LOP figure, so a day that
  // has an attendance row must not also be counted from the leave side — that would
  // charge the employee twice for the same absence. Leave-only LOP is added for days the
  // engine has not yet derived (a future-dated approval, or a gap in processing).
  const derivedDates = await tx.query<{ d: string }>(
    `SELECT to_char(attendance_date, 'YYYY-MM-DD') AS d
       FROM workforce.attendance
      WHERE tenant_id = $1 AND employee_id = $2 AND attendance_date BETWEEN $3::date AND $4::date`,
    [tx.tenantId, employeeId, paidFrom, paidTo],
  );
  const covered = new Set(derivedDates.rows.map((r) => r.d));

  const lopFromLeave = leaveDays
    .filter((d) => (d.is_lop || !d.is_paid) && !covered.has(d.date))
    .reduce((sum, d) => sum + d.units, 0);
  const lopUnits = Math.round((attendance.lop_units + lopFromLeave) * 100) / 100;

  const additional = await loadAdditionalSalary(tx, employeeId, ctx);

  // The resolved tax year, not one re-derived from the period end. `start`/`end`/`label`
  // keep the shape the rest of this function already used.
  const year = { label: ctx.taxYear.label, start: ctx.taxYear.start_date, end: ctx.taxYear.end_date };

  const declaration = await tx.query<{ regime: string; declared_amount: string; verified_amount: string | null }>(
    `SELECT regime, declared_amount, verified_amount
       FROM compensation.tax_declaration
      WHERE tenant_id = $1 AND employee_id = $2 AND financial_year = $3`,
    [tx.tenantId, employeeId, year.label],
  );

  const decl = declaration.rows[0];
  const regime = decl?.regime ?? employee.tax_regime ?? 'new';

  const yearToDate = await taxYearToDate(tx, employeeId, year, ctx.periodStart);
  const opening = await loadOpening(tx, employeeId, ctx.taxYear.id);

  // HRA exemption inputs, for this period and for the rest of the year. Resolved here and
  // frozen, so the engine never reads a rent declaration, a salary assignment or a location
  // — the same rule that already applies to every other input (ADR-005).
  // Section exemptions, with each section's ceiling for *this* tax year copied in. The
  // engine reads this and never the rule table, so a cap changed next April cannot re-price
  // a run calculated in March.
  const exemptions = await buildExemptionSnapshot(tx, employeeId, {
    taxYear: ctx.taxYear,
    regime,
    // The period's end, not today: the cutoff decision has to reach the same answer when
    // this run is recalculated months later as it did when the run was created.
    referenceDate: ctx.periodEnd,
  });

  // Professional tax: which state, how we know, which rule, and what the year has already
  // taken. Resolved here and frozen, so the engine has no path to the rule table and a
  // recalculation of an old period reproduces that period's jurisdiction.
  const professionalTax = await buildProfessionalTaxContext(tx, employeeId, {
    assertedStateCode: employee.pt_state_code,
    locationStateCode: employee.location_state,
    periodStart: ctx.periodStart,
    periodEnd: ctx.periodEnd,
    taxYearStart: ctx.taxYear.start_date,
    resolvedRules: ctx.statutory,
    requireProfessionalTax: await requireProfessionalTax(tx),
  });

  const hra = await buildHraSnapshot(tx, employeeId, {
    taxYearId: ctx.taxYear.id,
    taxYearEnd: ctx.taxYear.end_date,
    period: { periodStart: ctx.periodStart, periodEnd: ctx.periodEnd },
    periodsRemaining: ctx.periodsRemaining.remaining,
    exitDate: employee.exit_date,
    // Where they work, unless the rent declaration says they rent somewhere else.
    locationClassification: employee.location_metro ?? 'non_metro',
  });

  const pfApplicable = employee.pf_applicable ?? true;
  const esiApplicable = employee.esi_applicable ?? false;

  return {
    employee_json: {
      id: employee.id,
      employee_code: employee.employee_code,
      name: `${employee.first_name} ${employee.last_name}`,
      work_email: employee.work_email,
      joining_date: employee.joining_date,
      exit_date: employee.exit_date,
      employment_status: employee.employment_status,
      employment_type: employment.rows[0]?.employment_type ?? employee.employment_type,
      department_id: employment.rows[0]?.department_id ?? null,
      designation_id: employment.rows[0]?.designation_id ?? null,
      state_code: employee.pt_state_code ?? employee.location_state,
      timezone: employee.location_timezone,
      uan: employee.uan,
    },
    attendance_json: {
      ...attendance,
      total_days: totalDays,
      employed_days: employedDays,
      paid_from: paidFrom,
      paid_to: paidTo,
      // Combined LOP: unauthorised absence from derived attendance, plus unpaid or LOP
      // leave on days attendance has not yet been derived for.
      lop_units: lopUnits,
      lop_from_attendance: attendance.lop_units,
      lop_from_leave: Math.round(lopFromLeave * 100) / 100,
      // How much of the period attendance actually covers. A payroll administrator can
      // see at a glance whether LOP is based on a complete picture or a partial one, and
      // the figure is frozen into the snapshot alongside the numbers it explains.
      derived_days: covered.size,
      attendance_complete: covered.size >= employedDays,
      // The annualisation divisor. Counted from the payroll periods the tenant has actually
      // defined in this tax year where the year is fully laid out, and from months where it
      // is not — so a tenant paying fortnightly annualises over their own cycle rather than
      // over an assumed twelve. Name unchanged: it is what the engine already reads.
      months_remaining_in_fy: ctx.periodsRemaining.remaining,
      months_remaining_basis: ctx.periodsRemaining.basis,
    },
    leave_json: {
      days: leaveDays,
      lop_from_leave: Math.round(lopFromLeave * 100) / 100,
      paid_leave_days: Math.round(
        leaveDays.filter((d) => d.is_paid && !d.is_lop).reduce((s, d) => s + d.units, 0) * 100,
      ) / 100,
    },
    compensation_json: comp
      ? {
          salary_assignment_id: comp.salary_assignment_id,
          salary_structure_id: comp.salary_structure_id,
          structure_name: comp.structure_name,
          annual_ctc: comp.annual_ctc,
          base_amount: comp.base_amount,
          currency: comp.currency,
          effective_from: comp.effective_from,
          components: comp.components,
          // A supplementary run corrects a period the regular run already paid. Paying the
          // structure again would pay the employee twice; only the one-off amounts attached
          // to this run are due.
          pay_structure: ctx.runType !== 'supplementary',
        }
      : {},
    tax_json: {
      regime,
      // The resolved tax year, frozen with the run. A recalculation reads the year from
      // here, so moving the tenant's financial-year start month later cannot silently
      // reprice a run that has already been computed.
      tax_year_id: ctx.taxYear.id,
      tax_year_status: ctx.taxYear.status,
      proof_cutoff_date: ctx.taxYear.proof_cutoff_date,
      financial_year: year.label,
      financial_year_start: year.start,
      financial_year_end: year.end,
      // Legacy, and read only when `exemption_json` carries no tax year — which marks a
      // snapshot written before section caps existed. Those runs applied this uncapped
      // figure, so a recalculation must keep applying it or it would not reproduce them.
      declared_amount: decl?.verified_amount ?? decl?.declared_amount ?? '0',
      declaration_status: decl ? 'present' : 'absent',

      // --- annualisation inputs -------------------------------------------------------
      // What the employee brought in from a previous employer.
      opening_taxable_earnings: opening.taxableEarnings,
      opening_tds: opening.tds,
      opening_declared: opening.declared,
      // What *we* have actually paid and withheld this financial year, from finalized slips
      // only. A draft or cancelled run has withheld nothing from anyone.
      previous_taxable_earnings: yearToDate.taxableEarnings,
      previous_tax_deducted: yearToDate.taxDeducted,
      // Kept under its established name so an older snapshot still reads correctly; it is
      // now the opening balance plus what we deducted, which is the figure the engine wants.
      tax_deducted_ytd: String(Number(opening.tds) + Number(yearToDate.taxDeducted)),

      pf_applicable: pfApplicable,
      esi_applicable: esiApplicable,
      pt_state_code: employee.pt_state_code,
      // The whole professional-tax decision, frozen. Independent of `regime` above: an
      // employee on the new regime still pays their state's PT.
      professional_tax: professionalTax,
    },
    statutory_json: {
      ...ctx.statutory,
      // Not a rule — a list of the rule keys this employee cannot be calculated without.
      // The engine refuses the employee if one is absent, rather than deducting zero.
      required: requiredStatutoryRules({
        pfApplicable,
        esiApplicable,
        ptStateCode: employee.pt_state_code,
      }),
    },
    exemption_json: {
      ...exemptions,
      // A supplementary run pays one-off amounts against an already-finalized period; the
      // year's exemptions were applied by the run it corrects, and applying them again
      // would exempt the same income twice.
      sections: ctx.runType === 'supplementary' ? [] : exemptions.sections,
      ...(ctx.runType === 'supplementary'
        ? { reason: 'supplementary runs do not re-apply the year\'s section exemptions' }
        : {}),
    },
    hra_json: {
      ...hra,
      // A supplementary run pays one-off amounts and no salary structure, so there is no
      // allowance for an exemption to be measured against. Marking it here rather than
      // leaving the engine to infer it keeps the reason on the record.
      applicable: hra.applicable && ctx.runType !== 'supplementary',
      ...(ctx.runType === 'supplementary'
        ? { reason: 'supplementary runs pay no salary structure, so no HRA is received' }
        : {}),
    },
    additional_json: additional,
  };
}

/**
 * One-off amounts attached to this period.
 *
 * Two behaviours the caller depends on:
 *
 *   * `overwrites_structure` rows are returned too, flagged, so the engine can replace the
 *     structure component's value rather than adding a second line for it.
 *   * rows already consumed **by this run** are included. `createRun` marks rows consumed
 *     after snapshotting them, so a recalculation of the same run must still see them —
 *     without this, a recalculated payslip silently lost every bonus, arrear and recovery.
 */
async function loadAdditionalSalary(
  tx: TenantTx,
  employeeId: string,
  ctx: SnapshotContext,
): Promise<unknown[]> {
  const { rows } = await tx.query<{
    id: string;
    code: string;
    name: string;
    component_type: string;
    taxable: boolean;
    exempted_from_income_tax: boolean;
    affects_lop: boolean;
    amount: string;
    kind: string;
    payroll_date: string;
    overwrites_structure: boolean;
    source_type: string | null;
    source_id: string | null;
  }>(
    `SELECT a.id, c.code, c.name, c.component_type, c.taxable, c.exempted_from_income_tax,
            c.affects_lop, a.amount, a.kind, a.overwrites_structure, a.source_type, a.source_id,
            to_char(a.payroll_date, 'YYYY-MM-DD') AS payroll_date
       FROM compensation.additional_salary a
       JOIN compensation.salary_component c ON c.id = a.salary_component_id
      WHERE a.tenant_id = $1 AND a.employee_id = $2
        AND a.payroll_date BETWEEN $3::date AND $4::date
        AND (
          a.status = 'approved'
          -- Consumed by the run being rebuilt: a recalculation must see its own inputs.
          OR (a.status = 'consumed' AND $5::uuid IS NOT NULL AND a.consumed_by_run_id = $5)
        )
      ORDER BY a.overwrites_structure DESC, c.code, a.payroll_date`,
    [tx.tenantId, employeeId, ctx.periodStart, ctx.periodEnd, ctx.runId ?? null],
  );

  // Two overwrites for the same component in one period is an ambiguity, not something to
  // resolve by ordering. Fail this employee; the rest of the run is unaffected.
  const overwrites = new Map<string, typeof rows>();
  for (const row of rows.filter((r) => r.overwrites_structure)) {
    const seen = overwrites.get(row.code) ?? [];
    seen.push(row);
    overwrites.set(row.code, seen);
  }
  for (const [code, conflicting] of overwrites) {
    if (conflicting.length > 1) throw overwriteConflict(employeeId, code, conflicting, ctx);
  }

  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    component_type: row.component_type,
    taxable: row.taxable,
    exempted_from_income_tax: row.exempted_from_income_tax,
    affects_lop: row.affects_lop,
    amount: row.amount,
    kind: row.kind,
    overwrites_structure: row.overwrites_structure,
    source_type: row.source_type,
    source_id: row.source_id,
  }));
}

/**
 * The refusal when one component is overwritten twice in a period.
 *
 * A typed 409 rather than a bare `Error`, which surfaced as a 500 and told the operator
 * nothing they could act on. Two records overwriting the same component is a data conflict
 * the tenant created and the tenant must resolve, so the response names what they need to
 * find: the employee, the component, the period, and the records themselves.
 *
 * What it deliberately does not say is why the database could not decide — no constraint
 * names, no SQL, no table names. The constraint could not decide because the question is a
 * business one: which of these two corrections is the right one.
 */
function overwriteConflict(
  employeeId: string,
  componentCode: string,
  conflicting: readonly { id: string; payroll_date: string; amount: string }[],
  ctx: SnapshotContext,
): Error {
  return conflict(
    'additional_salary_overwrite_conflict',
    `Component ${componentCode} is overwritten by ${conflicting.length} additional salary `
      + `records in the period ${ctx.periodStart} to ${ctx.periodEnd}. Only one record may `
      + 'replace a component’s value; cancel the ones that no longer apply.',
    {
      employee_id: employeeId,
      salary_component_code: componentCode,
      period_start: ctx.periodStart,
      period_end: ctx.periodEnd,
      conflicting_records: conflicting.map((row) => ({
        additional_salary_id: row.id,
        payroll_date: row.payroll_date,
        amount: row.amount,
      })),
    },
  );
}

/**
 * Taxable earnings and tax deducted so far this financial year, from finalized slips.
 *
 * `taxable_earnings` rather than `gross_amount`: gross includes non-taxable reimbursements
 * and excludes the pre-tax deductions that reduce the base, so deriving the tax base from
 * gross after the fact would give a different number than the one that produced the tax.
 *
 * Bounded strictly before this period so a recalculation of the current run never counts
 * its own earlier attempt.
 */
async function taxYearToDate(
  tx: TenantTx,
  employeeId: string,
  year: { start: string },
  periodStart: string,
): Promise<{ taxableEarnings: string; taxDeducted: string }> {
  const { rows } = await tx.query<{ taxable: string; deducted: string }>(
    `SELECT COALESCE(SUM(s.taxable_earnings), 0)::text AS taxable,
            COALESCE(SUM(s.tax_amount), 0)::text AS deducted
       FROM payroll.salary_slip s
      WHERE s.tenant_id = $1 AND s.employee_id = $2
        AND s.status = 'finalized'
        AND s.period_start >= $3::date
        AND s.period_end < $4::date`,
    [tx.tenantId, employeeId, year.start, periodStart],
  );
  return {
    taxableEarnings: rows[0]?.taxable ?? '0',
    taxDeducted: rows[0]?.deducted ?? '0',
  };
}

export { financialYearOf, monthsRemainingInFinancialYear };
