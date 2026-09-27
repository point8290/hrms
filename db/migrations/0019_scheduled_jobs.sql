-- 0019 generic scheduled jobs.
--
-- Attendance close was the first job that had to be scheduled per tenant, retried with
-- backoff, recovered when a worker died mid-run and abandoned loudly when it could not
-- succeed. `workforce.attendance_close_run` carried all of that machinery, and it was about
-- to be copied wholesale for leave accrual and carry-forward.
--
-- Copying it would have been the wrong trade. The machinery is not attendance-specific:
-- what is attendance-specific is the payload and what the job does. So the machinery moves
-- here once, and each job type contributes only its own payload and executor.
--
-- Deliberately NOT a general task queue. It schedules work that is keyed by a tenant and a
-- date, must happen exactly once per key, and must be explainable afterwards. Ad-hoc,
-- fan-out and high-rate work belongs on SQS, which is where the dispatched jobs go.

CREATE TABLE integration.scheduled_job (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,

  -- Dotted namespace, e.g. 'attendance.close', 'leave.accrual'. Matched to an executor in
  -- code; an unknown job_type is left pending rather than being invented a meaning for.
  job_type        text NOT NULL CHECK (job_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),

  -- The business date the job is *for*, not when it runs. An attendance close for the 3rd
  -- that runs on the 4th is still the 3rd's close, and rerunning it must not shift it.
  execution_date  date NOT NULL,

  -- Discriminator within a tenant/type/date, for jobs that are per leave type or per
  -- period rather than one-per-day. Empty string rather than NULL on purpose: a NULL in a
  -- unique key is distinct from every other NULL, so the constraint would silently stop
  -- constraining exactly the tenant-wide case it most needs to cover.
  job_key         text NOT NULL DEFAULT '',

  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'abandoned')),
  attempt_count   integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts    integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),

  -- When this job may next be claimed. Backoff is a write to this column, so a failing job
  -- stops being polled instead of spinning.
  available_at    timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  completed_at    timestamptz,

  last_error      text,
  -- Ties every log line, audit row and event for one attempt together across the Node
  -- scheduler, SQS and the Python engine.
  correlation_id  uuid,

  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  result          jsonb NOT NULL DEFAULT '{}'::jsonb,

  scheduled_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, job_type, execution_date, job_key)
);

SELECT app.enable_tenant_rls('integration.scheduled_job');
SELECT app.add_updated_at_trigger('integration.scheduled_job');

-- The dispatch sweep's only predicate. Partial so the index stays small once most rows
-- are completed, which is the steady state.
CREATE INDEX idx_scheduled_job_claimable
  ON integration.scheduled_job (available_at, job_type)
  WHERE status IN ('pending', 'failed');

-- The stale sweep.
CREATE INDEX idx_scheduled_job_running
  ON integration.scheduled_job (started_at)
  WHERE status = 'running';

CREATE INDEX idx_scheduled_job_tenant_type_date
  ON integration.scheduled_job (tenant_id, job_type, execution_date DESC);

COMMENT ON TABLE integration.scheduled_job IS
  'One row per tenant per job type per business date. The record that the job was scheduled, attempted and settled.';

-- ---------------------------------------------------------------------------
-- Move attendance close onto it.
--
-- Backfilled rather than restarted: the existing rows are the evidence that a day was
-- closed, and payroll refuses to run over a day with no such evidence. Dropping them would
-- block every tenant's next payroll run until the whole period had been closed again.
-- ---------------------------------------------------------------------------

INSERT INTO integration.scheduled_job
  (id, tenant_id, job_type, execution_date, job_key, status, attempt_count,
   available_at, started_at, completed_at, last_error, payload, result, scheduled_at, created_at)
SELECT r.id,
       r.tenant_id,
       'attendance.close',
       r.business_date,
       '',
       r.status,
       r.attempt_count,
       r.next_attempt_at,
       r.started_at,
       r.completed_at,
       r.last_error,
       jsonb_build_object('timezone', r.timezone),
       CASE WHEN r.employee_count IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('employee_count', r.employee_count) END,
       r.scheduled_at,
       r.created_at
  FROM workforce.attendance_close_run r;

-- Same signature as before, so payroll's completeness guard is untouched.
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
    SELECT j.execution_date AS business_date
      FROM integration.scheduled_job j
     WHERE j.tenant_id = p_tenant_id
       AND j.job_type = 'attendance.close'
       AND j.status = 'completed'
       AND j.execution_date BETWEEN p_from AND p_to
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

DROP TABLE workforce.attendance_close_run;
