# Invariants

SEMANTIC. Rules that must not be violated. Violating one is a defect even if tests pass.
Sources: PRD s.27/s.29/s.35, ArchitectureDiagram/README s.5-14, ERD/README.

## Multi-tenancy

- Every tenant-owned table has `tenant_id UUID NOT NULL`.
- PostgreSQL RLS enforces isolation. Application filtering alone is never sufficient.
- Tenant context is transaction-local: `BEGIN` then `SET LOCAL app.tenant_id`.
- Never set tenant context at session/connection level — pools reuse connections across tenants.
- Background jobs take `tenant_id` from the event envelope. There is no JWT in a worker.
- Missing or unresolvable tenant context fails closed. Never fall back to "all tenants".
- Privileged/platform operations that cross tenants are explicit, audited and separately authorized.
- `tenant_id` leads tenant-scoped indexes.
- The API proves at boot that its own connection is subject to RLS and refuses to start
  otherwise (`probeRlsEnforcement`). Connecting as the table owner, a superuser, or a
  `BYPASSRLS` role silently disables every policy, so this is checked, not assumed.
- A table with `tenant_id` and no RLS policy is a defect. The only exceptions are marked
  in the migration with `-- rls:exempt <reason>` and are visible in
  `generated/db-objects.yaml`; `npm run knowledge:check` fails on an unmarked one.

## Events and async

- SQS delivery is at-least-once; consumers must be idempotent.
- A business write and its event are published via the outbox, in one transaction. Never write to the DB and then publish separately.
- Consumers record `(event_id, consumer_name)` in `processed_event` and check it before acting.
- Every queue has a DLQ. Failures are dead-lettered, never silently dropped.
- Work that calls an external service (email, S3) does not hold a database transaction open
  while it does so. Claim and commit, act, then settle — otherwise a transaction that fails
  after a successful send loses the record and the retry sends a second copy to a real person.
- Events carry the full envelope; `correlation_id` propagates end to end.
- Event ordering is not guaranteed — never depend on arrival order for correctness.

## Effective-dated history

- Employment, manager, salary, shift, policy, tax and benefit records are effective-dated.
- Calculations resolve the record effective *for the period*, never the current row.
- Changing today's configuration must not alter a historical result.
- Overlapping active records for the same employee/resource are invalid unless overlap is intentionally supported.

## Attendance

- Raw check-ins are immutable observed facts; never updated or deleted.
- **Absence is decided only by the daily close.** An event-driven recalculation writes a
  day only when that day has check-ins, leave or a correction. Without this split, whether
  someone was "absent" would depend on when an unrelated event happened to arrive, and
  payroll LOP would stop being deterministic.
- The close is **scheduled**, not manual. The scheduler polls per tenant, computes the
  business date in that tenant's timezone past its `attendance_close_hour`, and dispatches
  one job per tenant-day. Relying on an operator to call the endpoint is how absences stop
  being recorded.
- One close per tenant per business date, enforced by
  `UNIQUE (tenant_id, job_type, execution_date, job_key)` on `integration.scheduled_job`.
  Several scheduler instances is a supported configuration, not a race.
- A close that does not complete is reclaimed and retried; after `max_attempts` it is
  abandoned and audited as needing a human. An abandoned day is never silently forgotten.
- Payroll refuses to build a snapshot over days that were never closed. Overriding requires
  an explicit flag *and* a reason, and is audited as a sensitive action.
- A day inside a finalized payroll period is never re-derived. The correction still exists
  and is visible; the money moves through a supplementary run.
- LOP has exactly one source per day. Derived attendance already folds approved leave into
  its LOP figure, so payroll adds leave-based LOP only for days attendance has not covered
  — counting both would charge the employee twice for one absence.
- Attendance is derived state and must be recomputable from check-ins + shift + leave + holidays.
- Corrections go through request-and-approval and trigger recalculation; they never rewrite raw events.
- Overnight shifts (`crosses_midnight`) must be supported; attendance_date is the shift's date, not the clock date.
- Timestamps are `timestamptz`; the applicable timezone is explicit (location/tenant), never the server's.
- Processing tolerates duplicates, retries, missing OUT, out-of-order events, offline devices and device clock drift.

## Scheduled jobs

- Periodic work keyed by a tenant and a date lives in `integration.scheduled_job`, never in
  a per-domain copy of the same machinery (ADR-011). A new job type contributes a planner
  and an executor; retry, backoff, stale recovery and abandonment are inherited.
- `execution_date` is the date the job is *for*, not when it ran. A retry never shifts it.
- `job_key` is `NOT NULL DEFAULT ''`. A nullable discriminator in a unique key stops
  constraining the tenant-wide case, which is the case it most needs to cover.
