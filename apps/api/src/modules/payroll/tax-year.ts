import type { TenantTx } from '../../infra/db/pool.ts';
import { audit } from '../../infra/audit.ts';
import { conflict, notFound, unprocessable } from '../../infra/errors.ts';
import { financialYearOf } from '../tenant/financial-year.ts';

/**
 * The tax year.
 *
 * Distinct from `payroll_period`, which is the cycle an employee is paid for. A year
 * contains many periods, and almost everything statutory — exemption caps, the proof
 * cutoff, surcharge slabs, opening balances — is a fact about the year rather than the
 * month. Before this existed, the year was derived in application code from a date and a
 * start month, which left nowhere to put any of that.
 *
 * Years are created on demand rather than by a scheduled job: the first payroll period or
 * tax record that needs one brings it into being, with boundaries taken from the tenant's
 * configured start month. That avoids a tenant having to remember to open a year before
 * they can run payroll, and avoids creating years nobody will ever use.
 */

export type TaxYear = {
  id: string;
  label: string;
  start_date: string;
  end_date: string;
  status: 'open' | 'closed';
  proof_cutoff_date: string | null;
};

/**
 * The tax year containing `date`, creating it if the tenant has not used it yet.
 *
 * `ON CONFLICT DO NOTHING` then re-read rather than a check-then-insert: two payroll runs
 * created concurrently in a tenant's first month would otherwise race, and one would fail
 * on the unique constraint for no reason the operator could act on.
 */
export async function ensureTaxYear(
  tx: TenantTx,
  date: string,
  fyStartMonth: number,
): Promise<TaxYear> {
  const derived = financialYearOf(date, fyStartMonth);

  await tx.query(
    `INSERT INTO payroll.tax_year (tenant_id, label, start_date, end_date)
     VALUES ($1, $2, $3::date, $4::date)
     ON CONFLICT (tenant_id, label) DO NOTHING`,
    [tx.tenantId, derived.label, derived.start, derived.end],
  );

  const { rows } = await tx.query<TaxYear>(
    `SELECT id, label, to_char(start_date, 'YYYY-MM-DD') AS start_date,
            to_char(end_date, 'YYYY-MM-DD') AS end_date, status,
            to_char(proof_cutoff_date, 'YYYY-MM-DD') AS proof_cutoff_date
       FROM payroll.tax_year
      WHERE tenant_id = $1 AND label = $2`,
    [tx.tenantId, derived.label],
  );

  const year = rows[0];
  if (!year) throw notFound('Tax year');

  // A tenant whose start month changed after a year was created would otherwise get a year
  // whose boundaries no longer match its own configuration, and every annualisation in it
  // would be off. Refuse rather than silently using stale boundaries.
  if (year.start_date !== derived.start || year.end_date !== derived.end) {
    throw conflict(
      'tax_year_boundaries_changed',
      `Tax year ${year.label} runs ${year.start_date} to ${year.end_date}, but this tenant's `
        + `financial year now starts in month ${fyStartMonth}. Close the existing year or restore `
        + 'the original start month; changing it mid-year would silently reprice every tax calculation.',
      { existing: { start: year.start_date, end: year.end_date }, derived },
    );
  }

  return year;
}

/** The tax year a payroll period belongs to. */
export async function taxYearForPeriod(tx: TenantTx, payrollPeriodId: string): Promise<TaxYear> {
  const { rows } = await tx.query<TaxYear>(
    `SELECT ty.id, ty.label, to_char(ty.start_date, 'YYYY-MM-DD') AS start_date,
            to_char(ty.end_date, 'YYYY-MM-DD') AS end_date, ty.status,
            to_char(ty.proof_cutoff_date, 'YYYY-MM-DD') AS proof_cutoff_date
       FROM payroll.payroll_period p
       JOIN payroll.tax_year ty ON ty.id = p.tax_year_id
      WHERE p.tenant_id = $1 AND p.id = $2`,
    [tx.tenantId, payrollPeriodId],
  );
  const year = rows[0];
  if (!year) throw notFound('Tax year for this payroll period');
  return year;
}

/**
 * How many payroll periods of the year are still to be paid, counting this one.
 *
 * Counted from the periods the tenant has actually defined rather than assumed to be
 * twelve, so a tenant paying fortnightly annualises over their own cycle. Falls back to a
 * month count when the year has not been fully laid out yet, which is the common case: most
 * tenants create each month's period shortly before running it.
 */
