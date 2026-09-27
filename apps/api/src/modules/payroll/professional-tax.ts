import type { TenantTx } from '../../infra/db/pool.ts';

/**
 * Professional tax jurisdiction: which state an employee is liable in, and how we know.
 *
 * PT is levied by states, not by the union, so the only question that matters is *where*.
 * The chain is deliberate and ordered, and both steps already existed before this phase —
 * what was missing was writing down which wins and recording that on the snapshot:
 *
 *   1. **`core.tax_profile.pt_state_code`** — an explicit assertion that this employee is
 *      liable in that state. Effective-dated, so an employee who transfers keeps their old
 *      liability on old periods. This is the authority when present.
 *   2. **the work location's `state_code`** — where the employee actually works, inherited
 *      from `core.location`. A location fact rather than a tax assertion, which is why
 *      ADR-014 treats it as weaker: it resolves a rule but does not by itself make PT
 *      mandatory.
 *
 * Residential address is deliberately **not** in the chain. The system holds no residential
 * state, and PT follows the place of employment; inferring it from where someone lives would
 * be a guess dressed as a fact.
 *
 * Both steps resolve **as at the payroll period's end**, never today. That is what makes a
 * recalculation of an old period reproduce it: an employee who moved from Karnataka to
 * Maharashtra in October has their September payroll recalculated against Karnataka, because
 * the tax profile row effective in September still says so.
 */

export type PtStateSource = 'tax_profile' | 'work_location' | 'none';

export type ProfessionalTaxContext = {
  /** The resolved jurisdiction, or null when the employee has none. */
  state_code: string | null;
  state_source: PtStateSource;
  /** Whether a rule was actually found for that jurisdiction. */
  rule_resolved: boolean;
  rule_key: string | null;
  rule_effective_from: string | null;
  /**
   * Whether this employee must have a resolvable rule. True when they assert a state on
   * their tax profile (ADR-014) or the tenant has opted every employee in.
   */
  required: boolean;
  /** The calendar month of the period end, for a state with a special instalment. */
  period_month: number;
  /** PT already deducted this tax year, for a state with an annual ceiling. */
  paid_this_year: string;
  reason?: string;
};

/**
 * Resolves and freezes everything PT depends on for one employee and one period.
 *
 * Deliberately independent of the income-tax regime. An employee electing the new regime
 * still pays their state's professional tax: the two are different levies by different
 * governments, and coupling them would be wrong whichever way it leaned.
 */
export async function buildProfessionalTaxContext(
  tx: TenantTx,
  employeeId: string,
  ctx: {
    /** Asserted on the tax profile effective for this period, if any. */
    assertedStateCode: string | null;
    /** The work location's state, as a fallback. */
    locationStateCode: string | null;
    periodStart: string;
    periodEnd: string;
    taxYearStart: string;
    resolvedRules: Record<string, unknown>;
    requireProfessionalTax: boolean;
  },
): Promise<ProfessionalTaxContext> {
  const stateCode = ctx.assertedStateCode ?? ctx.locationStateCode ?? null;
  const stateSource: PtStateSource = ctx.assertedStateCode
    ? 'tax_profile'
    : ctx.locationStateCode
      ? 'work_location'
      : 'none';

  // An explicit tax-profile state is an assertion of liability and makes PT mandatory
  // (ADR-014). The tenant flag is the opt-in that extends that to a location-derived state.
  const required = Boolean(ctx.assertedStateCode) || ctx.requireProfessionalTax;

  const periodMonth = Number(ctx.periodEnd.slice(5, 7));
  const paidThisYear = await professionalTaxPaidThisYear(
    tx,
    employeeId,
    ctx.taxYearStart,
    ctx.periodStart,
  );

  if (!stateCode) {
    return {
      state_code: null,
      state_source: 'none',
      rule_resolved: false,
      rule_key: null,
      rule_effective_from: null,
      required,
      period_month: periodMonth,
      paid_this_year: paidThisYear,
      reason:
        'this employee has no professional tax state: none is asserted on their tax profile '
        + 'and their work location has no state recorded',
    };
  }

  const ruleKey = `professional_tax:${stateCode}`;
  const rule = ctx.resolvedRules[ruleKey] as
    | { rule_id?: string; version?: number; config?: Record<string, unknown> }
    | undefined;

  if (!rule?.config) {
    // Recorded as unsupported rather than silently deducting nothing. Whether that is a
    // refusal is `required`'s job; what matters here is that "this state levies no PT" and
    // "nobody has configured this state" can never again look the same on a payslip.
    return {
      state_code: stateCode,
      state_source: stateSource,
      rule_resolved: false,
      rule_key: ruleKey,
      rule_effective_from: null,
      required,
      period_month: periodMonth,
      paid_this_year: paidThisYear,
      reason:
        `no professional tax rule is configured for state ${stateCode} as at ${ctx.periodEnd}; `
        + 'that state is not supported by this deployment',
    };
  }

  const effectiveFrom = await ruleEffectiveFrom(tx, stateCode, ctx.periodEnd);

  return {
    state_code: stateCode,
    state_source: stateSource,
    rule_resolved: true,
    rule_key: ruleKey,
    rule_effective_from: effectiveFrom,
    required,
    period_month: periodMonth,
    paid_this_year: paidThisYear,
  };
}

