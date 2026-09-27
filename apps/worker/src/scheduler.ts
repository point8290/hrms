import { registerAllJobs, runSchedulerTick, type SchedulerReport } from '@hrms/api/src/infra/scheduler/index.ts';
import { withSpan } from '@hrms/api/src/infra/telemetry.ts';

/**
 * The scheduler loop.
 *
 * Polls rather than firing at a fixed wall-clock time, because "the period is over" happens
 * at a different instant for every tenant timezone. Each tick asks which tenants have passed
 * their own cutoff, so a tenant in Asia/Kolkata and one in America/New_York are both handled
 * correctly without per-timezone cron entries — and a missed tick is caught up by the next
 * one instead of needing a manual re-run.
 *
 * Every tick is safe to repeat and safe to run concurrently: scheduling is ON CONFLICT DO
 * NOTHING, claiming is FOR UPDATE SKIP LOCKED, and executors are idempotent. Two scheduler
 * instances is a supported configuration, which is what makes this an ordinary replicated
 * process rather than a singleton that must never be restarted twice.
 */

const DEFAULT_INTERVAL_MS = 5 * 60_000;

export type SchedulerOptions = {
  signal: AbortSignal;
  intervalMs?: number;
  backfillDays?: number;
  log: (msg: string, meta?: Record<string, unknown>) => void;
  logError: (msg: string, meta?: Record<string, unknown>) => void;
};

export async function runScheduler(options: SchedulerOptions): Promise<void> {
  const interval = options.intervalMs ?? Number(process.env.SCHEDULER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const backfillDays = options.backfillDays ?? Number(process.env.SCHEDULER_BACKFILL_DAYS ?? 7);

  registerAllJobs();
  options.log('scheduler started', { interval_ms: interval, backfill_days: backfillDays });

  while (!options.signal.aborted) {
    try {
      // One span per tick, not per job: a tick that does nothing is the common case, and a
      // span for every idle tenant would drown the traces that matter. Each job's own work
      // lands in the events it emits, which carry this trace forward.
      const report: SchedulerReport = await withSpan(
        'scheduler.tick',
        { component: 'scheduler' },
        () =>
          runSchedulerTick({
            backfillDays,
            onError: (context, err) => {
              // One tenant's failure must not stop every other tenant's jobs from running.
              options.logError('scheduled job failed', { ...context, err: String(err) });
            },
          }),
      );

      if (
        report.jobsCreated > 0 || report.jobsExecuted > 0 || report.jobsDispatched > 0 ||
        report.jobsFailed > 0 || report.staleReclaimed > 0 || report.abandoned > 0
      ) {
        options.log('scheduler tick', { ...report });
      }
      if (report.abandoned > 0) {
        // Abandoned means a tenant-period will never be evaluated without intervention. For
        // attendance close that silently costs employees LOP accuracy, so say it loudly.
        options.logError('scheduled jobs abandoned after max attempts', {
          count: report.abandoned,
          action: 'investigate the tenant data, then reset the job to pending',
        });
      }
    } catch (err) {
      options.logError('scheduler tick failed', { err: String(err) });
    }

    await sleep(interval, options.signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
