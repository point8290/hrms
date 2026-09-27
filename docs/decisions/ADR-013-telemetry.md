# ADR-013: W3C trace context everywhere, allow-listed span attributes

Status: Accepted
Date: 2026-09-16
Relates to: ADR-004

## Context

An HTTP request finalizes payroll. Seconds later the outbox publisher picks the event up.
SQS delivers it to a worker. The worker fans out one event per employee. A Python engine
finishes minutes after the request that started it returned.

"Why did this employee's payslip not arrive?" was answerable only by correlating timestamps
across four processes by hand. `correlation_id` existed but answers a different question: it
groups work by business cause, not by causal chain, and it was not propagated through the
queue in a form any tooling understands.

The system also handles salaries, bank account numbers, tax identifiers and names. A trace is
shipped to a third-party backend, retained for months, and readable by anyone with dashboard
access — a materially wider audience than the database.

## Problem

Get distributed tracing across the synchronous and asynchronous halves without putting
payroll data in a third-party store, and without making an APM vendor a deployment
dependency.

## Decision

**W3C trace context is the unit of propagation, carried on the event envelope and on the
outbox row. Span attributes are restricted by an allow-list.**

Three parts:

1. **Propagation.** A request continues an incoming `traceparent` or starts one.
   `emitEvent` stamps the current trace onto `integration.event_outbox.traceparent` at emit
   time — the trace that matters is the one that *caused* the event, and by the time the
   publisher runs, that request is long gone. The consumer resumes it before calling the
   handler.

2. **Export.** Spans always go to stdout as structured logs. When
   `OTEL_EXPORTER_OTLP_ENDPOINT` is set *and* the OpenTelemetry packages are installed, they
   additionally go to OTLP. Both the endpoint and the packages are optional, and a failure to
   load either is a warning, never a startup failure.

3. **Attributes.** An explicit allow-list of key names. Anything else is dropped before
   export. Error spans carry the error *type*, never its message.

## Reason

W3C trace context rather than a bespoke id because it is what OpenTelemetry, every language
SDK and every APM vendor already speak, so the choice does not have to be revisited when a
vendor is picked.

Lazy, optional SDK loading rather than a hard dependency because tracing must never be the
reason a deployment cannot start, and because a large transitive dependency tree in an
application that handles payroll is a supply-chain surface for an observability feature.
Logging spans by default matters more than it sounds: a trace that exists only in a vendor
nobody has bought yet is no trace at all, whereas a span line with a trace id ships with logs
that are already collected and is greppable today.

**Allow-list, not deny-list.** A deny-list has to predict every name someone will invent for
a salary field; an allow-list fails closed on the one nobody thought of. The error *message*
is excluded for the same reason: a PostgreSQL unique-violation message quotes the row that
violated the constraint, and that row is employee data.

`tenant.id` is allowed; `user.id` is not. A tenant is an operational dimension. A user id in
a third-party trace store is personal data with no operational use that the tenant id does
not already serve.

## Consequences

- `integration.event_outbox` and the event envelope both carry an optional `traceparent`. It
  is optional because an event produced before tracing existed, or by an untraced producer,
  must still be processable — a missing trace is an observability gap, never a reason to drop
  work.
- Adding a span attribute means adding its name to `ALLOWED_ATTRIBUTES`, which is a visible,
  reviewable change rather than an incidental one.
- Health endpoints are excluded from tracing. A probe every second would be the overwhelming
  majority of the volume and observes nothing.
- An exporter that throws is swallowed. Telemetry must never break the thing it observes.
- The Python engines do not yet continue the trace; they read `correlation_id` only.
  Propagating `traceparent` into them is a remaining gap, and the envelope field it needs is
  already there.
