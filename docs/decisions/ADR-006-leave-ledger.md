# ADR-006: Leave balance is derived from an append-only ledger

Status: Accepted
Source: PRD s.12, s.29; ERD/04-leave-erd.puml; ERD/README

## Context

Leave balance is affected by allocation, accrual, consumption, cancellation, adjustment,
carry-forward, expiry and encashment. A stored `balance` column updated in place is the
obvious design and the wrong one: it drifts under concurrency, loses the reason for every
change, cannot be reconstructed after a bug, and makes retroactive corrections
unverifiable. Leave also feeds payroll through LOP, so a wrong balance becomes a wrong
payslip.

## Decision

`leave_mgmt.leave_ledger_entry` is the authority. Every balance-affecting event appends
a row: `entry_type` (allocation | consumption | adjustment | carry_forward | expiry |
encashment), signed `quantity`, `effective_date`, and `source_type` / `source_id`
pointing at the cause.

Balance is always computed by summing ledger entries for an employee, leave type and
period. Any cached or denormalized balance is a read optimization and never authoritative.

Ledger entries are immutable. A cancelled or corrected leave produces a compensating
entry, never an `UPDATE` or `DELETE`. Approving a leave application writes the
application state change and the ledger entry in the same transaction.

## Reason

- Balance becomes reconstructible and auditable: every unit is traceable to its cause.
- Retroactive corrections stay honest — history shows what was believed and when.
- The PRD requires balance to be reconstructable from ledger entries (s.29).
- The same pattern already governs payroll and audit, so there is one consistent rule for
  financially meaningful state.

## Consequences

- Reads cost more than a column lookup; expect an aggregate query, and cache it as a
  derived value with clear invalidation if it ever becomes a hot path.
- The ledger is high-volume over time and needs indexing on
  `(tenant_id, employee_id, leave_type_id, effective_date)`.
- Allocation and accrual jobs must be idempotent — a duplicated run would otherwise
  append phantom entitlement (ADR-004).
- Any code that writes a balance field directly is a defect.
