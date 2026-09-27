# Multi-Tenant SaaS HRMS — C4 Architecture Diagrams

This directory contains the PlantUML source for the high-level architecture of the HRMS.

## 1. What this architecture represents

The product is an India-first, multi-tenant SaaS HRMS covering:

- Tenant and organization management
- Identity and RBAC
- Core HR and employee lifecycle
- Recruitment and onboarding
- Shift and attendance
- Leave
- Expenses
- Compensation
- Payroll
- Tax and statutory processing
- Benefits
- Performance
- Learning
- Documents
- Employee and manager self-service
- Workflow and approvals
- Notifications
- Reporting and analytics
- Audit and compliance
- Future AI capabilities

The architecture intentionally starts as a modular distributed system rather than a collection of very small microservices.

The core runtime boundary is:

React -> Node.js/TypeScript -> PostgreSQL/RLS

with asynchronous calculation workloads handled through:

SQS -> FastAPI/Python -> PostgreSQL

AWS S3 is used for documents and generated files, SES for transactional email, and Redis for cache/short-lived coordination.

---

## 2. C4 levels used in this project

### Level 1 — System Context

File:

`01-system-context.puml`

Answers:

- Who uses the HRMS?
- What external systems interact with it?
- What is inside the HRMS boundary?

Do not put databases, frameworks or individual services on this diagram.

The HRMS should appear as one system.

### Level 2 — Container

File:

`02-container.puml`

Answers:

- What are the major runtime/deployment containers?
- Which technology owns each responsibility?
- How do the major systems communicate?

Main containers:

- React web application
- Node.js HRMS API
- Node.js background worker
- FastAPI workforce engine
- FastAPI payroll engine
- PostgreSQL
- SQS
- Redis
- S3
- Notification service
- SES
- External integrations

This is the most important diagram for a senior system-design interview.

### Level 3 — Component

Files:

`03-node-components.puml`
`04-workforce-components.puml`
`05-payroll-components.puml`

The Node diagram explains business modules.

The Workforce diagram explains attendance calculation.

The Payroll diagram explains the payroll calculation engine.

Only complex containers need to be expanded to component level.

### Deployment

File:

`06-aws-deployment.puml`

Maps logical containers to AWS infrastructure.

The exact choice between ECS and EKS is a deployment decision; the diagram intentionally shows both as an implementation option.

### Sequence diagrams

Files:

`07-sequence-onboarding.puml`
`08-sequence-attendance.puml`
`09-sequence-leave.puml`
`10-sequence-payroll.puml`

These explain runtime behavior.

For interviews, the payroll and attendance sequences are particularly important because they demonstrate transaction boundaries, async processing, tenant context and idempotency.

### Cross-cutting tenant sequence

File:

`11-notes-tenant-runs.puml`

Shows the critical rule for background workers:

The HTTP JWT does not exist when an SQS worker runs.

Therefore:

`tenant_id -> event/message -> worker -> SET LOCAL app.tenant_id -> PostgreSQL RLS`

### State machines

File:

`12-state-machines.puml`

Shows important business lifecycle states for payroll, leave and expenses.

---

# 3. PlantUML prerequisites

The diagrams use C4-PlantUML.

The sources import C4-PlantUML from PlantUML's local standard library:

`<C4/C4_*.puml>`

Therefore rendering does not need network access for the C4 dependency. Use a current
PlantUML distribution that includes the C4 standard-library files.

Recommended options:

1. PlantUML desktop / local JAR
2. VS Code with a PlantUML extension
3. IntelliJ with PlantUML support
4. Kroki
5. A CI/CD PlantUML rendering step

For a renderer that does not ship the C4 standard library, install or vendor a pinned
C4-PlantUML distribution and configure its include path.

---

# 4. Recommended repository structure

A future architecture repository could look like:

```text
docs/
  architecture/
    README.md

    c4/
      01-system-context.puml
      02-container.puml
      03-node-components.puml
      04-workforce-components.puml
      05-payroll-components.puml
      06-aws-deployment.puml

    sequences/
      07-sequence-onboarding.puml
      08-sequence-attendance.puml
      09-sequence-leave.puml
      10-sequence-payroll.puml

    cross-cutting/
      11-tenant-context-async.puml
      12-state-machines.puml

    images/
      ...
```

---

# 5. Architecture rules

## Rule 1 — PostgreSQL is the transactional source of truth

