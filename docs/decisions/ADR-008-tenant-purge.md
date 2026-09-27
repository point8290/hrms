# ADR-008: Tenant erasure via a narrow, audited purge mode

Status: Accepted
Date: 2026-09-16
Refines: ADR-006 (append-only leave ledger), and the append-only rule generally.

## Context

Audit records, the leave ledger, raw check-ins, the event outbox and payroll input
snapshots are append-only, enforced by database triggers rather than by convention. A
finalized salary slip has its own guard that refuses both UPDATE and DELETE.

Those guarantees are correct and load-bearing. They also made it impossible to delete a
tenant: `DELETE FROM identity.tenant` cascades into every one of those tables and is
refused. This surfaced the first time a test tried to clean up after itself, but the real
case is not tests — it is offboarding a customer and honouring a data-erasure request.

## Problem

"History can never be removed" and "a customer can demand erasure" are both requirements.
A half-purged tenant — some tables emptied, others refused — is worse than either.

## Options

1. **Drop the append-only triggers.** Removes the guarantee that makes the ledger and the
   audit trail trustworthy. Rejected outright.
2. **Soft-delete tenants only.** Avoids the conflict but does not actually erase anything,
   so it does not satisfy an erasure obligation.
3. **Let the platform role bypass the triggers unconditionally.** Every publisher and
   maintenance job runs as that role, so any bug in any of them could silently erase
   history.
4. **A transaction-local purge mode, permitting DELETE only, behind a single privileged
   function.**

## Decision

Option 4.

`app.forbid_mutation()` allows DELETE when `app.purge_mode` is `on`, and refuses UPDATE in
every mode. `payroll.guard_finalized_slip()` does the same for finalized payslips.

The only sanctioned way to set it is `identity.purge_tenant(tenant_id, reason)`:

- `EXECUTE` is granted to `hrms_platform` only; `hrms_app` cannot call it
- it requires a non-empty reason
- it writes `identity.tenant_purge_log` *before* the cascade — a row that is deliberately
  not tenant-scoped, so the evidence outlives the tenant it names
- it sets `app.purge_mode` transaction-locally, so the flag cannot linger on a pooled
  connection

## Reason

- The distinction that actually matters is preserved: history can be removed **wholesale**
  under an authorised erasure, but it can never be **quietly rewritten**. Allowing DELETE
  while still refusing UPDATE encodes exactly that.
- Transaction-local scoping is the same mechanism as tenant context (ADR-002), and fails
  the same way — it cannot leak between requests.
- The privilege is one function with one grant, so "who can erase a tenant" has a single,
  greppable answer.
- The purge log means an erasure is itself auditable, which is what a regulator asks for.

## Trade-offs

- A GUC-based escape hatch is, in principle, reachable by anything that can execute
  arbitrary SQL as the platform role. The mitigation is that the platform role's surface is
  three narrow uses (provisioning, outbox publishing, queue transport) and the application
  role cannot reach the function at all.
- Purging is irreversible and cascades widely. There is no dry-run mode yet.
- Tests use the real purge path for teardown. That keeps it exercised, but it also means
  test runs depend on a production-grade privileged function behaving correctly.

## Impact

- `db/migrations/0009_purge_mode.sql`, `db/migrations/0010_purge_finalized_payroll.sql`
- `db/grants.sql`: `purge_tenant` EXECUTE granted to `hrms_platform` only
- `docs/knowledge/invariants.md#audit`
- `apps/api/test/integration/helpers.ts`: teardown goes through `identity.purge_tenant`
