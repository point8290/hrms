import type { Queryable, TenantTx } from '../db/pool.ts';
import { audit } from '../audit.ts';

/**
 * Storage primitives for `integration.scheduled_job`.
 *
 * Everything here is written to be safe to run from several scheduler instances at once:
 * scheduling is ON CONFLICT DO NOTHING, claiming is FOR UPDATE SKIP LOCKED, and every
 * settle is keyed by job id. Running two schedulers is a supported configuration, not a
 * race — which is what lets the scheduler be deployed as an ordinary replicated service
 * instead of a singleton nobody may restart.
 */

export const DEFAULT_MAX_ATTEMPTS = 5;

/** Presumed-dead threshold for a job left in `running`. */
export const DEFAULT_STALE_AFTER_MINUTES = 30;

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'abandoned';

export type ScheduleRequest = {
  jobType: string;
  /** Business date the job is for, `YYYY-MM-DD`. */
  executionDate: string;
  /** Discriminator within tenant/type/date. Empty string when there is only one per date. */
  jobKey?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  /** Earliest claim time. Defaults to now, i.e. as soon as the next tick runs. */
  availableAt?: Date;
};

export type ClaimedJob = {
  id: string;
  job_type: string;
  execution_date: string;
  job_key: string;
  attempt_count: number;
  max_attempts: number;
  payload: Record<string, unknown>;
  correlation_id: string;
};

/**
 * Creates the rows a tenant is owed.
 *
 * ON CONFLICT DO NOTHING is the whole idempotency story: a date that already has a row —
 * pending, running, completed or abandoned — is left exactly as it is. In particular a
 * completed job is never resurrected by a later sweep, which is what stops a backfill
 * window from re-running work that already succeeded.
 */
export async function scheduleJobs(tx: TenantTx, requests: readonly ScheduleRequest[]): Promise<number> {
  if (requests.length === 0) return 0;

  let created = 0;
  for (const request of requests) {
    const { rowCount } = await tx.query(
      `INSERT INTO integration.scheduled_job
         (tenant_id, job_type, execution_date, job_key, payload, max_attempts, available_at)
       VALUES ($1, $2, $3::date, $4, $5::jsonb, $6, COALESCE($7::timestamptz, now()))
       ON CONFLICT (tenant_id, job_type, execution_date, job_key) DO NOTHING`,
      [
        tx.tenantId,
        request.jobType,
        request.executionDate,
        request.jobKey ?? '',
        JSON.stringify(request.payload ?? {}),
        request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        request.availableAt ?? null,
      ],
    );
    created += rowCount ?? 0;
  }
  return created;
}

/**
 * Claims jobs that are ready to run.
 *
 * The status moves to `running`, the attempt is counted and a fresh correlation id is
 * stamped — all before the caller does anything with the job, and all in the caller's
 * transaction. A crash between the claim and the dispatch therefore leaves a `running` row
 * the stale sweep can find, rather than work nobody is tracking.
 *
 * `available_at` is pushed forward by the stale window at claim time too, so a job whose
 * dispatch commits but whose execution never lands cannot be claimed again until the same
 * moment the stale sweep would have reclaimed it.
 */
export async function claimDueJobs(
  tx: TenantTx,
  input: { jobTypes: readonly string[]; limit: number; staleAfterMinutes?: number },
): Promise<ClaimedJob[]> {
  const stale = input.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES;

  const { rows } = await tx.query<ClaimedJob>(
    // The CTE form, not `WHERE id IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)`. The
    // `IN` form is the more familiar one and it is wrong here: with a locking subquery the
    // planner is free to evaluate it more than once, and it was observed claiming two jobs
    // for a LIMIT of one. A caller that then handles only the first silently strands the
    // other in `running` until the stale sweep finds it. Joining against the CTE makes the
    // claim set what it says it is.
    `WITH due AS (
        SELECT id FROM integration.scheduled_job
         WHERE tenant_id = $1
           AND job_type = ANY($2::text[])
           AND status IN ('pending', 'failed')
           AND available_at <= now()
           AND attempt_count < max_attempts
         ORDER BY execution_date, job_type
         LIMIT $3
         FOR UPDATE SKIP LOCKED
     )
     UPDATE integration.scheduled_job j
        SET status = 'running',
            attempt_count = j.attempt_count + 1,
            started_at = now(),
            correlation_id = gen_random_uuid(),
            available_at = now() + make_interval(mins => $4)
       FROM due
      WHERE j.id = due.id
      RETURNING j.id, j.job_type,
                to_char(j.execution_date, 'YYYY-MM-DD') AS execution_date,
                j.job_key, j.attempt_count, j.max_attempts, j.payload, j.correlation_id`,
    [tx.tenantId, [...input.jobTypes], input.limit, stale],
  );
  return rows;
}

/** Marks a job finished. Safe to call from a different process than the one that claimed it. */
export async function completeJob(
  tx: TenantTx,
  jobId: string,
  result: Record<string, unknown> = {},
): Promise<void> {
  await tx.query(
    `UPDATE integration.scheduled_job
        SET status = 'completed', completed_at = now(), last_error = NULL, result = $3::jsonb
      WHERE tenant_id = $1 AND id = $2 AND status <> 'completed'`,
    [tx.tenantId, jobId, JSON.stringify(result)],
  );
}

