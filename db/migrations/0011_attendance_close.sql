-- 0011 scheduled attendance close.
--
-- ADR-007 made the daily close the only path that may record an absence. The job existed
-- but nothing drove it, so absences were never recorded and payroll silently under-reported
-- LOP. This table is the scheduling ledger that closes that gap.
--
-- It carries three jobs at once:
--   * idempotency  - UNIQUE (tenant_id, business_date) means a date can only be closed once,
--                    however many scheduler instances or redelivered messages there are
--   * concurrency  - the row is locked FOR UPDATE while a close runs, so two workers cannot
--                    process the same tenant-day
--   * observability - status, attempts and errors are queryable, so "did attendance close
--                    last night?" has an answer that is not a log search

CREATE TABLE workforce.attendance_close_run (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  business_date  date NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'running', 'completed', 'failed', 'abandoned')),
  attempt_count  integer NOT NULL DEFAULT 0,
  employee_count integer,
  last_error     text,
  -- Recorded so a close can be explained later: which timezone decided this business date.
  timezone       text NOT NULL,
  scheduled_at   timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, business_date)
);
SELECT app.enable_tenant_rls('workforce.attendance_close_run');
SELECT app.add_updated_at_trigger('workforce.attendance_close_run');

CREATE INDEX idx_attendance_close_due
  ON workforce.attendance_close_run (next_attempt_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX idx_attendance_close_tenant_date
  ON workforce.attendance_close_run (tenant_id, business_date DESC);

COMMENT ON TABLE workforce.attendance_close_run IS
  'One row per tenant per business date. The record that attendance for that day was evaluated.';

-- Answers "is attendance complete for this period?" without the caller reimplementing the
-- date arithmetic. Payroll uses it to refuse a run built on unevaluated days.
CREATE OR REPLACE FUNCTION workforce.attendance_close_coverage(
  p_tenant_id uuid,
  p_from date,
  p_to date
)
RETURNS TABLE (expected_days integer, closed_days integer, missing_dates date[])
LANGUAGE sql
STABLE
AS $$
  WITH expected AS (
    SELECT generate_series(p_from, p_to, INTERVAL '1 day')::date AS business_date
  ),
  closed AS (
    SELECT r.business_date
      FROM workforce.attendance_close_run r
     WHERE r.tenant_id = p_tenant_id
       AND r.status = 'completed'
       AND r.business_date BETWEEN p_from AND p_to
  )
  SELECT (SELECT count(*) FROM expected)::integer,
         (SELECT count(*) FROM closed)::integer,
         COALESCE(
           ARRAY(
             SELECT e.business_date FROM expected e
              WHERE NOT EXISTS (SELECT 1 FROM closed c WHERE c.business_date = e.business_date)
              ORDER BY e.business_date
           ),
           ARRAY[]::date[]
         );
$$;

-- Tenant configuration for when a day is considered over.
-- Local midnight is deliberately not the default: a late checkout or an overnight shift
-- would otherwise be missed by a close that ran the instant the date rolled.
ALTER TABLE identity.tenant
  ADD COLUMN attendance_close_hour smallint NOT NULL DEFAULT 2
    CHECK (attendance_close_hour BETWEEN 0 AND 23);

COMMENT ON COLUMN identity.tenant.attendance_close_hour IS
  'Local hour after which the previous business date may be closed. Default 02:00.';
