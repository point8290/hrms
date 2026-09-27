/**
 * Financial-year arithmetic, driven by the tenant's own year start.
 *
 * These were previously three functions in `snapshot.ts` that hardcoded April and hardcoded
 * a twelve-month year. `identity.tenant.fy_start_month` has existed since 0002 and was
 * never consulted, so a tenant on a January financial year got the wrong number of months
 * remaining — and therefore the wrong monthly TDS, every month.
 *
 * Kept as pure functions over `YYYY-MM-DD` strings and a start month, so the whole set is
 * unit-testable without a database and produces the same answer in Node and in a test.
 */

export type FinancialYear = {
  /** Label, e.g. `2026-27`. Matches `tax_declaration.financial_year`. */
  label: string;
  /** First day, `YYYY-MM-DD`. */
  start: string;
  /** Last day, `YYYY-MM-DD`. */
  end: string;
  /** Months in the year. Twelve, always — but named so the arithmetic below reads. */
  totalMonths: number;
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function assertStartMonth(startMonth: number): void {
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new Error(`financial year start month must be 1-12, got ${startMonth}`);
  }
}

/**
 * The financial year containing `date`.
 *
 * India's default is April–March, which is why this is configuration rather than a calendar
 * year: a payroll year that disagrees with the tenant's statutory year makes every year-end
 * reconciliation manual.
 */
export function financialYearOf(date: string, startMonth: number): FinancialYear {
  assertStartMonth(startMonth);

  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const startYear = month >= startMonth ? year : year - 1;

  const start = `${pad4(startYear)}-${pad2(startMonth)}-01`;
  const endExclusive = `${pad4(startYear + 1)}-${pad2(startMonth)}-01`;
  const end = addDays(endExclusive, -1);

  // A calendar-year tenant labels the year by itself (`2026-26` would be absurd), every
  // other start month labels it by the span it covers.
  const label =
    startMonth === 1
      ? `${pad4(startYear)}-${pad2(startYear % 100)}`
      : `${pad4(startYear)}-${pad2((startYear + 1) % 100)}`;

  return { label, start, end, totalMonths: 12 };
}

/**
 * Months left in the financial year, counting the period being paid.
 *
 * Monthly TDS is the outstanding liability spread over the months still to be paid, so this
 * figure decides how much tax is withheld now. In the final month it is 1, which is what
 * makes that month absorb any under-deduction from earlier in the year.
 */
export function monthsRemainingInFinancialYear(periodEnd: string, startMonth: number): number {
  assertStartMonth(startMonth);

  const month = Number(periodEnd.slice(5, 7));
  // 1-based position of this month within the financial year.
  const index = month >= startMonth ? month - startMonth + 1 : month + 12 - startMonth + 1;
  return 13 - index;
}

/** Months already completed in the financial year, excluding the period being paid. */
export function monthsElapsedInFinancialYear(periodEnd: string, startMonth: number): number {
  return 12 - monthsRemainingInFinancialYear(periodEnd, startMonth);
}
