import type { TenantTx } from '../../infra/db/pool.ts';
import { audit } from '../../infra/audit.ts';
import { conflict, notFound, unprocessable } from '../../infra/errors.ts';
import { financialYearOf } from '../tenant/financial-year.ts';
import { ensureTaxYear } from './tax-year.ts';

/**
 * What an employee brought into the financial year from a previous employer.
 *
 * Two numbers, and both matter. Without `opening_taxable_earnings` the annual liability is
 * computed on the months we paid alone, so a mid-year joiner looks like a low earner and is
 * under-deducted. Without `opening_tds` we would then re-collect tax the previous employer
 * already withheld. They are only correct together.
 *
 * Declared per employee per financial year, amendable while it can still make a difference
 * and frozen once it cannot: the moment a slip in that year is finalized, the figure has
 * been acted on and changing it would make a finalized payslip unexplainable.
 */

export type TaxOpening = {
  id: string;
  employee_id: string;
  financial_year: string;
  opening_taxable_earnings: string;
  opening_tds: string;
  source: 'previous_employer' | 'migration' | 'correction';
  note: string | null;
};

export type RecordOpeningInput = {
  employeeId: string;
  financialYear: string;
  openingTaxableEarnings: number;
  openingTds: number;
  source?: 'previous_employer' | 'migration' | 'correction';
  note?: string;
};

/**
 * Records or amends the opening balance.
 *
 * Refuses once a slip for that employee in that financial year has been finalized. That is
 * the right boundary rather than "once any payroll has run": a draft or cancelled run has
 * not withheld anything from anyone, so the figure is still safely correctable, while a
 * finalized slip has.
 */
export async function recordOpening(
  tx: TenantTx,
  input: RecordOpeningInput,
): Promise<{ id: string; amended: boolean }> {
  const employee = await tx.query<{ joining_date: string }>(
    `SELECT to_char(joining_date, 'YYYY-MM-DD') AS joining_date
       FROM core.employee WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, input.employeeId],
  );
  if (!employee.rows[0]) throw notFound('Employee');

  const fyStartMonth = await tenantFinancialYearStart(tx);
  // Resolving the label through the tax-year record rather than arithmetic alone means the
  // opening balance is attached to a year that exists, with the boundaries payroll will
  // actually assess against — the two can no longer disagree.
  const parsed = parseFinancialYear(input.financialYear, fyStartMonth);
  const year = await ensureTaxYear(tx, parsed.start, fyStartMonth);
  if (year.status === 'closed') {
    throw conflict(
      'tax_year_closed',
      `Tax year ${year.label} is closed. Reopen it, or correct through a supplementary run.`,
    );
  }

  if (input.openingTaxableEarnings < 0 || input.openingTds < 0) {
    throw unprocessable('negative_opening_balance', 'Opening balances cannot be negative');
  }
  if (input.openingTds > input.openingTaxableEarnings) {
    // Not a hard impossibility in exotic cases, but overwhelmingly a data-entry transposition
    // — and one that would suppress this employee's withholding for the rest of the year.
    throw unprocessable(
      'implausible_opening_balance',
      'Opening TDS exceeds opening taxable earnings. Check the figures from the previous employer.',
      { opening_taxable_earnings: input.openingTaxableEarnings, opening_tds: input.openingTds },
    );
  }

  const finalized = await tx.query<{ count: string }>(
    `SELECT count(*) AS count
       FROM payroll.salary_slip
      WHERE tenant_id = $1 AND employee_id = $2
        AND status = 'finalized'
        AND period_start >= $3::date AND period_end <= $4::date`,
    [tx.tenantId, input.employeeId, year.start_date, year.end_date],
  );
  if (Number(finalized.rows[0]?.count ?? 0) > 0) {
    throw conflict(
      'payroll_already_finalized',
      `A payslip for ${input.financialYear} has already been finalized for this employee. `
        + 'The opening balance was used to compute it and can no longer be changed; correct it '
        + 'through a supplementary run.',
    );
  }

  const existing = await tx.query<{ id: string; opening_taxable_earnings: string; opening_tds: string }>(
    `SELECT id, opening_taxable_earnings, opening_tds
       FROM payroll.employee_tax_opening
      WHERE tenant_id = $1 AND employee_id = $2 AND financial_year = $3`,
    [tx.tenantId, input.employeeId, input.financialYear],
  );
  const before = existing.rows[0];

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO payroll.employee_tax_opening
       (tenant_id, employee_id, tax_year_id, financial_year, opening_taxable_earnings, opening_tds,
        source, note, created_by)
     VALUES ($1, $2, $9, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, employee_id, financial_year) DO UPDATE
       SET opening_taxable_earnings = EXCLUDED.opening_taxable_earnings,
           opening_tds = EXCLUDED.opening_tds,
           source = EXCLUDED.source,
           note = EXCLUDED.note,
           tax_year_id = EXCLUDED.tax_year_id
     RETURNING id`,
    [
      tx.tenantId,
      input.employeeId,
      input.financialYear,
      input.openingTaxableEarnings,
      input.openingTds,
      input.source ?? (before ? 'correction' : 'previous_employer'),
      input.note ?? null,
      tx.actor.userId,
      year.id,
    ],
  );

  await audit(tx, {
    entityType: 'employee_tax_opening',
    entityId: rows[0]!.id,
    action: before ? 'tax.opening.amended' : 'tax.opening.recorded',
    before: before
      ? { taxable_earnings: before.opening_taxable_earnings, tds: before.opening_tds }
      : undefined,
    after: {
      employee_id: input.employeeId,
      financial_year: input.financialYear,
      taxable_earnings: input.openingTaxableEarnings,
      tds: input.openingTds,
      source: input.source ?? (before ? 'correction' : 'previous_employer'),
    },
  });

  return { id: rows[0]!.id, amended: Boolean(before) };
}

