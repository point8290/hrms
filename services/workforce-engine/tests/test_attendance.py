"""Attendance derivation tests.

These cover the edge cases the PRD calls out explicitly: duplicates, missing checkout,
out-of-order events, overnight shifts, grace periods, holidays, weekly offs and leave.
"""

from __future__ import annotations

import sys
import unittest
from datetime import date, datetime, time
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.attendance import (  # noqa: E402
    Checkin,
    Correction,
    DayInput,
    Direction,
    LeaveDay,
    Shift,
    Status,
    calculate_day,
    normalise_checkins,
    pair_sessions,
    shift_window,
)

IST = ZoneInfo("Asia/Kolkata")
DAY = date(2026, 3, 10)

DAY_SHIFT = Shift(
    id="sa-1",
    shift_type_id="st-1",
    start_time=time(9, 0),
    end_time=time(18, 0),
    crosses_midnight=False,
    break_minutes=60,
    grace_in_minutes=10,
    grace_out_minutes=10,
    half_day_threshold_minutes=240,
    full_day_threshold_minutes=480,
    overtime_enabled=True,
    overtime_after_minutes=480,
)

# An 8h window with a 30m unpaid break means 450 minutes of expected work; the
# thresholds are configured to match the shift rather than left at the generic default.
NIGHT_SHIFT = Shift(
    id="sa-2",
    shift_type_id="st-2",
    start_time=time(22, 0),
    end_time=time(6, 0),
    crosses_midnight=True,
    break_minutes=30,
    grace_in_minutes=10,
    grace_out_minutes=10,
    half_day_threshold_minutes=225,
    full_day_threshold_minutes=450,
)


def at(hour: int, minute: int = 0, day: date = DAY) -> datetime:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=IST)


def punches(*entries: tuple[datetime, Direction]) -> tuple[Checkin, ...]:
    return tuple(Checkin(id=f"c{i}", at=t, direction=d) for i, (t, d) in enumerate(entries))


def build(**overrides) -> DayInput:
    base = {
        "employee_id": "emp-1",
        "attendance_date": DAY,
        "timezone": "Asia/Kolkata",
        "shift": DAY_SHIFT,
        "checkins": (),
    }
    base.update(overrides)
    return DayInput(**base)


class TestShiftWindow(unittest.TestCase):
    def test_day_shift_window_is_same_day(self):
        start, end = shift_window(DAY, DAY_SHIFT, IST)
        self.assertEqual(start, at(9))
        self.assertEqual(end, at(18))

    def test_overnight_shift_ends_next_calendar_day(self):
        start, end = shift_window(DAY, NIGHT_SHIFT, IST)
        self.assertEqual(start, at(22))
        self.assertEqual(end, at(6, 0, date(2026, 3, 11)))


class TestNormalisation(unittest.TestCase):
    def test_out_of_order_events_are_sorted(self):
        result = normalise_checkins(list(punches((at(18), Direction.OUT), (at(9), Direction.IN))))
        self.assertEqual([c.at for c in result], [at(9), at(18)])

    def test_duplicate_punch_within_the_window_is_dropped(self):
        result = normalise_checkins(
            list(punches((at(9, 0), Direction.IN), (at(9, 0), Direction.IN), (at(18), Direction.OUT)))
        )
        self.assertEqual(len(result), 2)

    def test_distinct_punches_outside_the_window_are_kept(self):
        result = normalise_checkins(
            list(punches((at(9, 0), Direction.IN), (at(9, 5), Direction.IN), (at(18), Direction.OUT)))
        )
        self.assertEqual(len(result), 3)

    def test_unknown_directions_alternate_from_in(self):
        result = normalise_checkins(
            list(
                punches(
                    (at(9), Direction.UNKNOWN),
                    (at(13), Direction.UNKNOWN),
                    (at(14), Direction.UNKNOWN),
                    (at(18), Direction.UNKNOWN),
                )
            )
        )
        self.assertEqual(
            [c.direction for c in result],
            [Direction.IN, Direction.OUT, Direction.IN, Direction.OUT],
        )


class TestPairing(unittest.TestCase):
    def test_simple_pair(self):
        sessions, missing = pair_sessions(list(punches((at(9), Direction.IN), (at(18), Direction.OUT))))
        self.assertEqual(sessions, [(at(9), at(18))])
        self.assertFalse(missing)

    def test_repeated_in_keeps_the_earliest(self):
        sessions, missing = pair_sessions(
            list(punches((at(9), Direction.IN), (at(9, 30), Direction.IN), (at(18), Direction.OUT)))
        )
        self.assertEqual(sessions, [(at(9), at(18))])
        self.assertFalse(missing)

    def test_missing_checkout_is_flagged_and_contributes_no_time(self):
        sessions, missing = pair_sessions(list(punches((at(9), Direction.IN))))
        self.assertEqual(sessions, [])
        self.assertTrue(missing)

    def test_out_without_in_is_flagged(self):
        sessions, missing = pair_sessions(list(punches((at(18), Direction.OUT))))
        self.assertEqual(sessions, [])
        self.assertTrue(missing)


