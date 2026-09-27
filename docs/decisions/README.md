# Architecture Decision Records

Significant architectural decisions are captured here as short ADRs. An ADR records
*why* a constraint exists so a future agent does not "simplify" it away.

## When to write one

Write an ADR when a decision:

- constrains more than one domain,
- is expensive or disruptive to reverse,
- will look arbitrary to someone who was not in the discussion,
- or trades a real alternative away (there was a genuine choice).

Do **not** write one for routine implementation choices, library picks with no
architectural consequence, or anything already stated in `docs/knowledge/invariants.md`.

## Format

One file, `ADR-NNN-short-slug.md`, four sections, kept short:

```
Context     - the situation and forces
Decision    - what we decided, stated as a rule
Reason      - why this over the alternatives
Consequences- what this costs and what it now forbids
```

Status: `Accepted` | `Superseded by ADR-NNN` | `Proposed`. ADRs are append-only —
supersede rather than rewrite.

## Accepted

| ADR | Decision |
|---|---|
| [ADR-001](ADR-001-multi-tenancy.md) | Shared database, shared schema, `tenant_id` on every tenant-owned row |
| [ADR-002](ADR-002-postgresql-rls.md) | PostgreSQL RLS with transaction-local tenant context |
| [ADR-003](ADR-003-node-python-boundary.md) | Node owns transactions, Python owns calculation |
| [ADR-004](ADR-004-sqs-and-outbox.md) | Outbox + SQS + consumer idempotency |
| [ADR-005](ADR-005-payroll-snapshot.md) | Payroll calculates from immutable input snapshots |
| [ADR-006](ADR-006-leave-ledger.md) | Leave balance is derived from an append-only ledger |
| [ADR-007](ADR-007-attendance-daily-close.md) | Absence is decided by a daily close, not by event-driven recalculation |
| [ADR-008](ADR-008-tenant-purge.md) | Tenant erasure via a narrow, audited purge mode |
| [ADR-009](ADR-009-payslip-generation-point.md) | `SalarySlipGenerated` means finalized, and fans out per slip |
| [ADR-010](ADR-010-scheduler-worker-boundary.md) | Scheduling and job execution are separable roles of one binary |
| [ADR-011](ADR-011-scheduled-job-framework.md) | One scheduled-job ledger, not one table per periodic job |
| [ADR-012](ADR-012-mfa.md) | TOTP, required of anyone holding a sensitive permission |
| [ADR-013](ADR-013-telemetry.md) | W3C trace context everywhere, allow-listed span attributes |
| [ADR-014](ADR-014-payroll-correctness.md) | Payroll estimates the year, refuses what it cannot resolve, and corrects by delta |
| [ADR-015](ADR-015-tax-year-and-run-recovery.md) | The tax year is a record, a stalled run is noticed rather than cancelled |
| [ADR-016](ADR-016-hra-exemption.md) | HRA exemption is a period calculation that a tax year accumulates |
| [ADR-017](ADR-017-section-exemption-caps.md) | Section caps are configured per year; eligibility and the ceiling are different steps |
| [ADR-018](ADR-018-proof-cutoff.md) | Finalized payroll is immutable; a tax declaration is not |
| [ADR-019](ADR-019-surcharge-and-marginal-relief.md) | Surcharge is annual, and marginal relief is a guarantee rather than a formula |
| [ADR-020](ADR-020-professional-tax.md) | Professional tax follows the workplace, not the income-tax regime |
| [ADR-021](ADR-021-provident-fund-configuration.md) | Provident fund rates are configuration, and the engine will not guess at them |
| [ADR-022](ADR-022-esi-configuration.md) | ESI eligibility is derived from the wage, and its figures come only from the rule |

ADR-001 to ADR-006 record decisions already established by the PRD and the architecture
package. ADR-007 to ADR-009 record decisions forced by implementation: each was written because
building the system surfaced a conflict the design documents had not resolved, and ADR-009
corrects a placement in the architecture package itself.

ADR-014 records the payroll correctness pass: business rules aligned with standard payroll
practice, implemented within our snapshot architecture rather than around it. ADR-015 is
the structural groundwork the India statutory work needed and could not be built without: the
tax year as a record rather than an arithmetic result, and a payroll run that cannot silently
stall. It extends ADR-013's trace propagation across the Node/Python boundary.

ADR-016 is the first India statutory rule built on that groundwork, and it establishes the
shape the rest will follow: a statutory figure is calculated **per payroll period** on that
period's own inputs, and the tax year accumulates what has been paid and projects each
remaining period separately. Nothing is annualised by multiplying one month by twelve.

ADR-017 is the counterpart, and the pair should be read together: a chapter VI-A section
exemption is an **annual** figure with an annual ceiling, and is deliberately *not* computed
the way HRA is. Merging the two for implementation convenience would make one of them wrong.

ADR-018 completes the declaration story with the proof cutoff, and holds two rules that are
easy to collapse into one: a finalized payslip is immutable, and a tax declaration is still
amendable during its year. Freezing declarations because payroll has run would be the simpler
implementation and the wrong system.

ADR-019 adds surcharge and marginal relief to the annual liability. It is the one statutory
phase so far that needed no new table: the bands move with the same Finance Act that moves the
slabs, so they belong to the income-tax rule version rather than beside it.

ADR-020 covers professional tax, which is a state levy and therefore asks a different question
from everything above it: not how much, but *where*. It also needed no new table — the
statutory-rule model was already state-specific — and it is deliberately independent of the
income-tax regime that dominates ADR-017 to ADR-019.

ADR-021 is the smallest of the statutory ADRs and needed no schema change at all. It closes
one gap against the PRD's own words — statutory rules "rather than scattered as hard-coded
logic" — by removing the literal rate fallbacks from the provident-fund calculation, and
records which PF features are deliberately absent because the PRD does not ask for them.

ADR-022 does the same for ESI, and the pair should be read together: both close the same gap
against the same PRD sentence, and both record which features are deliberately absent. Where
they differ is instructive — PF names its contributing components while ESI is charged on
gross, and ESI's ceiling is an eligibility test rather than a cap, so a missing one cannot be
defaulted without silently deciding who is insured.

ADR-010 to ADR-013 record decisions forced by production hardening. ADR-010 and ADR-011
together replace the attendance-specific scheduler with a general one and give it a
deployment boundary; ADR-011 supersedes ADR-007's *storage* decision while leaving its close
semantics exactly as written.

## Relationship to the knowledge layer

An ADR explains *why*. `docs/knowledge/invariants.md` states the resulting *rule*.
Agents read invariants during normal work and reach for an ADR only when they need
the rationale or are considering changing the rule.
