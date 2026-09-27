import { queueForEvent } from '@hrms/events';
import {
  claimForPublish,
  markPublishFailed,
  markPublished,
  toEnvelope,
  type OutboxRow,
} from '@hrms/api/src/infra/events/outbox.ts';
import { withPlatform } from '@hrms/api/src/infra/db/pool.ts';
import { queue } from '@hrms/api/src/infra/queue.ts';

/**
 * Outbox publisher.
 *
 * Reads events the API and the engines committed alongside their business writes, and
 * forwards them to the broker (ADR-004). This is the only component that turns a committed
 * intent into a delivered message, which is what stops a crash between COMMIT and publish
 * from losing an event.
 *
 * Runs as the platform role because the outbox legitimately spans tenants, and it is the
 * narrow, auditable exception to tenant-scoped access.
 *
 * Three phases, separated by commits — claim, send, settle:
 *
 *   1. claim  — lease a batch and commit, so no other publisher takes it
 *   2. send   — call the broker, with **no transaction open**
 *   3. settle — mark what was published, and back off what was not
 *
 * The earlier version held the claiming transaction open across up to fifty SQS calls. That
 * put a network round trip inside a database transaction: a slow broker became held row
 * locks and a connection out of the pool, and a broker timing out for a minute could exhaust
 * the platform pool entirely. The lease costs a visible window in which a crashed publisher
 * leaves events unpublished for the lease duration, which is the far cheaper failure — and
 * it is bounded, because the lease expires and another publisher picks them up.
 */

const BATCH_SIZE = 50;

/** How long a claimed batch stays off-limits to other publishers. */
const LEASE_SECONDS = 60;

export type PublishResult = { published: number; failed: number };

export async function publishBatch(): Promise<PublishResult> {
  // Phase 1 — claim. Commits immediately.
  const claimed: OutboxRow[] = await withPlatform('outbox-publisher', (tx) =>
    claimForPublish(tx, BATCH_SIZE, LEASE_SECONDS),
  );
  if (claimed.length === 0) return { published: 0, failed: 0 };

  // Phase 2 — send. No transaction is open for the duration of this loop.
  const publishedIds: number[] = [];
  const failures: Array<{ id: number; error: string }> = [];

  for (const row of claimed) {
    try {
      await queue().send(queueForEvent(row.event_type), toEnvelope(row));
      publishedIds.push(row.id);
    } catch (err) {
      failures.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Phase 3 — settle. A crash before this leaves the events leased but unpublished; the
  // lease expires and they are re-sent. At-least-once was already the contract — every
  // consumer claims through `processed_event` — so a duplicate is absorbed, while a lost
  // event would not be.
  await withPlatform('outbox-publisher', async (tx) => {
    await markPublished(tx, publishedIds);
    for (const failure of failures) {
      await markPublishFailed(tx, failure.id, failure.error);
    }
  });

  return { published: publishedIds.length, failed: failures.length };
}

/**
 * Polls the outbox.
 *
 * Deliberately a poll rather than a listen/notify: polling survives a dropped connection
 * and a restarted publisher with no extra machinery, and the latency it costs is small
 * next to the work these events trigger.
 */
export async function runPublisher(options: {
  intervalMs?: number;
  signal: AbortSignal;
  log: (msg: string, meta?: Record<string, unknown>) => void;
}): Promise<void> {
  const interval = options.intervalMs ?? 1000;
  let consecutiveErrors = 0;

  while (!options.signal.aborted) {
    try {
      const result = await publishBatch();
      consecutiveErrors = 0;
      if (result.published > 0 || result.failed > 0) {
        options.log('outbox batch published', result);
      }
      // Back-to-back batches while there is a backlog; idle poll otherwise.
      if (result.published === BATCH_SIZE) continue;
    } catch (err) {
      consecutiveErrors += 1;
      options.log('outbox publisher error', { err: String(err), consecutive: consecutiveErrors });
      await sleep(Math.min(interval * 2 ** consecutiveErrors, 30_000), options.signal);
      continue;
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
