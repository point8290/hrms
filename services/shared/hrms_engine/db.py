"""Database access for the calculation engines.

The one rule this module exists to enforce: a worker has no HTTP request and no JWT, so
tenant context must come from the event envelope and be set transaction-locally before any
tenant query runs (ADR-002, ArchitectureDiagram/11-notes-tenant-runs.puml).

`tenant_transaction` is the only sanctioned way into tenant data from Python.
"""

from __future__ import annotations

import os
import re
import uuid
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .trace import outgoing_traceparent

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

_pool: ConnectionPool | None = None


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        dsn = os.environ.get("DATABASE_URL")
        if not dsn:
            raise RuntimeError("DATABASE_URL is not set")
        _pool = ConnectionPool(
            dsn,
            min_size=1,
            max_size=int(os.environ.get("DB_POOL_MAX", "5")),
            kwargs={"row_factory": dict_row, "application_name": os.environ.get("SERVICE_NAME", "hrms-engine")},
            open=True,
        )
    return _pool


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


class TenantContextError(RuntimeError):
    """Raised when tenant context is missing or malformed. Always fail closed."""


@contextmanager
def tenant_transaction(tenant_id: str, actor_label: str = "engine") -> Iterator[psycopg.Cursor]:
    """Opens a transaction with tenant context set for its duration.

    SET LOCAL, not SET: pooled connections are reused across tenants, and a session-level
    setting would leak the previous tenant's context into the next job.
    """
    if not tenant_id or not UUID_RE.match(str(tenant_id)):
        raise TenantContextError(f"refusing to run without a valid tenant_id (got {tenant_id!r})")

    with get_pool().connection() as conn:
        conn.autocommit = False
        with conn.cursor() as cur:
            cur.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tenant_id),))
            cur.execute("SELECT set_config('application_name', %s, true)", (actor_label,))
            try:
                yield cur
                conn.commit()
            except Exception:
                conn.rollback()
                raise


@contextmanager
def platform_transaction(reason: str = "engine-maintenance") -> Iterator[psycopg.Cursor]:
    """Cross-tenant transaction for transport-level work only (queue polling)."""
    dsn = os.environ.get("PLATFORM_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError("PLATFORM_DATABASE_URL / DATABASE_URL is not set")

    with psycopg.connect(dsn, row_factory=dict_row, application_name=f"hrms-platform:{reason}") as conn:
        with conn.cursor() as cur:
            try:
                yield cur
                conn.commit()
            except Exception:
                conn.rollback()
                raise


def claim_event(cur: psycopg.Cursor, tenant_id: str, event_id: str, consumer_name: str) -> bool:
    """Idempotency guard. False means this event was already handled by this consumer.

    SQS delivers at least once, so every consumer must ask this before doing work and must
    write it in the same transaction as that work (ADR-004). For payroll and the leave
    ledger a duplicate would create real financial effects.
    """
    cur.execute(
        """
        INSERT INTO integration.processed_event (tenant_id, event_id, consumer_name)
        VALUES (%s, %s, %s)
        ON CONFLICT (event_id, consumer_name) DO NOTHING
        RETURNING id
        """,
        (tenant_id, event_id, consumer_name),
    )
    return cur.fetchone() is not None


def emit_event(
    cur: psycopg.Cursor,
    tenant_id: str,
    event_type: str,
    aggregate_type: str,
    aggregate_id: str,
    payload: dict[str, Any] | None = None,
    correlation_id: str | None = None,
    producer: str = "hrms-engine",
    traceparent: str | None = None,
) -> str:
    """Writes to the outbox inside the caller's transaction.

    The engine does not publish to SQS itself: the outbox publisher does, so the
    calculation result and the announcement of it cannot diverge.

    The trace is taken from the event being handled unless the caller overrides it, so a
    payslip that descends from a payroll run is on the same trace as the HTTP request that
    started the run. Captured at emit time rather than publish time for the same reason the
    Node side does: by the time the publisher runs, the causing request is long gone.
    """
    import json

    event_id = str(uuid.uuid4())
    cur.execute(
        """
        INSERT INTO integration.event_outbox
          (event_id, tenant_id, event_type, schema_version, aggregate_type, aggregate_id,
           payload, correlation_id, producer, traceparent)
        VALUES (%s, %s, %s, 1, %s, %s, %s::jsonb, %s, %s, %s)
        """,
        (
            event_id,
            tenant_id,
            event_type,
            aggregate_type,
            aggregate_id,
            json.dumps(payload or {}),
            correlation_id,
            producer,
            traceparent if traceparent is not None else outgoing_traceparent(),
        ),
    )
    return event_id
