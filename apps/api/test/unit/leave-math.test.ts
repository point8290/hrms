import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSufficientBalance,
  computeCarryForward,
  computeLeaveBreakdown,
  deriveBalance,
  eachDate,
  proRateAllocation,
} from '../../src/modules/leave/leave-math.ts';

const SUNDAY_OFF = new Set([0]);
const NO_HOLIDAYS = new Set<string>();

function breakdown(overrides: Partial<Parameters<typeof computeLeaveBreakdown>[0]> = {}) {
  return computeLeaveBreakdown({
    startDate: '2026-03-02',
    endDate: '2026-03-04',
    startHalfDay: false,
    endHalfDay: false,
    holidays: NO_HOLIDAYS,
    weeklyOffs: SUNDAY_OFF,
    includeHolidays: false,
    allowHalfDay: true,
    ...overrides,
  });
}

describe('eachDate', () => {
  it('is inclusive of both ends', () => {
    assert.deepEqual(eachDate('2026-03-02', '2026-03-04'), ['2026-03-02', '2026-03-03', '2026-03-04']);
  });

  it('crosses a month boundary', () => {
    assert.deepEqual(eachDate('2026-02-27', '2026-03-01'), ['2026-02-27', '2026-02-28', '2026-03-01']);
  });

  it('handles a leap day', () => {
    assert.ok(eachDate('2028-02-27', '2028-03-01').includes('2028-02-29'));
  });

  it('rejects a reversed range', () => {
    assert.throws(() => eachDate('2026-03-04', '2026-03-02'), /must not precede/);
  });

  it('rejects a date that does not exist', () => {
    assert.throws(() => eachDate('2026-02-30', '2026-02-30'), /Invalid calendar date/);
  });
});

describe('computeLeaveBreakdown', () => {
  it('counts every working day in the range', () => {
    assert.equal(breakdown().quantity, 3);
  });

  it('skips a weekly off when the type excludes holidays', () => {
    // 2026-03-08 is a Sunday.
    const result = breakdown({ startDate: '2026-03-06', endDate: '2026-03-09' });
    assert.equal(result.quantity, 3);
    assert.equal(result.excludedDays, 1);
    assert.equal(result.days.find((d) => d.date === '2026-03-08')?.kind, 'weekly_off');
  });

  it('consumes weekly offs when the type includes holidays', () => {
    const result = breakdown({ startDate: '2026-03-06', endDate: '2026-03-09', includeHolidays: true });
    assert.equal(result.quantity, 4);
    assert.equal(result.excludedDays, 0);
  });

  it('skips a public holiday inside the range', () => {
    const result = breakdown({
      startDate: '2026-03-02',
      endDate: '2026-03-04',
      holidays: new Set(['2026-03-03']),
    });
    assert.equal(result.quantity, 2);
    assert.equal(result.days.find((d) => d.date === '2026-03-03')?.units, 0);
  });

  it('applies a half day at each end', () => {
    const result = breakdown({ startHalfDay: true, endHalfDay: true });
    assert.equal(result.quantity, 2);
  });

  it('treats a single day marked half on both ends as one half day', () => {
    const result = breakdown({
      startDate: '2026-03-02',
      endDate: '2026-03-02',
      startHalfDay: true,
      endHalfDay: true,
    });
    assert.equal(result.quantity, 0.5);
  });

  it('ignores half-day flags when the leave type forbids them', () => {
    const result = breakdown({ startHalfDay: true, endHalfDay: true, allowHalfDay: false });
    assert.equal(result.quantity, 3);
  });

  it('applies the half day to the first COUNTED day, not the calendar first day', () => {
    // Range starts on a Sunday; the half day must land on Monday 2026-03-09.
    const result = breakdown({ startDate: '2026-03-08', endDate: '2026-03-10', startHalfDay: true });
    assert.equal(result.quantity, 1.5);
    assert.equal(result.days.find((d) => d.date === '2026-03-09')?.units, 0.5);
    assert.equal(result.days.find((d) => d.date === '2026-03-08')?.units, 0);
  });

  it('consumes nothing when the whole range is non-working', () => {
    const result = breakdown({
      startDate: '2026-03-07',
      endDate: '2026-03-08',
      weeklyOffs: new Set([0, 6]),
    });
    assert.equal(result.quantity, 0);
    assert.equal(result.countedDays, 0);
  });
});

