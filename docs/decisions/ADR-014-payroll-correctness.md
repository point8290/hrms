# ADR-014: Payroll estimates the year, refuses what it cannot resolve, and corrects by delta

Status: Accepted
Date: 2026-09-16
Relates to: ADR-005, ADR-009
Reference: standard Indian payroll practice and the Income Tax Act, used for the domain rules

## Context

A business-domain review against standard payroll practice found that our payroll produced plausible
numbers in several situations where it should have produced different numbers, or refused.
Five were correctness defects rather than missing features:

1. **Income tax annualised as `gross × 12`.** Wrong for a mid-year joiner (projects twelve
   months of income from six), wrong after a raise (reprices months already paid at the old
   salary), and wrong in a month with heavy LOP (annualises the dip, then has to unwind it).
2. **No opening tax-year balances.** `tax_deducted_ytd` summed only our own finalized slips,
   so an employee who joined in October had no previous-employer income and no
   previous-employer TDS as far as we were concerned — systematic under-deduction and a
   section 192(2) exposure for the employer.
3. **`salary_component.taxable` was stored, snapshotted, and read by nothing**, so a
   reimbursement marked non-taxable was taxed; and there was no concept at all of a
   deduction reducing taxable income, although employee PF (80C) and professional tax
   (section 16(iii)) both do.
4. **Missing statutory configuration deducted zero.** A tenant with no PF rule got payslips
   with no PF, indistinguishable on the payslip from an employee for whom none was due.
5. **A supplementary run recalculated the full salary.** It would have paid the employee a
   second time; the bug was masked only because `slip_number` collided and produced an
   opaque unique violation.

Two further defects were found while reading: additional salary silently vanished on
recalculation, and leave encashment debited the leave ledger and paid nobody, despite a code
comment asserting the opposite.

## Decision

### Annualisation is built from what is known plus what is scheduled

```
annual = opening                                  previous employer, this year
       + previous                                 our finalized slips, this year
       + current                                  this period
       + recurring × (months_remaining − 1)       still scheduled
```

Only the **recurring** part is projected. A one-off bonus is in the year's income once; it is
not eleven more bonuses. A supplementary run projects nothing at all.

`months_remaining` comes from `identity.tenant.fy_start_month`, which had existed since
migration 0002 and was never consulted — the old helper hardcoded April, so a tenant on a
January financial year got the wrong month count and therefore the wrong monthly TDS.

### Opening tax-year facts are their own record

`payroll.employee_tax_opening`, keyed by employee and financial year. Not on the salary
assignment, where a mid-year compensation revision would create a second row carrying the
same opening balance. Amendable until a slip in that year is finalized, and refused after —
at that point the figure has been acted on, and changing it would make a finalized payslip
unexplainable.

### The tax base is what the component flags say it is

Earnings marked `taxable`, less deductions marked `exempted_from_income_tax`. Built-in PF and
professional tax default to reducing the base because the statute says so, overridable per
rule version for another jurisdiction. The resulting base is persisted on the slip as
`taxable_earnings` — next month's annualisation needs the actual figure, and deriving it from
gross afterwards would give a different number than the one that produced the tax.

### Missing statutory configuration fails the employee

The snapshot records which rules that employee's tax profile asserts they need
(`statutory_json.required`), derived from `pf_applicable`, `esi_applicable` and an explicit
`pt_state_code`. The engine refuses an employee whose required rule is absent, naming the
employee, the rule, the financial year and the jurisdiction.

**The check is in Python, not Node.** That is deliberate: it reuses the existing per-employee
isolation, so one tenant's misconfigured employee fails alone instead of aborting a run for
four thousand others.

Professional tax is the one optional case — several Indian states levy none — so it is
required only when someone has explicitly set `pt_state_code`, which is an assertion of
liability. A state code inherited from the work location is a location fact, not a tax one.

### Supplementary runs pay deltas

| Run type | Pays | Eligible employees |
| --- | --- | --- |
| `regular` | the salary structure plus one-off amounts | those **without** a finalized slip for the period |
| `off_cycle` | the same | the same |
| `supplementary` | **one-off amounts only** | those **with** a finalized slip to correct |

Enforced in three places, because one would not be enough: `selectEligibleEmployees` reports
each skip with a reason, `createRun` refuses a supplementary run for a period with no
finalized regular run, and the snapshot carries `pay_structure: false` so the engine cannot
pay the structure even if something else went wrong.

Slip numbers became `{REG|SUP|OFF}-{YYYY-MM}-{employee_code}-{run_sequence}`. The sequence is
assigned at run creation and never moves, which is what makes the number both deterministic
(recalculating reproduces it) and unique (a correction cannot collide with what it corrects).

### Additional salary may overwrite, and names its source

`overwrites_structure` replaces a component's value **before** pro-rating, so a percentage
component that depends on the overwritten one follows the correction. Applying it afterwards,
as a second line, would leave every dependent component computed from the structure's
original figure.

`source_type` / `source_id`, with a unique index, make the row idempotent per originating
document. Leave encashment now creates one, in the same transaction as the ledger debit, so
the balance cannot be spent without the money being owed — and a redelivered event finds the
row it already created rather than paying twice.

## Reason

The standard rules are right on all five points and were adopted. Common implementation
shortcuts were not: evaluating formulas stored in the database, binding the tax slab to each
employee assignment, or recalculating the slip on every save so the numbers move until
submit. Our frozen snapshot is a stronger guarantee and none of these changes weaken it — every new input
is snapshotted, and the engine still reads nothing else.

Two places where we deliberately kept our own, stricter behaviour: attendance completeness is
a hard refusal rather than an optional check, and one employee's failure fails that
employee rather than the whole run.

## Consequences

- **Leave encashment now requires configuration.** `leave_encashment_amount_per_day` on the
  salary assignment and an earning to post against. Without either, the request is refused.
  That is the point: the previous behaviour debited the balance and paid nothing, and a
  guessed daily rate would under- or over-pay a real person with nothing downstream to catch
  it.
- **A raw `payroll_run` insert must supply `run_sequence`.** It is `NOT NULL` because it is
  part of every slip number.
- **An existing tenant's TDS will change** the first time payroll runs after this. The new
  figures are correct; the old ones were not. A tenant mid-year should record opening
  balances before the next run, or their mid-year joiners stay under-deducted.
- **`CALCULATION_VERSION` moved to `in-payroll-2025.2`**, so a slip computed before and after
  is distinguishable. Finalized slips keep the version that produced them and are unaffected.
- Still deferred, and explicitly out of scope for this pass: HRA exemption, surcharge and
  marginal relief, professional tax beyond Karnataka and Maharashtra, LWF, VPF, and the
  EDLI/admin split of employer PF.