- Claiming is `FOR UPDATE SKIP LOCKED` **in a CTE**, not `WHERE id IN (SELECT ... LIMIT n
  FOR UPDATE SKIP LOCKED)`. With a locking subquery the planner may evaluate it more than
  once and claim past the limit; a caller that then handles only the first strands the rest.
  The same applies to every claim in the system: outbox, notifications, local queue.
- A claimed job is always either executed or explicitly failed. Leaving one `running` with
  nobody working on it is invisible until the stale sweep, which is the slow path.
- A failed attempt is recorded in its **own** transaction with the attempt count from the
  claim. The executing transaction has usually rolled back by then, taking its increment
  with it, so incrementing would let a permanently failing job retry for ever.
- Scheduling is `ON CONFLICT DO NOTHING`. A completed job is never resurrected by a later
  sweep, so the backfill window cannot re-run work that already succeeded.
- Nothing is scheduled for a period that began before the tenant existed.

## Leave

- `leave_ledger_entry` is the balance authority. Balance is always derived by summing the ledger.
- No stored mutable balance column is authoritative.
- Ledger entries are append-only. Reversals are compensating entries, never updates or deletes.
- Every ledger entry records its cause (`source_type`, `source_id`).
- Approval writes the application state and the ledger entry in the same transaction.

## Payroll

- Payroll calculates only from `payroll_input_snapshot`. Never from live mutable tables.
- One employee's bad data fails that employee, not the run. A run with any failed employee
  cannot be approved.
- The year's taxable income is **estimated, never extrapolated from one month**:
  `opening + previous actual + current + recurring × (months remaining − 1)` (ADR-014).
  `gross × 12` is wrong for a mid-year joiner, wrong after a raise, and wrong in an LOP
  month. Only the recurring part is projected — a one-off bonus is in the year once.
- Opening taxable earnings and opening TDS from a previous employer are part of that
  estimate and are frozen into the snapshot. Without them a mid-year joiner is
  systematically under-deducted, which is the employer's liability under section 192(2).
- Months remaining comes from `identity.tenant.fy_start_month`, never from a hardcoded
  April.
- Monthly TDS is `(annual liability − deducted year to date) ÷ months remaining`. Both
  terms are required: subtracting what was already deducted is what stops double
  collection after a raise, and dividing by the months left is what spreads the correction
  forward instead of rewriting finalized payslips.
- The tax base is decided by component configuration, not by component type: earnings
  marked `taxable`, less deductions marked `exempted_from_income_tax`. Employee PF and
  professional tax reduce taxable salary because the statute says so; ESI does not.
- A required statutory rule that cannot be resolved **fails that employee**, naming the
  rule, the year and the jurisdiction. Payroll never substitutes zero for a rule it could
  not find — zero deducted because none is due and zero deducted because nothing was
  configured are indistinguishable on a payslip, and only one of them is correct.
- A **supplementary** run pays one-off amounts only, and only for employees who already
  hold a finalized slip for that period. A **regular** or **off-cycle** run excludes
  employees who do. Neither may pay the same period's salary twice.
- Slip numbers carry the run type and the run's sequence within its period, so a
  correction can never collide with what it corrects.
- An additional-salary overwrite replaces a component's value **before** pro-rating, so
  dependent percentage components follow the correction rather than the structure.
- A compensation row created from another document carries `source_type`/`source_id` and is
  unique on them. Leave encashment creates one in the same transaction as the ledger debit:
  a balance may never be spent without the money being owed, and a redelivered event pays
  once.
- TDS never goes negative. Over-deduction is reclaimed by the employee on filing, not
  refunded through payroll.
- Calculation is deterministic: same snapshot + same `calculation_version` = same result.
- Calculation is idempotent; a redelivered job must not double-pay.
- Finalized payroll runs and salary slips are immutable.
- Corrections use adjustment, reversal or supplementary payroll — never an in-place edit.
- Statutory rule versions consumed by a finalized run are never edited; add a new version.
- Slip components keep a name snapshot so later renames do not rewrite history.
- Payment is triggered only after FINALIZED.

## Documents

- Binaries live in private S3; PostgreSQL stores metadata only.
- No public bucket, no public object ACL. Access is via short-lived presigned URLs.
- Authorization is checked before a presigned URL is issued.
- Documents are versioned with a checksum; supersede rather than overwrite.

## Audit

- `audit_log` is append-only. Never updated, never deleted.
- Append-only tables (`audit_log`, `leave_ledger_entry`, `employee_checkin`,
  `event_outbox`, `processed_event`, `payroll_input_snapshot`) enforce this with a trigger,
  not by convention.
