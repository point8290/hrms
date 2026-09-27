"""Payroll calculation engine.

Consumes PayrollRunCreated, calculates every employee in the run from their frozen
snapshot, writes draft salary slips and announces the result.

Two properties are load-bearing (ADR-005, ADR-004):
  * the only input is payroll_input_snapshot, so the run is reproducible
  * the whole run is idempotent, so a redelivered job cannot double-pay anyone
"""

from __future__ import annotations

import logging
import os
import sys
import threading
from decimal import Decimal
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))

from hrms_engine.consumer import run_consumer  # noqa: E402
from hrms_engine.db import claim_event, close_pool, emit_event, tenant_transaction  # noqa: E402

from .calculation import CALCULATION_VERSION, PayrollError, calculate  # noqa: E402

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format='{"level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
)
log = logging.getLogger("payroll-engine")

CONSUMER_NAME = "payroll-engine"
QUEUE_NAME = "payroll-jobs"


def _latest_snapshots(cur, run_id: str) -> list[dict[str, Any]]:
    """The newest snapshot version per employee.

    Snapshots are append-only, so a recalculated run has several versions; the engine uses
    the latest while the earlier ones remain available to explain a previous attempt.
    """
    cur.execute(
        """
        SELECT DISTINCT ON (s.employee_id)
               s.id, s.employee_id, s.snapshot_version,
               s.employee_json, s.attendance_json, s.leave_json,
               s.compensation_json, s.tax_json, s.statutory_json, s.additional_json,
               s.hra_json, s.exemption_json,
               pe.id AS payroll_employee_id
          FROM payroll.payroll_input_snapshot s
          JOIN payroll.payroll_employee pe
            ON pe.payroll_run_id = s.payroll_run_id AND pe.employee_id = s.employee_id
         WHERE s.payroll_run_id = %s
         ORDER BY s.employee_id, s.snapshot_version DESC
        """,
        (run_id,),
    )
    return cur.fetchall()


def handle_payroll_run_created(envelope: dict[str, Any]) -> None:
    tenant_id = envelope["tenant_id"]
    run_id = (envelope.get("payload") or {}).get("payroll_run_id") or envelope["aggregate_id"]

    with tenant_transaction(tenant_id, CONSUMER_NAME) as cur:
        if not claim_event(cur, tenant_id, envelope["event_id"], CONSUMER_NAME):
            log.info("payroll run %s already processed for event %s", run_id, envelope["event_id"])
            return

        cur.execute(
            """
            SELECT r.id, r.status, r.run_type, r.run_sequence,
                   to_char(p.period_start, 'YYYY-MM-DD') AS period_start,
                   to_char(p.period_end, 'YYYY-MM-DD') AS period_end
              FROM payroll.payroll_run r
              JOIN payroll.payroll_period p ON p.id = r.payroll_period_id
             WHERE r.id = %s
             FOR UPDATE OF r
            """,
            (run_id,),
        )
        run = cur.fetchone()
        if run is None:
            log.error("payroll run %s not found in tenant %s", run_id, tenant_id)
            return
        if run["status"] not in ("calculating", "validating"):
            log.warning("payroll run %s is %s; not calculating", run_id, run["status"])
            return

        snapshots = _latest_snapshots(cur, run_id)
        if not snapshots:
            _fail_run(cur, run_id, "no input snapshots were found for this run")
            return

        totals = {"gross": Decimal("0"), "deduction": Decimal("0"), "tax": Decimal("0"), "net": Decimal("0")}
        succeeded = 0
        failed = 0

        for snapshot in snapshots:
            employee_id = str(snapshot["employee_id"])
            try:
                result = calculate(snapshot)
            except PayrollError as err:
                # One employee's bad data fails that employee, never the whole run: a
                # payroll administrator can fix and recalculate without blocking everyone.
                failed += 1
                log.warning("employee %s failed: %s", employee_id, err)
                cur.execute(
                    """
                    UPDATE payroll.payroll_employee
                       SET status = 'failed', failure_reason = %s,
                           gross_amount = 0, deduction_amount = 0, tax_amount = 0, net_amount = 0
                     WHERE id = %s
                    """,
                    (str(err)[:1000], snapshot["payroll_employee_id"]),
                )
                continue

            _write_slip(cur, tenant_id, run_id, snapshot, result, run)
            succeeded += 1
            totals["gross"] += result.gross_amount
            totals["deduction"] += result.deduction_amount
            totals["tax"] += result.tax_amount
            totals["net"] += result.net_amount

        cur.execute(
            """
            UPDATE payroll.payroll_run
               SET status = 'calculated', calculated_at = now(),
                   total_gross = %s, total_deduction = %s, total_net = %s,
                   calculation_version = %s
             WHERE id = %s
            """,
            (totals["gross"], totals["deduction"] + totals["tax"], totals["net"], CALCULATION_VERSION, run_id),
        )

        emit_event(
            cur,
            tenant_id=tenant_id,
            event_type="PayrollCalculated",
            aggregate_type="payroll_run",
            aggregate_id=run_id,
            payload={
                "payroll_run_id": run_id,
                "calculation_version": CALCULATION_VERSION,
                "succeeded": succeeded,
                "failed": failed,
            },
            correlation_id=envelope.get("correlation_id"),
            producer=CONSUMER_NAME,
        )

        log.info("payroll run %s calculated: %s succeeded, %s failed", run_id, succeeded, failed)