/**
 * Professional tax already deducted this tax year, from finalized slips only.
 *
 * Needed by a state with an annual ceiling. Summed from the slip's PT component lines
 * because PT has no column of its own — and should not get one: it is a statutory deduction
 * like PF and ESI, and a column holding a copy of one line's amount would be a second source
 * of truth that could disagree with it.
 *
 * Bounded strictly before this period so a recalculation of the current run never counts
 * its own earlier attempt, exactly as `taxYearToDate` does for income tax.
 */
export async function professionalTaxPaidThisYear(
  tx: TenantTx,
  employeeId: string,
  taxYearStart: string,
  periodStart: string,
): Promise<string> {
  const { rows } = await tx.query<{ paid: string }>(
    `SELECT COALESCE(SUM(c.amount), 0)::text AS paid
       FROM payroll.salary_slip s
       JOIN payroll.salary_slip_component c
         ON c.tenant_id = s.tenant_id AND c.salary_slip_id = s.id
      WHERE s.tenant_id = $1 AND s.employee_id = $2
        AND s.status = 'finalized'
        AND c.component_code_snapshot = 'PT'
        AND s.period_start >= $3::date
        AND s.period_end < $4::date`,
    [tx.tenantId, employeeId, taxYearStart, periodStart],
  );
  return rows[0]?.paid ?? '0';
}

/** When the rule governing this period came into force. Part of the audit trail. */
async function ruleEffectiveFrom(
  tx: TenantTx,
  stateCode: string,
  asOf: string,
): Promise<string | null> {
  const { rows } = await tx.query<{ effective_from: string }>(
    `SELECT to_char(effective_from, 'YYYY-MM-DD') AS effective_from
       FROM payroll.statutory_rule
      WHERE country_code = 'IN' AND rule_type = 'professional_tax' AND state_code = $1
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY (tenant_id IS NOT NULL) DESC, effective_from DESC, version DESC
      LIMIT 1`,
    [stateCode, asOf],
  );
  return rows[0]?.effective_from ?? null;
}

/** Whether the tenant insists every employee resolve to a configured PT jurisdiction. */
export async function requireProfessionalTax(tx: TenantTx): Promise<boolean> {
  const { rows } = await tx.query<{ require_professional_tax: boolean }>(
    'SELECT require_professional_tax FROM payroll.tenant_payroll_policy WHERE tenant_id = $1',
    [tx.tenantId],
  );
  // No policy row is the documented default state, not missing configuration.
  return rows[0]?.require_professional_tax ?? false;
}