- Erasing a tenant is the single exception, and it is narrow: `identity.purge_tenant` sets
  `app.purge_mode` transaction-locally and is executable only by the platform role. It
  permits DELETE and never UPDATE — history can be removed wholesale under an authorised
  erasure, but it can never be quietly rewritten. Every purge writes to
  `identity.tenant_purge_log`, which outlives the tenant it names.
- Audit is mandatory for: salary change, bank detail change, attendance correction, leave adjustment, payroll finalization, separation, role/permission change.
- The trail records that a secret changed, never the secret. Passwords, tokens and account
  numbers are redacted before the audit row is written.
- Every audit record identifies actor, time, entity, action and before/after state.

## Security

- Sensitive fields (salary, bank, tax) require permission beyond normal tenant access.
- Bank account numbers are encrypted at rest.
- TLS in transit, KMS at rest, secrets in Secrets Manager — never in code or env files in the repo.
- Input validation, rate limiting and secure headers on every public endpoint.
- Rate-limit state is shared through Redis. Per-process counters multiply the effective
  limit by the instance count, so the API refuses to start in production without `REDIS_URL`.
- Rate limiting fails **open**: a Redis outage degrades the limit, it does not take the API
  down. Isolation and authorization are enforced elsewhere and are unaffected.
- Anyone holding a permission the catalog marks `sensitive` must have an active second
  factor and cannot complete a login without one (ADR-012). "Sensitive" is
  `identity.permission.sensitive`, never a second hand-maintained list, so a permission
  added later is covered without anyone remembering.
- The requirement is enforced in `login()` before a token is issued, and re-checked on every
  refresh. A route guard can be missed by a new route; a login that cannot mint a token
  cannot be.
- A TOTP code is single-use inside its own window (`last_used_counter`). A recovery code is
  single-use for ever, hashed like a password, and shown exactly once.
- Removing a second factor requires the password *and* a current code, and is refused for a
  privileged account. A hijacked session must not be able to strip the control that would
  have stopped it.
- Auth failures stay enumeration-resistant: wrong password, unknown email and no membership
  all return the same message after the same amount of work.

## Errors and transactions

- A constraint violation aborts the surrounding PostgreSQL transaction. Where a conflict is
  an expected outcome — a duplicate device check-in, a replayed accrual — use
  `ON CONFLICT`, not a caught exception, or the caller's other work in the same transaction
  fails with "current transaction is aborted".
- Database integrity errors are translated into meaningful HTTP responses (409, 422) rather
  than surfacing as 500s. A framework error that already carries a 4xx status keeps it.

## Observability

- A span may carry identifiers and counts. It may never carry a value: no salary, no bank
  detail, no tax identifier, no email, no name (ADR-013). Enforced by an **allow-list** of
  attribute names, because a deny-list has to predict every name someone invents.
- An error span carries the error *type*, never its message. A PostgreSQL constraint
  message quotes the row that violated it, and that row is employee data.
- The same rule governs logs: never log passwords, OTP secrets, recovery codes, refresh
  tokens, account numbers or payroll figures.
- Trace context propagates as W3C `traceparent`, on the outbox row and the event envelope,
  so asynchronous work belongs to the trace of the request that caused it.
- A missing or malformed trace is never a reason to drop work. Telemetry failures are
  swallowed; they must never break the thing they observe.

## Health

- Liveness, readiness and dependency health are three different questions with three
  endpoints. `/health/live` touches nothing — a database blip must not restart every task.
  `/health/ready` checks only what a request genuinely cannot proceed without, which is the
  database. `/health/deps` is diagnostics and always returns 200, so no load balancer acts
  on it.
- No health response may contain a connection string, host, bucket, queue URL or credential.

## Architecture

- PostgreSQL is the transactional source of truth. Redis, SQS and S3 never are.
- Node owns authentication, authorization, APIs, transactions and state transitions.
- Python owns calculation engines (attendance, payroll, tax, statutory, bulk).
- A domain depends on another domain's API or events, never on its tables.
- Do not fragment into many small microservices; extract only for a proven scaling, ownership or reliability reason.
- Long-running work is asynchronous and exposes state through a job/aggregate record.
- The worker binary has four selectable roles — `publisher`, `consumer`, `notifications`,
  `scheduler` (ADR-010). Splitting them across deployments is configuration, not a code
  change, and every loop is safe to run in several instances at once. An unknown role name
  is a startup error: a typo that quietly starts no scheduler is invisible until payroll is
  wrong.
- The scheduler is monitored by the **absence** of ticks, not by errors. It failing produces
  no error at all — days simply stop closing.

## AI

- Human-in-the-loop for high-impact employment decisions.
- AI must never autonomously reject a candidate, terminate an employee, deny leave or alter payroll.
- AI outputs are explainable, reviewable and auditable.
