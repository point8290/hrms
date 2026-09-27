import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../src/http/app.ts';
import { closePools } from '../../src/infra/db/pool.ts';
import { closeRedis } from '../../src/infra/redis.ts';
import { signAccessToken } from '../../src/http/auth.ts';
import * as identity from '../../src/modules/identity/service.ts';
import { createTestTenant, dropTestTenant, skipWithoutDb, type TestTenant } from './helpers.ts';

/**
 * The notification HTTP surface (PRD s.18.1, s.18.3, s.20).
 *
 * The worker suite proves what gets *written*. This suite proves who may *read* it, which
 * is a different question and the one with security consequences: a notification carries
 * the substance of a leave decision, an expense outcome or a payslip becoming available,
 * so "can Bob fetch Alice's inbox?" is really "can Bob read Alice's payroll messages
 * without holding any payroll permission?".
 *
 * Authorization here is ownership rather than a permission, so there is no role to
 * mis-assign and nothing to grant — which also means an ownership predicate that silently
 * stopped matching would leak everything with no failing permission test to catch it.
 * Hence these tests.
 */
describe('notification API', skipWithoutDb, () => {
  let app: FastifyInstance;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let alice: { userId: string; token: string };
  let bob: { userId: string; token: string };
  let carol: { userId: string; token: string };

  /** A signed-in member of a tenant. No permissions: ownership is the only gate. */
  async function member(tenant: TestTenant, email: string, name: string) {
    const membership = await tenant.as((tx) =>
      identity.inviteUser(tx, {
        email,
        fullName: name,
        password: 'NotifPassword1',
        roleNames: [],
      }),
    );
    const token = await signAccessToken({
      sub: membership.userId,
      tid: tenant.tenantId,
      mid: membership.membershipId,
      eid: null,
      perms: [],
      name,
      mfa: true,
    });
    return { userId: membership.userId, token };
  }

  /** Writes one notification directly, so the test controls exactly what exists. */
  async function give(
    tenant: TestTenant,
    userId: string,
    overrides: Partial<{ channel: string; status: string; subject: string; category: string }> = {},
  ) {
    const o = {
      channel: 'in_app', status: 'sent', subject: 'A leave request was approved',
      category: 'leave', ...overrides,
    };
    return tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO notification.notification
           (tenant_id, recipient_user_id, recipient_email, channel, category, template_code,
            subject, status, sent_at, dedupe_key)
         VALUES ($1,$2,'x@example.com',$3,$4,'leave.approved',$5,$6,
                 CASE WHEN $6 = 'sent' THEN now() ELSE NULL END, $7)
         RETURNING id`,
        [tx.tenantId, userId, o.channel, o.category, o.subject, o.status, randomUUID()],
      );
      return rows[0]!.id;
    });
  }

  const get = (path: string, token: string) =>
    app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${token}` } });

  before(async () => {
    process.env.LOG_LEVEL = 'error';
    app = await buildApp();
    await app.ready();

    tenantA = await createTestTenant('notif-api-a');
    tenantB = await createTestTenant('notif-api-b');
    alice = await member(tenantA, 'alice@notif-a.example', 'Alice');
    bob = await member(tenantA, 'bob@notif-a.example', 'Bob');
    carol = await member(tenantB, 'carol@notif-b.example', 'Carol');
  });

  after(async () => {
    await app.close();
    await dropTestTenant(tenantA.tenantId);
    await dropTestTenant(tenantB.tenantId);
    await closePools();
    await closeRedis();
  });

  beforeEach(async () => {
    for (const t of [tenantA, tenantB]) {
      await t.as((tx) => tx.query(
        'DELETE FROM notification.notification WHERE tenant_id = $1', [tx.tenantId],
      ).then(() => undefined));
      await t.as((tx) => tx.query(
        'DELETE FROM notification.notification_preference WHERE tenant_id = $1', [tx.tenantId],
      ).then(() => undefined));
    }
  });

  // ------------------------------------------------------------------ inbox

  describe('inbox', () => {
    it('returns the caller their own notifications and nobody else\'s', async () => {
      await give(tenantA, alice.userId, { subject: 'For Alice' });
      await give(tenantA, bob.userId, { subject: 'For Bob' });

      const response = await get('/api/notifications', alice.token);
      assert.equal(response.statusCode, 200);

      const body = response.json() as { notifications: { subject: string }[]; unread: number };
      assert.deepEqual(body.notifications.map((n) => n.subject), ['For Alice']);
      assert.equal(body.unread, 1);
    });

    it('does not reach across tenants', async () => {
      await give(tenantB, carol.userId, { subject: 'For Carol' });

      const body = (await get('/api/notifications', alice.token)).json() as {
        notifications: unknown[];
      };
      assert.deepEqual(body.notifications, []);
    });

    it('never lists email notifications back', async () => {
      // The email was delivered to a mailbox this system does not own. Listing it here
      // would be a second copy of it, readable by anyone who reaches the inbox.
      await give(tenantA, alice.userId, { channel: 'email', subject: 'Emailed' });

      const body = (await get('/api/notifications', alice.token)).json() as {
        notifications: unknown[];
      };
      assert.deepEqual(body.notifications, [], 'only in-app is exposed');
    });

    it('hides a notification that has not been sent yet', async () => {
      await give(tenantA, alice.userId, { status: 'pending', subject: 'Not yet' });

      const body = (await get('/api/notifications', alice.token)).json() as {
        notifications: unknown[]; unread: number;
      };
      assert.deepEqual(body.notifications, []);
      assert.equal(body.unread, 0);
    });

    it('filters to unread on request', async () => {
      const read = await give(tenantA, alice.userId, { subject: 'Already read' });
      await give(tenantA, alice.userId, { subject: 'Still unread' });
      await app.inject({
        method: 'POST', url: `/api/notifications/${read}/read`,
        headers: { authorization: `Bearer ${alice.token}` },
      });

      const body = (await get('/api/notifications?unreadOnly=true', alice.token)).json() as {
        notifications: { subject: string }[]; unread: number;
      };
      assert.deepEqual(body.notifications.map((n) => n.subject), ['Still unread']);
      assert.equal(body.unread, 1, 'the count tracks the filter');
    });

    it('refuses an unauthenticated caller', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/notifications' });
      assert.equal(response.statusCode, 401);
    });
  });

  // ------------------------------------------------------------------ mark read

  describe('marking read', () => {
    const markRead = (id: string, token: string) =>
      app.inject({
        method: 'POST', url: `/api/notifications/${id}/read`,
        headers: { authorization: `Bearer ${token}` },
      });

    it('moves SENT to READ and keeps the first timestamp on a repeat', async () => {
      const id = await give(tenantA, alice.userId);

      const first = await markRead(id, alice.token);
      assert.equal(first.statusCode, 200);
      const firstAt = (first.json() as { read_at: string }).read_at;
      assert.ok(firstAt);

      const second = await markRead(id, alice.token);
      assert.equal(second.statusCode, 200);
      assert.equal((second.json() as { read_at: string }).read_at, firstAt,
        'a second read is idempotent, not a new timestamp');
    });

    it('will not let one user mark another\'s notification read', async () => {
      const bobs = await give(tenantA, bob.userId);

      const response = await markRead(bobs, alice.token);
      assert.equal(response.statusCode, 404,
        'not 403 — a different answer for "exists but not yours" would confirm the id');

      const stillUnread = await tenantA.as(async (tx) => {
        const { rows } = await tx.query<{ read_at: Date | null }>(
          'SELECT read_at FROM notification.notification WHERE tenant_id = $1 AND id = $2',
          [tx.tenantId, bobs]);
        return rows[0]!.read_at;
      });
      assert.equal(stillUnread, null, 'and nothing was written');
    });

    it('will not reach into another tenant', async () => {
      const carols = await give(tenantB, carol.userId);
      assert.equal((await markRead(carols, alice.token)).statusCode, 404);
    });

    it('answers the same way for an id that does not exist', async () => {
      assert.equal((await markRead(randomUUID(), alice.token)).statusCode, 404);
    });

    it('refuses to mark an email notification read', async () => {
      // s.18.3 gives SENT -> READ to in-app only; this system cannot know an email was read.
      const id = await give(tenantA, alice.userId, { channel: 'email' });
      assert.equal((await markRead(id, alice.token)).statusCode, 404);
    });
  });

  // ------------------------------------------------------------------ preferences

  describe('preferences', () => {
    const putPreferences = (
      body: { category: string; channel: string; enabled: boolean }[],
      token: string,
    ) =>
      app.inject({
        method: 'PUT', url: '/api/notification-preferences',
        headers: { authorization: `Bearer ${token}` },
        payload: { preferences: body },
      });

    it('offers only categories the PRD allows an employee to control', async () => {
      const body = (await get('/api/notification-preferences', alice.token)).json() as {
        preferences: { category: string; enabled: boolean }[];
        mandatory_categories: string[];
      };

      const offered = [...new Set(body.preferences.map((p) => p.category))].sort();
      assert.deepEqual(offered, ['attendance', 'expense', 'leave', 'onboarding']);
      assert.ok(body.mandatory_categories.includes('payroll'),
        'payroll is named in s.18.4 and must not be offered as a switch');
      assert.equal(offered.includes('payroll'), false);
    });

    it('defaults to enabled when nothing has been chosen', async () => {
      const body = (await get('/api/notification-preferences', alice.token)).json() as {
        preferences: { enabled: boolean }[];
      };
      assert.ok(body.preferences.every((p) => p.enabled),
        'a preference nobody expressed never suppresses anything');
    });

    it('stores a choice and reads it back', async () => {
      const put = await putPreferences([{ category: 'leave', channel: 'email', enabled: false }],
        alice.token);
      assert.equal(put.statusCode, 200);

      const body = (await get('/api/notification-preferences', alice.token)).json() as {
        preferences: { category: string; channel: string; enabled: boolean }[];
      };
      const leaveEmail = body.preferences.find(
        (p) => p.category === 'leave' && p.channel === 'email');
      assert.equal(leaveEmail?.enabled, false);
    });

    it('refuses a mandatory category rather than ignoring it', async () => {
      // Accepting the write and then sending anyway would leave the employee believing the
      // setting worked. s.18.4 means the answer is no, and the employee should be told so.
      const response = await putPreferences(
        [{ category: 'payroll', channel: 'email', enabled: false }], alice.token);
      assert.equal(response.statusCode, 403);

      const stored = await tenantA.as(async (tx) => {
        const { rows } = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM notification.notification_preference
            WHERE tenant_id = $1 AND category = 'payroll'`, [tx.tenantId]);
        return rows[0]!.n;
      });
      assert.equal(stored, 0, 'and nothing was written');
    });

    it('refuses a category that is not a category at all', async () => {
      assert.equal(
        (await putPreferences([{ category: 'nonsense', channel: 'email', enabled: false }],
          alice.token)).statusCode,
        403,
      );
    });

    it('writes only the caller\'s own preferences', async () => {
      await putPreferences([{ category: 'leave', channel: 'email', enabled: false }], alice.token);

      const bobsView = (await get('/api/notification-preferences', bob.token)).json() as {
        preferences: { enabled: boolean }[];
      };
      assert.ok(bobsView.preferences.every((p) => p.enabled),
        'one employee cannot change another employee\'s notifications');
    });

    it('audits the change, as s.20 requires', async () => {
      await putPreferences([{ category: 'expense', channel: 'in_app', enabled: false }],
        alice.token);

      // The audit log is append-only by trigger, so beforeEach cannot clear it and the
      // other preference tests above have already written entries. Scope to this change.
      const entries = await tenantA.as(async (tx) => {
        const { rows } = await tx.query<{ entity_id: string; after_state: unknown }>(
          `SELECT entity_id, after_state FROM audit.audit_log
            WHERE tenant_id = $1 AND action = 'notification.preferences.changed'
              AND after_state @> $2::jsonb`,
          [tx.tenantId,
           JSON.stringify({ preferences: [{ category: 'expense', channel: 'in_app' }] })]);
        return rows;
      });

      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.entity_id, alice.userId, 'attributed to whoever changed it');
      assert.deepEqual(entries[0]!.after_state,
        { preferences: [{ category: 'expense', channel: 'in_app', enabled: false }] });
    });

    it('refuses an unauthenticated caller', async () => {
      const response = await app.inject({
        method: 'PUT', url: '/api/notification-preferences',
        payload: { preferences: [{ category: 'leave', channel: 'email', enabled: false }] },
      });
      assert.equal(response.statusCode, 401);
    });
  });
});