Do not make Redis, SQS or S3 the source of truth for HR transactions.

PostgreSQL owns:

- Employees
- Employment history
- Attendance
- Leave ledger
- Compensation
- Payroll
- Expenses
- Workflow state
- Audit records

S3 owns binary files.

SQS owns asynchronous message delivery.

Redis owns temporary/cache state.

---

## Rule 2 — Every tenant-owned table has tenant_id

Conceptually:

```sql
tenant_id UUID NOT NULL
```

Tenant-owned tables should have appropriate RLS policies.

Example policy concept:

```sql
CREATE POLICY tenant_isolation
ON employee
USING (
    tenant_id = current_setting('app.tenant_id')::uuid
);
```

The actual production implementation should also handle:

- missing tenant context
- connection pooling
- privileged operations
- migrations
- platform administration
- service/database roles

---

# 6. Tenant context rule

For an HTTP request:

```text
JWT
 |
 +-- tenant_id / tenant membership
 |
 v
Node.js
 |
 v
BEGIN
 |
 +-- SET LOCAL app.tenant_id
 |
 v
PostgreSQL
 |
 v
RLS
```

For SQS:

```text
SQS message
 |
 +-- tenant_id
 |
 v
Worker
 |
 v
BEGIN
 |
 +-- SET LOCAL app.tenant_id
 |
 v
PostgreSQL
 |
 v
RLS
```

Never assume the worker can obtain tenant context from an HTTP request.

There is no HTTP request.

---

# 7. Event contract

All important domain events should use a common envelope.

Example:

```json
{
  "event_id": "uuid",
  "event_type": "PayrollRunCreated",
  "schema_version": 1,
  "tenant_id": "tenant-uuid",
  "aggregate_type": "PayrollRun",
  "aggregate_id": "payroll-run-uuid",
  "occurred_at": "2026-09-15T10:00:00Z",
  "producer": "hrms-api",
  "correlation_id": "request-uuid",
  "payload": {}
}
```

Minimum required fields:

- event_id
- event_type
- schema_version
- tenant_id
- aggregate_id
- occurred_at
- producer
- payload

Correlation/request IDs should be propagated through the whole workflow.

---

# 8. Outbox pattern

Do not do this:

```text
DB transaction
   |
   +-- COMMIT

then

SQS publish
```

because the application can crash between the two operations.

Instead:

```text
BEGIN
 |
 +-- Business write
 |
 +-- Outbox event
 |
COMMIT
 |
 v
Outbox publisher
 |
 v
SQS
```

This makes the database transaction and event intent atomic.

The outbox publisher must itself be idempotent.

---

# 9. Idempotency

SQS delivery must be treated as potentially duplicated.

Every consumer should have a processed-event mechanism.

Conceptually:

```text
processed_event
----------------
event_id
consumer_name
tenant_id
processed_at
```

Consumer:

```text
Receive message
       |
       v
Check event_id
       |
   +---+---+
   |       |
Exists   New
   |       |
No-op   Process
   |       |
   |    Record
   |       |
   +---+---+
       |
      ACK
```

This is mandatory for payroll, leave ledger, attendance and financial operations.

---

# 10. Attendance design notes

Raw check-in events should be treated as immutable facts.

Example:

```text
09:02 IN
13:01 OUT
13:45 IN
18:10 OUT
```

The calculation engine derives:

```text
Working hours = 8h 24m
Late = 2m
Overtime = 10m
Status = Present
```

If the attendance policy changes, derived attendance can be recalculated without losing the original check-in events.

The system must handle:

- duplicate events
- missing OUT
- out-of-order events
- offline devices
- device clock differences
- timezone
- overnight shifts
- grace periods
- holidays
- weekly offs
- leave
- overtime

---

# 11. Payroll design notes

Payroll must operate from a controlled snapshot.

Conceptually:

```text
Payroll Run
    |
    +-- Employee snapshot
    +-- Salary snapshot
    +-- Attendance snapshot
    +-- Leave/LOP snapshot
    +-- Tax configuration
    +-- Benefits
    |
    v
Python Calculation Engine
    |
    +-- Earnings
    +-- Deductions
    +-- LOP
    +-- Statutory
    +-- Tax
    +-- Net Pay
    |
    v
Salary Slip Snapshot
    |
    v
Review
    |
    v
Finalize
```

After finalization:

