import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  closePools,
  withPlatform,
  withTenant,
  SYSTEM_ACTOR,
  type TenantTx,
} from '@hrms/api/src/infra/db/pool.ts';
import {
  MAX_NOTIFICATION_ATTEMPTS,
  dispatchNotifications,
  reclaimStuckNotifications,
} from '../src/notifications.ts';

/**
 * Notification delivery.
 *
 * The property under test is that the email is sent *outside* a database transaction, and
 * that every outcome is settled afterwards. The failure branches matter more than the happy
 * path: a provider outage must not lose the notification, and a dead worker must not leave
 * one stuck forever.
 */

const hasDatabase = Boolean(process.env.DATABASE_URL);
const skipWithoutDb = {
  skip: hasDatabase ? false : 'DATABASE_URL is not set (docker compose up -d postgres && npm run db:migrate)',
};

describe('notification dispatch', skipWithoutDb, () => {
  let tenantId: string;

  const as = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    withTenant(tenantId, { ...SYSTEM_ACTOR, label: 'worker-test' }, fn);

  before(async () => {
    tenantId = await withPlatform('tenant-provisioning', async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO identity.tenant (name, slug, timezone) VALUES ($1, $2, 'Asia/Kolkata') RETURNING id`,
        [`Worker test`, `worker-${randomUUID().slice(0, 8)}`],
      );
      return rows[0]!.id;
    });
  });

  after(async () => {
    await withPlatform('maintenance', (tx) =>
      tx.query('SELECT identity.purge_tenant($1, $2)', [tenantId, 'worker test teardown']),
    );
    await closePools();
  });

  async function queue(dedupeKey: string, email: string | null = 'someone@example.com'): Promise<string> {
    return as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO notification.notification
           (tenant_id, recipient_email, channel, template_code, subject, payload, dedupe_key)
         VALUES ($1, $2, 'email', 'leave.approved', 'Test', '{}'::jsonb, $3)
         ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [tenantId, email, dedupeKey],
      );
      return rows[0]?.id ?? '';
    });
  }

  async function statusOf(dedupeKey: string) {
    return as(async (tx) => {
      const { rows } = await tx.query<{
        status: string;
        retry_count: number;
        provider_message_id: string | null;
        last_error: string | null;
      }>(
        `SELECT status, retry_count, provider_message_id, last_error
           FROM notification.notification WHERE tenant_id = $1 AND dedupe_key = $2`,
        [tenantId, dedupeKey],
      );
      return rows[0]!;
    });
  }

  it('suppresses a duplicate queued by a redelivered event', async () => {
    const first = await queue('dedupe-me');
    const second = await queue('dedupe-me');
    assert.ok(first);
    assert.equal(second, '', 'the dedupe key must stop the same person being emailed twice');
  });

  it('sends a pending notification and records the provider message id', async () => {
    const sent = await dispatchNotifications(tenantId);
    assert.ok(sent >= 1);

    const row = await statusOf('dedupe-me');
    assert.equal(row.status, 'sent');
    assert.ok(row.provider_message_id, 'the provider id is the evidence the send happened');
  });

  it('suppresses a notification with no recipient instead of retrying forever', async () => {
    await queue('no-address', null);
    await dispatchNotifications(tenantId);

    const row = await statusOf('no-address');
    assert.equal(row.status, 'suppressed');
    assert.match(row.last_error ?? '', /no recipient/);
  });

  it('reclaims a notification whose worker died between sending and settling', async () => {
    await as((tx) =>
      tx.query(
        `INSERT INTO notification.notification
           (tenant_id, recipient_email, channel, template_code, subject, payload, dedupe_key,
            status, updated_at)
         VALUES ($1, 'stuck@example.com', 'email', 'leave.approved', 'Stuck', '{}'::jsonb,
                 'stuck', 'sending', now() - INTERVAL '1 hour')`,
        [tenantId],
      ),
    );

    const reclaimed = await reclaimStuckNotifications(tenantId, 15);
    assert.equal(reclaimed, 1);

    const row = await statusOf('stuck');
    assert.equal(row.status, 'pending');
    assert.equal(row.retry_count, 1, 'the abandoned attempt is counted so it cannot loop forever');
  });

  it('does not reclaim a notification that is still being sent', async () => {
    await as((tx) =>
      tx.query(
        `INSERT INTO notification.notification
           (tenant_id, recipient_email, channel, template_code, subject, payload, dedupe_key,
            status, updated_at)
         VALUES ($1, 'inflight@example.com', 'email', 'leave.approved', 'In flight', '{}'::jsonb,
                 'inflight', 'sending', now())`,
        [tenantId],
      ),
    );

    const reclaimed = await reclaimStuckNotifications(tenantId, 15);
    assert.equal(reclaimed, 0, 'a send that started moments ago must be left alone');
  });

  it('skips a notification that has exhausted its attempts', async () => {
    await as((tx) =>
      tx.query(
        `INSERT INTO notification.notification
           (tenant_id, recipient_email, channel, template_code, subject, payload, dedupe_key, retry_count)
         VALUES ($1, 'exhausted@example.com', 'email', 'leave.approved', 'Exhausted', '{}'::jsonb,
                 'exhausted', $2)`,
        [tenantId, MAX_NOTIFICATION_ATTEMPTS],
      ),
    );

    await dispatchNotifications(tenantId);

    const row = await statusOf('exhausted');
    assert.equal(row.status, 'pending', 'it is passed over, not re-sent and not silently dropped');
    assert.equal(row.retry_count, MAX_NOTIFICATION_ATTEMPTS);
  });

  it('leaves nothing in `sending` once a dispatch pass completes', async () => {
    await queue('final-check');
    await dispatchNotifications(tenantId);

    const stuck = await as(async (tx) => {
      const { rows } = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM notification.notification
          WHERE tenant_id = $1 AND status = 'sending' AND dedupe_key <> 'inflight'`,
        [tenantId],
      );
      return Number(rows[0]!.count);
    });
    assert.equal(stuck, 0, 'every claimed notification must reach a terminal state');
  });

  it('isolates dispatch to one tenant', async () => {
    const otherTenant = await withPlatform('tenant-provisioning', async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO identity.tenant (name, slug) VALUES ($1, $2) RETURNING id`,
        ['Other', `other-${randomUUID().slice(0, 8)}`],
      );
      return rows[0]!.id;
    });

    try {
      await withTenant(otherTenant, { ...SYSTEM_ACTOR, label: 'worker-test' }, (tx) =>
        tx.query(
          `INSERT INTO notification.notification
             (tenant_id, recipient_email, channel, template_code, subject, payload, dedupe_key)
           VALUES ($1, 'other@example.com', 'email', 'leave.approved', 'Other', '{}'::jsonb, 'other')`,
          [otherTenant],
        ),
      );

      // Dispatching our tenant must not touch the other tenant's queue.
      await dispatchNotifications(tenantId);

      const otherStatus = await withTenant(otherTenant, { ...SYSTEM_ACTOR, label: 'worker-test' }, async (tx) => {
        const { rows } = await tx.query<{ status: string }>(
          `SELECT status FROM notification.notification WHERE dedupe_key = 'other'`,
        );
        return rows[0]!.status;
      });
      assert.equal(otherStatus, 'pending');
    } finally {
      await withPlatform('maintenance', (tx) =>
        tx.query('SELECT identity.purge_tenant($1, $2)', [otherTenant, 'worker test teardown']),
      );
    }
  });
});
