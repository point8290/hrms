import type { TenantTx } from '../../infra/db/pool.ts';
import { audit } from '../../infra/audit.ts';
import { conflict, notFound, unprocessable } from '../../infra/errors.ts';
import { ensureTaxYear, type TaxYear } from './tax-year.ts';
import { tenantFinancialYearStart } from './tax-opening.ts';

/**
 * Chapter VI-A exemptions: 80C, 80D and the rest, capped per financial year.
 *
 * The chain this file exists to make explicit, and which was entirely missing before:
 *
 *     declaration  ->  eligibility  ->  financial-year rule  ->  statutory cap
 *                  ->  allowed exemption  ->  snapshot  ->  tax calculation
 *
 * Three of those were absent. A declaration was a free-form `{key: number}` map summed into
 * one number and subtracted from the old regime's taxable income with no ceiling at all, so
 * an employee could declare any amount under any spelling and have all of it deducted.
 *
 * Two distinctions carry the design, and collapsing either would produce a plausible wrong
 * number rather than an obvious one:
 *
 *   * **eligible is not declared.** A verifier narrows what was declared to what is
 *     supportable. Until someone does, the declared figure stands — which is what this
 *     system already did, kept deliberately rather than replaced.
 *   * **the cap is not eligibility.** Declaring 200,000 under 80C and having 180,000
 *     accepted does not make the allowed exemption 150,000 *of the declared* amount; it
 *     makes it min(180,000, 150,000). The ceiling applies last, to whatever survived.
 *
 * This is deliberately *not* how HRA works, and the two must not be merged. HRA is a
 * period-level least-of-three that a tax year accumulates (ADR-016). A section exemption is
 * an annual figure with an annual ceiling — there is no monthly 80C, and dividing the cap by
 * twelve or multiplying a month by twelve would both be inventions.
 *
 * ## The proof cutoff (ADR-018)
 *
 * A declaration is a statement of intent; proof is what turns it into a deduction. The tax
 * year carries a `proof_cutoff_date`, and after it an unproved declaration stops reducing
 * tax:
 *
 *     declaration -> proof status -> cutoff evaluation -> eligible amount
 *                 -> section cap -> allowed exemption
 *
 * Four states, three of them stored. `declared`, `verified` and `rejected` are rows;
 * **unverified is derived** — still `declared` when the cutoff has passed. Storing it would
 * need a job flipping rows at midnight, and it would be wrong anyway: whether the cutoff has
 * passed is a question about a *payroll run*, not about the row, and two runs in the same
 * year legitimately answer it differently.
 *
 * The comparison happens **here and only here**, and is frozen as a boolean. The engine
 * never compares dates, so Node and Python cannot drift apart on a boundary or a timezone.
 */

export type ExemptionRule = {
  id: string;
  section_code: string;
  name: string;
  version: number;
  effective_from: string;
  effective_to: string | null;
  max_amount: string;
  applicable_regimes: string[];
  source: 'platform' | 'tenant';
};

/**
 * The rules in force for a tax year.
 *
 * Resolved against the year's **first day**, not against the payroll period's end. A cap is
 * an annual figure that the Finance Act sets for a whole year; resolving it per period would
 * let a rule change in October alter the ceiling for a year already half spent, and an
 * employee's 80C allowance would move between March and April payslips for no reason they
 * could act on.
 *
 * A tenant override outranks the platform default for the same section, matching how
 * `loadStatutoryRules` already resolves slab tables.
 */
export async function resolveExemptionRules(
  tx: TenantTx,
  taxYear: TaxYear,
): Promise<Record<string, ExemptionRule>> {
  const { rows } = await tx.query<ExemptionRule & { tenant_id: string | null }>(
    `SELECT DISTINCT ON (section_code)
            id, section_code, name, version,
            to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
            to_char(effective_to, 'YYYY-MM-DD') AS effective_to,
            max_amount, applicable_regimes, tenant_id,
            CASE WHEN tenant_id IS NULL THEN 'platform' ELSE 'tenant' END AS source
       FROM payroll.tax_exemption_rule
      WHERE country_code = 'IN'
        AND effective_from <= $1::date
        AND (effective_to IS NULL OR effective_to >= $1::date)
      ORDER BY section_code, (tenant_id IS NOT NULL) DESC, effective_from DESC, version DESC`,
    [taxYear.start_date],
  );

  const out: Record<string, ExemptionRule> = {};
  for (const row of rows) out[row.section_code] = row;
  return out;
}