class TestFullDay(unittest.TestCase):
    def test_full_day_present_with_break_deducted(self):
        result = calculate_day(build(checkins=punches((at(9), Direction.IN), (at(18), Direction.OUT))))
        self.assertEqual(result.status, Status.PRESENT)
        self.assertEqual(result.working_minutes, 480)  # 9h minus a 1h break
        self.assertEqual(result.late_minutes, 0)
        self.assertEqual(result.overtime_minutes, 0)
        self.assertEqual(result.lop_units, 0.0)

    def test_lunch_break_split_into_two_sessions(self):
        result = calculate_day(
            build(
                checkins=punches(
                    (at(9), Direction.IN),
                    (at(13), Direction.OUT),
                    (at(14), Direction.IN),
                    (at(18), Direction.OUT),
                )
            )
        )
        # The lunch gap is already excluded by pairing, so the configured break is not
        # deducted a second time.
        self.assertEqual(result.working_minutes, 480)
        self.assertEqual(result.break_minutes, 0)
        self.assertEqual(result.status, Status.PRESENT)
        self.assertEqual(result.first_in_at, at(9))
        self.assertEqual(result.last_out_at, at(18))

    def test_grace_period_absorbs_a_small_delay(self):
        result = calculate_day(build(checkins=punches((at(9, 8), Direction.IN), (at(18), Direction.OUT))))
        self.assertEqual(result.late_minutes, 0)

    def test_late_beyond_grace_is_counted_from_the_grace_boundary(self):
        result = calculate_day(build(checkins=punches((at(9, 40), Direction.IN), (at(18), Direction.OUT))))
        self.assertEqual(result.late_minutes, 30)

    def test_early_exit_beyond_grace(self):
        result = calculate_day(build(checkins=punches((at(9), Direction.IN), (at(17, 20), Direction.OUT))))
        self.assertEqual(result.early_exit_minutes, 30)

    def test_overtime_only_beyond_the_threshold(self):
        result = calculate_day(build(checkins=punches((at(9), Direction.IN), (at(20), Direction.OUT))))
        self.assertEqual(result.working_minutes, 600)
        self.assertEqual(result.overtime_minutes, 120)

    def test_missing_checkout_does_not_invent_hours(self):
        result = calculate_day(build(checkins=punches((at(9), Direction.IN))))
        self.assertTrue(result.has_missing_punch)
        self.assertEqual(result.working_minutes, 0)
        self.assertEqual(result.status, Status.ABSENT)

    def test_no_checkins_is_absent_with_full_lop(self):
        result = calculate_day(build())
        self.assertEqual(result.status, Status.ABSENT)
        self.assertEqual(result.lop_units, 1.0)

    def test_short_day_is_half_day_with_half_lop(self):
        result = calculate_day(build(checkins=punches((at(9), Direction.IN), (at(14, 30), Direction.OUT))))
        # Below a full day, so no unpaid break is assumed.
        self.assertEqual(result.working_minutes, 330)
        self.assertEqual(result.status, Status.HALF_DAY)
        self.assertEqual(result.lop_units, 0.5)

    def test_checkin_far_outside_the_shift_window_is_ignored(self):
        # 03:00 is more than checkin_window_before_minutes (120) ahead of a 09:00 shift.
        result = calculate_day(
            build(checkins=punches((at(3), Direction.IN), (at(9), Direction.IN), (at(18), Direction.OUT)))
        )
        self.assertEqual(result.first_in_at, at(9))
        self.assertEqual(result.working_minutes, 480)


class TestOvernightShift(unittest.TestCase):
    def test_night_worked_across_midnight_belongs_to_the_start_date(self):
        result = calculate_day(
            build(
                shift=NIGHT_SHIFT,
                checkins=punches(
                    (at(22), Direction.IN),
                    (at(6, 0, date(2026, 3, 11)), Direction.OUT),
                ),
            )
        )
        self.assertEqual(result.attendance_date, DAY)
        self.assertEqual(result.working_minutes, 450)  # 8h minus a 30m break
        self.assertEqual(result.status, Status.PRESENT)
        self.assertEqual(result.late_minutes, 0)

    def test_late_arrival_on_an_overnight_shift(self):
        result = calculate_day(
            build(
                shift=NIGHT_SHIFT,
                checkins=punches(
                    (at(22, 45), Direction.IN),
                    (at(6, 0, date(2026, 3, 11)), Direction.OUT),
                ),
            )
        )
        self.assertEqual(result.late_minutes, 35)


