# Architecture

Index into the existing architecture artifacts. This page does not restate them.

## Artifacts

| Source | Contents |
|---|---|
| [`../../ArchitectureDiagram/`](../../ArchitectureDiagram) | C4 diagrams, sequences, state machines, architecture rules |
| [`../../ERD/`](../../ERD) | PostgreSQL logical domain model |

Read them in this order, and only the file you need:

```
01-system-context  -> who uses it, external systems
02-container       -> runtime boundaries (most important single diagram)
03-node-components -> node business modules
04/05-components   -> workforce and payroll calculation engines
06-aws-deployment  -> infrastructure mapping
07-10 sequences    -> onboarding, attendance, leave, payroll runtime behavior
11-tenant-context  -> tenant context in async workers
12-state-machines  -> payroll, leave, expense lifecycle states
```

ERD:

```
01-domain-overview        -> business entity relationships
02..07 per-domain ERDs    -> core hr, workforce, leave, compensation/payroll, expense/performance, documents/workflow/audit
08-full-logical-erd       -> consolidated
09-rls-model              -> tenant isolation flow
10-payroll-data-flow      -> payroll snapshot pipeline
```

## Shape in one block

```
React (S3 + CloudFront)
   -> API Gateway / ALB
   -> Node.js API (auth, authz, transactions, state transitions)
   -> PostgreSQL (source of truth, RLS)

Node.js --outbox--> SQS --> FastAPI engines (workforce, payroll) --> PostgreSQL
                       \--> Node worker --> SES / S3

Redis: cache, short-lived locks, rate limiting
S3:    documents, payslips, reports (private, presigned)
```

Style: modular monolith (Node) plus separate processing services (Python).
Not a fine-grained microservice architecture — see
[`../decisions/ADR-003-node-python-boundary.md`](../decisions/ADR-003-node-python-boundary.md).

## Rendering the diagrams

The `.puml` sources include C4-PlantUML from a `master` URL, so rendering needs network
access. Pin or vendor the C4 library before adding a CI rendering step.

## Where the architecture is encoded for agents

Do not re-derive architecture from the diagrams on every task. The machine-readable
summary lives in [`../knowledge/`](../knowledge/README.md):

- runtime boundaries and module ownership -> `codebase-map.yaml`
- infrastructure and node/python split -> `integration-map.yaml`
- async contracts -> `event-map.yaml`
- data semantics -> `database-map.yaml`
- rules that constrain design -> `invariants.md`

## Adding architecture documentation

Prefer a diagram or an ADR over prose. New diagrams belong in `ArchitectureDiagram/`
with a matching entry here; new decisions belong in [`../decisions/`](../decisions/README.md).
If a change alters domain boundaries, data semantics or async behavior, update the
knowledge layer in the same change.