/** Every section a tenant could declare under in a year, for a form to render. */
export async function listExemptionRules(
  tx: TenantTx,
  taxYearId?: string,
): Promise<ExemptionRule[]> {
  if (!taxYearId) {
    const { rows } = await tx.query<ExemptionRule>(
      `SELECT id, section_code, name, version,
              to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
              to_char(effective_to, 'YYYY-MM-DD') AS effective_to,
              max_amount, applicable_regimes,
              CASE WHEN tenant_id IS NULL THEN 'platform' ELSE 'tenant' END AS source
         FROM payroll.tax_exemption_rule
        WHERE country_code = 'IN'
        ORDER BY section_code, effective_from DESC`,
    );
    return rows;
  }

  const year = await loadTaxYear(tx, taxYearId);
  return Object.values(await resolveExemptionRules(tx, year)).sort((a, b) =>
    a.section_code.localeCompare(b.section_code),
  );
}

/**
 * Whether the tenant honours an unproved declaration, and from when.
 *
 * `require_proof_after_cutoff` and `require_proof_cutoff` answer different questions, and
 * conflating them would fail closed on every tenant that has never set a date:
 *
 *   * `require_proof_after_cutoff` — given a cutoff exists and has passed, does an unproved
 *     declaration stop counting. Default true: the employer carries the liability for
 *     under-deduction.
 *   * `require_proof_cutoff` — must a cutoff exist at all. Default false, opt-in, and the
 *     only thing that makes a missing date a failure rather than "no cutoff".
 */
export type ProofPolicy = {
  requireProofAfterCutoff: boolean;
  requireProofCutoff: boolean;
};

export async function loadProofPolicy(tx: TenantTx): Promise<ProofPolicy> {
  const { rows } = await tx.query<{
    require_proof_after_cutoff: boolean;
    require_proof_cutoff: boolean;
  }>(
    `SELECT require_proof_after_cutoff, require_proof_cutoff
       FROM payroll.tenant_payroll_policy WHERE tenant_id = $1`,
    [tx.tenantId],
  );
  const policy = rows[0];
  // No row means the tenant has never configured a policy, which is the documented default
  // state from migration 0024 rather than a missing configuration.
  return {
    requireProofAfterCutoff: policy?.require_proof_after_cutoff ?? true,
    requireProofCutoff: policy?.require_proof_cutoff ?? false,
  };
}

/**
 * Has the proof cutoff passed, as at the date this payroll run is for?
 *
 * **Convention: the cutoff has passed on the cutoff date itself.** A cutoff of 31 January
 * means proof must be in *before* 31 January; a payroll period ending on or after it is
 * assessed as late. The stricter of the two readings, chosen because under-deduction is the
 * employer's liability and over-deduction is something the employee reclaims when they file.
 *
 * The reference date is the **payroll period's end**, not today. That is what makes the
 * decision reproducible: recalculating an April run in December must reach the same answer
 * it reached in April, and `now()` would silently make it a different one.
 */
