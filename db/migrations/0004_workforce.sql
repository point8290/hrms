-- 0004 shifts, holidays, raw check-ins and derived attendance.
--
-- Invariant: workforce.employee_checkin is an immutable observation.
-- workforce.attendance is derived state and may be recalculated at any time.

CREATE TABLE workforce.holiday_list (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  name        text NOT NULL,
  year        integer NOT NULL,
  location_id uuid REFERENCES core.location(id),
  is_default  boolean NOT NULL DEFAULT false,
  weekly_offs smallint[] NOT NULL DEFAULT ARRAY[0]::smallint[],
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, year)
);
SELECT app.enable_tenant_rls('workforce.holiday_list');
SELECT app.add_updated_at_trigger('workforce.holiday_list');
COMMENT ON COLUMN workforce.holiday_list.weekly_offs IS
  'ISO-ish day numbers, 0=Sunday .. 6=Saturday. Drives weekly-off attendance status.';

CREATE TABLE workforce.holiday (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  holiday_list_id uuid NOT NULL REFERENCES workforce.holiday_list(id) ON DELETE CASCADE,
  holiday_date    date NOT NULL,
  name            text NOT NULL,
  is_optional     boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (holiday_list_id, holiday_date)
);
SELECT app.enable_tenant_rls('workforce.holiday');
CREATE INDEX idx_holiday_date ON workforce.holiday (tenant_id, holiday_date);

CREATE TABLE workforce.shift_type (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  name                text NOT NULL,
  code                text NOT NULL,
  start_time          time NOT NULL,
  end_time            time NOT NULL,
  crosses_midnight    boolean NOT NULL DEFAULT false,
  break_minutes       integer NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  grace_in_minutes    integer NOT NULL DEFAULT 0 CHECK (grace_in_minutes >= 0),
  grace_out_minutes   integer NOT NULL DEFAULT 0 CHECK (grace_out_minutes >= 0),
  half_day_threshold_minutes integer NOT NULL DEFAULT 240 CHECK (half_day_threshold_minutes >= 0),
  full_day_threshold_minutes integer NOT NULL DEFAULT 480 CHECK (full_day_threshold_minutes >= 0),
  overtime_enabled    boolean NOT NULL DEFAULT false,
  overtime_after_minutes integer NOT NULL DEFAULT 480 CHECK (overtime_after_minutes >= 0),
  -- How far before/after the shift window a check-in still belongs to this shift.
  checkin_window_before_minutes integer NOT NULL DEFAULT 120,
  checkout_window_after_minutes integer NOT NULL DEFAULT 240,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CONSTRAINT shift_thresholds CHECK (full_day_threshold_minutes >= half_day_threshold_minutes)
);
SELECT app.enable_tenant_rls('workforce.shift_type');
SELECT app.add_updated_at_trigger('workforce.shift_type');

CREATE TABLE workforce.shift_assignment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  shift_type_id   uuid NOT NULL REFERENCES workforce.shift_type(id),
  holiday_list_id uuid REFERENCES workforce.holiday_list(id),
  effective_from  date NOT NULL,
  effective_to    date,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_assignment_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
SELECT app.enable_tenant_rls('workforce.shift_assignment');
SELECT app.add_updated_at_trigger('workforce.shift_assignment');
CREATE INDEX idx_shift_assignment_employee
  ON workforce.shift_assignment (tenant_id, employee_id, effective_from DESC);
-- An employee cannot hold two active shift assignments on the same day.
ALTER TABLE workforce.shift_assignment
  ADD CONSTRAINT shift_assignment_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    app.daterange_of(effective_from, effective_to) WITH &&
  ) WHERE (status = 'active');

-- Immutable observed fact. Append-only enforced by trigger, not convention.
CREATE TABLE workforce.employee_checkin (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id       uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  checkin_at        timestamptz NOT NULL,
  direction         text NOT NULL CHECK (direction IN ('in', 'out', 'unknown')),
  source            text NOT NULL CHECK (source IN ('web', 'mobile', 'biometric', 'api', 'import')),
  device_id         text,
  latitude          numeric(9, 6),
  longitude         numeric(9, 6),
  external_event_id text,
  device_recorded_at timestamptz,
  payload           jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('workforce.employee_checkin');
SELECT app.make_append_only('workforce.employee_checkin');
CREATE INDEX idx_checkin_tenant_employee_time
  ON workforce.employee_checkin (tenant_id, employee_id, checkin_at);
-- Device retries and offline batch replays must not create duplicate observations.
CREATE UNIQUE INDEX idx_checkin_external_dedupe
  ON workforce.employee_checkin (tenant_id, employee_id, external_event_id)
  WHERE external_event_id IS NOT NULL;
COMMENT ON TABLE workforce.employee_checkin IS
  'Immutable raw observation. Never corrected in place - corrections live in attendance_correction.';

CREATE TABLE workforce.attendance (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  attendance_date     date NOT NULL,
  shift_assignment_id uuid REFERENCES workforce.shift_assignment(id),
  shift_type_id       uuid REFERENCES workforce.shift_type(id),
  status              text NOT NULL
                        CHECK (status IN ('present', 'absent', 'half_day', 'on_leave', 'weekly_off',
                                          'holiday', 'work_from_home', 'not_marked')),
  first_in_at         timestamptz,
  last_out_at         timestamptz,
  working_minutes     integer NOT NULL DEFAULT 0 CHECK (working_minutes >= 0),
  break_minutes       integer NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  late_minutes        integer NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  early_exit_minutes  integer NOT NULL DEFAULT 0 CHECK (early_exit_minutes >= 0),
  overtime_minutes    integer NOT NULL DEFAULT 0 CHECK (overtime_minutes >= 0),
  lop_units           numeric(5, 2) NOT NULL DEFAULT 0 CHECK (lop_units >= 0),
  leave_application_id uuid,
  has_missing_punch   boolean NOT NULL DEFAULT false,
  is_corrected        boolean NOT NULL DEFAULT false,
  calculation_version text NOT NULL,
  source_checkin_ids  uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  calculated_at       timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_id, attendance_date)
);
SELECT app.enable_tenant_rls('workforce.attendance');
SELECT app.add_updated_at_trigger('workforce.attendance');
CREATE INDEX idx_attendance_tenant_employee_date
  ON workforce.attendance (tenant_id, employee_id, attendance_date);
CREATE INDEX idx_attendance_tenant_date ON workforce.attendance (tenant_id, attendance_date);
COMMENT ON TABLE workforce.attendance IS
  'Derived state. Safe to delete and recompute from employee_checkin + shift + leave + holidays.';

CREATE TABLE workforce.attendance_correction (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id       uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  attendance_date   date NOT NULL,
  attendance_id     uuid REFERENCES workforce.attendance(id),
  requested_by      uuid NOT NULL,
  reason            text NOT NULL,
  proposed_in_at    timestamptz,
  proposed_out_at   timestamptz,
  proposed_status   text,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  workflow_instance_id uuid,
  decided_by        uuid,
  decided_at        timestamptz,
  decision_note     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('workforce.attendance_correction');
SELECT app.add_updated_at_trigger('workforce.attendance_correction');
CREATE INDEX idx_attendance_correction_employee
  ON workforce.attendance_correction (tenant_id, employee_id, attendance_date);
-- Only one open correction request per employee per day.
CREATE UNIQUE INDEX idx_attendance_correction_open
  ON workforce.attendance_correction (tenant_id, employee_id, attendance_date)
  WHERE status = 'pending';
COMMENT ON TABLE workforce.attendance_correction IS
  'Approved corrections re-derive attendance; the original check-ins remain untouched.';
