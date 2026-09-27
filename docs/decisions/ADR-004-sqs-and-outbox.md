# ADR-004: Outbox publication, SQS transport, consumer idempotency

Status: Accepted
Source: PRD s.25, s.29; ArchitectureDiagram/README s.7-9, 11-notes-tenant-runs.puml

## Context

Domain changes must trigger asynchronous work: attendance calculation, payroll
calculation, notifications, payslip generation. Publishing to a broker after committing
the transaction means a crash between the two silently loses the event. Publishing
before committing means an event for a change that never happened.

AWS SQS standard queues deliver at least once and do not guarantee order.

## Decision

**Outbox.** The business write and an `integration.event_outbox` row are written in the
same transaction. A separate publisher reads unpublished rows and sends them to SQS,
marking `published_at`. The publisher is itself idempotent.

**Envelope.** Every event carries `event_id`, `event_type`, `schema_version`, `tenant_id`,
`aggregate_type`, `aggregate_id`, `occurred_at`, `producer`, `payload`, plus
`correlation_id` where available. `tenant_id` is mandatory — it is how a worker obtains
tenant context (ADR-002).

**Idempotency.** Every consumer checks `integration.processed_event (event_id,
consumer_name)` before acting, and writes its business change and the `processed_event`
row in one transaction. ACK happens only after commit.

**Failure.** Every queue has a DLQ. Nothing is dropped silently.

## Reason

- The outbox makes "state changed" and "event will be sent" atomic without a distributed
  transaction between PostgreSQL and SQS.
- At-least-once plus an idempotency table is simpler and more robust than pursuing
  exactly-once delivery.
- Duplicate protection is mandatory here specifically: a replayed payroll or leave-ledger
  message would create real financial effects.
- Carrying `tenant_id` in the envelope is the only workable source of tenant context in a
  worker; there is no JWT.

## Consequences

- Events are delivered with a small publisher lag rather than instantly.
- `event_outbox` is a high-volume table — time-partition candidate, with a retention policy.
- Consumers must not rely on message order; ordering requirements need a FIFO queue or an
  explicit sequencing check in the consumer.
- Adding an event means adding its contract to `docs/knowledge/event-map.yaml` in the same
  change, and versioning the payload via `schema_version`.
