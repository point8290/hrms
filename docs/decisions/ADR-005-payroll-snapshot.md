# ADR-005: Payroll calculates from immutable input snapshots

Status: Accepted
Source: PRD s.15, s.16, s.29; ArchitectureDiagram/README s.11, s.14; ERD/10-payroll-data-flow.puml

## Context

Payroll reads from many mutable places: employee master, salary assignment, attendance,
leave/LOP, tax declarations, benefits and statutory rules. All of them keep changing —
an employee transfers, a salary revision lands, an attendance correction is approved, a
tax slab is updated.

If payroll read live tables, recalculating a run would produce a different answer than
the first run, and last month's payslip would change meaning whenever today's
configuration changed. Payroll is also long-running, so it cannot be a synchronous
request.

## Decision

Creating a payroll run commits `payroll.payroll_input_snapshot` per employee: frozen
attendance, leave/LOP, compensation, tax and benefits JSON, with a `snapshot_version`.
The snapshot is committed *before* `PayrollRunCreated` is published.

The calculation engine reads **only** the snapshot. It never reads live employee,
attendance, leave or compensation tables.

Results carry `calculation_version`. Finalized `payroll_run`, `salary_slip` and
`salary_slip_component` rows are immutable; `salary_slip_component` stores a component
name snapshot. Corrections use adjustment, reversal or supplementary runs.

Statutory rule versions consumed by a finalized run are never edited — changes add a new
effective-dated version.

## Reason

- Determinism: the same snapshot and the same `calculation_version` always produce the
  same numbers, which makes recalculation safe and disputes resolvable.
- Auditability: the exact inputs behind a payslip remain inspectable years later.
- Idempotency: a redelivered SQS job recomputes the same result instead of double-paying.
- Historical correctness: today's configuration cannot rewrite a past period.

## Consequences

- Snapshot storage grows with employees x runs; it is accepted cost, with retention
  handled deliberately.
- Late-arriving inputs (an attendance correction after snapshotting) do not silently
  appear in the run — they require an explicit re-snapshot before finalization, or a
  supplementary run after it. This is intended.
- Fixing a finalized payroll is never an `UPDATE`. Any code path that edits a finalized
  slip is a defect.
- The engine has no legitimate reason to query live business tables; a join outside the
  snapshot is a review red flag.
