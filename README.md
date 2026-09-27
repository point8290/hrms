# Multi-Tenant SaaS HRMS

India-first HR platform covering the employee lifecycle from onboarding through
attendance, leave, compensation and payroll.

```
React ──► Node.js / TypeScript ──► PostgreSQL + RLS
                │
              outbox ──► SQS ──► FastAPI engines ──► PostgreSQL
                                  (workforce, payroll)
```

PostgreSQL is the transactional source of truth. Node owns authentication, authorization,
transactions and state transitions. Python owns calculation. S3 holds documents, SES sends
mail, Redis is cache only.

## Running it

Requires Node 20+, Python 3.12+, Docker.

```bash
# 1. database
docker compose up -d postgres
docker compose exec -T postgres psql -U hrms_owner -d hrms < db/roles.sql
cp .env.example .env
npm install
npm run db:migrate

# 2. python dependencies
pip install -r services/requirements.txt

# 3. the four processes (separate terminals, or use the commands below)
npm run dev:api                                            # :4000
npm run dev:worker                                         # outbox publisher + consumers
cd services/workforce-engine && python -m app.main         # attendance engine
cd services/payroll-engine   && python -m app.main         # payroll engine
npm run dev:web                                            # :5173
```

Then walk the whole product in one command:

```bash
node scripts/demo/mvp-journey.mjs
```

It creates a tenant, an organization, employees, a shift, check-ins, leave with a manager
approval, compensation and a payroll run — then finalizes payroll, generates the payslip
PDF and asserts that the core invariants hold. Everything goes through the public API and
real queue delivery.

### Verifying

```bash
npm test                       # unit tests, no database needed
npm run typecheck              # all TypeScript workspaces
npm run knowledge:check        # knowledge layer vs. reality

cd apps/api && npm run test:integration      # needs DATABASE_URL
cd services/workforce-engine && python -m unittest discover -s tests
cd services/payroll-engine   && python -m unittest discover -s tests
```

## How the important parts work

**Tenant isolation.** Every tenant table has `tenant_id` and an RLS policy. The application
connects as `hrms_app`, which does not own the tables and cannot bypass RLS — and the API
*proves* this at boot, refusing to start if its connection could bypass a policy. Tenant
context is transaction-local (`SET LOCAL app.tenant_id`), so it cannot leak across a pooled
connection. Background workers read `tenant_id` from the event envelope, because a worker
has no JWT.

**Attendance.** Raw check-ins are immutable observations, enforced by trigger. Attendance
is derived from them and can be recomputed at any time. Corrections are requests that, once
approved, trigger re-derivation — they never edit what the device recorded. Absence is
decided only by a daily close, never by an event that happens to land near a date
([ADR-007](docs/decisions/ADR-007-attendance-daily-close.md)).

**Leave.** Balance is a sum over an append-only ledger, never a stored number. Cancelling
approved leave appends a reversal, so the history still shows the leave existed
([ADR-006](docs/decisions/ADR-006-leave-ledger.md)).

**Payroll.** Creating a run freezes every input into `payroll_input_snapshot`. The engine
reads that and nothing else, so the same run always produces the same payslip — a salary
revision or an attendance correction landing tomorrow cannot change what was paid. Finalized
slips are immutable, enforced by a database trigger
([ADR-005](docs/decisions/ADR-005-payroll-snapshot.md)).

**Events.** A business write and its event commit together via the outbox. Delivery is
at-least-once, so every consumer claims `(event_id, consumer_name)` before acting. Locally
the queue is a Postgres table that reproduces SQS's redelivery and visibility timeout, so
idempotency bugs surface in development ([ADR-004](docs/decisions/ADR-004-sqs-and-outbox.md)).

## Layout

```
apps/api                  Node API: all domain modules, tenant context, outbox, audit
apps/worker               outbox publisher, event consumers, notifications, payslip PDFs
apps/web                  React console: ESS, approvals, directory, payroll, audit
services/workforce-engine FastAPI: attendance derivation
services/payroll-engine   FastAPI: payroll, PF/ESI/PT/TDS
services/shared           Python runtime shared by both engines
packages/events           event envelope contract
db/                       migrations, roles, grants
docs/knowledge            the Repository Knowledge Layer — start here
docs/decisions            ADRs
scripts/demo              end-to-end MVP journey
```

## Where to start reading

[`docs/knowledge/`](docs/knowledge/README.md) is a compact, machine-readable map of the
system: which domains exist, which module owns each, what depends on what, which tables and
events belong where, and which invariants must not be broken. It is designed so an agent (or
a new engineer) can find the right three files instead of reading the repository.

`npm run knowledge:check` verifies that map against the actual tree and fails on drift.

## Status

The MVP journey runs end to end. Not yet built: recruitment, onboarding tasks, expenses,
performance, learning, benefits. `docs/knowledge/codebase-map.yaml` marks each module's
status, and `docs/knowledge/api-map.yaml` lists the gaps inside partially-built domains.

## Reference artifacts

`ArchitectureDiagram/` and `ERD/` are the architecture sources (the product requirements
document is kept private). They are read-only inputs — the knowledge layer indexes them so they
do not have to be re-read for every task.

Where the PRD leaves HR behaviour open (leave day counting, shift semantics, payroll
mechanics), decisions follow established Indian HR and payroll practice and are recorded
as ADRs.
