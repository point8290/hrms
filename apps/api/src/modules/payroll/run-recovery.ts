import type { TenantTx } from '../../infra/db/pool.ts';
import { audit } from '../../infra/audit.ts';
import { conflict, notFound } from '../../infra/errors.ts';
import type { ClaimedJob, ScheduleRequest, TenantClock } from '../../infra/scheduler/jobs.ts';
import type { JobDefinition, JobOutcome } from '../../infra/scheduler/registry.ts';

/**
 * Recovery for a payroll run whose calculation stalled.
 *
 * `calculating -> cancelled` is illegal and stays illegal: a run must not be cancelled out
 * from under an engine that may be halfway through four thousand employees. The problem was
 * never the transition, it was that nobody noticed. A run that stopped making progress sat
 * in `calculating` until a person happened to look, and the period it occupied could not be
 * re-run because of the one-live-regular-run constraint.
 *
 * So the run records when it last made progress, and this sweep moves one that has made
 * none for long enough into `failed` — where the existing retry path already applies, and
 * where an operator can see it.
 *
 * Two things stop this from ever killing a live run, and the second is the one that matters:
 *
 *   1. The threshold is long, and every state transition restarts the clock.
 *   2. **The engine holds `FOR UPDATE` on the run row for its whole transaction.** Recovery
 *      takes the same lock, so a sweep that arrives while the engine is working blocks until
 *      the engine commits, and then re-reads a run that is no longer `calculating` and
 *      declines to touch it. The database decides, not the timeout.
 *
 * Recovery is therefore the last line, behind SQS redelivery: a consumer that dies rolls its
 * transaction back — including its `processed_event` claim — so the message is redelivered
 * and retried first. This catches what is left, the run whose message is gone for good.
 */

export const PAYROLL_RECOVERY_JOB = 'payroll.recover_stalled';

/**
 * How long a run may make no progress before it is presumed dead.
 *
 * Deliberately generous, and longer than the SQS visibility timeout and redelivery budget
 * put together — otherwise this would compete with the retry that is already under way.
 * Four thousand employees calculate in about thirty seconds, so nothing healthy is anywhere
 * near this; it is sized for the message that is never coming back.
 */
export const STALL_THRESHOLD_MINUTES = 45;

/**
 * Attempts before a run stops being retried automatically.
 *
 * A run that has stalled three times is not suffering bad luck; something about its data or
 * its configuration is stopping it, and continuing to retry hides that. It stays `failed`
 * with the reason recorded, and a person decides.
 */
export const MAX_CALCULATION_ATTEMPTS = 3;

export type StalledRun = {
  id: string;
  status: string;
  calculation_attempts: number;
  minutes_stalled: number;
};

/** Runs that have made no progress for longer than the threshold. */
export async function findStalledRuns(
  tx: TenantTx,
  thresholdMinutes = STALL_THRESHOLD_MINUTES,
): Promise<StalledRun[]> {
  const { rows } = await tx.query<StalledRun>(
    `SELECT id, status, calculation_attempts,
            EXTRACT(EPOCH FROM (now() - last_progress_at))::int / 60 AS minutes_stalled
       FROM payroll.payroll_run
      WHERE tenant_id = $1
        AND status IN ('validating', 'calculating')
        AND last_progress_at < now() - make_interval(mins => $2)
      ORDER BY last_progress_at`,
    [tx.tenantId, thresholdMinutes],
  );
  return rows;
}

export type RecoveryOutcome = {
  runId: string;
  recovered: boolean;
  exhausted: boolean;
  reason: string;
};

/**
 * Moves one stalled run to `failed`.
 *
 * Idempotent and safe to race: the row is locked, and the status is re-checked under that
 * lock. A second worker, or an operator pressing the button at the same moment, finds the
 * run already recovered and reports that rather than recovering it twice — which would
 * double-count the attempt and could push a healthy run past its retry limit.
 */