/**
 * Records a failed attempt and schedules the retry.
 *
 * `attemptCount` is written rather than incremented, and comes from the claim. A job is
 * executed inside its claiming transaction, so a failure usually rolls that claim back and
 * the increment with it; writing the claimed value makes the recorded attempt correct
 * whether the failure rolled back or not. Incrementing here instead would let a job whose
 * executor always throws retry forever, because the attempt would never stick.
 *
 * Backoff is exponential and capped, so a job failing for a structural reason stops
 * consuming a scheduler slot every tick while a job failing transiently still recovers
 * quickly. The cap matters more than the curve: an hour is short enough that a tenant-day
 * still closes the same night.
 */
export async function failJob(
  tx: TenantTx,
  jobId: string,
  error: string,
  attemptCount: number,
): Promise<void> {
  await tx.query(
    `UPDATE integration.scheduled_job
        SET status = 'failed',
            last_error = $3,
            attempt_count = GREATEST(attempt_count, $4),
            available_at = now() + make_interval(mins => LEAST(power(2, GREATEST(attempt_count, $4))::int, 60))
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, jobId, error.slice(0, 2000), attemptCount],
  );
}

/**
 * Returns jobs stuck in `running` to the queue.
 *
 * A worker killed mid-job leaves the row claimed. Without this the tenant-day would never
 * be retried and the gap would persist silently — for attendance close that costs an
 * employee LOP accuracy, which is the exact failure the scheduling ledger exists to prevent.
 */
export async function reclaimStaleJobs(
  tx: TenantTx,
  input: { jobTypes: readonly string[]; staleAfterMinutes?: number },
): Promise<number> {
  const { rowCount } = await tx.query(
    `UPDATE integration.scheduled_job
        SET status = 'failed',
            last_error = 'job did not report an outcome; reclaimed as stale',
            available_at = now()
      WHERE tenant_id = $1
        AND job_type = ANY($2::text[])
        AND status = 'running'
        AND started_at < now() - make_interval(mins => $3)`,
    [tx.tenantId, [...input.jobTypes], input.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES],
  );
  return rowCount ?? 0;
}

/**
 * Parks jobs that exhausted their attempts, and says so in the audit trail.
 *
 * Abandonment is not a quiet state. It means a tenant-day will never be evaluated without
 * someone looking at it, so it is recorded as an auditable event carrying
 * `requires_operator_attention` rather than only appearing in a log line that scrolls away.
 */
export async function abandonExhaustedJobs(
  tx: TenantTx,
  jobTypes: readonly string[],
): Promise<Array<{ job_type: string; execution_date: string; last_error: string | null }>> {
  const { rows } = await tx.query<{ job_type: string; execution_date: string; last_error: string | null }>(
    `UPDATE integration.scheduled_job
        SET status = 'abandoned'
      WHERE tenant_id = $1
        AND job_type = ANY($2::text[])
        AND status = 'failed'
        AND attempt_count >= max_attempts
      RETURNING job_type, to_char(execution_date, 'YYYY-MM-DD') AS execution_date, last_error`,
    [tx.tenantId, [...jobTypes]],
  );

  if (rows.length > 0) {
    await audit(tx, {
      entityType: 'scheduled_job',
      action: 'scheduled_job.abandoned',
      after: {
        jobs: rows.map((r) => `${r.job_type}@${r.execution_date}`),
        last_error: rows[0]?.last_error ?? null,
      },
      metadata: { requires_operator_attention: true },
    });
  }

  return rows;
}

export type TenantClock = {
  tenant_id: string;
  timezone: string;
  /** Today's date in the tenant's own timezone. */
  local_date: string;
  /** Latest business date whose attendance may now be closed. */
  close_through: string;
  /** The tenant's first day, in its own timezone. Nothing is ever scheduled before it. */
  created_date: string;
  fy_start_month: number;
};

/**
 * Every active tenant's local calendar position.
 *
 * Date arithmetic is done in PostgreSQL rather than JavaScript on purpose: `now() AT TIME
 * ZONE tenant.timezone` is correct across DST transitions and does not depend on the
 * process locale, and getting it wrong means closing a day that is not over yet.
 *
 * This is the one genuinely cross-tenant read in scheduling, so it runs on the platform
 * connection; every decision that follows runs inside that tenant's own transaction.
 */
export async function tenantClocks(tx: Queryable): Promise<TenantClock[]> {
  const { rows } = await tx.query<TenantClock>(
    `SELECT t.id AS tenant_id,
            t.timezone,
            t.fy_start_month,
            to_char((now() AT TIME ZONE t.timezone)::date, 'YYYY-MM-DD') AS local_date,
            -- A date D is closable once local time reaches D+1 at the cutoff hour.
            -- Subtracting the cutoff before taking the date is what encodes that: at 01:00
            -- local with a 02:00 cutoff, yesterday is still open.
            to_char(
              (((now() AT TIME ZONE t.timezone) - make_interval(hours => t.attendance_close_hour))::date
                - INTERVAL '1 day')::date,
              'YYYY-MM-DD'
            ) AS close_through,
            to_char((t.created_at AT TIME ZONE t.timezone)::date, 'YYYY-MM-DD') AS created_date
       FROM identity.tenant t
      WHERE t.status = 'active'
      ORDER BY t.id`,
  );
  return rows;
}
