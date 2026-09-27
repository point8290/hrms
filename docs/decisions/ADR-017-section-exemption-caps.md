# ADR-017: Section caps are configured per year, and eligibility is not the ceiling

Status: Accepted
Date: 2026-09-16
Relates to: ADR-005, ADR-014, ADR-015, ADR-016
Reference: Income Tax Act chapter VI-A (80C, 80D, 80CCD(1B)); section 115BAC for the new regime

## Context

`compensation.tax_declaration.declarations` was a free-form `{key: number}` jsonb. Every value
was summed into `declared_amount` and subtracted from the old regime's annual taxable income
**with no ceiling at all**. An employee could declare two million rupees under a key spelled
anything, and the engine would deduct all of it.

Three things were missing: a catalogue of sections a declaration could be checked against, a
ceiling belonging to a financial year, and any notion that a regime might not grant a section.

## Decision

### The chain, with every step distinct

```
declaration -> eligibility -> eligible amount -> financial-year rule
            -> statutory cap -> allowed exemption -> snapshot -> tax calculation
```

Two distinctions carry the design, and collapsing either produces a plausible wrong number
rather than an obvious one.

**Eligible is not declared.** A verifier narrows what was declared to what is supportable.
Until someone looks, the declared figure stands — which is what this system already did, kept
deliberately rather than replaced. Nobody may be found eligible for more than they declared.

**The ceiling is not eligibility.** Declaring 200,000 under 80C and having 180,000 accepted
does not make the allowed exemption 150,000 *of the declared* amount; it makes it
`min(180,000, 150,000)`. The cap applies **last**, to whatever survived eligibility.

### `payroll.tax_exemption_rule`, resolved by tax year

A table of its own rather than more keys in `payroll.statutory_rule.rule_config`. That table
holds one jsonb per `(tenant, country, state, rule_type, version)`, and the dimension that
matters here is the *section*: 80C's ceiling can change in a year 80D's does not, and
expressing that inside one income-tax rule version would mean reissuing the whole slab table
to move one number. It would also leave no column to constrain and no way to ask "which
sections are configured" without unpacking jsonb.

Everything else is copied from `statutory_rule` on purpose — nullable `tenant_id` for a
platform default a tenant may override, integer `version`, effective dates, and the same RLS
policy — so this is one more instance of the established pattern, not a second architecture.

**Resolution is against the tax year's first day**, never the section code alone and never the
payroll period's end. A ceiling is an annual figure the Finance Act sets for a whole year;
resolving per period would let a rule effective in October change the ceiling for a year
already half spent, and an employee's allowance would move between September and October
payslips for no reason they could act on. A GIST exclusion constraint stops two rules for one
section overlapping in time, because "what is the 80C ceiling on 1 July 2026" must have one
answer.

### `compensation.tax_declaration_item`, hanging off the existing declaration

The parent `tax_declaration` keeps the regime election and the lifecycle; the items add the
section structure it never had. One live row per `(declaration, section)`: amending replaces
and resets the proof lifecycle, and the previous figure lives in the audit trail. Two live
rows would have to be summed or chosen between, and neither rule was ever stated.

Status is `declared` / `verified` / `rejected`, the same vocabulary rent declarations use and
the one phase 4's cutoff will act on. **No cutoff is enforced here.**

**A declaration stays revisable after a payslip in the year is finalized**, and this is a
deliberate departure from how opening balances behave. The three are different kinds of
statement:

| | what it is | frozen when |
| --- | --- | --- |
| opening balance | a fact about the past — what a previous employer withheld | once a slip used it |
| rent declaration | rent for a named stretch | for stretches already paid |
| section declaration | forward-looking intent for the year | never; the year closing ends it |

Employees declare an intention in April and revise it in January when they have actually
invested. Refusing after the first finalized payslip would make revision impossible from May
onward. Nothing retroactive happens: finalized slips keep what their snapshots froze, the
immutability guard enforces it, and the annualisation spreads the correction over the periods
that remain — which is precisely what it is for.

