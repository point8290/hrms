import { SYSTEM_ACTOR, withPlatform, withTenant, type TenantTx } from '../db/pool.ts';
import {
  abandonExhaustedJobs,
  claimDueJobs,
  completeJob,
  failJob,
  reclaimStaleJobs,
  scheduleJobs,
  tenantClocks,
  type ClaimedJob,
  type ScheduleRequest,
  type TenantClock,
  DEFAULT_STALE_AFTER_MINUTES,
} from './jobs.ts';

/**
 * The scheduler tick: plan, claim, execute, settle — for every job type, for every tenant.
 *
 * This is the part that used to be attendance-specific. Nothing here knows what a job
 * *does*; a job type contributes a `plan` (what does this tenant owe, given its own clock)
 * and an `execute` (do it, or hand it to someone who will). Everything else — idempotent
 * scheduling, claiming, attempt counting, backoff, stale recovery, abandonment and the
 * audit trail — is shared, so a new periodic job cannot accidentally ship without them.
 */

export type JobOutcome =
  /** Finished here and now. Settles inside the executing transaction. */
  | { mode: 'completed'; result?: Record<string, unknown> }
  /**
   * Handed off — to SQS, to an engine, to anything out of process. The job stays `running`
   * until whoever executes it reports back, and the stale sweep is the safety net if it
   * never does.
   */
  | { mode: 'dispatched' }
  /** Nothing to do after all (configuration changed since planning). Not a failure. */
  | { mode: 'skipped'; reason: string };

export type JobDefinition = {
  jobType: string;
  /**
   * What this tenant owes as of its own local clock. Called every tick; must be pure with
   * respect to scheduling, because inserting is idempotent and re-planning is normal.
   */
  plan(tx: TenantTx, clock: TenantClock, options: PlanOptions): Promise<ScheduleRequest[]>;
  /** Runs inside the job's own transaction, immediately after the claim. */
  execute(tx: TenantTx, job: ClaimedJob, clock: TenantClock): Promise<JobOutcome>;
  staleAfterMinutes?: number;
};

export type PlanOptions = {
  /** How far back a newly-registered job type will fill in, so a tenant is not flooded. */
  backfillDays: number;
};

export type SchedulerReport = {
  tenantsConsidered: number;
  jobsCreated: number;
  jobsExecuted: number;
  jobsDispatched: number;
  jobsFailed: number;
  staleReclaimed: number;
  abandoned: number;
};

const registry = new Map<string, JobDefinition>();

export function registerJob(definition: JobDefinition): void {
  registry.set(definition.jobType, definition);
}

export function registeredJobTypes(): string[] {
  return [...registry.keys()];
}

/** Test seam: drop registrations so a test can drive one job type in isolation. */
export function clearJobRegistry(): void {
  registry.clear();
}

export type TickOptions = {
  backfillDays?: number;
  /** Jobs executed per tenant per tick. Bounds one tenant's share of a scheduler pass. */
  perTenantLimit?: number;
  jobTypes?: readonly string[];
  onError?: (context: { tenantId: string; jobType?: string; jobId?: string }, err: unknown) => void;
};

/**
 * One scheduler pass across every active tenant.
 *
 * Tenant enumeration is the only cross-tenant step. Everything after it runs inside that
 * tenant's own transaction under RLS, exactly as a request would — a scheduled job is not
 * a reason to widen the isolation boundary.
 *
 * A failure for one tenant, or one job, is recorded and skipped. One misconfigured tenant
 * must not stop every other tenant's day from closing.
 */
export async function runSchedulerTick(options: TickOptions = {}): Promise<SchedulerReport> {
  const backfillDays = options.backfillDays ?? 7;
  const perTenantLimit = options.perTenantLimit ?? 20;
  const jobTypes = options.jobTypes ?? registeredJobTypes();
  const definitions = jobTypes.map((t) => registry.get(t)).filter((d): d is JobDefinition => d !== undefined);

  const report: SchedulerReport = {
    tenantsConsidered: 0,
    jobsCreated: 0,
    jobsExecuted: 0,
    jobsDispatched: 0,
    jobsFailed: 0,
    staleReclaimed: 0,
    abandoned: 0,
  };
  if (definitions.length === 0) return report;

  const types = definitions.map((d) => d.jobType);
  const staleAfter = Math.min(
    ...definitions.map((d) => d.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES),
  );

  const clocks = await withPlatform('maintenance', (tx) => tenantClocks(tx));
  report.tenantsConsidered = clocks.length;

  for (const clock of clocks) {
    const actor = { ...SYSTEM_ACTOR, label: 'scheduler' };

    // Pass 1 — maintenance and planning. One transaction: these are all cheap writes, and
    // committing them together means a tenant is never left half-planned.
    try {
      await withTenant(clock.tenant_id, actor, async (tx) => {
        report.staleReclaimed += await reclaimStaleJobs(tx, { jobTypes: types, staleAfterMinutes: staleAfter });
        report.abandoned += (await abandonExhaustedJobs(tx, types)).length;

        for (const definition of definitions) {
          const requests = await definition.plan(tx, clock, { backfillDays });
          report.jobsCreated += await scheduleJobs(tx, requests);
        }
      });
    } catch (err) {
      options.onError?.({ tenantId: clock.tenant_id }, err);
      continue;
    }

    // Pass 2 — execute. One transaction per claim, on purpose: the claim and the work
    // commit together, so a crash mid-job rolls the claim back rather than leaving work
    // nobody will retry, and one tenant's bad data cannot roll back another's job.
    for (let pass = 0; pass < perTenantLimit; pass += 1) {
      let claimed: ClaimedJob[] = [];
      try {
        const done = await withTenant(clock.tenant_id, actor, async (tx) => {
          claimed = await claimDueJobs(tx, { jobTypes: types, limit: 1, staleAfterMinutes: staleAfter });
          if (claimed.length === 0) return true;

          // Normally one. Every claimed job is executed even if the database returns more
          // than the limit asked for: a claim that is taken but not run leaves the job in
          // `running` with nobody working on it, invisible until the stale sweep.
          for (const job of claimed) {
            const definition = registry.get(job.job_type);
            if (!definition) {
              // Registered types were the query filter, so this is unreachable in practice.
              // Leaving the job `running` would hide it; fail it so the sweep surfaces it.
              throw new Error(`no executor registered for job type "${job.job_type}"`);
            }

            const outcome = await definition.execute(tx, job, clock);
            if (outcome.mode === 'completed') {
              await completeJob(tx, job.id, outcome.result ?? {});
              report.jobsExecuted += 1;
            } else if (outcome.mode === 'skipped') {
              await completeJob(tx, job.id, { skipped: true, reason: outcome.reason });
            } else {
              report.jobsDispatched += 1;
            }
          }
          return false;
        });
        if (done) break;
      } catch (err) {
        report.jobsFailed += 1;
        options.onError?.(
          { tenantId: clock.tenant_id, jobType: claimed[0]?.job_type, jobId: claimed[0]?.id },
          err,
        );

        // The executing transaction rolled back, taking the attempt increment with it.
        // Record the failure in its own transaction so the job backs off instead of being
        // retried on every tick for ever.
        const failed = claimed;
        if (failed.length > 0) {
          try {
            await withTenant(clock.tenant_id, actor, async (tx) => {
              for (const job of failed) {
                await failJob(tx, job.id, err instanceof Error ? err.message : String(err), job.attempt_count);
              }
            });
          } catch (settleErr) {
            options.onError?.({ tenantId: clock.tenant_id }, settleErr);
          }
        }
      }
    }
  }

  return report;
}
