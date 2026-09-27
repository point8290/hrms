import { withTenant, SYSTEM_ACTOR } from '@hrms/api/src/infra/db/pool.ts';
import { sendMail } from './mailer.ts';

/**
 * Notification delivery.
 *
 * The important property here is that the email is sent with **no database transaction
 * open**. Sending inside one holds row locks across a network call to an email provider,
 * and a transaction that fails after a successful send loses the record of it — so the
 * retry delivers a second copy to a real person.
 *
 * Three phases, separated by commits:
 *
 *   1. claim  — mark rows `sending` and commit, so no other worker takes them
 *   2. send   — call the provider, outside any transaction
 *   3. settle — record each outcome
 *
 * A worker that dies between 1 and 3 leaves rows in `sending`, which the stale sweep
 * returns to `pending`. That risks a duplicate only in the crash case, rather than on every
 * transient database error — the trade the previous single-transaction version got backwards.
 */

/** Attempts before a notification is parked as failed and stops being retried. */
export const MAX_NOTIFICATION_ATTEMPTS = 5;

type ClaimedNotification = {
  id: string;
  recipient_email: string | null;
  subject: string | null;
  template_code: string;
  payload: Record<string, unknown>;
};

type Outcome =
  | { id: string; kind: 'sent'; messageId: string }
  | { id: string; kind: 'suppressed' }
  | { id: string; kind: 'failed'; error: string };

export async function dispatchNotifications(tenantId: string, limit = 50): Promise<number> {
  const actor = { ...SYSTEM_ACTOR, label: 'notification-dispatch' };

  // Phase 1 — claim. FOR UPDATE SKIP LOCKED lets several workers share the queue without
  // handing the same notification to two of them.
  const claimed = await withTenant(tenantId, actor, async (tx) => {
    const { rows } = await tx.query<ClaimedNotification>(
      // CTE rather than `WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`: with a locking
      // subquery the planner may evaluate it more than once, claiming past the limit.
      `WITH due AS (
          SELECT id FROM notification.notification
           WHERE tenant_id = $1 AND status = 'pending' AND retry_count < $3
           ORDER BY created_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
       )
       UPDATE notification.notification n
          SET status = 'sending', updated_at = now()
         FROM due
        WHERE n.id = due.id
        RETURNING n.id, n.recipient_email, n.subject, n.template_code, n.payload`,
      [tenantId, limit, MAX_NOTIFICATION_ATTEMPTS],
    );
    return rows;
  });

  if (claimed.length === 0) return 0;

  // Phase 2 — send. No transaction is open for the duration of this loop.
  const outcomes: Outcome[] = [];
  for (const notification of claimed) {
    if (!notification.recipient_email) {
      outcomes.push({ id: notification.id, kind: 'suppressed' });
      continue;
    }
    try {
      const messageId = await sendMail({
        to: notification.recipient_email,
        subject: notification.subject ?? notification.template_code,
        template: notification.template_code,
        data: notification.payload,
      });
      outcomes.push({ id: notification.id, kind: 'sent', messageId });
    } catch (err) {
      outcomes.push({
        id: notification.id,
        kind: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Phase 3 — settle.
  return withTenant(tenantId, actor, async (tx) => {
    let sent = 0;
    for (const outcome of outcomes) {
      if (outcome.kind === 'suppressed') {
        await tx.query(
          `UPDATE notification.notification
              SET status = 'suppressed', last_error = 'no recipient address'
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, outcome.id],
        );
      } else if (outcome.kind === 'sent') {
        await tx.query(
          `UPDATE notification.notification
              SET status = 'sent', sent_at = now(), provider_message_id = $3, last_error = NULL
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, outcome.id, outcome.messageId],
        );
        sent += 1;
      } else {
        await tx.query(
          `UPDATE notification.notification
              SET retry_count = retry_count + 1,
                  last_error = $3,
                  status = CASE WHEN retry_count + 1 >= $4 THEN 'failed' ELSE 'pending' END
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, outcome.id, outcome.error.slice(0, 500), MAX_NOTIFICATION_ATTEMPTS],
        );
      }
    }
    return sent;
  });
}

/**
 * Returns notifications stuck in `sending` to the queue.
 *
 * Only reachable when a worker stopped between claiming and settling. Retrying may deliver
 * a duplicate; the alternative is a notification that is never sent and never reported,
 * which is worse for a payslip-available message.
 */
export async function reclaimStuckNotifications(
  tenantId: string,
  staleAfterMinutes = 15,
): Promise<number> {
  return withTenant(
    tenantId,
    { ...SYSTEM_ACTOR, label: 'notification-dispatch' },
    async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE notification.notification
            SET status = 'pending',
                retry_count = retry_count + 1,
                last_error = 'worker stopped before the send outcome was recorded'
          WHERE tenant_id = $1
            AND status = 'sending'
            AND updated_at < now() - make_interval(mins => $2)`,
        [tenantId, staleAfterMinutes],
      );
      return rowCount ?? 0;
    },
  );
}
