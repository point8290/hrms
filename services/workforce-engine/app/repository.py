"""Database reads and writes for the workforce engine.

Everything here runs inside a tenant transaction opened by the caller, so RLS applies to
every statement exactly as it does for an API request.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import psycopg

from .attendance import (
    Checkin,
    Correction,
    DayInput,
    DayResult,
    Direction,
    LeaveDay,
    Shift,
    shift_window,
)


def employee_context(cur: psycopg.Cursor, employee_id: str) -> dict[str, Any] | None:
    cur.execute(
        """
        SELECT e.id, e.employment_status,
               to_char(e.joining_date, 'YYYY-MM-DD') AS joining_date,
               to_char(e.exit_date, 'YYYY-MM-DD') AS exit_date,
               COALESCE(l.timezone, t.timezone) AS timezone
          FROM core.employee e
          JOIN identity.tenant t ON t.id = e.tenant_id
          LEFT JOIN core.location l ON l.id = e.location_id
         WHERE e.id = %s
        """,
        (employee_id,),
    )
    return cur.fetchone()


def shift_for(cur: psycopg.Cursor, employee_id: str, on: date) -> tuple[Shift | None, str | None]:
    """The shift assignment effective on a date, plus its holiday calendar.

    Resolved per day rather than once per run because an assignment can change mid-range,
    and using the wrong shift silently produces wrong late/overtime figures.
    """
    cur.execute(
        """
        SELECT sa.id AS assignment_id, sa.holiday_list_id, st.id AS shift_type_id,
               st.start_time, st.end_time, st.crosses_midnight, st.break_minutes,
               st.grace_in_minutes, st.grace_out_minutes,
               st.half_day_threshold_minutes, st.full_day_threshold_minutes,
               st.overtime_enabled, st.overtime_after_minutes,
               st.checkin_window_before_minutes, st.checkout_window_after_minutes
          FROM workforce.shift_assignment sa
          JOIN workforce.shift_type st ON st.id = sa.shift_type_id
         WHERE sa.employee_id = %s
           AND sa.status = 'active'
           AND sa.effective_from <= %s
           AND (sa.effective_to IS NULL OR sa.effective_to >= %s)
         ORDER BY sa.effective_from DESC
         LIMIT 1
        """,
        (employee_id, on, on),
    )
    row = cur.fetchone()
    if row is None:
        return None, None

    return (
        Shift(
            id=str(row["assignment_id"]),
            shift_type_id=str(row["shift_type_id"]),
            start_time=row["start_time"],
            end_time=row["end_time"],
            crosses_midnight=row["crosses_midnight"],
            break_minutes=row["break_minutes"],
            grace_in_minutes=row["grace_in_minutes"],
            grace_out_minutes=row["grace_out_minutes"],
            half_day_threshold_minutes=row["half_day_threshold_minutes"],
            full_day_threshold_minutes=row["full_day_threshold_minutes"],
            overtime_enabled=row["overtime_enabled"],
            overtime_after_minutes=row["overtime_after_minutes"],
            checkin_window_before_minutes=row["checkin_window_before_minutes"],
            checkout_window_after_minutes=row["checkout_window_after_minutes"],
        ),
        str(row["holiday_list_id"]) if row["holiday_list_id"] else None,
    )


def calendar_for(
    cur: psycopg.Cursor, holiday_list_id: str | None, start: date, end: date
) -> tuple[set[date], set[int]]:
    """Holiday dates and weekly-off weekdays for the range."""
    if holiday_list_id is None:
        cur.execute(
            "SELECT id, weekly_offs FROM workforce.holiday_list WHERE is_default ORDER BY year DESC LIMIT 1"
        )
        row = cur.fetchone()
        if row is None:
            return set(), set()
        holiday_list_id = str(row["id"])
        weekly_offs = set(row["weekly_offs"] or [])
    else:
        cur.execute("SELECT weekly_offs FROM workforce.holiday_list WHERE id = %s", (holiday_list_id,))
        row = cur.fetchone()
        weekly_offs = set(row["weekly_offs"] or []) if row else set()

    cur.execute(
        """
        SELECT holiday_date FROM workforce.holiday
         WHERE holiday_list_id = %s AND holiday_date BETWEEN %s AND %s AND NOT is_optional
        """,
        (holiday_list_id, start, end),
    )
    return {r["holiday_date"] for r in cur.fetchall()}, weekly_offs


def checkins_for(cur: psycopg.Cursor, employee_id: str, start: datetime, end: datetime) -> list[Checkin]:
    cur.execute(
        """
        SELECT id, checkin_at, direction
          FROM workforce.employee_checkin
         WHERE employee_id = %s AND checkin_at BETWEEN %s AND %s
         ORDER BY checkin_at
        """,
        (employee_id, start, end),
    )
    return [
        Checkin(id=str(r["id"]), at=r["checkin_at"], direction=Direction(r["direction"]))
        for r in cur.fetchall()
    ]


def approved_leave_for(cur: psycopg.Cursor, employee_id: str, start: date, end: date) -> dict[date, LeaveDay]:
    """Approved leave keyed by date.

    Half days are represented honestly: the engine needs to know that half the day is
    still expected to be worked.
    """
    cur.execute(
        """
        SELECT la.id, la.start_date, la.end_date, la.start_half_day, la.end_half_day,
               lt.code, lt.is_paid, lt.is_lop
          FROM leave_mgmt.leave_application la
          JOIN leave_mgmt.leave_type lt ON lt.id = la.leave_type_id
         WHERE la.employee_id = %s AND la.status = 'approved'
           AND la.start_date <= %s AND la.end_date >= %s
        """,
        (employee_id, end, start),
    )

    out: dict[date, LeaveDay] = {}
    for row in cur.fetchall():
        current = row["start_date"]
        while current <= row["end_date"]:
            if start <= current <= end:
                units = 1.0
                if row["start_half_day"] and current == row["start_date"]:
                    units = 0.5
                elif row["end_half_day"] and current == row["end_date"]:
                    units = 0.5
                out[current] = LeaveDay(
                    leave_application_id=str(row["id"]),
                    leave_type_code=row["code"],
                    units=units,
                    is_paid=row["is_paid"],
                    is_lop=row["is_lop"],
                )
            current = date.fromordinal(current.toordinal() + 1)
    return out


def correction_for(cur: psycopg.Cursor, employee_id: str, on: date) -> Correction | None:
    cur.execute(
        """
        SELECT proposed_in_at, proposed_out_at, proposed_status
          FROM workforce.attendance_correction
         WHERE employee_id = %s AND attendance_date = %s AND status = 'approved'
         ORDER BY decided_at DESC
         LIMIT 1
        """,
        (employee_id, on),
    )
    row = cur.fetchone()
    if row is None:
        return None
    return Correction(
        proposed_in_at=row["proposed_in_at"],
        proposed_out_at=row["proposed_out_at"],
        proposed_status=row["proposed_status"],
    )


def persist(cur: psycopg.Cursor, tenant_id: str, result: DayResult) -> None:
    """Upserts derived attendance.

    Safe to repeat: attendance is derived state keyed by (tenant, employee, date), so a
    redelivered job recomputes and overwrites rather than duplicating.
    """
    cur.execute(
        """
        INSERT INTO workforce.attendance
          (tenant_id, employee_id, attendance_date, shift_assignment_id, shift_type_id, status,
           first_in_at, last_out_at, working_minutes, break_minutes, late_minutes,
           early_exit_minutes, overtime_minutes, lop_units, leave_application_id,
           has_missing_punch, is_corrected, calculation_version, source_checkin_ids, calculated_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::uuid[], now())
        ON CONFLICT (tenant_id, employee_id, attendance_date) DO UPDATE SET
          shift_assignment_id = EXCLUDED.shift_assignment_id,
          shift_type_id       = EXCLUDED.shift_type_id,
          status              = EXCLUDED.status,
          first_in_at         = EXCLUDED.first_in_at,
          last_out_at         = EXCLUDED.last_out_at,
          working_minutes     = EXCLUDED.working_minutes,
          break_minutes       = EXCLUDED.break_minutes,
          late_minutes        = EXCLUDED.late_minutes,
          early_exit_minutes  = EXCLUDED.early_exit_minutes,
          overtime_minutes    = EXCLUDED.overtime_minutes,
          lop_units           = EXCLUDED.lop_units,
          leave_application_id = EXCLUDED.leave_application_id,
          has_missing_punch   = EXCLUDED.has_missing_punch,
          is_corrected        = EXCLUDED.is_corrected,
          calculation_version = EXCLUDED.calculation_version,
          source_checkin_ids  = EXCLUDED.source_checkin_ids,
          calculated_at       = now()
        """,
        (
            tenant_id,
            result.employee_id,
            result.attendance_date,
            result.shift_assignment_id,
            result.shift_type_id,
            str(result.status),
            result.first_in_at,
            result.last_out_at,
            result.working_minutes,
            result.break_minutes,
            result.late_minutes,
            result.early_exit_minutes,
            result.overtime_minutes,
            result.lop_units,
            result.leave_application_id,
            result.has_missing_punch,
            result.is_corrected,
            result.calculation_version,
            result.source_checkin_ids,
        ),
    )


def attendance_exists(cur: psycopg.Cursor, employee_id: str, on: date) -> bool:
    """True when a derived row already exists for this employee-day."""
    cur.execute(
        "SELECT 1 FROM workforce.attendance WHERE employee_id = %s AND attendance_date = %s",
        (employee_id, on),
    )
    return cur.fetchone() is not None


def locked_by_finalized_payroll(cur: psycopg.Cursor, employee_id: str, on: date) -> bool:
    """True when the date is already inside a finalized payroll run.

    Recalculating such a day would make attendance disagree with a payslip that is, by
    design, immutable. The correction still exists and is visible; the adjustment belongs
    in a supplementary payroll run (ADR-005).
    """
    cur.execute(
        """
        SELECT 1
          FROM payroll.payroll_run r
          JOIN payroll.payroll_period p ON p.id = r.payroll_period_id
          JOIN payroll.payroll_employee pe ON pe.payroll_run_id = r.id
         WHERE pe.employee_id = %s
           AND r.status IN ('finalized', 'payment_pending', 'paid')
           AND %s BETWEEN p.period_start AND p.period_end
         LIMIT 1
        """,
        (employee_id, on),
    )
    return cur.fetchone() is not None


def build_day_input(
    cur: psycopg.Cursor,
    employee: dict[str, Any],
    on: date,
) -> DayInput:
    """Assembles everything needed to derive one employee-day.

    The check-in fetch is bounded by the shift's own window in the *employee's* timezone.
    Fetching a wider range and letting the calculator filter would make the day look like
    it had observations when the punches actually belong to a neighbouring day — and the
    caller uses "did this day have inputs?" to decide whether an absence may be declared.
    """
    employee_id = str(employee["id"])
    tz = ZoneInfo(employee["timezone"] or "Asia/Kolkata")

    shift, holiday_list_id = shift_for(cur, employee_id, on)
    holidays, weekly_offs = calendar_for(cur, holiday_list_id, on, on)

    if shift is not None:
        window_start, window_end = shift_window(on, shift, tz)
        lower = window_start - timedelta(minutes=shift.checkin_window_before_minutes)
        upper = window_end + timedelta(minutes=shift.checkout_window_after_minutes)
    else:
        # No shift assigned: the local calendar day is the only sensible boundary.
        lower = datetime.combine(on, time(0, 0), tzinfo=tz)
        upper = lower + timedelta(days=1)

    checkins = checkins_for(cur, employee_id, lower, upper)
    leave = approved_leave_for(cur, employee_id, on, on).get(on)

    return DayInput(
        employee_id=employee_id,
        attendance_date=on,
        timezone=employee["timezone"] or "Asia/Kolkata",
        shift=shift,
        checkins=tuple(checkins),
        leave=leave,
        is_holiday=on in holidays,
        # Python's isoweekday is 1=Monday..7=Sunday; the holiday list stores 0=Sunday.
        is_weekly_off=on.isoweekday() % 7 in weekly_offs,
        correction=correction_for(cur, employee_id, on),
    )