export async function periodsRemainingInYear(
  tx: TenantTx,
  taxYearId: string,
  periodEnd: string,
): Promise<{ remaining: number; basis: 'defined_periods' | 'months' }> {
  const { rows } = await tx.query<{ remaining: number; days_covered: number }>(
    `SELECT count(*) FILTER (WHERE period_end >= $3::date)::int AS remaining,
            COALESCE(sum(period_end - period_start + 1), 0)::int AS days_covered
       FROM payroll.payroll_period
      WHERE tenant_id = $1 AND tax_year_id = $2`,
    [tx.tenantId, taxYearId, periodEnd],
  );

  const year = await tx.query<{ start_date: string; end_date: string }>(
    `SELECT to_char(start_date, 'YYYY-MM-DD') AS start_date,
            to_char(end_date, 'YYYY-MM-DD') AS end_date
       FROM payroll.tax_year WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, taxYearId],
  );
  const bounds = year.rows[0];
  if (!bounds) throw notFound('Tax year');

  // Only trust the defined periods once they cover the whole year. A tenant three months in
  // would otherwise annualise over three periods and deduct a year of tax in a quarter.
  //
  // Measured in days covered rather than periods counted, because the cycle is the tenant's
  // choice: four quarters cover a year exactly as well as twelve months do, and counting
  // periods against months would have sent every non-monthly tenant down the fallback for
  // ever. Payroll periods do not overlap, so the sum is the coverage.
  const daysInYear = daysBetween(bounds.start_date, bounds.end_date);
  if ((rows[0]?.days_covered ?? 0) >= daysInYear) {
    return { remaining: Math.max(1, rows[0]!.remaining), basis: 'defined_periods' };
  }

  const monthsInYear = monthsBetween(bounds.start_date, bounds.end_date);
  return { remaining: monthsRemaining(bounds.start_date, periodEnd, monthsInYear), basis: 'months' };
}

export async function listTaxYears(tx: TenantTx): Promise<TaxYear[]> {
  const { rows } = await tx.query<TaxYear>(
    `SELECT id, label, to_char(start_date, 'YYYY-MM-DD') AS start_date,
            to_char(end_date, 'YYYY-MM-DD') AS end_date, status,
            to_char(proof_cutoff_date, 'YYYY-MM-DD') AS proof_cutoff_date
       FROM payroll.tax_year WHERE tenant_id = $1
      ORDER BY start_date DESC`,
    [tx.tenantId],
  );
  return rows;
}

/**
 * Sets the date after which an unverified declaration stops reducing tax.
 *
 * Changing it is audited as sensitive: it moves the withholding of every employee in the
 * year who declared an exemption and has not proved it.
 */
export async function setProofCutoff(
  tx: TenantTx,
  taxYearId: string,
  cutoff: string | null,
): Promise<TaxYear> {
  const { rows } = await tx.query<TaxYear & { previous: string | null }>(
    `UPDATE payroll.tax_year
        SET proof_cutoff_date = $3::date
      WHERE tenant_id = $1 AND id = $2 AND status = 'open'
      RETURNING id, label, to_char(start_date, 'YYYY-MM-DD') AS start_date,
                to_char(end_date, 'YYYY-MM-DD') AS end_date, status,
                to_char(proof_cutoff_date, 'YYYY-MM-DD') AS proof_cutoff_date,
                NULL::text AS previous`,
    [tx.tenantId, taxYearId, cutoff],
  );
  const year = rows[0];
  if (!year) {
    throw unprocessable(
      'tax_year_not_open',
      'Only an open tax year can have its proof cutoff changed',
    );
  }

  await audit(tx, {
    entityType: 'tax_year',
    entityId: year.id,
    action: 'tax.year.proof_cutoff_set',
    after: { label: year.label, proof_cutoff_date: cutoff },
  });

  return year;
}

/** Inclusive day count, so a year that starts and ends on the same day is one day. */
function daysBetween(start: string, end: string): number {
  const ms = Date.UTC(...ymd(end)) - Date.UTC(...ymd(start));
  return Math.round(ms / 86_400_000) + 1;
}

function ymd(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y!, m! - 1, d!];
}

function monthsBetween(start: string, end: string): number {
  const [sy, sm] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  return (ey! - sy!) * 12 + (em! - sm!) + 1;
}

/** Months left in the year, counting the one being paid. Never below one. */
function monthsRemaining(yearStart: string, periodEnd: string, monthsInYear: number): number {
  const elapsed = monthsBetween(yearStart, periodEnd);
  return Math.max(1, monthsInYear - elapsed + 1);
}