/**
 * The opening balance for one employee and tax year, or zeroes when none was declared.
 *
 * Keyed by the tax year's id rather than its label. A label is a display string that a
 * tenant changing its financial-year start month can make ambiguous; the id cannot be.
 */
export async function loadOpening(
  tx: TenantTx,
  employeeId: string,
  taxYearId: string,
): Promise<{ taxableEarnings: string; tds: string; declared: boolean }> {
  const { rows } = await tx.query<{ opening_taxable_earnings: string; opening_tds: string }>(
    `SELECT opening_taxable_earnings, opening_tds
       FROM payroll.employee_tax_opening
      WHERE tenant_id = $1 AND employee_id = $2 AND tax_year_id = $3`,
    [tx.tenantId, employeeId, taxYearId],
  );
  const row = rows[0];
  return {
    taxableEarnings: row?.opening_taxable_earnings ?? '0',
    tds: row?.opening_tds ?? '0',
    // Recorded in the snapshot so a payslip can distinguish "joined in April, nothing to
    // carry" from "joined in October and nobody asked them for a Form 12B".
    declared: Boolean(row),
  };
}

export async function listOpenings(
  tx: TenantTx,
  filter: { employeeId?: string; financialYear?: string },
): Promise<TaxOpening[]> {
  const { rows } = await tx.query<TaxOpening>(
    `SELECT o.id, o.employee_id, o.financial_year, o.opening_taxable_earnings,
            o.opening_tds, o.source, o.note
       FROM payroll.employee_tax_opening o
      WHERE o.tenant_id = $1
        AND ($2::uuid IS NULL OR o.employee_id = $2)
        AND ($3::text IS NULL OR o.financial_year = $3)
      ORDER BY o.financial_year DESC, o.employee_id`,
    [tx.tenantId, filter.employeeId ?? null, filter.financialYear ?? null],
  );
  return rows;
}

/** The tenant's financial-year start month. Read once per run, not per employee. */
export async function tenantFinancialYearStart(tx: TenantTx): Promise<number> {
  const { rows } = await tx.query<{ fy_start_month: number }>(
    'SELECT fy_start_month FROM identity.tenant WHERE id = $1',
    [tx.tenantId],
  );
  const month = rows[0]?.fy_start_month;
  if (!month) throw notFound('Tenant');
  return month;
}

/**
 * Turns a `2026-27` label back into dates, and refuses one that does not exist.
 *
 * A typo here would silently attach an opening balance to a year no payroll runs in, and
 * the employee would be under-deducted with no visible error anywhere.
 */
function parseFinancialYear(label: string, startMonth: number): { start: string; end: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(label);
  if (!match) {
    throw unprocessable('invalid_financial_year', 'Expected a financial year like 2026-27');
  }

  const startYear = Number(match[1]);
  const derived = financialYearOf(`${startYear}-${String(startMonth).padStart(2, '0')}-01`, startMonth);
  if (derived.label !== label) {
    throw unprocessable(
      'invalid_financial_year',
      `${label} is not a financial year for this tenant. With a year starting in month ${startMonth}, `
        + `the year beginning ${startYear} is ${derived.label}.`,
    );
  }
  return { start: derived.start, end: derived.end };
}
