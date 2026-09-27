# ADR-011: One scheduled-job ledger, not one table per periodic job

Status: Accepted
Date: 2026-09-16
Supersedes the storage decision in ADR-007 (the close semantics are unchanged)
Relates to: ADR-010

## Context

`workforce.attendance_close_run` was built for one job and carried five separate concerns:
idempotency per tenant-day, claiming, attempt counting with backoff, recovery of a run whose
worker died, and abandonment when a day could not be evaluated at all.

Leave accrual and carry-forward needed every one of those. They had none: both were
reachable only from an API call. A tenant whose administrator forgot to press the button on
the first of the financial year quietly did not accrue anyone's leave, and carry-forward
that never runs takes days away from employees who earned them — the same class of silent
failure ADR-007 was written to prevent for attendance.

The obvious move was to copy `attendance_close_run` for leave. That would have duplicated
the machinery, and the second copy is where the retry semantics quietly diverge from the
first.

## Problem

Decide whether periodic work gets shared infrastructure or per-domain tables.

## Options

1. **Copy the table per job type.** No abstraction to get wrong, and the retry, stale and
   abandonment logic exists in as many versions as there are jobs.
2. **A general task queue** (Celery-style, or a `jobs` table with arbitrary payloads and
   handlers). Solves a much larger problem than this system has, and invites ad-hoc and
   high-rate work into a table designed for exactly-once periodic work.
3. **One ledger for work keyed by tenant and date.** `integration.scheduled_job` with
   `(tenant_id, job_type, execution_date, job_key)` unique, and a code-side registry mapping
   a job type to a planner and an executor.

## Decision

**Option 3.** `integration.scheduled_job` holds every periodic job. A job type contributes
only what is specific to it:

- `plan(tx, clock)` — what does this tenant owe, given its own local calendar position
- `execute(tx, job)` — do it, or hand it to someone who will

Everything else is shared: idempotent scheduling, claiming with `FOR UPDATE SKIP LOCKED`,
attempt counting, capped exponential backoff, stale recovery, abandonment, and the audit row
that makes abandonment visible.

It is deliberately **not** a general task queue. It schedules work that is keyed by a tenant
and a date and must happen exactly once per key. Fan-out and high-rate work belong on SQS,
which is where dispatched jobs go.

`attendance_close_run` was migrated onto it and dropped. Its rows were **backfilled**, not
recreated: they are the evidence that a day was closed, and payroll refuses to run over a day
with no such evidence, so discarding them would have blocked every tenant's next payroll run.

## Reason

Two job types with identical machinery is the point at which sharing stops being speculative.
The framework earns itself immediately: leave accrual and carry-forward gained retry, stale
recovery and abandonment for free, and gained scheduling at all.

`job_key` is `NOT NULL DEFAULT ''` rather than nullable on purpose. A `NULL` in a unique key
is distinct from every other `NULL`, so a nullable discriminator silently stops constraining
exactly the tenant-wide case it most needs to cover — a bug this repository has already been
bitten by once, in `leave_period_job`.

`execution_date` is the date the job is *for*, not when it runs. An attendance close for the
3rd that runs on the 4th is still the 3rd's close, and a retry must not shift it.

## Consequences

- `workforce.attendance_close_coverage()` keeps its signature and now reads
  `integration.scheduled_job`. Payroll's completeness guard is untouched.
- The Python workforce engine settles `integration.scheduled_job` rather than
  `attendance_close_run`. The contract between Node and Python is one row and its status.
- A new periodic job cannot ship without retry, backoff and abandonment, because it inherits
  them rather than implementing them.
- Only `annual` leave accrual is scheduled. `runAccrual` grants the full annual allocation
  regardless of `accrual_frequency`, so automating monthly rules would grant twelve years of
  leave in a year. The restriction is in code with the reason next to it, and the gap is
  recorded in the knowledge layer rather than left to be rediscovered.
- Jobs are never scheduled for a period that began before the tenant existed, so deploying
  this does not retroactively accrue a year of leave for every existing tenant.
