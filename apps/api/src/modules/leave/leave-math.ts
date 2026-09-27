/**
 * Pure leave arithmetic. No database, no clock, no I/O — so the rules that decide how
 * much leave someone consumed are directly testable and cannot drift with the caller.
 *
 * Business semantics follow mature HR behaviour:
 *   - a leave type that excludes holidays does not consume holidays or weekly offs that
 *     fall inside the requested range
 *   - a half day is only meaningful on a day that would otherwise be consumed
 *   - balance is derived by summing ledger entries, never read from a stored field
 */

export type DayKind = 'working' | 'holiday' | 'weekly_off';

export type LeaveDay = {
  date: string; // YYYY-MM-DD
  kind: DayKind;
  counted: boolean;
  units: 0 | 0.5 | 1;
};

export type LeaveBreakdownInput = {
  startDate: string;
  endDate: string;
  startHalfDay: boolean;
  endHalfDay: boolean;
  /** Dates (YYYY-MM-DD) that are public holidays for this employee's calendar. */
  holidays: ReadonlySet<string>;
  /** Day-of-week numbers that are weekly offs, 0 = Sunday. */
  weeklyOffs: ReadonlySet<number>;
  /** When true the type consumes holidays and weekly offs inside the range. */
  includeHolidays: boolean;
  allowHalfDay: boolean;
};

export type LeaveBreakdown = {
  days: LeaveDay[];
  quantity: number;
  countedDays: number;
  excludedDays: number;
};

export function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Parses YYYY-MM-DD as a UTC calendar date — no local-timezone drift. */
export function parseDateKey(key: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) throw new Error(`Invalid date "${key}", expected YYYY-MM-DD`);
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (toDateKey(date) !== key) throw new Error(`Invalid calendar date "${key}"`);
  return date;
}

export function eachDate(startKey: string, endKey: string): string[] {
  const start = parseDateKey(startKey);
  const end = parseDateKey(endKey);
  if (end < start) throw new Error('endDate must not precede startDate');

  const out: string[] = [];
  for (let d = start; d <= end; d = new Date(d.getTime() + 86_400_000)) {
    out.push(toDateKey(d));
  }
  return out;
}

export function classifyDay(
  dateKey: string,
  holidays: ReadonlySet<string>,
  weeklyOffs: ReadonlySet<number>,
): DayKind {
  if (holidays.has(dateKey)) return 'holiday';
  if (weeklyOffs.has(parseDateKey(dateKey).getUTCDay())) return 'weekly_off';
  return 'working';
}

/**
 * Expands a leave request into per-day units and the total consumed quantity.
 *
 * Half days apply to the first and last *counted* day. A request whose entire range is
 * holiday or weekly off consumes nothing, and the caller rejects it — silently booking
 * zero-day leave would leave an approved application with no ledger effect.
 */
export function computeLeaveBreakdown(input: LeaveBreakdownInput): LeaveBreakdown {
  const dates = eachDate(input.startDate, input.endDate);

  const days: LeaveDay[] = dates.map((date) => {
    const kind = classifyDay(date, input.holidays, input.weeklyOffs);
    const counted = input.includeHolidays || kind === 'working';
    return { date, kind, counted, units: counted ? 1 : 0 };
  });

  const countedDays = days.filter((d) => d.counted);

  if (input.allowHalfDay && countedDays.length > 0) {
    const first = countedDays[0]!;
    const last = countedDays[countedDays.length - 1]!;

    if (input.startHalfDay && input.endHalfDay && first === last) {
      // Single consumed day marked half on both ends is still one half day.
      first.units = 0.5;
    } else {
      if (input.startHalfDay) first.units = 0.5;
      if (input.endHalfDay) last.units = 0.5;
    }
  }

  const quantity = round2(days.reduce((sum, d) => sum + d.units, 0));

  return {
    days,
    quantity,
    countedDays: countedDays.length,
    excludedDays: days.length - countedDays.length,
  };
}

export type LedgerEntry = {
  entryType: 'allocation' | 'consumption' | 'adjustment' | 'carry_forward' | 'expiry' | 'encashment' | 'reversal';
  quantity: number;
};

export type LeaveBalance = {
  allocated: number;
  consumed: number;
  adjusted: number;
  carriedForward: number;
  expired: number;
  encashed: number;
  balance: number;
};

/**
 * Derives balance from ledger entries.
 *
 * The ledger stores signed quantities (consumption is negative), so the balance is a
 * plain sum. The per-bucket figures are reported as positive magnitudes because that is
 * how a payslip or leave statement reads.
 */
export function deriveBalance(entries: readonly LedgerEntry[]): LeaveBalance {
  let allocated = 0;
  let consumed = 0;
  let adjusted = 0;
  let carriedForward = 0;
  let expired = 0;
  let encashed = 0;
  let balance = 0;

  for (const entry of entries) {
    balance += entry.quantity;
    switch (entry.entryType) {
      case 'allocation':
        allocated += entry.quantity;
        break;
      case 'consumption':
        consumed += Math.abs(entry.quantity);
        break;
      case 'carry_forward':
        carriedForward += entry.quantity;
        break;
      case 'expiry':
        expired += Math.abs(entry.quantity);
        break;
      case 'encashment':
        encashed += Math.abs(entry.quantity);
        break;
      case 'adjustment':
      case 'reversal':
        adjusted += entry.quantity;
        break;
    }
  }

  return {
    allocated: round2(allocated),
    consumed: round2(consumed),
    adjusted: round2(adjusted),
    carriedForward: round2(carriedForward),
    expired: round2(expired),
    encashed: round2(encashed),
    balance: round2(balance),
  };
}

export type SufficiencyInput = {
  balance: number;
  requested: number;
  allowNegative: boolean;
  maxNegative: number;
};

export function checkSufficientBalance(input: SufficiencyInput):
  | { ok: true }
  | { ok: false; shortfall: number; floor: number } {
  const floor = input.allowNegative ? -Math.abs(input.maxNegative) : 0;
  const after = round2(input.balance - input.requested);
  if (after >= floor) return { ok: true };
  return { ok: false, shortfall: round2(floor - after), floor };
}

/**
 * Carry-forward is capped by the policy, never by what happens to be left over.
 * Anything above the cap expires at period close rather than silently rolling on.
 */
export function computeCarryForward(closingBalance: number, maxCarryForward: number | null): {
  carried: number;
  expired: number;
} {
  const available = Math.max(0, closingBalance);
  if (maxCarryForward === null) return { carried: round2(available), expired: 0 };
  const carried = Math.min(available, Math.max(0, maxCarryForward));
  return { carried: round2(carried), expired: round2(available - carried) };
}

/**
 * Pro-rates an annual entitlement for someone who joins or leaves mid-period.
 * Rounded to the nearest half day, which is the smallest unit leave is booked in.
 */
export function proRateAllocation(
  annualAllocation: number,
  periodStart: string,
  periodEnd: string,
  eligibleFrom: string,
  eligibleTo?: string,
): number {
  const totalDays = eachDate(periodStart, periodEnd).length;
  const from = parseDateKey(eligibleFrom) > parseDateKey(periodStart) ? eligibleFrom : periodStart;
  const to = eligibleTo && parseDateKey(eligibleTo) < parseDateKey(periodEnd) ? eligibleTo : periodEnd;
  if (parseDateKey(to) < parseDateKey(from)) return 0;

  const eligibleDays = eachDate(from, to).length;
  return roundToHalf((annualAllocation * eligibleDays) / totalDays);
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function roundToHalf(value: number): number {
  return Math.round(value * 2) / 2;
}