```text
Historical salary slip = immutable
```

Do not allow today's employee configuration to rewrite last month's payroll.

---

# 12. Why Node.js and Python are separated

Node.js owns transactional orchestration:

```text
Authentication
Authorization
CRUD
Workflow
State transitions
Tenant management
Employee management
Leave requests
Expense requests
Payroll orchestration
```

Python owns computational engines:

```text
Attendance calculation
Working-hours calculation
Overtime calculation
Payroll calculation
Tax calculation
Statutory calculation
Bulk processing
```

The split is based on responsibility, not programming-language preference.

---

# 13. Why we should not create dozens of microservices

Avoid:

```text
Employee Service
Department Service
Designation Service
Shift Service
Holiday Service
Attendance Service
Leave Service
Salary Service
Payslip Service
...
```

That would create unnecessary:

- Network calls
- Distributed transactions
- Deployment overhead
- Observability complexity
- Failure modes
- Data consistency problems

Instead:

```text
Node.js Modular Application
        +
Python Calculation Engines
```

Extract a domain only when there is a clear reason such as:

- independent scaling
- independent deployment
- separate team ownership
- different reliability requirements
- materially different workload characteristics

---

# 14. Important database design principle

Use effective-dated records for things that affect historical calculations.

Examples:

```text
Employee department
Employee designation
Manager
Salary
Salary structure
Shift assignment
Leave policy
Tax rules
Benefits
```

Example:

```text
salary_assignment

employee_id
salary_structure_id
effective_from
effective_to
```

This allows payroll for September 2026 to know exactly which salary configuration was effective during that period.

---

# 15. Important interview explanation

If asked:

"Why PostgreSQL RLS if the application already checks tenant_id?"

Answer:

```text
Application-level tenant checks are necessary but not sufficient.

RLS provides a database-level isolation boundary.

Even if an application query accidentally forgets:
WHERE tenant_id = ...

PostgreSQL can still prevent access to another tenant's rows.

The application therefore supplies tenant context,
and PostgreSQL enforces the final isolation boundary.
```

Then explain the worker case:

```text
HTTP requests get tenant context from authenticated user membership.

SQS workers do not have HTTP/JWT context.

Therefore tenant_id is part of the event envelope.

The worker starts a transaction and executes:

SET LOCAL app.tenant_id = ...

before accessing tenant data.

RLS then applies exactly as it does for an API request.
```

---

# 16. Important interview explanation — payroll

If asked:

"Why is payroll calculation asynchronous?"

Answer:

```text
Payroll can involve thousands of employees and multiple calculation stages.

A synchronous API request would be long-running and vulnerable to timeout.

The API therefore creates a payroll run and commits its input snapshot.

An SQS job invokes the Python calculation engine.

The calculation engine processes employees independently,
persists results and reports progress.

The user can review the calculated payroll before finalization.
```

Then add:

```text
The calculation is idempotent and versioned.

Finalization is a separate controlled transaction.
```

---

# 17. Important interview explanation — attendance

If asked:

"Why store check-ins separately from attendance?"

Answer:

```text
A check-in is an observed event.

Attendance is a derived business result.

Keeping them separate gives us traceability and allows attendance
to be recalculated when shift or attendance policies change.

It also prevents corrections from destroying the original device event.
```

---

# 18. C4 diagram reading order

When presenting the architecture, use this order:

```text
01 System Context
        |
        v
02 Container
        |
        v
03 Node Components
        |
        +----> 04 Workforce Components
        |
        +----> 05 Payroll Components
        |
        v
06 AWS Deployment
        |
        v
07-10 Sequence Diagrams
        |
        v
11 Tenant Context
        |
        v
12 State Machines
```

Do not start with the AWS diagram.

Start with the business/system boundary and progressively reveal implementation details.

---

# 19. Recommended next diagrams

After these diagrams, the architecture should be extended with:

1. HRMS domain/data model
2. PostgreSQL logical schema
3. Tenant/RLS database design
4. Payroll data flow
5. Attendance data flow
6. Leave ledger flow
7. Outbox/event architecture
8. SQS retry/DLQ flow
9. Authentication/JWT flow
10. Document upload/download flow
11. API Gateway security flow
12. Disaster recovery architecture

The next highest-value artifact is the **PostgreSQL domain/data model**, because it will validate whether the C4 boundaries actually work at the data level.
