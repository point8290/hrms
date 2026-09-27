# ADR-007: Absence is decided by a daily close, not by event-driven recalculation

Status: Accepted
Date: 2026-09-16
Supersedes: nothing. Refines ADR-005 (payroll determinism).

## Context

Attendance is derived state: a check-in arrives, the workforce engine re-derives the day it
belongs to. Because an overnight shift can be affected by a punch made after midnight, the
engine re-derives the previous day too.

That produced a real bug. A check-in on the 10th caused the 9th to be evaluated, found no
punches for it, and wrote `absent` with a full day of LOP. Days nobody happened to touch
stayed unevaluated. So whether an employee was recorded absent depended on whether an
unrelated event later landed near that date — and payroll LOP, which is supposed to be a
deterministic function of the period, silently became a function of event timing.

The underlying confusion is that two different questions were being answered by one code
path:

- *What do these observations say about this day?* — answerable as soon as an observation
  arrives.
- *Was this person absent?* — only answerable once the day is over and all its observations
  are in.

## Problem

Deriving attendance on every event either invents absences for days that were never really
evaluated, or — if absences are suppressed — never records a genuine absence at all.

## Options

1. **Suppress absence entirely in event-driven runs, never record it.** Simple, but nobody
   is ever marked absent, and LOP silently under-reports.
2. **Evaluate the whole period at payroll time.** Makes payroll responsible for attendance
   semantics, duplicating the engine's logic on the Node side — exactly the duplication
   ADR-003 exists to prevent.
3. **Split the two jobs.** Event-driven recalculation writes only days that have inputs; a
   scheduled daily close evaluates every employee for a completed day and is the only path
   that may record an absence.

## Decision

Option 3. `recalculate_range(..., mark_absent: bool)`:

- **Event-driven** (`mark_absent=False`): writes a day only when it has check-ins, approved
  leave, an approved correction, or an already-derived row to update.
- **Daily close** (`mark_absent=True`): `close_day(tenant_id, date)` evaluates every active
  employee for that date. Exposed as `POST /internal/close-day` and as a CLI subcommand,
  so a scheduler decides when a tenant's day is over in its own timezone.

An operator-requested recalculation also uses `mark_absent=True`: asking for a range
explicitly is a statement that the range is complete.

Payroll's snapshot records `derived_days` and `attendance_complete`, so a payroll
administrator can see whether LOP was computed from a complete picture.

## Reason

- Absence is a judgement about a finished day. Making that explicit in the signature stops
  the two cases being conflated again.
- LOP becomes a function of the period and its observations, which is what ADR-005 needs
  from it: the same snapshot must always produce the same payslip.
- The scheduler, not the engine, owns "when is the day over" — the only component that can
  know a tenant's timezone and cut-off policy.

## Trade-offs

- A daily close must actually be scheduled. If it is not, absences are never recorded and
  payroll under-reports LOP. The snapshot's `attendance_complete` flag makes that visible
  rather than silent, but it does not prevent it.
- Two code paths through the same derivation, distinguished by one flag. The alternative —
  two separate functions — would duplicate the loop and drift.
- Backfilling a long-unprocessed range is bounded by `MAX_BACKFILL_DAYS` (31), so a very
  stale employee needs repeated closes.

## Impact

- `services/workforce-engine/app/main.py`: `recalculate_range`, `close_day`
- `services/workforce-engine/app/repository.py`: `attendance_exists`
- `apps/api/src/modules/payroll/snapshot.ts`: `derived_days`, `attendance_complete`
- `docs/knowledge/invariants.md#attendance`
- Deployment gains a required scheduled job per tenant timezone.
