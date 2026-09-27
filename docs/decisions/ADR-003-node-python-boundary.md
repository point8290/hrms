# ADR-003: Node owns transactions, Python owns calculation

Status: Accepted
Source: PRD s.24; ArchitectureDiagram/README s.12-13, 02/04/05

## Context

The system has two very different workloads. One is transactional and latency-sensitive:
authentication, CRUD, approvals, state transitions. The other is computational and
batch-shaped: pairing thousands of check-ins into attendance, running payroll for
thousands of employees through earnings, LOP, statutory and tax stages.

Running both in one process couples their scaling and failure modes. Splitting every
domain into its own service creates distributed transactions across data that must stay
consistent.

## Decision

Two runtimes, split by responsibility, not by domain:

- **Node.js/TypeScript** — authentication, authorization, REST APIs, transactional
  workflows, state machines, orchestration, tenant management. A modular monolith:
  one deployable, `apps/api/src/modules/<domain>`.
- **Python/FastAPI** — calculation engines: attendance/working hours/overtime
  (`workforce-engine`) and payroll/tax/statutory (`payroll-engine`). Invoked by SQS jobs,
  never by the browser.

Both read and write the same PostgreSQL database under the same RLS rules. Node never
calls an engine synchronously on a request path.

Domains are *not* extracted into services. Extraction requires a proven reason:
independent scaling, independent deployment, separate team ownership, different
reliability requirements, or materially different workload characteristics.

## Reason

- The split follows the actual scaling axes: API traffic, attendance ingestion and
  payroll processing grow independently.
- Calculation code benefits from Python's numeric/date tooling and reads more directly
  as a rules engine.
- Keeping transactional domains in one Node process keeps payroll's multi-domain reads
  and leave's application-plus-ledger write as ordinary ACID transactions.
- Avoids the failure modes listed in the architecture package: distributed transactions,
  chatty network calls, deployment and observability overhead.

## Consequences

- Two languages to build, test, deploy and monitor.
- Shared database schema across runtimes — migrations are a cross-runtime contract, and
  both must implement the tenant-context rule from ADR-002.
- The engines must be idempotent, because SQS delivers at least once (ADR-004).
- "Which side owns this?" has a standing answer: if it changes state or authorizes, Node;
  if it computes a result from a snapshot, Python.
