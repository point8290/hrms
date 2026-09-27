"""Pure attendance derivation.

No database, no clock, no I/O. Everything the engine decides about a day is a function of
its inputs, which is what makes attendance recomputable: the raw check-ins are immutable
facts and this module turns them into derived state on demand (invariants.md#attendance).

Business behaviour follows mature HR semantics:
paired IN/OUT sessions, grace periods, half-day and full-day working-hour thresholds,
overtime beyond a configured threshold, and holidays and weekly offs that are neither
present nor absent.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from enum import StrEnum
from zoneinfo import ZoneInfo

CALCULATION_VERSION = "workforce-2025.1"

# Two observations this close together are one physical event seen twice (a device
# double-tap or an at-least-once redelivery), not two punches.
DUPLICATE_WINDOW_SECONDS = 60


class Status(StrEnum):
    PRESENT = "present"
    ABSENT = "absent"
    HALF_DAY = "half_day"
    ON_LEAVE = "on_leave"
    WEEKLY_OFF = "weekly_off"
    HOLIDAY = "holiday"
    WORK_FROM_HOME = "work_from_home"
    NOT_MARKED = "not_marked"


class Direction(StrEnum):
    IN = "in"
    OUT = "out"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class Checkin:
    id: str
    at: datetime  # timezone-aware
    direction: Direction


@dataclass(frozen=True)
class Shift:
    id: str | None
    shift_type_id: str | None
    start_time: time
    end_time: time
    crosses_midnight: bool
    break_minutes: int = 0
    grace_in_minutes: int = 0
    grace_out_minutes: int = 0
    half_day_threshold_minutes: int = 240
    full_day_threshold_minutes: int = 480
    overtime_enabled: bool = False
    overtime_after_minutes: int = 480
    checkin_window_before_minutes: int = 120
    checkout_window_after_minutes: int = 240


@dataclass(frozen=True)
class LeaveDay:
    """An approved leave that covers this date, in units of 1.0 or 0.5."""

    leave_application_id: str
    leave_type_code: str
    units: float
    is_paid: bool
    is_lop: bool


@dataclass(frozen=True)
class Correction:
    """An approved correction. Applied as an additional input, never as an edit of a check-in."""

    proposed_in_at: datetime | None = None
    proposed_out_at: datetime | None = None
    proposed_status: str | None = None


@dataclass(frozen=True)
class DayInput:
    employee_id: str
    attendance_date: date
    timezone: str
    shift: Shift | None
    checkins: tuple[Checkin, ...] = ()
    leave: LeaveDay | None = None
    is_holiday: bool = False
    is_weekly_off: bool = False
    correction: Correction | None = None


@dataclass
class DayResult:
    employee_id: str
    attendance_date: date
    status: Status
    first_in_at: datetime | None = None
    last_out_at: datetime | None = None
    working_minutes: int = 0
    break_minutes: int = 0
    late_minutes: int = 0
    early_exit_minutes: int = 0
    overtime_minutes: int = 0
    lop_units: float = 0.0
    has_missing_punch: bool = False
    is_corrected: bool = False
    leave_application_id: str | None = None
    shift_assignment_id: str | None = None
    shift_type_id: str | None = None
    source_checkin_ids: list[str] = field(default_factory=list)
    calculation_version: str = CALCULATION_VERSION


def shift_window(attendance_date: date, shift: Shift, tz: ZoneInfo) -> tuple[datetime, datetime]:
    """The shift's start and end as absolute instants for this attendance date.

    An overnight shift ends on the following calendar day, so its window — and therefore
    everything derived from it — belongs to the date the shift *started*. Anchoring on the
    clock date instead would split one night's work across two days.
    """
    start = datetime.combine(attendance_date, shift.start_time, tzinfo=tz)
    end_date = attendance_date + timedelta(days=1) if shift.crosses_midnight else attendance_date
    end = datetime.combine(end_date, shift.end_time, tzinfo=tz)
    if end <= start:
        # end_time equal to start_time on a non-overnight shift means a full 24h shift.
        end += timedelta(days=1)
    return start, end


def normalise_checkins(checkins: list[Checkin]) -> list[Checkin]:
    """Sorts, de-duplicates and infers missing directions.

    Devices are unreliable: they retry, replay offline batches, disagree on clocks and
    frequently report no direction at all. Rather than rejecting such data (and losing the
    day), unknown directions are inferred by alternating from the first observation, which
    is how a physical IN/OUT sequence actually behaves.
    """
    ordered = sorted(checkins, key=lambda c: (c.at, c.id))

    deduped: list[Checkin] = []
    for checkin in ordered:
        if deduped:
            previous = deduped[-1]
            same_direction = previous.direction == checkin.direction
            close_together = (checkin.at - previous.at).total_seconds() <= DUPLICATE_WINDOW_SECONDS
            if close_together and (same_direction or Direction.UNKNOWN in (previous.direction, checkin.direction)):
                continue
        deduped.append(checkin)

    resolved: list[Checkin] = []
    expected = Direction.IN
    for checkin in deduped:
        if checkin.direction is Direction.UNKNOWN:
            resolved.append(Checkin(id=checkin.id, at=checkin.at, direction=expected))
            expected = Direction.OUT if expected is Direction.IN else Direction.IN
        else:
            resolved.append(checkin)
            expected = Direction.OUT if checkin.direction is Direction.IN else Direction.IN

    return resolved


def pair_sessions(checkins: list[Checkin]) -> tuple[list[tuple[datetime, datetime]], bool]:
    """Pairs IN/OUT observations into worked sessions.

    Returns the sessions and whether a punch is missing. Repeated INs keep the earliest
    (someone tapped twice on the way in); repeated OUTs keep the latest (they left for
    good at the last one). A trailing IN with no OUT contributes no time but is flagged,
    because guessing a departure time would invent hours nobody worked.
    """
    sessions: list[tuple[datetime, datetime]] = []
    open_in: datetime | None = None
    missing = False

    for checkin in checkins:
        if checkin.direction is Direction.IN:
            if open_in is None:
                open_in = checkin.at
            # A second IN while one is open: keep the first, ignore the duplicate.
        else:
            if open_in is None:
                # An OUT with no matching IN: the IN was never recorded.
                missing = True
                continue
            if sessions and sessions[-1][1] == open_in:
                sessions[-1] = (sessions[-1][0], checkin.at)
            else:
                sessions.append((open_in, checkin.at))
            open_in = None

    if open_in is not None:
        missing = True

    return sessions, missing


def calculate_day(day: DayInput) -> DayResult:
    """Derives one employee-day of attendance."""
    tz = ZoneInfo(day.timezone)
    result = DayResult(
        employee_id=day.employee_id,
        attendance_date=day.attendance_date,
        status=Status.NOT_MARKED,
        shift_assignment_id=day.shift.id if day.shift else None,
        shift_type_id=day.shift.shift_type_id if day.shift else None,
    )

    checkins = list(day.checkins)

    # A correction adds observations for this day; it never rewrites employee_checkin.
    if day.correction is not None:
        result.is_corrected = True
        if day.correction.proposed_in_at is not None:
            checkins.append(Checkin(id="correction-in", at=day.correction.proposed_in_at, direction=Direction.IN))
        if day.correction.proposed_out_at is not None:
            checkins.append(Checkin(id="correction-out", at=day.correction.proposed_out_at, direction=Direction.OUT))

    if day.shift is not None:
        window_start, window_end = shift_window(day.attendance_date, day.shift, tz)
        lower = window_start - timedelta(minutes=day.shift.checkin_window_before_minutes)
        upper = window_end + timedelta(minutes=day.shift.checkout_window_after_minutes)
        checkins = [c for c in checkins if lower <= c.at <= upper]
    else:
        window_start = window_end = None
        local_day = day.attendance_date
        checkins = [c for c in checkins if c.at.astimezone(tz).date() == local_day]

    normalised = normalise_checkins(checkins)
    sessions, missing = pair_sessions(normalised)
    result.has_missing_punch = missing
    result.source_checkin_ids = [c.id for c in normalised if not c.id.startswith("correction-")]

    worked = int(sum((end - start).total_seconds() for start, end in sessions) // 60)

    # The unpaid break is only assumed when the employee never punched out for one, and
    # only on a stint long enough to contain it. If they did punch out, the gap is already
    # excluded by pairing — deducting again would charge them for the same break twice.
    if (
        day.shift is not None
        and day.shift.break_minutes > 0
        and len(sessions) == 1
        and worked >= day.shift.full_day_threshold_minutes
    ):
        result.break_minutes = day.shift.break_minutes
        worked -= day.shift.break_minutes

    result.working_minutes = max(0, worked)

    if sessions:
        result.first_in_at = sessions[0][0]
        result.last_out_at = sessions[-1][1]
    elif normalised:
        result.first_in_at = normalised[0].at

    if day.shift is not None and window_start is not None and window_end is not None:
        if result.first_in_at is not None:
            allowed_in = window_start + timedelta(minutes=day.shift.grace_in_minutes)
            result.late_minutes = max(0, int((result.first_in_at - allowed_in).total_seconds() // 60))
        if result.last_out_at is not None:
            allowed_out = window_end - timedelta(minutes=day.shift.grace_out_minutes)
            result.early_exit_minutes = max(0, int((allowed_out - result.last_out_at).total_seconds() // 60))
        if day.shift.overtime_enabled:
            result.overtime_minutes = max(0, result.working_minutes - day.shift.overtime_after_minutes)

    result.status, result.lop_units = _resolve_status(day, result)
    if day.leave is not None and result.status in (Status.ON_LEAVE, Status.HALF_DAY):
        result.leave_application_id = day.leave.leave_application_id

    return result


def _resolve_status(day: DayInput, result: DayResult) -> tuple[Status, float]:
    """Decides the day's status and how much of it is loss of pay.

    Order matters. An explicit correction wins; then approved leave; then holidays and
    weekly offs (which are non-working, so working on one is credit, never absence);
    finally the worked-hours thresholds.
    """
    correction_status = day.correction.proposed_status if day.correction else None
    if correction_status:
        status = Status(correction_status)
        return status, _lop_for(status)

    worked = result.working_minutes
    half_threshold = day.shift.half_day_threshold_minutes if day.shift else 240
    full_threshold = day.shift.full_day_threshold_minutes if day.shift else 480

    if day.leave is not None:
        if day.leave.units >= 1.0:
            # Unpaid or LOP leave still shows as leave; the pay impact is the LOP figure.
            return Status.ON_LEAVE, (1.0 if day.leave.is_lop or not day.leave.is_paid else 0.0)
        # Half-day leave: the other half is expected to be worked.
        lop = 0.5 if day.leave.is_lop or not day.leave.is_paid else 0.0
        if worked >= half_threshold or worked == 0:
            return Status.HALF_DAY, lop
        return Status.HALF_DAY, lop + 0.5

    if day.is_holiday:
        return (Status.PRESENT, 0.0) if worked > 0 else (Status.HOLIDAY, 0.0)

    if day.is_weekly_off:
        return (Status.PRESENT, 0.0) if worked > 0 else (Status.WEEKLY_OFF, 0.0)

    if day.shift is None and worked == 0:
        # No shift assigned and nothing observed: we cannot claim absence.
        return Status.NOT_MARKED, 0.0

    if worked >= full_threshold:
        return Status.PRESENT, 0.0
    if worked >= half_threshold:
        return Status.HALF_DAY, 0.5
    if worked > 0:
        # Present but below the half-day bar: recorded as half day with full LOP would be
        # punitive twice over, so it is a half day with a half day of LOP.
        return Status.HALF_DAY, 0.5
    return Status.ABSENT, 1.0


def _lop_for(status: Status) -> float:
    if status is Status.ABSENT:
        return 1.0
    if status is Status.HALF_DAY:
        return 0.5
    return 0.0
