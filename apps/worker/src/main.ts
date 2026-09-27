import { pathToFileURL } from 'node:url';
import { config } from '@hrms/api/src/config.ts';
import { closePools, withPlatform } from '@hrms/api/src/infra/db/pool.ts';
import { closeRedis } from '@hrms/api/src/infra/redis.ts';
import { initTelemetry } from '@hrms/api/src/infra/telemetry.ts';
import { CONSUMER_NAME } from './handlers.ts';
import { runConsumer } from './consumer.ts';
import { dispatchNotifications, reclaimStuckNotifications } from './notifications.ts';
import { runPublisher } from './publisher.ts';
import { runScheduler } from './scheduler.ts';

/**
 * Background worker.
 *
 * One binary, four roles — `publisher`, `consumer`, `notifications`, `scheduler` — selected
 * by `WORKER_ROLES` and all enabled by default.
 *
 * The roles are separable because they have genuinely different failure and scaling
 * profiles. Job execution wants many replicas and is the thing that falls over under load;
 * scheduling wants to keep ticking precisely when that happens. Running them in one process
 * made the schedule an accidental casualty of a busy consumer — deploy the API without a
 * worker, or saturate the worker, and days silently stopped closing.
 *
 * They are separable, not separate: one deployment with every role is still the default and
 * still correct, because every loop is safe to run in several instances at once. Splitting
 * is a deployment decision (`WORKER_ROLES=scheduler` alongside `WORKER_ROLES=consumer`), not
 * a code change — which is the version of "Scheduler → SQS → Workers" that does not cost a
 * fourth service to operate before anyone needs one (ADR-010).
 */

const ALL_ROLES = ['publisher', 'consumer', 'notifications', 'scheduler'] as const;
export type WorkerRole = (typeof ALL_ROLES)[number];

export function parseRoles(raw: string | undefined): WorkerRole[] {
  if (!raw || raw.trim() === '' || raw.trim() === 'all') return [...ALL_ROLES];

  const requested = raw.split(',').map((r) => r.trim()).filter(Boolean);
  const unknown = requested.filter((r) => !ALL_ROLES.includes(r as WorkerRole));
  if (unknown.length > 0) {
    // Refuse rather than silently running fewer roles than the operator asked for. A typo
    // in WORKER_ROLES that starts no scheduler is invisible until payroll is wrong.
    throw new Error(
      `Unknown WORKER_ROLES: ${unknown.join(', ')}. Valid roles are ${ALL_ROLES.join(', ')}.`,
    );
  }
  return [...new Set(requested)] as WorkerRole[];
}

function log(msg: string, meta: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', component: 'worker', msg, ...meta }));
}

function logError(msg: string, meta: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: 'error', component: 'worker', msg, ...meta }));
}

/**
 * Sends queued notifications, tenant by tenant.
 *
 * Tenants are enumerated through the platform connection — the only cross-tenant step —
 * and each tenant's dispatch then runs inside its own tenant-scoped transaction.
 */
async function notificationLoop(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const tenants = await withPlatform('maintenance', async (tx) => {
        const { rows } = await tx.query<{ tenant_id: string }>(
          `SELECT DISTINCT tenant_id
             FROM notification.notification
            WHERE status IN ('pending', 'sending') AND retry_count < 5
            LIMIT 100`,
        );
        return rows.map((r) => r.tenant_id);
      });

      let sent = 0;
      let reclaimed = 0;
      for (const tenantId of tenants) {
        if (signal.aborted) break;
        // Reclaim first: a row a dead worker left in `sending` should be retried in this
        // same pass rather than waiting for the next one.
        reclaimed += await reclaimStuckNotifications(tenantId);
        sent += await dispatchNotifications(tenantId);
      }
      if (sent > 0 || reclaimed > 0) log('notifications dispatched', { sent, reclaimed });
    } catch (err) {
      logError('notification dispatch failed', { err: String(err) });
    }

    await sleep(5000, signal);
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

function loopsFor(roles: readonly WorkerRole[], signal: AbortSignal): Array<Promise<void>> {
  const loops: Array<Promise<void>> = [];
  if (roles.includes('publisher')) loops.push(runPublisher({ signal, log }));
  if (roles.includes('consumer')) loops.push(runConsumer({ signal, log, logError }));
  if (roles.includes('notifications')) loops.push(notificationLoop(signal));
  if (roles.includes('scheduler')) loops.push(runScheduler({ signal, log, logError }));
  return loops;
}

async function main(): Promise<void> {
  const cfg = config();
  const roles = parseRoles(process.env.WORKER_ROLES);
  const controller = new AbortController();

  await initTelemetry({ serviceName: process.env.SERVICE_NAME ?? 'hrms-worker' });

  log('worker starting', {
    roles,
    consumer: CONSUMER_NAME,
    queue_driver: cfg.QUEUE_DRIVER,
    mailer: cfg.MAILER_DRIVER,
  });

  // Finish the current batch before exiting so a half-processed event is redelivered
  // rather than lost.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('shutting down', { signal });
    controller.abort();
    setTimeout(() => {
      void Promise.allSettled([closePools(), closeRedis()]).finally(() => process.exit(0));
    }, 2000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await Promise.all(loopsFor(roles, controller.signal));
}

// Only when run as the process entry point, so a test can import `parseRoles` and
// `loopsFor` without starting four polling loops against the test database.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    logError('worker crashed', { err: String(err) });
    process.exit(1);
  });
}
