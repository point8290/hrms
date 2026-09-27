# ADR-009: `SalarySlipGenerated` means *finalized*, and fans out per slip

Status: Accepted
Date: 2026-09-16
Amends: `ArchitectureDiagram/05-payroll-components.puml`

## Context

`05-payroll-components.puml` shows the payroll engine emitting `SalarySlipGenerated` from
its result writer, immediately after persisting a slip. The implementation did not emit it
at all; payslip PDF generation hangs off `PayrollFinalized` instead. The event sat in the
contract, unused — a documented event nobody produced.

Two things were conflated under one name:

- **a slip row exists** — true as soon as calculation writes it, but the slip is `draft`,
  the run can still be recalculated, and the figures can still change
- **a payslip is real** — true only after finalization, when the slip is immutable and
  payable

A document generated at the first point can contradict the payslip the employee is
eventually paid against. The diagram's placement is therefore wrong for document
generation, and "generated" was the wrong word for a draft.

Separately, the existing `PayrollFinalized` handler exposed a real problem. It looped every
slip in the run inside **one** tenant transaction: rendering PDFs, uploading to S3, writing
document rows and queueing notifications. For a few employees that is fine. For a few
thousand it is a very long-running transaction holding locks while making network calls to
S3 — and a failure on employee 4,000 rolls back the 3,999 payslips already produced.

## Problem

Decide what `SalarySlipGenerated` means, or remove it — and fix the fan-out while the
semantics are being settled, because the two questions have the same answer.

## Options

1. **Emit it from the engine after writing a draft slip**, as the diagram shows. Matches
   the picture, but names a draft "generated" and invites exactly the bug of producing a
   document for figures that can still change.
2. **Delete the event.** `PayrollCalculated` and `PayrollFinalized` already mark both real
   moments at run granularity. Honest, but leaves the single-transaction fan-out unsolved.
3. **Keep the event, move its emission point to after finalization, and make it per slip.**

## Decision

Option 3.

`SalarySlipGenerated` is emitted **once per finalized salary slip**, by the Node worker,
after `PayrollFinalized`. Its meaning is precise:

> A finalized, immutable salary slip artifact exists for this employee and is ready for
> document generation and delivery.

The flow becomes:

```
payroll-engine  -> PayrollCalculated   (run: draft slips written, figures may still change)
api             -> PayrollFinalized    (run: slips are immutable)
worker          -> SalarySlipGenerated (per slip, fan-out)
worker          -> renders one PDF, stores it, writes metadata, queues one notification
```

The `PayrollFinalized` handler now only enumerates slips and emits one event each — cheap,
and safely inside a single short transaction. Each `SalarySlipGenerated` is then processed
independently, in its own transaction, guarded by its own `processed_event` claim.

The diagram is annotated rather than redrawn: `05-payroll-components.puml` gains a note
recording that the engine writes the slip but does not announce it.

## Reason

- The event now names a fact that cannot later become untrue. A finalized slip is immutable
  by database trigger, so a document generated from it can never contradict what was paid.
- Per-slip fan-out removes the long transaction and the S3 calls inside it. One employee's
  PDF failing retries that employee, instead of discarding several thousand successful ones.
- Idempotency granularity matches the work: `(event_id, consumer_name)` per slip, so
  redelivery re-does one payslip rather than a whole run.
- The event keeps its name from the architecture package, so the diagram and the code agree
  again — with the emission point corrected rather than the vocabulary abandoned.

## Trade-offs

- A large run now produces N events instead of 1. That is the point, but it makes the outbox
  and the platform queue busier at finalization time; the publisher batches, so the cost is
  bounded.
- Payslip documents appear progressively rather than all at once. The API reports
  `document_id` as null until a slip's PDF exists, which the web client already handles.
- The engine still writes slips without announcing them. Anything that wants to react to
  calculation completing must use `PayrollCalculated`, at run granularity — deliberate, so
  no consumer is tempted to treat a draft as final.

## Impact

- `apps/worker/src/handlers.ts`: `PayrollFinalized` fans out; new `SalarySlipGenerated` handler
- `packages/events/src/index.ts`: payload shape for the per-slip event
- `docs/knowledge/event-map.yaml`: status and emission point
- `ArchitectureDiagram/05-payroll-components.puml`: note recording the correction
