# HRMS PostgreSQL Domain Model + ERD

This package defines the PostgreSQL domain model for the multi-tenant SaaS HRMS.

It is intentionally more detailed than the C4 diagrams. C4 explains runtime architecture; this package explains the transactional data model.

## Design principles

1. PostgreSQL is the source of truth for transactional HR data.
2. Every tenant-owned table contains `tenant_id`.
3. PostgreSQL Row-Level Security (RLS) is the database-level tenant isolation boundary.
4. Sensitive and financially important records are auditable.
5. Historical business data is preserved using effective-dated records and immutable snapshots.
6. Raw attendance events are separated from derived attendance.
7. Leave balances are ledger-derived rather than balance-field-only.
8. Payroll is snapshot-based and finalized payroll is immutable.
9. Events are recorded through an outbox for reliable asynchronous publication.
10. Large event-like tables can be time-partitioned after real workload measurements.

## Diagram files

- `01-domain-overview.puml` — business domain relationships.
- `02-core-hr-erd.puml` — tenant, identity, organization and employee model.
- `03-workforce-erd.puml` — shifts, check-ins, attendance and corrections.
- `04-leave-erd.puml` — leave policy, applications and ledger.
- `05-compensation-payroll-erd.puml` — salary structures, assignments, payroll and payslips.
- `06-expense-performance-erd.puml` — expenses, advances and performance.
- `07-documents-workflow-audit-erd.puml` — documents, workflow, notifications and audit.
- `08-full-logical-erd.puml` — consolidated logical ERD.
- `09-rls-model.puml` — tenant isolation and RLS flow.
- `10-payroll-data-flow.puml` — payroll snapshot/data-flow diagram.

## Suggested database schemas

A practical initial PostgreSQL database can use logical schemas:

```text
identity
core
recruitment
workforce
leave_mgmt
expense
compensation
payroll
performance
learning
workflow
documents
notification
audit
integration
```

Do not create a separate database for every domain at the beginning. Keeping tightly coupled transactional domains in PostgreSQL simplifies ACID transactions and historical consistency.

## Tenant ownership

Most business tables are tenant-owned:

```text
tenant_id UUID NOT NULL
```

Reference/configuration data can still be tenant-scoped when customers are allowed to customize it.

For example, a salary component such as `Basic` may look globally generic, but its percentage, formula, eligibility and tax treatment can be tenant-specific. Therefore tenant ownership should normally remain explicit.

## RLS rule

The application establishes:

```sql
BEGIN;

SELECT set_config(
  'app.tenant_id',
  '<tenant UUID>',
  true
);

-- tenant-scoped queries

COMMIT;
```

RLS policies then compare `tenant_id` with the transaction-local setting.

A production implementation should also deliberately handle missing context. Fail closed rather than accidentally allowing broad access.

## Worker rule

SQS workers do not have an HTTP JWT.

Therefore:

```text
SQS event
   |
   +-- tenant_id
   |
   v
Worker
   |
   +-- BEGIN
   +-- SET LOCAL app.tenant_id
   |
   v
PostgreSQL RLS
```

The worker must not rely on an application-global tenant variable because connection pools can reuse database connections across tenants.

## Effective dating

Use effective-dated records for:

- employment assignment
- department/designation
- manager assignment
- salary assignment
- shift assignment
- tax rules
- benefits
- policies

A common pattern is:

```text
effective_from
effective_to NULL
```

For temporal correctness, avoid overlapping active records for the same employee/resource unless overlap is intentionally supported.

## Immutable records

The following should be treated as append-only or effectively immutable after finalization:

- raw check-in events
- leave ledger entries
- audit events
- finalized payroll
- finalized salary slip snapshots
- important event/outbox records

Corrections should generally create compensating records rather than silently rewriting history.

## Important relationships

```text
Tenant
  |
  +-- Users / Memberships
  +-- Organization
  +-- Employees
  +-- Policies
  +-- Payroll
  +-- Attendance
  +-- Leave
  +-- Expenses
```

Employee:

```text
Employee
  |
  +-- Employment History
  +-- Manager Assignment
  +-- Bank Accounts
  +-- Tax Profile
  +-- Documents
  +-- Shift Assignments
  +-- Check-ins
  +-- Attendance
  +-- Leave Applications
  +-- Leave Ledger
  +-- Expenses
  +-- Salary Assignments
  +-- Payroll Results
  +-- Performance
```

## Payroll source-of-truth rule

Payroll should consume a controlled input snapshot:

```text
Employee
Salary Assignment
Attendance
Leave / LOP
Benefits
Tax Declaration
Statutory Rules
        |
        v
Payroll Input Snapshot
        |
        v
Calculation Engine
        |
        v
Salary Slip Snapshot
        |
        v
Finalized Payroll
```

The salary slip must not depend on today's mutable employee data after finalization.

## Recommended indexes

For tenant-owned tables, most indexes should begin with `tenant_id` when queries are tenant-scoped.

Examples:

```sql
CREATE INDEX idx_employee_tenant_status
ON core.employee(tenant_id, employment_status);

CREATE INDEX idx_checkin_tenant_employee_time
ON workforce.employee_checkin(tenant_id, employee_id, checkin_at);

CREATE INDEX idx_attendance_tenant_employee_date
ON workforce.attendance(tenant_id, employee_id, attendance_date);

CREATE INDEX idx_leave_application_tenant_employee
ON leave_mgmt.leave_application(tenant_id, employee_id);

CREATE INDEX idx_payroll_employee_tenant_run
ON payroll.payroll_employee(tenant_id, payroll_run_id);
```

Do not blindly add indexes to every column. Use actual query patterns and `EXPLAIN ANALYZE`.

## Large-table partitioning

Candidates for partitioning:

```text
employee_checkin
audit_log
notification
event_outbox
```

A sensible starting strategy is time-based partitioning for high-volume event tables, while retaining `tenant_id` in every row and in appropriate indexes.

Do not partition solely by tenant unless there is a proven operational requirement. A tenant-per-partition model becomes difficult with many tenants.

## What this ERD intentionally does not define

This is a logical/high-level database model, not a production migration.

It does not yet prescribe:

- exact UUID implementation
- all CHECK constraints
- all FK actions
- every audit column
- generated columns
- every index
- partition DDL
- encryption implementation
- migration tooling
- exact tax formulas
- country-specific statutory rules

Those belong in the physical database design after the domain model is accepted.