class TestNonWorkingDays(unittest.TestCase):
    def test_holiday_with_no_work_is_a_holiday_not_an_absence(self):
        result = calculate_day(build(is_holiday=True))
        self.assertEqual(result.status, Status.HOLIDAY)
        self.assertEqual(result.lop_units, 0.0)

    def test_weekly_off_with_no_work_carries_no_lop(self):
        result = calculate_day(build(is_weekly_off=True))
        self.assertEqual(result.status, Status.WEEKLY_OFF)
        self.assertEqual(result.lop_units, 0.0)

    def test_working_on_a_holiday_is_present(self):
        result = calculate_day(
            build(is_holiday=True, checkins=punches((at(9), Direction.IN), (at(18), Direction.OUT)))
        )
        self.assertEqual(result.status, Status.PRESENT)
        self.assertEqual(result.lop_units, 0.0)


class TestLeave(unittest.TestCase):
    def _leave(self, units: float, *, paid: bool = True, lop: bool = False) -> LeaveDay:
        return LeaveDay(
            leave_application_id="la-1",
            leave_type_code="EL" if paid else "LOP",
            units=units,
            is_paid=paid,
            is_lop=lop,
        )

    def test_full_day_paid_leave_has_no_lop(self):
        result = calculate_day(build(leave=self._leave(1.0)))
        self.assertEqual(result.status, Status.ON_LEAVE)
        self.assertEqual(result.lop_units, 0.0)
        self.assertEqual(result.leave_application_id, "la-1")

    def test_full_day_lop_leave_is_a_full_day_of_lop(self):
        result = calculate_day(build(leave=self._leave(1.0, paid=False, lop=True)))
        self.assertEqual(result.status, Status.ON_LEAVE)
        self.assertEqual(result.lop_units, 1.0)

    def test_half_day_leave_with_the_other_half_worked(self):
        result = calculate_day(
            build(leave=self._leave(0.5), checkins=punches((at(14), Direction.IN), (at(18), Direction.OUT)))
        )
        self.assertEqual(result.status, Status.HALF_DAY)
        self.assertEqual(result.lop_units, 0.0)

    def test_half_day_leave_with_the_other_half_unworked_adds_lop(self):
        result = calculate_day(
            build(leave=self._leave(0.5), checkins=punches((at(14), Direction.IN), (at(15), Direction.OUT)))
        )
        self.assertEqual(result.status, Status.HALF_DAY)
        self.assertEqual(result.lop_units, 0.5)


class TestCorrections(unittest.TestCase):
    def test_correction_supplies_a_missing_checkout_without_touching_raw_events(self):
        result = calculate_day(
            build(
                checkins=punches((at(9), Direction.IN)),
                correction=Correction(proposed_out_at=at(18)),
            )
        )
        self.assertTrue(result.is_corrected)
        self.assertEqual(result.status, Status.PRESENT)
        self.assertEqual(result.working_minutes, 480)
        # The derived record cites only the genuine observation as its source.
        self.assertEqual(result.source_checkin_ids, ["c0"])

    def test_correction_can_set_the_status_outright(self):
        result = calculate_day(build(correction=Correction(proposed_status="work_from_home")))
        self.assertEqual(result.status, Status.WORK_FROM_HOME)
        self.assertEqual(result.lop_units, 0.0)


class TestDeterminism(unittest.TestCase):
    def test_same_input_produces_the_same_result(self):
        day = build(
            checkins=punches(
                (at(9, 5), Direction.IN),
                (at(13), Direction.OUT),
                (at(13, 45), Direction.IN),
                (at(18, 30), Direction.OUT),
            )
        )
        first = calculate_day(day)
        second = calculate_day(day)
        self.assertEqual(first, second)

    def test_input_order_does_not_change_the_result(self):
        forward = build(
            checkins=punches((at(9), Direction.IN), (at(13), Direction.OUT), (at(14), Direction.IN), (at(18), Direction.OUT))
        )
        shuffled = build(
            checkins=punches((at(14), Direction.IN), (at(18), Direction.OUT), (at(9), Direction.IN), (at(13), Direction.OUT))
        )
        self.assertEqual(calculate_day(forward).working_minutes, calculate_day(shuffled).working_minutes)


if __name__ == "__main__":
    unittest.main(verbosity=2)
