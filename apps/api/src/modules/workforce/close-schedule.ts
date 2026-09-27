import type { TenantTx } from '../../infra/db/pool.ts';
import { emitEvent } from '../../infra/events/outbox.ts';
import type { ClaimedJob, ScheduleRequest, TenantClock } from '../../infra/scheduler/jobs.ts';
import type { JobDefinition, JobOutcome, PlanOptions } from '../../infra/scheduler/registry.ts';

/**
 * The daily attendance close, as a scheduled job (ADR-007).
 *
 * The close itself is Python's job — it derives attendance. Deciding *when* a tenant's day
 * is over is a platform concern, and all of the machinery around that decision (idempotent
 * scheduling, claiming, retries, stale recovery, abandonment) now lives in
 * `infra/scheduler`. What is left here is only what is attendance-specific: which dates a
 * tenant owes, and what to send when one comes due.
 */

export const ATTENDANCE_CLOSE_JOB = 'attendance.close';

/** How far back a newly-scheduled tenant will backfill, so a new tenant is not flooded. */
export const DEFAULT_BACKFILL_DAYS = 7;

/**
 * The business dates this tenant owes a close for.
 *
 * Bounded at both ends: never before the tenant existed, and never further back than the
 * backfill window. Re-planning every tick is free because scheduling is ON CONFLICT DO
 * NOTHING — a date that was already closed stays closed.
 */
export function plannedCloseDates(clock: TenantClock, backfillDays: number): string[] {
  const from = maxDate(clock.created_date, addDays(clock.local_date, -backfillDays));
  if (from > clock.close_through) return [];

  const dates: string[] = [];
  for (let d = from; d <= clock.close_through; d = addDays(d, 1)) dates.push(d);
  return dates;
}

export const attendanceCloseJob: JobDefinition = {
  jobType: ATTENDANCE_CLOSE_JOB,

  async plan(_tx: TenantTx, clock: TenantClock, options: PlanOptions): Promise<ScheduleRequest[]> {
    return plannedCloseDates(clock, options.backfillDays).map((date) => ({
      jobType: ATTENDANCE_CLOSE_JOB,
      executionDate: date,
      payload: { timezone: clock.timezone },
    }));
  },

  /**
   * Hands the day to the workforce engine.
   *
   * The event is emitted to the outbox inside the claiming transaction, so the claim and
   * the intent to run commit together: there is no window in which a job is marked running
   * but no message will ever be produced, and none in which a message exists for a job
   * that was never claimed.
   *
   * The job stays `running` until the engine reports back. If the engine never does, the
   * stale sweep reclaims it and the next tick tries again.
   */
  async execute(tx: TenantTx, job: ClaimedJob): Promise<JobOutcome> {
    await emitEvent(tx, 'AttendanceCloseRequested', {
      aggregateType: 'scheduled_job',
      aggregateId: job.id,
      correlationId: job.correlation_id,
      payload: {
        close_run_id: job.id,
        business_date: job.execution_date,
        attempt: job.attempt_count,
      },
    });
    return { mode: 'dispatched' };
  },
};

export type CloseCoverage = {
  expected_days: number;
  closed_days: number;
  missing_dates: string[];
  complete: boolean;
};

/**
 * Whether attendance has been closed for every day in a period.
 *
 * Payroll calls this before freezing a snapshot. Attendance that was never evaluated is not
 * the same as attendance that was evaluated and found empty, and paying on the former is
 * how an employee silently loses LOP days.
 */
export async function closeCoverage(
  tx: TenantTx,
  from: string,
  to: string,
): Promise<CloseCoverage> {
  const { rows } = await tx.query<{
    expected_days: number;
    closed_days: number;
    missing_dates: string[];
  }>(
    `SELECT expected_days, closed_days,
            ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(missing_dates) AS d) AS missing_dates
       FROM workforce.attendance_close_coverage($1, $2::date, $3::date)`,
    [tx.tenantId, from, to],
  );

  const row = rows[0] ?? { expected_days: 0, closed_days: 0, missing_dates: [] };
  return { ...row, complete: row.missing_dates.length === 0 };
}

/** `YYYY-MM-DD` arithmetic in UTC, so it never drifts with the process timezone. */
function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}