export async function recoverRun(
  tx: TenantTx,
  runId: string,
  options: { thresholdMinutes?: number; force?: boolean } = {},
): Promise<RecoveryOutcome> {
  const threshold = options.thresholdMinutes ?? STALL_THRESHOLD_MINUTES;

  const { rows } = await tx.query<{
    status: string;
    calculation_attempts: number;
    minutes_stalled: number | null;
  }>(
    `SELECT status, calculation_attempts,
            EXTRACT(EPOCH FROM (now() - last_progress_at))::int / 60 AS minutes_stalled
       FROM payroll.payroll_run
      WHERE tenant_id = $1 AND id = $2
      FOR UPDATE`,
    [tx.tenantId, runId],
  );
  const run = rows[0];
  if (!run) throw notFound('Payroll run');

  // Already recovered, or never stalled. Either way there is nothing to do, and saying so
  // is the idempotent answer rather than an error.
  if (!['validating', 'calculating'].includes(run.status)) {
    return {
      runId,
      recovered: false,
      exhausted: false,
      reason: `run is ${run.status}; only a run still waiting on the engine can be recovered`,
    };
  }

  const stalled = run.minutes_stalled ?? 0;
  if (!options.force && stalled < threshold) {
    // Refusing is the point: a scheduler that recovered on sight would kill live payroll.
    throw conflict(
      'run_not_stalled',
      `This run last made progress ${stalled} minute(s) ago, under the ${threshold}-minute `
        + 'threshold. It may still be calculating.',
      { minutes_stalled: stalled, threshold_minutes: threshold },
    );
  }

  const attempts = run.calculation_attempts + 1;
  const exhausted = attempts >= MAX_CALCULATION_ATTEMPTS;
  const reason = exhausted
    ? `calculation stalled for ${stalled} minute(s) after ${attempts} attempt(s); no further automatic retry`
    : `calculation stalled for ${stalled} minute(s); recovered for retry`;

  await tx.query(
    `UPDATE payroll.payroll_run
        SET status = 'failed',
            failure_reason = $3,
            calculation_attempts = $4,
            recovered_at = now(),
            recovery_reason = $3
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, runId, reason.slice(0, 1000), attempts],
  );

  await audit(tx, {
    entityType: 'payroll_run',
    entityId: runId,
    action: 'payroll.run.recovered',
    before: { status: run.status, calculation_attempts: run.calculation_attempts },
    after: {
      status: 'failed',
      calculation_attempts: attempts,
      minutes_stalled: stalled,
      reason,
      retryable: !exhausted,
    },
    // Someone has to decide whether to retry, and if the attempts are spent, why it keeps
    // stalling. A log line would scroll away.
    metadata: { requires_operator_attention: true },
  });

  return { runId, recovered: true, exhausted, reason };
}

/**
 * The scheduled sweep.
 *
 * Runs through the existing job framework rather than a bespoke loop, so it inherits
 * per-tenant isolation, claiming, retry and the audit row that says it was abandoned — and
 * so a new periodic job cannot ship without them (ADR-011).
 */
export const payrollRecoveryJob: JobDefinition = {
  jobType: PAYROLL_RECOVERY_JOB,

  async plan(_tx: TenantTx, clock: TenantClock): Promise<ScheduleRequest[]> {
    // One sweep per tenant per local day. A stalled run is not urgent to the minute — the
    // period is already late — and a per-tick sweep would be noise.
    return [{ jobType: PAYROLL_RECOVERY_JOB, executionDate: clock.local_date }];
  },

  async execute(tx: TenantTx, _job: ClaimedJob): Promise<JobOutcome> {
    const stalled = await findStalledRuns(tx);
    if (stalled.length === 0) {
      return { mode: 'completed', result: { stalled: 0 } };
    }

    const outcomes: RecoveryOutcome[] = [];
    for (const run of stalled) {
      outcomes.push(await recoverRun(tx, run.id));
    }

    return {
      mode: 'completed',
      result: {
        stalled: stalled.length,
        recovered: outcomes.filter((o) => o.recovered).length,
        exhausted: outcomes.filter((o) => o.exhausted).length,
        runs: outcomes.map((o) => o.runId),
      },
    };
  },
};
