# ADR-019: Surcharge is annual, and marginal relief is a guarantee rather than a formula

Status: Accepted
Date: 2026-09-16
Relates to: ADR-005, ADR-015, ADR-016, ADR-017, ADR-018
Reference: Finance Act surcharge bands; section 115BAC for the new regime's 25% ceiling

## Context

The engine computed slab tax, a section 87A rebate and 4% cess, and stopped. An employee
earning six crore paid the same marginal rate as one earning fifteen lakh. Surcharge — 10% to
37% of the *income tax*, depending on total income — was simply absent, and with it marginal
relief, the rule that stops crossing a threshold costing more than the income that crossed it.

## Decision

### No new table: surcharge belongs to the income-tax rule

Phase 3 gave section exemptions their own table because 80C's ceiling can move in a year
80D's does not, so the two must be versioned apart. Surcharge is the opposite case. The bands
are part of the rate structure and move with the same Finance Act that moves the slabs;
versioning them separately would permit a rule version holding this year's slabs beside last
year's bands, which is not a state that should be representable.

So they live in `payroll.statutory_rule` under `income_tax`, which is already tax-year aware
(effective-dated resolution), regime aware (`regimes.old` / `regimes.new`), versioned,
tenant-overridable, non-overlapping and RLS-protected. Nothing the phase required was missing
from it. **The smallest schema extension turned out to be none.**

Version 1 is closed at 2026-03-31 and version 2 carries the identical slabs plus bands from
2026-04-01. Closing a version is supersession — `effective_to` exists for exactly this — not
the editing that ADR-005 forbids. Runs already finalized are untouched either way: they froze
`rule_config` in their snapshot and the engine reads that, never the table.

### Bands are data, never a formula

```json
{"threshold": 5000000, "rate": 0.10, "marginal_relief": true}
```

A threshold, a rate, and a flag. No expression to evaluate, nothing for a tenant to compose,
and no path by which tenant-supplied text reaches an interpreter. `marginal_relief` is a flag
rather than a formula because relief is a statutory rule with one shape.

Regime-aware because the regimes genuinely differ: section 115BAC caps surcharge at 25% and
has no 37% band, so an employee over five crore pays materially differently depending on their
election. One shared band list would be wrong for whichever regime lost.

### The order, and why each step sits where it does

```
annual taxable income
  -> slab tax
  -> less section 87A rebate                    = base tax
  -> plus surcharge at the band rate            = surcharge before relief
  -> less marginal relief                       = surcharge charged
  -> plus cess on (base tax + surcharge)
  = annual tax liability
```

Surcharge is charged on the **income tax**, never on income — 10% of six crore would be sixty
lakh rather than the correct figure. Cess is charged on tax *plus* relieved surcharge:
computing cess first would under-charge it, and relieving after cess would over-relieve by the
cess rate. The existing cess implementation was kept and its base widened; it is not
duplicated.

**Surcharge is annual because its thresholds are thresholds on the year's total income.** One
month of a large salary says nothing about whether the year crosses five million. A monthly
band test would surcharge an employee who never reaches the threshold and miss one who reaches
it in March. The E2E demonstrates exactly this: a monthly salary of ₹4.29 lakh, nowhere near
any band, annualising to ₹50.98 lakh and crossing the first one.

### Marginal relief, implemented as the guarantee it is

```
relief = (base tax + surcharge at I) − (tax payable at the threshold) − (I − threshold)
```

taken when positive, capped at the surcharge — relief cancels surcharge and never reaches into
the base tax. By construction the result satisfies:

```
tax after relief  ≤  tax payable at the threshold  +  income above the threshold
```

The tests assert **that inequality directly, at every band**, rather than comparing against a
number someone computed by hand once. A formula can be transcribed wrongly and still look
plausible; the inequality is what the rule actually promises.

"Tax payable at the threshold" uses the band *below* the one that applies — at one crore the
employee already pays 10%, so comparing against an unsurcharged figure would over-relieve. The
slab walk and the rebate were extracted into helpers so the tax at the threshold is computed
by identical rules to the tax at the income; two implementations would eventually disagree by
a few hundred rupees nobody could account for.

### Resolution and freezing

Node resolves the rule as it always has and freezes the whole `rule_config` — bands included —
into `statutory_json`. The engine reads it and has no path to the rule table. `rule_id` was
added alongside the existing `version` and `source`, because a version number is unique only
within a scope and a two-year-old payslip should not require guessing whether it came from the
platform default or a tenant override.

A rule version with no `surcharge` key is recorded in the trace as *declaring none*, which is
deliberately distinguishable from `applicable: false` (this year levies none) and from a
malformed band, which raises. "No surcharge was due" and "nobody configured whether any was"
must not look the same. A band missing a threshold or a rate fails that employee rather than
being guessed at, reusing the per-employee isolation.

### Rounding

`money()` — 2dp, HALF_UP — is the engine's single rounding boundary and the only one used. No
`round()` was introduced. Intermediate relief arithmetic stays in full Decimal precision and
is quantised once at the boundary, so the same snapshot always produces the same paise.

### No salary-slip column, and therefore no trigger change

Surcharge is an annual figure inside the TDS computation, already explained by the TDS line's
`calculation_detail`. A monthly column holding an annual number would be a second source of
truth that could disagree with the trace. `payroll.guard_finalized_slip` was inspected from
`pg_proc.prosrc` before and after the migration and is **byte-identical**.

## Consequences

- **No existing payroll figure changes.** Every pre-existing rule version has no `surcharge`
  key, and cess on a zero surcharge is cess on the same base as before. The E2E June baseline
  is byte-identical: gross ₹96,666.66, TDS ₹3,865.33, net ₹90,801.33.
- **`CALCULATION_VERSION` moved to `in-payroll-2025.6`.** Finalized slips keep the version that
  produced them.
- A run in FY 2025-26 still resolves version 1 and has no surcharge; FY 2026-27 onward resolves
  version 2. That is the tax-year awareness working, not a discontinuity.
- Deferred, and unchanged from ADR-017/018: HRA rent-proof cutoff, previous-employer exemption
  utilisation. **One genuine gap found and not closed:** `employee_tax_opening` records opening
  taxable earnings and TDS, so opening income correctly pushes an employee over a threshold —
  but it records no opening *surcharge already borne*. For an employee whose previous employer
  withheld surcharge, the annualised liability is right while the split between employers is
  not reconstructable from our data. Documented rather than invented, per §8.