def _write_slip(cur, tenant_id: str, run_id: str, snapshot: dict[str, Any], result, run: dict[str, Any]) -> None:
    """Writes the draft slip and its component lines.

    Draft, not finalized: finalization is a separate, explicitly authorized human step.
    Recalculation deletes draft slips first, so this insert is always for a fresh slip.
    """
    employee_id = str(snapshot["employee_id"])
    employee_code = (snapshot["employee_json"] or {}).get("employee_code", employee_id[:8])
    slip_number = build_slip_number(
        period_start=run["period_start"],
        employee_code=employee_code,
        run_type=run["run_type"],
        run_sequence=run["run_sequence"],
    )

    cur.execute(
        """
        INSERT INTO payroll.salary_slip
          (tenant_id, payroll_run_id, payroll_employee_id, employee_id, slip_number,
           period_start, period_end, total_days, payable_days, lop_days,
           gross_amount, deduction_amount, tax_amount, employer_contribution, net_amount,
           taxable_earnings, hra_exemption, section_exemption_total,
           currency, calculation_version, snapshot_id, status)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'draft')
        RETURNING id
        """,
        (
            tenant_id, run_id, snapshot["payroll_employee_id"], employee_id, slip_number,
            run["period_start"], run["period_end"],
            result.total_days, result.payable_days, result.lop_days,
            result.gross_amount, result.deduction_amount, result.tax_amount,
            result.employer_contribution, result.net_amount, result.taxable_earnings,
            result.hra_exemption, result.section_exemption_total,
            result.currency, CALCULATION_VERSION, snapshot["id"],
        ),
    )
    slip_id = cur.fetchone()["id"]

    import json

    for order, line in enumerate(result.components):
        cur.execute(
            """
            INSERT INTO payroll.salary_slip_component
              (tenant_id, salary_slip_id, component_code_snapshot, component_name_snapshot,
               component_type, amount, is_statutory, calculation_detail, display_order)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s)
            """,
            (
                tenant_id, slip_id, line.code, line.name, line.component_type,
                line.amount, line.is_statutory,
                # The tax classification travels with the line, so a payslip explains not
                # just what was deducted but why it did or did not affect the tax base.
                json.dumps(
                    {
                        **line.detail,
                        "taxable": line.taxable,
                        "exempted_from_income_tax": line.exempted_from_income_tax,
                    },
                    default=str,
                ),
                order,
            ),
        )

    cur.execute(
        """
        UPDATE payroll.payroll_employee
           SET status = 'calculated', failure_reason = NULL,
               gross_amount = %s, deduction_amount = %s, tax_amount = %s, net_amount = %s
         WHERE id = %s
        """,
        (
            result.gross_amount, result.deduction_amount, result.tax_amount,
            result.net_amount, snapshot["payroll_employee_id"],
        ),
    )


# Run types abbreviate into the slip number so a regular slip and its correction are
# distinguishable at a glance, on paper, months later.
_RUN_PREFIX = {"regular": "REG", "supplementary": "SUP", "off_cycle": "OFF"}


def build_slip_number(*, period_start: str, employee_code: str, run_type: str, run_sequence: int) -> str:
    """A slip number that is unique across period, employee, run type and run.

    The previous form was '{YYYY-MM}-{employee_code}', which a supplementary run for the
    same month reproduced exactly — so the duplicate-payment case surfaced as an opaque
    unique-violation on `slip_number` rather than being prevented. Including the run type
    and its sequence within the period makes the number deterministic (recalculating a run
    reproduces it) and unique (a correction cannot collide with what it corrects).
    """
    prefix = _RUN_PREFIX.get(run_type, "RUN")
    return f"{prefix}-{period_start[:7]}-{employee_code}-{int(run_sequence):02d}"


def _fail_run(cur, run_id: str, reason: str) -> None:
    log.error("payroll run %s failed: %s", run_id, reason)
    cur.execute(
        "UPDATE payroll.payroll_run SET status = 'failed', failure_reason = %s WHERE id = %s",
        (reason[:1000], run_id),
    )


HANDLERS = {"PayrollRunCreated": handle_payroll_run_created}


def start_consumer() -> None:
    log.info("payroll engine consuming %s", QUEUE_NAME)
    # Payroll runs take longer than attendance jobs, so the visibility timeout is larger:
    # a message that reappears mid-calculation would be handled by the idempotency guard,
    # but doing the work twice is pure waste.
    #
    # `max_receives` matches the redrive policy in `infra/terraform/queues.tf`, and must.
    # On SQS the application does not move a message to the DLQ — it returns it at
    # visibility zero and the broker's `maxReceiveCount` moves it. So a consumer that gives
    # up *earlier* than the redrive does not stop the work: the message comes straight back,
    # the handler runs again, and it gives up again, until the broker's count catches up.
    # This engine used to say 3 against a redrive of 5, which spent the difference spinning.
    # Equality puts the application's decision on the last delivery the broker permits, so
    # the reason is recorded once and no delivery is wasted.
    run_consumer(QUEUE_NAME, CONSUMER_NAME, HANDLERS, visibility_seconds=900, max_receives=5)


def create_app():
    from fastapi import FastAPI

    app = FastAPI(title="HRMS Payroll Engine", version=CALCULATION_VERSION)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "calculation_version": CALCULATION_VERSION}

    @app.on_event("startup")
    def _start() -> None:
        if os.environ.get("RUN_CONSUMER", "true").lower() == "true":
            threading.Thread(target=start_consumer, daemon=True, name="payroll-consumer").start()

    @app.on_event("shutdown")
    def _stop() -> None:
        close_pool()

    return app


if __name__ == "__main__":
    start_consumer()
