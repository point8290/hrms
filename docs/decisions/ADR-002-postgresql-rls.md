# ADR-002: PostgreSQL RLS with transaction-local tenant context

Status: Accepted
Source: PRD s.27; ArchitectureDiagram/README s.5-6, s.15; ERD/09-rls-model.puml

## Context

ADR-001 puts all tenants in one schema, so isolation depends on every query being
correctly scoped. Application-level filtering is necessary but not sufficient: one
forgotten predicate, one hand-written report query, one ORM relation loaded without a
scope, and a tenant sees another tenant's payroll.

Background workers complicate this further — an SQS consumer has no HTTP request and no
JWT to derive tenant from.

## Decision

Row-Level Security is the enforcement boundary. Every tenant-scoped table has an RLS
policy comparing `tenant_id` to `current_setting('app.tenant_id')`.

The application supplies context; PostgreSQL enforces it:

```sql
BEGIN;
SELECT set_config('app.tenant_id', $1, true);  -- true = transaction-local
-- tenant-scoped queries
COMMIT;
```

Rules:

- Context is **transaction-local** (`SET LOCAL` / `set_config(..., true)`), never session-level.
- Workers take `tenant_id` from the event envelope and set it the same way.
- Missing or unparseable context fails closed — no rows, not all rows.
- The application-level tenant filter stays in place as defense in depth.

## Reason

- Connection pools reuse connections across tenants; a session-level setting leaks into
  the next request on that connection. Transaction-local scoping cannot leak.
- RLS makes isolation a property of the data, not of the code path that reads it.
- The same mechanism works identically for API requests and workers, so there is one
  rule to teach, review and test.

## Consequences

- Every database access must go through a transaction that established tenant context.
  A helper that opens a transaction and sets context is the only sanctioned entry point.
- Migrations, the outbox publisher and platform administration need a privileged role
  that bypasses RLS, used deliberately and never by request-handling code.
- Query plans must be checked with RLS enabled; predicates are added by the policy.
- Isolation tests (tenant A cannot read tenant B) are mandatory, not optional.
