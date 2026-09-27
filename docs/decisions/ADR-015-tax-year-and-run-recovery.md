# ADR-015: The tax year is a record, a stalled run is noticed rather than cancelled

Status: Accepted
Date: 2026-09-16
Relates to: ADR-005, ADR-011, ADR-013, ADR-014

## Context

Three problems stood between the correctness pass (ADR-014) and the India statutory work
that follows it. None is about tax arithmetic; all three are about structure, and each one
would have had to be worked around in every statutory feature built on top of it.

1. **There was no tax year.** `payroll_period` was doing two jobs: the cycle an employee is
   paid for, and the year income tax is assessed over. The year was derived in application
   code from a date and `identity.tenant.fy_start_month`. That works for arithmetic and
   nowhere else — there is no row to hang a proof cutoff on, no way to say "this year is
   closed", and `employee_tax_opening.financial_year` was a free-text label that nothing
   validated against a year anyone had agreed existed. HRA exemption, section caps,
   surcharge and the declaration/proof lifecycle are all facts about a *year*.

2. **A run whose engine never answered sat in `calculating` for ever.** `calculating →
   cancelled` is illegal on purpose, so the only way out was an operator marking it failed
   by hand — and nothing told them it had happened. Meanwhile the period could not be re-run,
   because a period may have only one live regular run.

3. **The trace stopped at the language boundary.** ADR-013 put a `traceparent` on every
   outbox row and on the event envelope. The Python engines read the envelope and ignored the
   field, so `PayrollCalculated`, the payslip job that descended from it and the notification
   after that were, to any tracing backend, three unrelated events that happened to coincide.

## Decision

### `payroll.tax_year` is a record, created on demand

Boundaries, status and proof cutoff, with a GIST exclusion constraint on
`(tenant_id, daterange(start_date, end_date))`. Two overlapping years would make "which year
is this period in" ambiguous, and the answer decides how much tax is withheld; the database
settles it rather than the code that happens to ask first.

Years are created by the first period or opening balance that needs one, not by a scheduled
job and not by an operator opening one in advance. A tenant should not be able to be blocked
from running payroll because nobody remembered to create a year, and years nobody uses should
not exist. `ensureTaxYear` inserts `ON CONFLICT DO NOTHING` and re-reads, so two runs created
concurrently in a tenant's first month do not race.

A period belongs to the year its **end date** falls in, which is where the income is taxed.
`payroll_period.tax_year_id` and `employee_tax_opening.tax_year_id` are both `NOT NULL`;
`financial_year` survives as a denormalised label because snapshots written before this
migration still read it.

Creating a period is therefore a domain operation (`createPeriod`) rather than an insert.
That is the visible cost of this decision, and it is the right cost: a period with no year
cannot be assessed, so there should be no way to make one.

### Annualisation counts the tenant's own periods

`periodsRemainingInYear` counts the payroll periods defined in the year, and falls back to
month arithmetic until those periods **cover** the year. Coverage is measured in days, not in
periods counted: four quarters cover a year exactly as well as twelve months do, and counting
periods against months would have sent every non-monthly tenant down the fallback for ever.

The fallback matters more than the main path. Most tenants create each month's period shortly
before running it, so a tenant three months in has three periods defined — trusting that count
would annualise over three and deduct a year of tax in a quarter.

Both the divisor and the basis that produced it are snapshotted, so a finalized slip can be
explained without guessing which rule was in force.

### A stalled run is failed by a sweep, and the lock is what makes that safe

`calculating → cancelled` stays illegal. What was missing was not a transition but a
noticing. `payroll_run.last_progress_at` is stamped by every state transition, including a
no-op one — a recalculation re-entering `calculating` is progress, and the clock must restart
or the sweep would fail a run that has just been restarted.

`payroll.recover_stalled` runs through the ADR-011 job framework, once per tenant per local
day, and moves a run that has made no progress for 45 minutes into `failed`, where the
existing retry path already starts. Three stalls exhausts the run: something about its data
is stopping it, and continuing to retry hides that.

**What stops this killing a live run is not the timeout — it is the row lock.** The engine
holds `FOR UPDATE` on the run row for its entire transaction. Recovery takes the same lock,
so a sweep arriving mid-calculation blocks until the engine commits and then re-reads a run
that is no longer `calculating` and declines to touch it. The 45 minutes and the manual
`force` are belt and braces on top of a guarantee the database already makes.

Recovery is the last line, behind SQS redelivery: a consumer that dies rolls back its
transaction *including its `processed_event` claim*, so the message is redelivered and retried
first. This catches what is left — the run whose message is gone for good.

### Two overwrites of one component is a 409, not a 500

The snapshot builder already refused two `overwrites_structure` rows for one component in one
period; it threw a bare `Error`, which surfaced as "an unexpected error occurred". The
partial unique index catches the same-date duplicate, but two overwrites on *different* dates
in one period are distinct rows and legitimately accepted — the ambiguity only appears when
the snapshot is built.

It is now `additional_salary_overwrite_conflict`, 409, naming the employee, the component
code, the period and the conflicting records with their dates and amounts. It names no
constraint, no table and no column: the database could not decide because the question is a
business one — which of these two corrections is the right one.

### Trace context crosses into Python

`hrms_engine.trace` mirrors the Node helpers: parse, format, a `contextvars` current context,
and `continue_trace` around every handler. `emit_event` stamps `outgoing_traceparent()` on the
outbox row, so events the engine emits belong to the request that caused them.

It is context propagation, not an OpenTelemetry SDK — no exporter, no spans. Adding the SDK
later means replacing the storage under these names, not changing call sites.

A malformed `traceparent` yields no trace rather than an exception: a bad header is not a
reason to fail payroll. An absent one yields no trace rather than a fabricated root, because
a trace id with no parent anywhere looks like a request that never happened. And nothing from
an event payload enters trace state — a trace id is opaque and safe to ship to a third-party
backend; employee and payroll data is not.

## Consequences

- **No existing payroll figure changes.** The end-to-end journey produces the same gross
  (₹96,666.66), TDS (₹3,865.33) and net (₹90,801.33) as before. The tax year resolves to the
  same year the old arithmetic derived, and the same month count.
- **A payroll period must be created through `createPeriod`.** Raw inserts fail on the
  `NOT NULL`, which is the point.
- **A tenant that changes `fy_start_month` after a year exists is refused**
  (`tax_year_boundaries_changed`) rather than silently given stale boundaries, which would
  reprice every annualisation in that year.
- **`loadOpening` takes a tax-year id, not a label.** A label is a display string that a
  changed start month can make ambiguous; an id cannot be.
- `payroll.recover`, `tax.year.manage` and `payroll.policy.manage` are new permissions; the
  last two are sensitive, and `payroll.run.recovered` is a sensitive audit action carrying
  `requires_operator_attention`.
- `payroll.tenant_payroll_policy` exists but nothing reads it yet. Its defaults reproduce
  today's behaviour exactly; the statutory phases that follow are what give it effect.
