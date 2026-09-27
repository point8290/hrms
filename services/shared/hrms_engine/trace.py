"""W3C trace context for the Python engines.

The Node API stamps a `traceparent` on every outbox row and carries it on the event
envelope, so one HTTP request can be followed through however many queues it caused. Python
was the end of that chain: the engine read the envelope, ignored the field, and wrote
follow-on events with no trace at all — so `PayrollCalculated` and every payslip that
descended from it looked unrelated to the run that produced them.

This is the same handful of functions the Node side has (`infra/telemetry.ts`), deliberately
kept small and dependency-free. It is context propagation, not an OpenTelemetry SDK: there
is no exporter here and no span is emitted. Adding the SDK later means replacing the storage
underneath these names, not changing every call site.

Nothing from an event payload is ever put into trace state. A trace id is an opaque
identifier; employee and payroll data is not, and must not travel in something designed to
be shipped to a third-party observability backend.
"""

from __future__ import annotations

import contextvars
import re
import secrets
from contextlib import contextmanager
from typing import Iterator, NamedTuple

TRACEPARENT_RE = re.compile(r"^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$")

_INVALID_TRACE_ID = "0" * 32
_INVALID_SPAN_ID = "0" * 16


class TraceContext(NamedTuple):
    trace_id: str
    span_id: str
    flags: str


_current: contextvars.ContextVar[TraceContext | None] = contextvars.ContextVar(
    "hrms_trace_context", default=None
)


def parse_traceparent(header: str | None) -> TraceContext | None:
    """Parses a `traceparent`. Returns None for anything malformed — never raises.

    A bad header is not a reason to fail payroll. The work still happens; it is simply not
    correlated, which is exactly the situation we were already in.
    """
    if not header or not isinstance(header, str):
        return None
    match = TRACEPARENT_RE.match(header.strip().lower())
    if not match:
        return None
    trace_id, span_id, flags = match.groups()
    # The spec's "invalid" sentinels. Propagating them would produce traces that join
    # everything to everything.
    if trace_id == _INVALID_TRACE_ID or span_id == _INVALID_SPAN_ID:
        return None
    return TraceContext(trace_id=trace_id, span_id=span_id, flags=flags)


def format_traceparent(context: TraceContext) -> str:
    return f"00-{context.trace_id}-{context.span_id}-{context.flags}"


def new_span_id() -> str:
    return secrets.token_hex(8)


def new_trace_id() -> str:
    return secrets.token_hex(16)


def current_trace() -> TraceContext | None:
    """The trace this code is running inside, if any."""
    return _current.get()


def outgoing_traceparent() -> str | None:
    """The header to stamp on anything leaving this process.

    Returns None rather than inventing a trace when there is none: a trace id with no parent
    anywhere is worse than an honest absence, because it looks like a root request that
    never happened.
    """
    context = current_trace()
    return format_traceparent(context) if context else None


def current_trace_id() -> str | None:
    """Just the trace id, for log correlation. Safe to log; it identifies nothing but itself."""
    context = current_trace()
    return context.trace_id if context else None


@contextmanager
def continue_trace(traceparent: str | None) -> Iterator[TraceContext | None]:
    """Runs a block inside the trace an event carried.

    The join between the synchronous and asynchronous halves of the system: the handler runs
    under the trace of the HTTP request that ultimately caused it, however many queues ago
    that was. A new span id is minted for this process's own work, with the incoming span as
    its parent, so the engine is a step in the chain rather than a replacement for it.
    """
    parsed = parse_traceparent(traceparent)
    if parsed is None:
        yield None
        return

    child = TraceContext(trace_id=parsed.trace_id, span_id=new_span_id(), flags=parsed.flags)
    token = _current.set(child)
    try:
        yield child
    finally:
        _current.reset(token)
