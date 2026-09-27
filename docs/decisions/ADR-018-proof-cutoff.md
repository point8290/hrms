# ADR-018: Finalized payroll is immutable; a tax declaration is not

Status: Accepted
Date: 2026-09-16
Relates to: ADR-005, ADR-015, ADR-016, ADR-017

## Context

ADR-017 gave declarations a `declared` / `verified` / `rejected` lifecycle and left the
cutoff for this phase. Without one, an employee could declare ₹150,000 under 80C in April,
never produce a receipt, and have the deduction all year — which is the employer's liability
under section 192, not the employee's.

Almost everything needed already existed and was never wired up. Migration 0024 added
`payroll.tax_year.proof_cutoff_date` and `payroll.tenant_payroll_policy.require_proof_after_cutoff`;
`setProofCutoff()` and its route shipped with phase 1. So this is mostly connection, not
construction.

## Decision

### Two rules that must both hold

```
finalized payroll  = immutable
tax declaration    = amendable during the tax year
```

The tempting simplification — freeze declarations once a payslip exists — breaks the second,
and ADR-017 established it deliberately. An employee declares an intention in April and proves
it in January, by which time most of the year is finalized. So amendment and proof are
accepted at any point in the open year, and nothing about them reaches back:

```
April payroll finalized -> May declaration amended -> May snapshot sees it
                        -> April slip unchanged
```

The finalized slip is protected by its snapshot and by `guard_finalized_slip`, not by refusing
the amendment.

### Four states, three of them stored

| state | meaning | worth |
| --- | --- | --- |
| `declared` | stated, nobody has looked | the declared figure |
| `verified` | proof examined and accepted | the verified figure |
| `rejected` | proof examined and refused | nothing |
| **`unverified`** | still unproved once the cutoff has passed | nothing |

`unverified` is **derived, not stored**. Whether the cutoff has passed is a fact about a
*payroll run*, not about the row: the same declaration is `declared` for a December run and
`unverified` for a February one. Storing it would need a job flipping rows at midnight and
would still answer the wrong question. Node derives it per run as `effective_status`.

### One date comparison, in Node, frozen as a boolean

`cutoffPassed()` is the only place a date is compared. The engine receives a boolean and never
recomputes it — a second comparison in a second language is a second set of boundary and
timezone assumptions, and the two would eventually disagree about 31 January. A Python test
passes deliberately contradictory dates and asserts the boolean still wins.

**Convention: the cutoff has passed on the cutoff date itself** (`period_end >= cutoff`). A
cutoff of 31 January means proof must be in *before* it. The stricter of the two readings,
chosen because under-deduction is the employer's liability while over-deduction is something
the employee reclaims when they file.

**The reference date is the payroll period's end, never `now()`.** That is what makes
recalculating an April run in December reach April's answer. Using the wall clock would
silently turn a historical recalculation into a different payslip.

### Late proof restores eligibility, and that is configurable

§13 of the brief asked this to be determined rather than assumed. The PRD does not specify it,
so the conservative-and-configurable answer:

- The cutoff governs what an **unproved** declaration is worth. It does not govern whether
  proof may still be examined.
- Proof accepted in February is accepted. The row becomes `verified`, the cutoff no longer
  applies to it, and the periods still to be paid allow it. Periods already finalized keep
  what they allowed.
- `require_proof_after_cutoff` (default true) is the tenant's switch for whether an unproved
  declaration lapses at all.

This supports an HR policy that allows late verification without requiring one, and without
inventing a permanent prohibition the business model does not ask for.

### Missing configuration fails closed, but only when the tenant asked for it

`require_proof_after_cutoff` cannot also mean "a cutoff must exist" — it defaults to true for
everyone, so reading it that way would fail closed on every tenant that has never set a date.
A separate `require_proof_cutoff` (default **false**, opt-in) is the assertion that every tax
year must have one. A tenant that turns it on and leaves a year unconfigured gets a
per-employee failure naming the tenant policy, the year and the section — never a guessed
date. Default false reproduces migration 0024's documented behaviour: no date means no cutoff.

### Proof metadata, because a rejection has to survive as one

`verified_by`, `verified_at`, `proof_outcome_reason` and `previous_status` on
`tax_declaration_item`. `note` was carrying the employee's remark, the verifier's remark and
the rejection reason at once, with no way to tell which. An employee asking why their 80C gave
nothing deserves the reason, the person who decided and the date.

Amending clears the whole outcome — amount, verifier, timestamp and reason — because leaving a
verifier's name against a number they never saw is worse than leaving none.

A verifier may not accept more than was declared. Raising the figure is something the employee
asserts, through `declareSection`, so the declared amount stays the employee's own statement.

### Verifying is its own permission

`tax.proof.verify`, mirroring `tax.rent.verify`. The Employee role holds `tax.declare.self`
and neither `tax.manage` nor `tax.proof.verify`, so nobody can verify their own proof. The
migration grants the new permission to every role that already had `tax.manage`, so no live
tenant is locked out of their own January proof run.

### HRA is deliberately untouched

Rent declarations have the same three states and, in reality, the same cutoff would apply. The
brief scoped this phase to section exemptions, and widening it would have changed HRA figures
for a reason nobody asked for. Recorded as deferred, not overlooked.

## Consequences

- **No payroll output changes.** No tenant has a `proof_cutoff_date`, and with none configured
  the cutoff never passes. The E2E June baseline is byte-identical: gross ₹96,666.66, TDS
  ₹3,865.33, net ₹90,801.33.
- **`CALCULATION_VERSION` moved to `in-payroll-2025.5`.**
- **No column was added to `payroll.salary_slip`, so `guard_finalized_slip` was not touched.**
  Verified by diffing `pg_proc.prosrc` before and after migration 0032: byte-identical. All
  seventeen protections in `finalized-slip-guard.test.ts` stay green.
- `POST /api/tax/exemption-declarations/:id/eligibility` became `.../proof`, and
  `setExemptionEligibility` became `setProofOutcome`. The audit action
  `tax.exemption.eligibility_assessed` became `tax.exemption.proof_reviewed`. All three
  shipped in phase 3 and have no external consumers yet.
- Deferred: the same cutoff for HRA rent proof, surcharge and marginal relief, and
  previous-employer exemption utilisation — still a real gap from ADR-017, still unmodelled.
