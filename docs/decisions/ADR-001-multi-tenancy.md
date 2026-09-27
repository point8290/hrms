# ADR-001: Shared-database multi-tenancy with `tenant_id`

Status: Accepted
Source: PRD s.6, s.27, s.29; ERD/README

## Context

The product is SaaS: many customer organizations on shared infrastructure, each needing
strict data isolation. The options were database-per-tenant, schema-per-tenant, or a
shared schema with a discriminator column. Tenant count is expected to grow well beyond
what per-tenant DDL can be operated comfortably, and the domain needs ACID transactions
spanning many tables (payroll touches compensation, attendance, leave and tax together).

## Decision

One PostgreSQL database, one set of logical schemas, shared by all tenants.

Every tenant-owned table carries `tenant_id UUID NOT NULL`. `tenant_id` leads
tenant-scoped indexes. The `tenant` table itself and global `app_user` / `permission`
records are the only non-tenant-scoped tables.

Tenant-scoped reference and configuration data stays tenant-owned even when it looks
generic — a salary component named "Basic" has tenant-specific formula, eligibility and
tax treatment.

## Reason

- Migrations, monitoring and backup stay O(1) instead of O(tenants).
- Cross-table transactions remain ordinary local transactions.
- Isolation can still be enforced at the database level via RLS (see ADR-002), which is
  the property database-per-tenant was really bought for.
- Per-tenant physical separation can still be introduced later for a specific large
  tenant without redesigning the data model.

## Consequences

- Isolation is now a *correctness* concern in every query path, so it must be enforced
  by the database, not by developer discipline — hence ADR-002.
- A missing `WHERE tenant_id` is a cross-tenant data leak, the highest-severity defect
  class in this system.
- Partitioning by tenant is deliberately avoided; high-volume tables partition by time
  instead (`employee_checkin`, `audit_log`, `notification`, `event_outbox`).
- Platform-level operations that legitimately cross tenants must be explicit, separately
  authorized and audited.