### Annual, not monthly — and explicitly not HRA

There is no monthly 80C. The declaration is annual, the ceiling is annual, and both are
applied to the annual estimate the tax engine already builds. Nothing is multiplied by twelve
and nothing is divided by it; the same declaration in April and in March allows the same
amount.

This is why section exemptions are **not** forced through the HRA path, and why `hra_json` and
`exemption_json` are separate snapshot sections:

```
HRA                 a period-level least-of-three, accumulated and projected by tax year
Section exemptions  an annual capped declaration, applied to the annual estimate
```

Sharing a structure would invite one to be computed like the other, and whichever lost would
be wrong. They meet only at the end, where both reduce what tax is assessed on.

### Order of operations, unchanged

```
gross taxable earnings (per period)
  - HRA exemption (per period)                    -> salary_slip.taxable_earnings
  - pre-tax statutory deductions (PF, PT)
  = annual estimate: opening + previous + current + projected
  - standard deduction
  - section exemptions (annual, capped)           <- this phase
  = annual taxable income -> slabs -> rebate -> cess
```

The section total enters exactly where the uncapped `declared_amount` used to, as
`declared_deductions`. Nothing was reordered.

### Fail closed

A declared section whose rule cannot be resolved raises in **Python**, failing that employee
and no one else — reusing the per-employee isolation `require_statutory_rules` established.
Not unlimited, not zero, not last year's number: any of those is a confident figure nobody
configured. Node snapshots the *reason* rather than dropping the section, so the failure
carries the employee, section, year and rule.

Regime applicability is configured per rule (`applicable_regimes`). Under section 115BAC the
new regime forfeits these sections; applying one anyway would exempt fully taxable income for
everyone who elected it.

## Consequences

- **No existing payroll figure changes.** No tenant had any `tax_declaration` row, and the
  E2E journey's June baseline is byte-identical: gross ₹96,666.66, TDS ₹3,865.33, net
  ₹90,801.33.
- **A legacy uncapped figure is still honoured for old snapshots.** A snapshot with no
  `tax_year_id` in `exemption_json` predates this phase; recalculating one reapplies
  `tax_json.declared_amount` unchanged, because it must reproduce the payslip it recalculates.
  That is the only place the legacy figure is still read.
- **A free-form key that names no configured section no longer deducts anything.** The
  migration backfills items only for recognised sections. That is the defect being closed, and
  it is reported rather than hidden; no tenant is affected in practice.
- **`CALCULATION_VERSION` moved to `in-payroll-2025.4`.**
- `payroll.tax_exemption_rule` is the first tenant-optional table added since
  `statutory_rule`, and uses that table's policy verbatim rather than
  `app.enable_tenant_rls()`, which assumes a `NOT NULL` tenant.
- Deferred by design: the proof cutoff (phase 4), surcharge and marginal relief (phase 5), and
  real eligibility rules — the senior-citizen 80D ceiling, the 80C/80CCC/80CCD(1) shared
  limit, and previous-employer exemption utilisation for a mid-year joiner. The last is a
  genuine gap: `employee_tax_opening` records opening taxable earnings and TDS but has no
  field for exemption already used elsewhere, so a mid-year joiner's ceiling is assessed as if
  unused. Documented rather than guessed at.

## A note on the migration itself

Migration 0031 extends `payroll.guard_finalized_slip` by one column. The definition was taken
from `pg_proc.prosrc` — the **live** function — not from any migration's source. Doing exactly
that in 0029 silently reverted 0010's purge escape and 0023's `snapshot_id` and
`calculation_version` clauses, and nothing failed until an unrelated test happened to purge a
tenant. `apps/api/test/integration/finalized-slip-guard.test.ts` now asserts all seventeen
protections, each tagged with the migration that introduced it, so the next such regression
fails loudly.