export function cutoffPassed(referenceDate: string, cutoff: string | null): boolean {
  if (!cutoff) return false;
  return referenceDate >= cutoff;
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

export type ProofStatus = 'declared' | 'verified' | 'rejected';

export type DeclarationItem = {
  id: string;
  employee_id: string;
  tax_year_id: string;
  section_code: string;
  declared_amount: string;
  verified_amount: string | null;
  status: ProofStatus;
  previous_status: ProofStatus | null;
  verified_by: string | null;
  verified_at: string | null;
  proof_outcome_reason: string | null;
  note: string | null;
};

const ITEM_COLUMNS = `id, employee_id, tax_year_id, section_code, declared_amount,
            verified_amount, status, previous_status, verified_by,
            to_char(verified_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF') AS verified_at,
            proof_outcome_reason, note`;

export type DeclareInput = {
  employeeId: string;
  financialYear: string;
  regime?: 'old' | 'new';
  sectionCode: string;
  declaredAmount: number;
  note?: string;
};

/**
 * Records or amends one section's declaration.
 *
 * Amending replaces rather than adding a second row, and resets the proof lifecycle: a
 * figure that has changed has not been verified. The previous value is in the audit trail,
 * which is where a historical declaration belongs — a second live row for the same section
 * would have to be summed or chosen between, and neither rule was ever stated.
 */
export async function declareSection(
  tx: TenantTx,
  input: DeclareInput,
): Promise<{ id: string; amended: boolean; taxYearLabel: string; sectionCode: string }> {
  if (input.declaredAmount < 0) {
    throw unprocessable('negative_declaration', 'A declared amount cannot be negative');
  }

  const employee = await tx.query<{ id: string }>(
    'SELECT id FROM core.employee WHERE tenant_id = $1 AND id = $2',
    [tx.tenantId, input.employeeId],
  );
  if (!employee.rows[0]) throw notFound('Employee');

  const fyStartMonth = await tenantFinancialYearStart(tx);
  const year = await ensureTaxYearFromLabel(tx, input.financialYear, fyStartMonth);
  if (year.status === 'closed') {
    throw conflict('tax_year_closed', `Tax year ${year.label} is closed.`);
  }

  const sectionCode = input.sectionCode.toUpperCase();

  // A section nobody configured cannot be capped, and an uncapped deduction is exactly what
  // this phase exists to stop. Refused at the door rather than at calculation time, so the
  // employee finds out while they can still fix it instead of a month later on a payslip.
  const rules = await resolveExemptionRules(tx, year);
  const rule = rules[sectionCode];
  if (!rule) {
    throw unprocessable(
      'unknown_exemption_section',
      `Section ${sectionCode} is not configured for tax year ${year.label}.`,
      { section_code: sectionCode, tax_year: year.label, configured: Object.keys(rules).sort() },
    );
  }

  const declaration = await ensureParentDeclaration(tx, input, year);

  // Deliberately *not* refused once a payslip in the year is finalized, unlike an opening
  // balance or a rent declaration for a period already paid. The three are different kinds
  // of statement:
  //
  //   * an opening balance is a fact about the past — what a previous employer actually
  //     paid and withheld. Changing it after a slip used it makes that slip unexplainable.
  //   * a rent declaration covers a named stretch, so the months already paid are frozen
  //     and the months ahead are still open.
  //   * a section declaration is forward-looking intent for the whole year, and employees
  //     routinely revise it in January when they have actually made the investment they
  //     projected in April.
  //
  // Refusing here would make revision impossible from the second month onward, which is not
  // a rule anyone wants. Nothing retroactive happens: the finalized slips keep the figures
  // their snapshots froze, the immutability guard enforces that, and the annualisation
  // spreads the correction over the periods that remain — which is exactly what it is for.
  const existing = await tx.query<{ id: string; declared_amount: string; status: string }>(
    `SELECT id, declared_amount, status FROM compensation.tax_declaration_item
      WHERE tenant_id = $1 AND tax_declaration_id = $2 AND section_code = $3`,
    [tx.tenantId, declaration.id, sectionCode],
  );
  const before = existing.rows[0];

  let id: string;
  if (before) {
    // A figure that has changed has not been proved. The whole outcome goes with it —
    // amount, verifier, timestamp and reason — because leaving a verifier's name against a
    // number they never saw is worse than leaving none.
    await tx.query(
      `UPDATE compensation.tax_declaration_item
          SET declared_amount = $3, note = $4, status = 'declared', verified_amount = NULL,
              previous_status = status, verified_by = NULL, verified_at = NULL,
              proof_outcome_reason = NULL
        WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, before.id, input.declaredAmount, input.note ?? null],
    );
    id = before.id;
  } else {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO compensation.tax_declaration_item
         (tenant_id, tax_declaration_id, employee_id, tax_year_id, section_code,
          declared_amount, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        tx.tenantId, declaration.id, input.employeeId, year.id, sectionCode,
        input.declaredAmount, input.note ?? null, tx.actor.userId,
      ],
    );
    id = rows[0]!.id;
  }

  await audit(tx, {
    entityType: 'tax_declaration_item',
    entityId: id,
    action: before ? 'tax.exemption.amended' : 'tax.exemption.declared',
    before: before
      ? { declared_amount: before.declared_amount, status: before.status }
      : undefined,
    after: {
      employee_id: input.employeeId,
      tax_year: year.label,
      section_code: sectionCode,
      declared_amount: input.declaredAmount,
      statutory_cap: rule.max_amount,
      rule_version: rule.version,
    },
  });

  return { id, amended: Boolean(before), taxYearLabel: year.label, sectionCode };
}

/**
 * Records the outcome of examining proof: accepted, and for how much, or refused.
 *
 * This is the *eligibility* step and it is upstream of the ceiling — the amount recorded
 * here is what the cap is then applied to.
 *
 * Verification is what matters, not when it happened. A tenant whose HR policy allows late
 * proof simply verifies late, and the declaration becomes eligible again for the periods
 * still to be paid; nothing here refuses an outcome because the cutoff has passed. The
 * cutoff only decides what an *unproved* declaration is worth (ADR-018).
 */
export async function setProofOutcome(
  tx: TenantTx,
  itemId: string,
  outcome: { status: 'verified' | 'rejected'; eligibleAmount?: number; reason?: string },
): Promise<DeclarationItem> {
  if (outcome.status === 'verified' && outcome.eligibleAmount === undefined) {
    throw unprocessable(
      'eligible_amount_required',
      'Verifying a declaration requires the amount actually found eligible',
    );
  }
  if (outcome.status === 'rejected' && outcome.eligibleAmount !== undefined) {
    throw unprocessable(
      'eligible_amount_not_allowed',
      'A rejected declaration has no eligible amount',
    );
  }

  const current = await tx.query<{ status: ProofStatus; declared_amount: string }>(
    `SELECT status, declared_amount FROM compensation.tax_declaration_item
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tx.tenantId, itemId],
  );
  const before = current.rows[0];
  if (!before) throw notFound('Tax declaration item');

  // Nobody may be verified for more than they declared. Increasing the figure is an
  // amendment — a thing the employee asserts — not something a verifier does on their
  // behalf, and routing it through `declareSection` keeps the declared amount the
  // employee's own statement.
  if (
    outcome.status === 'verified'
    && outcome.eligibleAmount! > Number(before.declared_amount)
  ) {
    throw unprocessable(
      'verified_exceeds_declared',
      `Proof was accepted for ${outcome.eligibleAmount} but only `
        + `${before.declared_amount} was declared. Amend the declaration first; a verifier `
        + 'does not raise it on the employee\'s behalf.',
      { declared_amount: before.declared_amount, eligible_amount: outcome.eligibleAmount },
    );
  }

  const { rows } = await tx.query<DeclarationItem>(
    `UPDATE compensation.tax_declaration_item
        SET status = $3,
            verified_amount = $4,
            previous_status = status,
            verified_by = $5,
            verified_at = now(),
            proof_outcome_reason = $6
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${ITEM_COLUMNS}`,
    [
      tx.tenantId, itemId, outcome.status,
      outcome.status === 'verified' ? outcome.eligibleAmount : null,
      tx.actor.userId, outcome.reason ?? null,
    ],
  );
  const item = rows[0]!;

  await audit(tx, {
    entityType: 'tax_declaration_item',
    entityId: item.id,
    action: 'tax.exemption.proof_reviewed',
    before: { status: before.status, declared_amount: before.declared_amount },
    after: {
      employee_id: item.employee_id,
      section_code: item.section_code,
      old_status: before.status,
      new_status: item.status,
      declared_amount: item.declared_amount,
      verified_amount: item.verified_amount,
      reason: item.proof_outcome_reason,
    },
  });

  return item;
}

export async function listDeclarationItems(
  tx: TenantTx,
  filter: { employeeId?: string; taxYearId?: string },
): Promise<DeclarationItem[]> {
  const { rows } = await tx.query<DeclarationItem>(
    `SELECT ${ITEM_COLUMNS}
       FROM compensation.tax_declaration_item
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR employee_id = $2)
        AND ($3::uuid IS NULL OR tax_year_id = $3)
      ORDER BY section_code`,
    [tx.tenantId, filter.employeeId ?? null, filter.taxYearId ?? null],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** One section, frozen with everything needed to re-derive its allowed amount. */
export type ExemptionSnapshotSection = {
  section_code: string;
  name: string;
  declared_amount: string;
  /** What a verifier accepted. Null means nobody assessed it and the declared figure stands. */
  eligible_amount: string | null;
  status: ProofStatus;
  /**
   * The state the *calculation* should treat this as, which is not always the stored status.
   *
   * `unverified` is the one that is derived rather than stored: still `declared`, but the
   * cutoff for this run has passed. It is per-run by nature — the same row is `declared` for
   * a December run and `unverified` for a February one — so it belongs on the snapshot and
   * not on the row.
   */
  effective_status: ProofStatus | 'unverified';
  proof_cutoff_date: string | null;
  /** The date the cutoff was judged against: this run's period end, never `now()`. */
  cutoff_reference_date: string;
  cutoff_passed: boolean;
  /** Whether an unproved declaration stops counting once the cutoff has passed. */
  require_proof_after_cutoff: boolean;
  verified_at: string | null;
  rule_id: string | null;
  rule_version: number | null;
  rule_source: 'platform' | 'tenant' | null;
  max_amount: string | null;
  applicable_regimes: string[] | null;
  /** Set when the rule could not be resolved; the engine fails this employee on it. */
  unresolved_reason?: string;
};

export type ExemptionSnapshot = {
  tax_year_id: string;
  tax_year_label: string;
  regime: string;
  proof_cutoff_date: string | null;
  cutoff_reference_date: string;
  cutoff_passed: boolean;
  require_proof_after_cutoff: boolean;
  require_proof_cutoff: boolean;
  sections: ExemptionSnapshotSection[];
};

/**
 * Freezes every section declaration with the rule that governs it.
 *
 * The rule is copied in, not referenced: `max_amount` and `version` are part of the answer,
 * and a cap that changed next April must not silently re-price a run calculated in March.
 * The engine reads this and never `payroll.tax_exemption_rule`.
 *
 * A declared section whose rule cannot be resolved is snapshotted **with the reason and no
 * ceiling**, rather than dropped. Dropping it would mean an employee who declared 80C and
 * hit a configuration gap quietly received no exemption; carrying the gap forward lets the
 * engine fail that one employee with something an administrator can act on.
 */
export async function buildExemptionSnapshot(
  tx: TenantTx,
  employeeId: string,
  ctx: {
    taxYear: TaxYear;
    regime: string;
    /** This run's period end. The cutoff is judged against it, so the answer reproduces. */
    referenceDate: string;
  },
): Promise<ExemptionSnapshot> {
  const items = await tx.query<DeclarationItem>(
    `SELECT ${ITEM_COLUMNS}
       FROM compensation.tax_declaration_item
      WHERE tenant_id = $1 AND employee_id = $2 AND tax_year_id = $3
      ORDER BY section_code`,
    [tx.tenantId, employeeId, ctx.taxYear.id],
  );

  const policy = await loadProofPolicy(tx);
  const passed = cutoffPassed(ctx.referenceDate, ctx.taxYear.proof_cutoff_date);

  const base: ExemptionSnapshot = {
    tax_year_id: ctx.taxYear.id,
    tax_year_label: ctx.taxYear.label,
    regime: ctx.regime,
    proof_cutoff_date: ctx.taxYear.proof_cutoff_date,
    cutoff_reference_date: ctx.referenceDate,
    cutoff_passed: passed,
    require_proof_after_cutoff: policy.requireProofAfterCutoff,
    require_proof_cutoff: policy.requireProofCutoff,
    sections: [],
  };
  if (items.rows.length === 0) return base;

  const rules = await resolveExemptionRules(tx, ctx.taxYear);

  // A tenant that has asserted every year must have a cutoff, and whose year has none, is a
  // configuration gap rather than a tenant with no cutoff. Carried onto each section as an
  // unresolved reason so the engine fails this employee with something actionable — the
  // same shape a missing ceiling already uses.
  const missingCutoff =
    policy.requireProofCutoff && !ctx.taxYear.proof_cutoff_date
      ? `tenant policy requires a proof cutoff, but tax year ${ctx.taxYear.label} has none `
        + 'configured'
      : null;

  base.sections = items.rows.map((item) => {
    const shared = {
      section_code: item.section_code,
      declared_amount: item.declared_amount,
      eligible_amount: item.verified_amount,
      status: item.status,
      effective_status: effectiveStatus(item.status, passed, policy.requireProofAfterCutoff),
      proof_cutoff_date: ctx.taxYear.proof_cutoff_date,
      cutoff_reference_date: ctx.referenceDate,
      cutoff_passed: passed,
      require_proof_after_cutoff: policy.requireProofAfterCutoff,
      verified_at: item.verified_at,
    };

    const rule = rules[item.section_code];
    if (!rule) {
      return {
        ...shared,
        name: item.section_code,
        rule_id: null,
        rule_version: null,
        rule_source: null,
        max_amount: null,
        applicable_regimes: null,
        unresolved_reason:
          `no exemption rule is in force for section ${item.section_code} in tax year `
          + `${ctx.taxYear.label} (resolved as at ${ctx.taxYear.start_date})`,
      };
    }
    return {
      ...shared,
      name: rule.name,
      rule_id: rule.id,
      rule_version: rule.version,
      rule_source: rule.source,
      max_amount: rule.max_amount,
      applicable_regimes: rule.applicable_regimes,
      ...(missingCutoff ? { unresolved_reason: missingCutoff } : {}),
    };
  });

  return base;
}

/**
 * What the calculation should treat this declaration as.
 *
 * The only derivation: a declaration still unproved once the cutoff has passed becomes
 * `unverified`, which is the state that gives nothing. `verified` and `rejected` are already
 * decided and the cutoff does not revisit them — a proof accepted in February is accepted,
 * and a rejection stays a rejection.
 */
export function effectiveStatus(
  status: ProofStatus,
  passed: boolean,
  requireProofAfterCutoff: boolean,
): ProofStatus | 'unverified' {
  if (status !== 'declared') return status;
  return passed && requireProofAfterCutoff ? 'unverified' : 'declared';
}

// ---------------------------------------------------------------------------

async function loadTaxYear(tx: TenantTx, taxYearId: string): Promise<TaxYear> {
  const { rows } = await tx.query<TaxYear>(
    `SELECT id, label, to_char(start_date, 'YYYY-MM-DD') AS start_date,
            to_char(end_date, 'YYYY-MM-DD') AS end_date, status,
            to_char(proof_cutoff_date, 'YYYY-MM-DD') AS proof_cutoff_date
       FROM payroll.tax_year WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, taxYearId],
  );
  const year = rows[0];
  if (!year) throw notFound('Tax year');
  return year;
}

/** Turns a `2026-27` label into the tax-year record, creating it if this is its first use. */
async function ensureTaxYearFromLabel(
  tx: TenantTx,
  label: string,
  fyStartMonth: number,
): Promise<TaxYear> {
  const match = /^(\d{4})-(\d{2})$/.exec(label);
  if (!match) {
    throw unprocessable('invalid_financial_year', 'Expected a financial year like 2026-27');
  }
  const startYear = Number(match[1]);
  const year = await ensureTaxYear(
    tx,
    `${startYear}-${String(fyStartMonth).padStart(2, '0')}-01`,
    fyStartMonth,
  );
  if (year.label !== label) {
    throw unprocessable(
      'invalid_financial_year',
      `${label} is not a financial year for this tenant. With a year starting in month `
        + `${fyStartMonth}, the year beginning ${startYear} is ${year.label}.`,
    );
  }
  return year;
}

/**
 * The parent declaration, which holds the regime election and the lifecycle.
 *
 * Created on demand so declaring a section is one call rather than two. The regime is only
 * written when the caller states one: a section declaration is not the place to silently
 * re-elect someone's regime.
 */
async function ensureParentDeclaration(
  tx: TenantTx,
  input: DeclareInput,
  year: TaxYear,
): Promise<{ id: string; regime: string }> {
  const { rows } = await tx.query<{ id: string; regime: string }>(
    `INSERT INTO compensation.tax_declaration
       (tenant_id, employee_id, financial_year, tax_year_id, regime, status)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'new'), 'submitted')
     ON CONFLICT (tenant_id, employee_id, financial_year) DO UPDATE
       SET regime = COALESCE($5, compensation.tax_declaration.regime),
           tax_year_id = EXCLUDED.tax_year_id
     RETURNING id, regime`,
    [tx.tenantId, input.employeeId, year.label, year.id, input.regime ?? null],
  );
  return rows[0]!;
}