describe('deriveBalance', () => {
  it('sums a full ledger lifecycle', () => {
    const balance = deriveBalance([
      { entryType: 'allocation', quantity: 18 },
      { entryType: 'carry_forward', quantity: 5 },
      { entryType: 'consumption', quantity: -3.5 },
      { entryType: 'consumption', quantity: -1 },
      { entryType: 'expiry', quantity: -2 },
      { entryType: 'encashment', quantity: -4 },
      { entryType: 'adjustment', quantity: 1.5 },
    ]);
    assert.equal(balance.allocated, 18);
    assert.equal(balance.carriedForward, 5);
    assert.equal(balance.consumed, 4.5);
    assert.equal(balance.expired, 2);
    assert.equal(balance.encashed, 4);
    assert.equal(balance.adjusted, 1.5);
    assert.equal(balance.balance, 14);
  });

  it('nets a reversal against the consumption it undoes', () => {
    const balance = deriveBalance([
      { entryType: 'allocation', quantity: 10 },
      { entryType: 'consumption', quantity: -2 },
      { entryType: 'reversal', quantity: 2 },
    ]);
    assert.equal(balance.balance, 10);
    assert.equal(balance.consumed, 2, 'history still shows the consumption');
  });

  it('is zero for an empty ledger', () => {
    assert.equal(deriveBalance([]).balance, 0);
  });

  it('avoids floating point drift across many half days', () => {
    const entries = Array.from({ length: 10 }, () => ({ entryType: 'consumption' as const, quantity: -0.1 }));
    assert.equal(deriveBalance([{ entryType: 'allocation', quantity: 1 }, ...entries]).balance, 0);
  });
});

describe('checkSufficientBalance', () => {
  it('allows a request that fits', () => {
    assert.deepEqual(
      checkSufficientBalance({ balance: 5, requested: 5, allowNegative: false, maxNegative: 0 }),
      { ok: true },
    );
  });

  it('rejects an overdraw and reports the shortfall', () => {
    const result = checkSufficientBalance({ balance: 2, requested: 3.5, allowNegative: false, maxNegative: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.shortfall, 1.5);
  });

  it('permits negative balance up to the configured floor', () => {
    assert.equal(
      checkSufficientBalance({ balance: 0, requested: 2, allowNegative: true, maxNegative: 2 }).ok,
      true,
    );
    assert.equal(
      checkSufficientBalance({ balance: 0, requested: 2.5, allowNegative: true, maxNegative: 2 }).ok,
      false,
    );
  });
});

describe('computeCarryForward', () => {
  it('caps the carry and expires the rest', () => {
    assert.deepEqual(computeCarryForward(12, 5), { carried: 5, expired: 7 });
  });

  it('carries everything when uncapped', () => {
    assert.deepEqual(computeCarryForward(12, null), { carried: 12, expired: 0 });
  });

  it('never carries a negative balance forward', () => {
    assert.deepEqual(computeCarryForward(-3, 5), { carried: 0, expired: 0 });
  });
});

describe('proRateAllocation', () => {
  it('gives the full entitlement to someone present all period', () => {
    assert.equal(proRateAllocation(12, '2026-01-01', '2026-12-31', '2025-06-01'), 12);
  });

  it('pro-rates a mid-period joiner to the nearest half day', () => {
    // Joining 1 July leaves 184 of 365 days: 12 * 184/365 = 6.05 -> 6.
    assert.equal(proRateAllocation(12, '2026-01-01', '2026-12-31', '2026-07-01'), 6);
  });

  it('pro-rates someone who leaves mid-period', () => {
    assert.equal(proRateAllocation(12, '2026-01-01', '2026-12-31', '2026-01-01', '2026-06-30'), 6);
  });

  it('allocates nothing when eligibility starts after the period ends', () => {
    assert.equal(proRateAllocation(12, '2026-01-01', '2026-12-31', '2027-02-01'), 0);
  });
});
