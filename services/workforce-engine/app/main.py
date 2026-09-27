"""Workforce calculation engine.

Consumes attendance jobs from SQS, derives attendance and persists it. Exposes a small
FastAPI surface for health checks and an operator-triggered recalculation; it is not a
public API — the browser never talks to this service (ArchitectureDiagram/02).
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

# The shared runtime lives alongside the services in the monorepo; the container build
# context is services/, so this path is present in both local and deployed runs.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))

from hrms_engine.consumer import run_consumer  # noqa: E402
from hrms_engine.db import claim_event, close_pool, emit_event, tenant_transaction  # noqa: E402

from .attendance import CALCULATION_VERSION, calculate_day  # noqa: E402
from . import repository  # noqa: E402

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format='{"level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
)
log = logging.getLogger("workforce-engine")

CONSUMER_NAME = "workforce-engine"
QUEUE_NAME = "workforce-jobs"

# How far back a single check-in can pull recalculation. An offline device replaying a
# week of punches must still land on the right days.
MAX_BACKFILL_DAYS = 31


def recalculate_range(
    tenant_id: str,
    employee_id: str,
    start: date,
    end: date,
    *,
    mark_absent: bool = False,
) -> int:
    """Recomputes attendance for an employee over a date range.

    Derived state, so this is safe to run repeatedly — that is what makes a policy change
    or an approved correction re-derivable without touching the raw check-ins.

    `mark_absent` separates two genuinely different jobs:

      * event-driven re-derivation (False) only writes days that have something to derive.
        A check-in arriving today must not silently declare last Tuesday an absence just
        because that day happened to fall inside the recalculation window.
      * the daily close (True) evaluates every day in the range, which is where a real
        absence is decided — after the day has ended and all its observations are in.

    Without that split, LOP would depend on when events happened to arrive rather than on
    what the employee actually did, and payroll would be non-deterministic.
    """
    if (end - start).days > MAX_BACKFILL_DAYS:
        end = start + timedelta(days=MAX_BACKFILL_DAYS)

    written = 0
    with tenant_transaction(tenant_id, f"{CONSUMER_NAME}:recalculate") as cur:
        employee = repository.employee_context(cur, employee_id)
        if employee is None:
            log.warning("employee %s not visible in tenant %s; skipping", employee_id, tenant_id)
            return 0

        current = start
        while current <= end:
            if repository.locked_by_finalized_payroll(cur, employee_id, current):
                log.info(
                    "skipping %s for %s: inside a finalized payroll period",
                    current, employee_id,
                )
                current += timedelta(days=1)
                continue

            day_input = repository.build_day_input(cur, employee, current)

            has_inputs = bool(day_input.checkins) or day_input.leave is not None or day_input.correction is not None
            already_derived = repository.attendance_exists(cur, employee_id, current)
            if not mark_absent and not has_inputs and not already_derived:
                current += timedelta(days=1)
                continue

            result = calculate_day(day_input)
            repository.persist(cur, tenant_id, result)
            written += 1
            current += timedelta(days=1)

    return written


def close_day(tenant_id: str, on: date, employee_ids: list[str] | None = None) -> int:
    """Daily attendance close for a whole tenant.

    This is the job that decides absences. Run it after the day has ended in the tenant's
    timezone; running it for today would mark everyone who has not yet checked out absent.
    """
    with tenant_transaction(tenant_id, f"{CONSUMER_NAME}:close-day") as cur:
        if employee_ids:
            targets = employee_ids
        else:
            cur.execute(
                """
                SELECT id FROM core.employee
                 WHERE employment_status <> 'separated'
                   AND joining_date <= %s
                   AND (exit_date IS NULL OR exit_date >= %s)
                """,
                (on, on),
            )
            targets = [str(row["id"]) for row in cur.fetchall()]

    processed = 0
    for employee_id in targets:
        processed += recalculate_range(tenant_id, employee_id, on, on, mark_absent=True)

    log.info("closed %s for %s employee(s) in tenant %s", on, processed, tenant_id)
    return processed


def handle_checkin_recorded(envelope: dict[str, Any]) -> None:
    """A new observation arrived; re-derive the day it belongs to.

    The attendance date comes from the producer's timezone-aware hint rather than being
    re-derived from the UTC instant here, so an overnight punch is attributed to the shift
    it belongs to.
    """
    tenant_id = envelope["tenant_id"]
    payload = envelope.get("payload") or {}
    employee_id = payload.get("employee_id")
    if not employee_id:
        log.error("CheckinRecorded %s has no employee_id", envelope["event_id"])
        return

    hint = payload.get("attendance_date_hint")
    target = date.fromisoformat(hint) if hint else datetime.fromisoformat(payload["checkin_at"]).date()

    with tenant_transaction(tenant_id, CONSUMER_NAME) as cur:
        if not claim_event(cur, tenant_id, envelope["event_id"], CONSUMER_NAME):
            log.info("event %s already processed by %s", envelope["event_id"], CONSUMER_NAME)
            return

    # An overnight shift that started the previous day is also affected by a punch made
    # after midnight, so both candidate days are re-derived.
    recalculate_range(tenant_id, employee_id, target - timedelta(days=1), target)

    with tenant_transaction(tenant_id, CONSUMER_NAME) as cur:
        emit_event(
            cur,
            tenant_id=tenant_id,
            event_type="AttendanceCalculated",
            aggregate_type="attendance",
            aggregate_id=employee_id,
            payload={
                "employee_id": employee_id,
                "attendance_date": target.isoformat(),
                "calculation_version": CALCULATION_VERSION,
            },
            correlation_id=envelope.get("correlation_id"),
            producer=CONSUMER_NAME,
        )


def handle_close_requested(envelope: dict[str, Any]) -> None:
    """Executes a scheduled daily close for one tenant-day (ADR-007).

    The scheduled-job row is the concurrency control: it is locked FOR UPDATE while the
    status is checked, so two workers handed the same message cannot both evaluate the day.
    A row that is already `completed` short-circuits, which is what makes redelivery free.

    Failure marks the row `failed` with the error and a backoff, in its own transaction, so
    the scheduler can retry it. Raising afterwards lets the queue apply its own backoff too.
    """
    tenant_id = envelope["tenant_id"]
    payload = envelope.get("payload") or {}
    run_id = payload.get("close_run_id") or envelope["aggregate_id"]
    business_date = date.fromisoformat(payload["business_date"])

    with tenant_transaction(tenant_id, f"{CONSUMER_NAME}:close") as cur:
        if not claim_event(cur, tenant_id, envelope["event_id"], CONSUMER_NAME):
            log.info("close event %s already processed", envelope["event_id"])
            return

        cur.execute(
            """
            SELECT status, execution_date FROM integration.scheduled_job
             WHERE id = %s AND job_type = 'attendance.close' FOR UPDATE
            """,
            (run_id,),
        )
        row = cur.fetchone()
        if row is None:
            log.error("close run %s not found in tenant %s", run_id, tenant_id)
            return
        if row["status"] == "completed":
            log.info("close run %s already completed", run_id)
            return

    try:
        # Outside the lock transaction: the close itself opens its own tenant transactions
        # per day and can take a while for a large tenant.
        processed = close_day(tenant_id, business_date)
    except Exception as err:  # noqa: BLE001 - recorded, then re-raised for queue backoff
        log.exception("close run %s failed", run_id)
        with tenant_transaction(tenant_id, f"{CONSUMER_NAME}:close-failed") as cur:
            cur.execute(
                """
                UPDATE integration.scheduled_job
                   SET status = 'failed',
                       last_error = %s,
                       available_at = now()
                                    + make_interval(mins => LEAST(power(2, attempt_count)::int, 60))
                 WHERE id = %s
                """,
                (str(err)[:1000], run_id),
            )
        raise

    with tenant_transaction(tenant_id, f"{CONSUMER_NAME}:close-complete") as cur:
        cur.execute(
            """
            UPDATE integration.scheduled_job
               SET status = 'completed',
                   result = jsonb_build_object('employee_count', %s::int),
                   completed_at = now(),
                   last_error = NULL
             WHERE id = %s
            """,
            (processed, run_id),
        )
        # Audited, not just logged: "was attendance closed for that day" is a question a
        # payroll dispute will ask months later.
        cur.execute(
            """
            INSERT INTO audit.audit_log
              (tenant_id, actor_label, entity_type, entity_id, action, is_sensitive, after_state)
            VALUES (%s, 'attendance-close', 'scheduled_job', %s, 'attendance.close.completed',
                    false, %s::jsonb)
            """,
            (
                tenant_id,
                run_id,
                json.dumps({"business_date": business_date.isoformat(), "employee_count": processed}),
            ),
        )
        emit_event(
            cur,
            tenant_id=tenant_id,
            event_type="AttendanceClosed",
            aggregate_type="scheduled_job",
            aggregate_id=run_id,
            payload={
                "close_run_id": run_id,
                "business_date": business_date.isoformat(),
                "employee_count": processed,
            },
            correlation_id=envelope.get("correlation_id"),
            producer=CONSUMER_NAME,
        )

    log.info("closed %s for tenant %s: %s employee-day(s)", business_date, tenant_id, processed)


def handle_recalculation(envelope: dict[str, Any]) -> None:
    """Explicit recalculation: an approved correction, or an operator request."""
    tenant_id = envelope["tenant_id"]
    payload = envelope.get("payload") or {}
    employee_id = payload.get("employee_id")
    if not employee_id:
        log.error("recalculation event %s has no employee_id", envelope["event_id"])
        return

    start = date.fromisoformat(payload["from_date"])
    end = date.fromisoformat(payload.get("to_date") or payload["from_date"])

    with tenant_transaction(tenant_id, CONSUMER_NAME) as cur:
        if not claim_event(cur, tenant_id, envelope["event_id"], CONSUMER_NAME):
            return

    # An operator (or an approved correction) asked for this range explicitly, so every
    # day in it is evaluated — including days that turn out to be absences.
    days = recalculate_range(tenant_id, employee_id, start, end, mark_absent=True)
    log.info("recalculated %s day(s) for employee %s", days, employee_id)

    with tenant_transaction(tenant_id, CONSUMER_NAME) as cur:
        emit_event(
            cur,
            tenant_id=tenant_id,
            event_type="AttendanceCalculated",
            aggregate_type="attendance",
            aggregate_id=employee_id,
            payload={
                "employee_id": employee_id,
                "attendance_date": end.isoformat(),
                "calculation_version": CALCULATION_VERSION,
                "days_recalculated": days,
            },
            correlation_id=envelope.get("correlation_id"),
            producer=CONSUMER_NAME,
        )


HANDLERS = {
    "CheckinRecorded": handle_checkin_recorded,
    "AttendanceCorrectionApproved": handle_recalculation,
    "AttendanceCloseRequested": handle_close_requested,
}


def start_consumer() -> None:
    log.info("workforce engine consuming %s", QUEUE_NAME)
    run_consumer(QUEUE_NAME, CONSUMER_NAME, HANDLERS)


def create_app():
    from fastapi import FastAPI

    app = FastAPI(title="HRMS Workforce Engine", version=CALCULATION_VERSION)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "calculation_version": CALCULATION_VERSION}

    @app.post("/internal/close-day")
    def close(payload: dict) -> dict:
        """Daily attendance close. Invoked by a scheduler, never by a browser.

        Kept as an explicit operation rather than a timer inside the engine so the caller
        controls when a tenant's day is considered over in its own timezone.
        """
        tenant_id = payload["tenant_id"]
        on = date.fromisoformat(payload["date"])
        return {"processed": close_day(tenant_id, on, payload.get("employee_ids"))}

    @app.on_event("startup")
    def _start() -> None:
        if os.environ.get("RUN_CONSUMER", "true").lower() == "true":
            threading.Thread(target=start_consumer, daemon=True, name="workforce-consumer").start()

    @app.on_event("shutdown")
    def _stop() -> None:
        close_pool()

    return app


if __name__ == "__main__":
    # `python -m app.main close-day <tenant_id> <YYYY-MM-DD>` runs the daily close;
    # with no arguments the process runs as a queue consumer.
    if len(sys.argv) >= 4 and sys.argv[1] == "close-day":
        close_day(sys.argv[2], date.fromisoformat(sys.argv[3]))
    else:
        start_consumer()
