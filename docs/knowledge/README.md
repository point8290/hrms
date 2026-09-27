# Repository Knowledge Layer (RKL)

A compact, machine-readable map of this repository. It exists so a coding agent can
locate the right domain, files, tables and events **without** re-reading the PRD,
the C4 diagrams, the ERD, or scanning the source tree.

The source code is the implementation truth. This layer is an index and a semantic map.

## Files

| File | Answers | Type |
|---|---|---|
| `domain-map.yaml` | what domains exist, what each owns, what it depends on | semantic |
| `codebase-map.yaml` | which module owns a domain, where the code lives, status | semantic |
| `dependency-map.yaml` | what breaks if I change X (forward + reverse edges) | semantic |
| `database-map.yaml` | schemas, tables, tenancy, RLS, immutability, relationships | semantic |
| `event-map.yaml` | events, producers, consumers, envelope, idempotency | semantic |
| `api-map.yaml` | domain-level API ownership and base paths | semantic |
| `integration-map.yaml` | external systems and the node/python boundary | semantic |
| `invariants.md` | rules that must not be violated | semantic |
| `generated/` | structural facts scanned from the repo | generated |

Related: [`../architecture/`](../architecture/README.md) (diagram index), [`../decisions/`](../decisions/README.md) (ADRs).

## How Coding Agents Should Use This

Retrieve the **subset** you need. Do not read every file for every task.

1. Identify the relevant domain.
2. Read `domain-map.yaml` — that domain's entry only.
3. Read `codebase-map.yaml` for the implementation location and status.
4. Read `dependency-map.yaml` for impact (`impacts` is the blast radius).
5. Read `database-map.yaml` if persistence is involved.
6. Read `event-map.yaml` if async behavior is involved.
7. Read `invariants.md` when touching a critical domain (tenancy, leave, payroll, attendance, documents, audit).
8. Inspect only the source files the map points to.
9. Expand the repository search only when the map proves insufficient — then fix the map.

Typical cost: 2-3 files, not the whole layer.

### Worked example — "change leave approval"

```
domain-map.leave          -> owns leave_application + leave_ledger_entry; depends on workflow
codebase-map.leave        -> apps/api/src/modules/leave; pure logic in leave-math.ts
dependency-map.leave      -> impacts: attendance, payroll, notification
database-map              -> leave_mgmt.leave_application (state machine), leave_ledger_entry (append-only, authoritative)
event-map                 -> produces LeaveApproved / LeaveRejected
invariants.md#leave       -> ledger is the balance authority; approval writes state + ledger in one transaction

then read, in this order:
  apps/api/src/modules/workflow/service.ts   decide()
  apps/api/src/modules/leave/service.ts      applyWorkflowOutcome(), postConsumption()
  apps/api/src/modules/workflow/routes.ts    the endpoint that wires them together
```

### Worked example — "change payroll calculation"

```
domain-map.payroll        -> snapshot-based, deterministic, states, finalization
codebase-map.payroll      -> orchestration in apps/api/src/modules/payroll
codebase-map.payroll-engine -> calculation in services/payroll-engine/app (python)
dependency-map.payroll    -> depends on compensation, attendance, leave, tax, benefits
database-map              -> payroll_input_snapshot (immutable input), salary_slip (immutable after finalization), statutory_rule (versioned)
event-map                 -> PayrollRunCreated -> PayrollCalculated -> SalarySlipGenerated -> PayrollFinalized
invariants.md#payroll     -> calculate from the snapshot only; never edit a finalized slip
```

## Generated vs Semantic

**GENERATED** — regenerate, never hand-edit (`docs/knowledge/generated/`):
file paths, module structure, TypeScript modules, Python packages, API routes,
database migrations, cross-module imports, event registrations.

**SEMANTIC** — hand-maintained, change only when the architecture or business meaning changes:
domain ownership, responsibilities, invariants, architectural rationale, business rules,
dependency intent, trade-offs, event contracts.

Each file declares `meta.type: semantic`. Generated files carry a DO NOT EDIT banner.

## Where the Rules Actually Live

Some invariants are enforced by the database, not by code that can be bypassed. When
changing these areas, read the migration as well as the module:

| Rule | Enforced by |
|---|---|
| tenant isolation | RLS policies via `app.enable_tenant_rls`, plus a boot-time probe |
| append-only history | `app.forbid_mutation` triggers |
| finalized payslip immutability | `payroll.guard_finalized_slip` trigger |
| no overlapping effective-dated rows | gist exclusion constraints |
| device check-in de-duplication | partial unique index on `external_event_id` |
| one live regular payroll run per period | partial unique index |
| legal payroll state transitions | transition table in `payroll/service.ts` |

## Keeping It Fresh

```bash
npm run knowledge:update   # regenerate generated/, then validate
npm run knowledge:check    # validate only (safe in CI, no writes)
```

`knowledge:update` only writes under `docs/knowledge/generated/`. It never touches
semantic files. `knowledge:check` fails when:

- a module marked `implemented` has a missing path,
- a module marked `planned` has a path that now exists (promote it),
- a domain, module or event references something that does not exist in the maps.

Until application code exists the generator reports an empty structure — that is correct,
not a failure. See [`scripts/knowledge/README.md`](../../scripts/knowledge/README.md).

**When you add a module, table, API or event, update the semantic map in the same change.**
A knowledge layer that lags the code is worse than none.

## HR Business Reference

Where the PRD leaves HR business behaviour open (leave day counting, shift semantics,
payroll mechanics), decisions follow established Indian HR and payroll practice and the
relevant statutes. Record each such decision in an ADR so the reasoning stays with the code.

## Reference Artifacts

Source of truth for intent. Read only when the knowledge layer is genuinely insufficient.

- Product requirements document — kept private, not in this repository
- `ArchitectureDiagram/` — C4 context, container, component, deployment, sequences, state machines
- `ERD/` — PostgreSQL domain model

These are read-only inputs. Do not modify them and do not copy them into this layer.

## Current State

The MVP journey from PRD s.30 runs end to end:

```
Create Tenant -> Organization -> Employee -> Assign Shift -> Check In ->
Calculate Attendance -> Apply Leave -> Calculate LOP -> Assign Salary ->
Run Payroll -> Review -> Finalize -> Generate Payslip -> Notify
```

`scripts/demo/mvp-journey.mjs` walks it over HTTP against a running stack, with the
outbox publisher and both Python engines doing the asynchronous work.

**Implemented**: tenant and org, identity and RBAC, core HR with effective-dated history,
shifts, attendance (Python), leave with a ledger, workflow approvals, compensation,
payroll (Python) with India statutory, documents, audit, notifications, React console.

**Not implemented**: recruitment, onboarding tasks, expenses, performance, learning,
benefits. `codebase-map.yaml` marks each `status: planned`, and `api-map.yaml` lists the
gaps inside partially-built domains.

Check status before assuming: `status` in `codebase-map.yaml` is the authority, and
`npm run knowledge:check` fails if it disagrees with what is on disk.
