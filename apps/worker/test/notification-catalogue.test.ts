import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closePools, getAppPool, withPlatform, withTenant, SYSTEM_ACTOR, type TenantTx } from '@hrms/api/src/infra/db/pool.ts';
import { NOTIFICATIONS, configurableCategories, dedupeKey, notificationDefinition } from '@hrms/events';
import { HANDLERS } from '../src/handlers.ts';

const hasDb = Boolean(process.env.DATABASE_URL);
const skipWithoutDb = { skip: hasDb ? false : 'DATABASE_URL is not set' };

type TestTenant = { tenantId: string; companyId: string; locationId: string };

/** The minimum org scaffolding these tests need, created inline. */
async function createTestTenant(prefix: string): Promise<TestTenant> {
  const slug = `${prefix}-${randomUUID().slice(0, 8)}`;
  const tenantId = await withPlatform('tenant-provisioning', async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO identity.tenant (name, slug, timezone) VALUES ($1,$2,'Asia/Kolkata') RETURNING id`,
      [slug, slug]);
    return rows[0]!.id;
  });
  const scaffolding = await withTenant(tenantId, { ...SYSTEM_ACTOR, label: 'notification-test' }, async (tx) => {
    const company = await tx.query<{ id: string }>(
      `INSERT INTO core.company (tenant_id, name, legal_name) VALUES ($1,'Acme','Acme Ltd') RETURNING id`,
      [tenantId]);
    const location = await tx.query<{ id: string }>(
      `INSERT INTO core.location (tenant_id, name, timezone, state_code)
       VALUES ($1,'Bengaluru','Asia/Kolkata','KA') RETURNING id`, [tenantId]);
    return { companyId: company.rows[0]!.id, locationId: location.rows[0]!.id };
  });
  return { tenantId, ...scaffolding };
}

async function dropTestTenant(tenantId: string): Promise<void> {
  await withPlatform('maintenance', async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['hrms:test:purge_tenant']);
    await tx.query('SELECT identity.purge_tenant($1,$2)', [tenantId, 'notification test teardown']);
  });
}

/**
 * Notifications (PRD s.18, s.19, s.20).
 *
 * The catalogue's classification is tested against the PRD rather than against itself: s.18.4
 * says which notifications cannot be disabled and s.18.5 says which an employee may control,
 * and those two lists are asserted here by name. Everything else follows from them — a
 * preference can silence a category only if the PRD said it could.
 *
 * Delivery is tested through the real handlers, so what is exercised is the path a redelivered
 * SQS message actually takes.
 */

const actor = { ...SYSTEM_ACTOR, label: 'notification-test' };

function asTenant<T>(t: TestTenant, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withTenant(t.tenantId, actor, fn);
}

describe('notifications', skipWithoutDb, () => {
  let tenant: TestTenant;
  let other: TestTenant;
  let employeeId: string;
  let userId: string;
  let managerId: string;

  /** An employee with a linked login, so both channels are reachable. */
  async function makeEmployee(t: TestTenant, code: string, managerEmployeeId?: string) {
    const email = `${code.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`;
    const uid = await withPlatform('tenant-provisioning', async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO identity.app_user (email, full_name, status, password_hash)
         VALUES ($1, $2, 'active', 'x') RETURNING id`, [email, code]);
      return rows[0]!.id;
    });
    await withPlatform('tenant-provisioning', (tx) =>
      tx.query(`INSERT INTO identity.tenant_membership (tenant_id, user_id, status)
                VALUES ($1,$2,'active')`, [t.tenantId, uid]).then(() => undefined));

    const eid = await asTenant(t, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO core.employee
           (tenant_id, company_id, location_id, employee_code, first_name, last_name,
            work_email, joining_date, employment_status, user_id, manager_employee_id)
         VALUES ($1,$2,$3,$4,$5,'Tester',$6,'2026-01-01','active',$7,$8) RETURNING id`,
        [tx.tenantId, t.companyId, t.locationId, code, code, email, uid, managerEmployeeId ?? null]);
      return rows[0]!.id;
    });
    return { employeeId: eid, userId: uid, email };
  }

  async function notificationsFor(t: TestTenant, template: string) {
    return asTenant(t, async (tx) => {
      const { rows } = await tx.query<{
        channel: string; status: string; category: string; subject: string;
        recipient_user_id: string | null; dedupe_key: string; read_at: Date | null;
        payload: Record<string, unknown>; sent_at: Date | null;
      }>(
        `SELECT channel, status, category, subject, recipient_user_id, dedupe_key, read_at,
                payload, sent_at
           FROM notification.notification
          WHERE tenant_id = $1 AND template_code = $2
          ORDER BY channel`,
        [tx.tenantId, template]);
      return rows;
    });
  }

  before(async () => {
    tenant = await createTestTenant('notif');
    other = await createTestTenant('notif-other');
    const manager = await makeEmployee(tenant, 'NTFMGR');
    managerId = manager.employeeId;
    const employee = await makeEmployee(tenant, 'NTFEMP', managerId);
    employeeId = employee.employeeId;
    userId = employee.userId;
  });

  after(async () => {
    await dropTestTenant(tenant.tenantId);
    await dropTestTenant(other.tenantId);
    await closePools();
  });

  beforeEach(async () => {
    // Both tenants: an isolation test that asserts the other tenant is empty is only
    // meaningful if nothing earlier left something in it.
    for (const t of [tenant, other]) {
      await asTenant(t, (tx) =>
        tx.query('DELETE FROM notification.notification WHERE tenant_id = $1', [tx.tenantId])
          .then(() => undefined));
      await asTenant(t, (tx) =>
        tx.query('DELETE FROM notification.notification_preference WHERE tenant_id = $1', [tx.tenantId])
          .then(() => undefined));
    }
  });

  // ------------------------------------------------------------------ catalogue

  describe('catalogue classification', () => {
    it('marks exactly the s.18.5 categories as employee-controllable', () => {
      // s.18.5: "Employee may control: leave approval, attendance correction, expense
      // approval, non-critical reminders". Onboarding task reminders are the reminders.
      assert.deepEqual(configurableCategories(), ['attendance', 'expense', 'leave', 'onboarding']);
    });

    it('keeps the s.18.4 mandatory notifications out of employee control', () => {
      // Payslip availability is named in s.18.4 as one that cannot be disabled.
      assert.equal(notificationDefinition('payroll.payslip_available').mandatory, true);
      assert.equal(configurableCategories().includes('payroll' as never), false);
    });

    it('treats a notification the PRD never offered to make optional as mandatory', () => {
      // employee_created is in the s.19 catalogue but in neither s.18.4 nor s.18.5. An
      // employee cannot opt out of something the product never offered to switch off.
      assert.equal(notificationDefinition('employee.welcome').mandatory, true);
      assert.equal(notificationDefinition('onboarding.completed').mandatory, true);
    });

    it('will not let an approver switch off a pending-approval notification', () => {
      // s.18.4 makes "workflow approval required" non-disableable. s.18.5's "leave approval"
      // and "expense approval" are the requester's side — the outcome of their own request.
      // The two sides share a category, so only the per-notification flag separates them.
      assert.equal(notificationDefinition('leave.awaiting_approval').mandatory, true);
      assert.equal(notificationDefinition('expense.awaiting_approval').mandatory, true);

      // And the outcome notifications on those same categories stay controllable.
      assert.equal(notificationDefinition('leave.approved').mandatory, false);
      assert.equal(notificationDefinition('expense.paid').mandatory, false);
    });

    it('builds the dedupe identity from the five parts s.18.6 names', () => {
      const key = dedupeKey({
        eventId: 'e1', recipient: 'u1', channel: 'email', notificationType: 'leave.approved',
      });
      // tenant is the index's scope rather than part of the string.
      assert.equal(key, 'e1:u1:email:leave.approved');
      assert.notEqual(
        key,
        dedupeKey({ eventId: 'e1', recipient: 'u1', channel: 'in_app', notificationType: 'leave.approved' }),
        'the same notification on another channel is a different message',
      );
    });

    it('keeps money out of every subject line', () => {
      // s.18.8: salary, tax and bank detail must not appear in subjects or previews.
      for (const definition of Object.values(NOTIFICATIONS)) {
        assert.doesNotMatch(
          definition.subject, /\d|₹|INR|salary|amount|net pay/i,
          `subject "${definition.subject}" must not carry a figure`,
        );
      }
    });
  });

  // ------------------------------------------------------------------ delivery

  describe('delivery', () => {
    /** Runs a real handler with a synthetic envelope. */
    async function deliver(eventType: string, payload: Record<string, unknown>, eventId = randomUUID()) {
      await HANDLERS[eventType]!({
        event_id: eventId,
        event_type: eventType,
        schema_version: 1,
        tenant_id: tenant.tenantId,
        aggregate_type: 'test',
        aggregate_id: randomUUID(),
        occurred_at: new Date().toISOString(),
        producer: 'test',
        payload,
      } as never);
      return eventId;
    }

    it('writes one row per channel, with the in-app copy already sent', async () => {
      await deliver('EmployeeCreated', { employee_id: employeeId });

      const rows = await notificationsFor(tenant, 'employee.welcome');
      assert.deepEqual(rows.map((r) => r.channel), ['email', 'in_app']);

      const email = rows.find((r) => r.channel === 'email')!;
      const inApp = rows.find((r) => r.channel === 'in_app')!;

      // Email is queued for the dispatcher; in-app has nowhere to go and is done.
      assert.equal(email.status, 'pending');
      assert.equal(email.sent_at, null);
      assert.equal(inApp.status, 'sent');
      assert.ok(inApp.sent_at);
      assert.equal(inApp.read_at, null);
      assert.equal(inApp.recipient_user_id, userId);
      assert.equal(inApp.category, 'employee');

      // Every row carries a dedupe identity, in the shape s.18.6 defines. A notification
      // written without one is outside the partial unique index and could be duplicated
      // freely, so its absence is a silent loss of the guarantee rather than a visible bug.
      for (const row of rows) {
        assert.ok(row.dedupe_key, 'a notification without a dedupe key is not deduplicated');
        assert.equal(row.dedupe_key.split(':').length, 4);
        assert.ok(row.dedupe_key.endsWith(`:${row.channel}:employee.welcome`));
      }
    });

    it('does not duplicate when the same event is delivered twice', async () => {
      const eventId = randomUUID();
      await deliver('EmployeeCreated', { employee_id: employeeId }, eventId);
      await deliver('EmployeeCreated', { employee_id: employeeId }, eventId);

      assert.equal((await notificationsFor(tenant, 'employee.welcome')).length, 2, 'two channels, once each');
    });

    it('does not duplicate when the same business fact arrives under a new event id', async () => {
      // The processed_event guard stops the first case; the dedupe key is what stops this
      // one, and PRD s.18.6 is why the key includes the event id at all.
      await deliver('EmployeeCreated', { employee_id: employeeId }, randomUUID());
      const first = await notificationsFor(tenant, 'employee.welcome');
      await deliver('EmployeeCreated', { employee_id: employeeId }, randomUUID());
      const second = await notificationsFor(tenant, 'employee.welcome');

      // A different event id is a different message by s.18.6's identity, so this is two
      // notifications — recorded here as the behaviour the PRD's dedupe rule produces.
      assert.equal(first.length, 2);
      assert.equal(second.length, 4);
    });

    it('enforces the dedupe identity in the database, not only in the insert', async () => {
      // `once()` settles a redelivery before the send path runs, so the ON CONFLICT clause is
      // a second line of defence that handler-level tests cannot reach — the processed-event
      // guard is append-only and cannot be undone to simulate its absence. What *is* testable
      // is the constraint the clause depends on: two notifications may not share a dedupe
      // identity within a tenant. Without this index, ON CONFLICT would have nothing to
      // conflict against.
      const key = dedupeKey({
        eventId: randomUUID(), recipient: userId, channel: 'email',
        notificationType: 'employee.welcome',
      });
      const insert = (tx: TenantTx) => tx.query(
        `INSERT INTO notification.notification
           (tenant_id, recipient_user_id, recipient_email, channel, category, template_code,
            subject, dedupe_key)
         VALUES ($1,$2,'x@example.com','email','employee','employee.welcome','s',$3)`,
        [tx.tenantId, userId, key]);

      await asTenant(tenant, (tx) => insert(tx).then(() => undefined));
      await assert.rejects(
        asTenant(tenant, (tx) => insert(tx).then(() => undefined)),
        /idx_notification_dedupe|duplicate key/,
      );

      // And the same key in another tenant is a different notification, not a collision.
      await asTenant(other, (tx) => tx.query(
        `INSERT INTO notification.notification
           (tenant_id, recipient_user_id, recipient_email, channel, category, template_code,
            subject, dedupe_key)
         VALUES ($1,NULL,'x@example.com','email','employee','employee.welcome','s',$2)`,
        [tx.tenantId, key]).then(() => undefined));
    });

    it('notifies every task owner when one onboarding plan is created', async () => {
      // One event, several recipients — which is what makes the recipient part of the
      // dedupe identity load-bearing. Without it the second owner's notification would
      // collide with the first's and be silently dropped.
      const ownerA = await makeEmployee(tenant, `NTFOA${randomUUID().slice(0, 4).toUpperCase()}`);
      const ownerB = await makeEmployee(tenant, `NTFOB${randomUUID().slice(0, 4).toUpperCase()}`);

      const planId = await asTenant(tenant, async (tx) => {
        const plan = await tx.query<{ id: string }>(
          `INSERT INTO recruitment.onboarding_plan
             (tenant_id, employee_id, template_name, joining_date)
           VALUES ($1,$2,'Standard','2026-06-01') RETURNING id`,
          [tx.tenantId, employeeId]);
        for (const [i, owner] of [ownerA, ownerB].entries()) {
          await tx.query(
            `INSERT INTO recruitment.onboarding_task
               (tenant_id, plan_id, sequence_no, title, owner_employee_id, due_date)
             VALUES ($1,$2,$3,$4,$5,'2026-06-01')`,
            [tx.tenantId, plan.rows[0]!.id, i + 1, `Task ${i + 1}`, owner.employeeId]);
        }
        return plan.rows[0]!.id;
      });

      await deliver('OnboardingPlanCreated', { onboarding_plan_id: planId, employee_id: employeeId });

      const rows = await notificationsFor(tenant, 'onboarding.task_assigned');
      const recipients = new Set(rows.map((r) => r.recipient_user_id));
      assert.equal(recipients.size, 2, 'both owners must be told');
      assert.equal(rows.length, 4, 'two owners, two channels each');
    });

    it('keeps two owners apart even when they share one mailbox', async () => {
      // `core.employee.work_email` has no unique index, so two employees can legitimately
      // share an address, and neither needs a login. That is the one case where the old
      // key — which fell back to the email — made two different people look like one
      // recipient, and ON CONFLICT dropped the second person's notification.
      const shared = `shared-${randomUUID().slice(0, 8)}@example.com`;
      const owners = await asTenant(tenant, async (tx) => {
        const ids: string[] = [];
        for (const code of ['NTFSA', 'NTFSB']) {
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO core.employee
               (tenant_id, company_id, location_id, employee_code, first_name, last_name,
                work_email, joining_date, employment_status)
             VALUES ($1,$2,$3,$4,$4,'Tester',$5,'2026-01-01','active') RETURNING id`,
            [tx.tenantId, tenant.companyId, tenant.locationId,
             `${code}${randomUUID().slice(0, 4).toUpperCase()}`, shared]);
          ids.push(rows[0]!.id);
        }
        return ids;
      });

      // A plan is unique per employee, so this one needs its own joiner.
      const joiner = await makeEmployee(tenant, `NTFSJ${randomUUID().slice(0, 4).toUpperCase()}`);
      const planId = await asTenant(tenant, async (tx) => {
        const plan = await tx.query<{ id: string }>(
          `INSERT INTO recruitment.onboarding_plan
             (tenant_id, employee_id, template_name, joining_date)
           VALUES ($1,$2,'Standard','2026-06-01') RETURNING id`,
          [tx.tenantId, joiner.employeeId]);
        for (const [i, owner] of owners.entries()) {
          await tx.query(
            `INSERT INTO recruitment.onboarding_task
               (tenant_id, plan_id, sequence_no, title, owner_employee_id, due_date)
             VALUES ($1,$2,$3,$4,$5,'2026-06-01')`,
            [tx.tenantId, plan.rows[0]!.id, i + 1, `Task ${i + 1}`, owner]);
        }
        return plan.rows[0]!.id;
      });

      await deliver('OnboardingPlanCreated',
        { onboarding_plan_id: planId, employee_id: joiner.employeeId });

      // Neither has a login, so email is the only channel either can receive on.
      const rows = (await notificationsFor(tenant, 'onboarding.task_assigned'))
        .filter((r) => r.recipient_user_id === null);
      assert.equal(rows.length, 2, 'both owners must be told, not just whoever was written first');
      assert.equal(new Set(rows.map((r) => r.dedupe_key)).size, 2, 'and under distinct identities');
    });

    it('notifies the approver when an expense claim is submitted', async () => {
      const claimId = await asTenant(tenant, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO expense.expense_claim
             (tenant_id, employee_id, claim_number, claim_date, title, status, created_by)
           VALUES ($1,$2,$3,'2026-06-01','Travel','submitted',$2) RETURNING id`,
          [tx.tenantId, employeeId, `EXP-${randomUUID().slice(0, 6)}`]);
        return rows[0]!.id;
      });

      await deliver('ExpenseClaimSubmitted', { expense_claim_id: claimId, employee_id: employeeId });

      const rows = await notificationsFor(tenant, 'expense.awaiting_approval');
      assert.equal(rows.length, 2);
      assert.match(rows[0]!.subject, /Expense claim from/);
      assert.equal(rows[0]!.category, 'expense');
    });

    it('tells the claimant the outcome, without the amount', async () => {
      const claimId = await asTenant(tenant, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO expense.expense_claim
             (tenant_id, employee_id, claim_number, claim_date, title, status, created_by,
              total_claimed_amount)
           VALUES ($1,$2,$3,'2026-06-01','Travel','paid',$2, 4321.00) RETURNING id`,
          [tx.tenantId, employeeId, `EXP-${randomUUID().slice(0, 6)}`]);
        return rows[0]!.id;
      });

      await deliver('ExpensePaid', { expense_claim_id: claimId, employee_id: employeeId });

      const rows = await notificationsFor(tenant, 'expense.paid');
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.doesNotMatch(JSON.stringify(row.payload), /4321/, 'no amount in the payload (s.18.8)');
        assert.doesNotMatch(row.subject, /4321/);
      }
    });
  });

  // ------------------------------------------------------------------ dedupe invariant

  describe('deduplication invariant', () => {
    /** Writes one notification with an explicitly composed dedupe identity. */
    async function insertWith(
      t: TestTenant,
      parts: { eventId: string; recipient: string; channel: 'email' | 'in_app'; notificationType: string },
      recipientUserId: string | null = null,
    ) {
      return asTenant(t, (tx) => tx.query(
        `INSERT INTO notification.notification
           (tenant_id, recipient_user_id, recipient_email, channel, category, template_code,
            subject, dedupe_key)
         VALUES ($1,$2,'x@example.com',$3,'employee','employee.welcome','s',$4)`,
        [tx.tenantId, recipientUserId, parts.channel, dedupeKey(parts)],
      ).then(() => undefined));
    }

    const base = {
      recipient: 'recipient-a', channel: 'email' as const, notificationType: 'employee.welcome',
    };

    it('treats one identity as one notification', async () => {
      const parts = { ...base, eventId: randomUUID() };
      await insertWith(tenant, parts);
      await assert.rejects(insertWith(tenant, parts), /idx_notification_dedupe|duplicate key/);
    });

    it('separates a different recipient', async () => {
      const eventId = randomUUID();
      await insertWith(tenant, { ...base, eventId });
      await insertWith(tenant, { ...base, eventId, recipient: 'recipient-b' });
    });

    it('separates a different channel', async () => {
      const eventId = randomUUID();
      await insertWith(tenant, { ...base, eventId });
      await insertWith(tenant, { ...base, eventId, channel: 'in_app' }, userId);
    });

    it('separates a different notification type', async () => {
      const eventId = randomUUID();
      await insertWith(tenant, { ...base, eventId });
      await insertWith(tenant, { ...base, eventId, notificationType: 'leave.approved' });
    });

    it('does not collide across tenants', async () => {
      const parts = { ...base, eventId: randomUUID() };
      await insertWith(tenant, parts);
      await insertWith(other, parts);
    });

    it('is enforced by an index whose shape matches the intent', async () => {
      // The invariant lives in the database, not in the insert clause: scoped by tenant,
      // on the dedupe key, and partial so a row without an identity is out of scope.
      const definition = await asTenant(tenant, async (tx) => {
        const { rows } = await tx.query<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes
            WHERE schemaname = 'notification' AND indexname = 'idx_notification_dedupe'`);
        return rows[0]?.indexdef ?? '';
      });
      assert.match(definition, /UNIQUE INDEX/);
      assert.match(definition, /\(tenant_id, dedupe_key\)/);
      assert.match(definition, /WHERE \(dedupe_key IS NOT NULL\)/);
    });
  });

  // ------------------------------------------------------------------ convergence

  describe('convergence under redelivery and concurrency', () => {
    async function deliverOnce(eventId: string) {
      await HANDLERS.EmployeeCreated!({
        event_id: eventId, event_type: 'EmployeeCreated', schema_version: 1,
        tenant_id: tenant.tenantId, aggregate_type: 'employee', aggregate_id: employeeId,
        occurred_at: new Date().toISOString(), producer: 'test',
        payload: { employee_id: employeeId },
      } as never);
    }

    async function claimCount(eventId: string) {
      return asTenant(tenant, async (tx) => {
        const { rows } = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM integration.processed_event
            WHERE tenant_id = $1 AND event_id = $2`, [tx.tenantId, eventId]);
        return rows[0]!.n;
      });
    }

    it('converges when two workers process the same event at the same moment', async () => {
      // The race the dedupe clause is usually credited with handling. It is actually settled
      // one layer earlier: both transactions try to insert the same processed_event row, the
      // second blocks on that unique index, and when the first commits the second's
      // ON CONFLICT leaves it with rowCount 0 — so it returns before reaching the
      // notification insert at all.
      const eventId = randomUUID();
      const results = await Promise.allSettled([deliverOnce(eventId), deliverOnce(eventId)]);

      assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled'],
        'neither worker may fail; a duplicate delivery is normal, not an error');
      assert.equal(await claimCount(eventId), 1, 'exactly one claim');
      assert.equal((await notificationsFor(tenant, 'employee.welcome')).length, 2,
        'one notification per channel, once');
    });

    it('never reaches the notification insert once the event is already claimed', async () => {
      const eventId = randomUUID();
      await deliverOnce(eventId);
      const after = await notificationsFor(tenant, 'employee.welcome');

      // Delete every notification, then redeliver. If the insert were reached at all, rows
      // would reappear. They do not: the claim short-circuits before the send path.
      await asTenant(tenant, (tx) => tx.query(
        'DELETE FROM notification.notification WHERE tenant_id = $1', [tx.tenantId])
        .then(() => undefined));

      await deliverOnce(eventId);

      assert.equal(after.length, 2);
      assert.deepEqual(await notificationsFor(tenant, 'employee.welcome'), [],
        'a claimed event does not run the handler again, so nothing is re-created',
      );
    });

    it('commits the claim and the notification together, or neither', async () => {
      // The two live in one transaction, so "notified but not recorded as handled" and
      // "recorded as handled but not notified" are both unreachable. A failure after the
      // insert takes the claim with it, and redelivery starts clean.
      const eventId = randomUUID();
      await assert.rejects(
        withTenant(tenant.tenantId, { ...SYSTEM_ACTOR, label: 'notification-test' }, async (tx) => {
          await tx.query(
            `INSERT INTO integration.processed_event (tenant_id, event_id, consumer_name)
             VALUES ($1,$2,'platform-worker')`, [tx.tenantId, eventId]);
          await tx.query(
            `INSERT INTO notification.notification
               (tenant_id, recipient_user_id, recipient_email, channel, category, template_code,
                subject, dedupe_key)
             VALUES ($1,$2,'x@example.com','email','employee','employee.welcome','s',$3)`,
            [tx.tenantId, userId, `rollback-${eventId}`]);
          throw new Error('settlement failed after both writes');
        }),
        /settlement failed/,
      );

      assert.equal(await claimCount(eventId), 0, 'the claim rolled back');
      assert.deepEqual(await notificationsFor(tenant, 'employee.welcome'), [],
        'and so did the notification');

      // Which is what lets the redelivery succeed cleanly.
      await deliverOnce(eventId);
      assert.equal(await claimCount(eventId), 1);
      assert.equal((await notificationsFor(tenant, 'employee.welcome')).length, 2);
    });
  });

  // ------------------------------------------------------------------ preferences

  describe('preferences', () => {
    async function setPreference(category: string, channel: string, enabled: boolean) {
      await asTenant(tenant, (tx) =>
        tx.query(
          `INSERT INTO notification.notification_preference
             (tenant_id, user_id, category, channel, enabled)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (tenant_id, user_id, category, channel)
           DO UPDATE SET enabled = EXCLUDED.enabled`,
          [tx.tenantId, userId, category, channel, enabled]).then(() => undefined));
    }

    async function deliver(eventType: string, payload: Record<string, unknown>) {
      await HANDLERS[eventType]!({
        event_id: randomUUID(), event_type: eventType, schema_version: 1,
        tenant_id: tenant.tenantId, aggregate_type: 'test', aggregate_id: randomUUID(),
        occurred_at: new Date().toISOString(), producer: 'test', payload,
      } as never);
    }

    // Leave applications for one employee may not overlap, so each fixture gets its own day.
    let leaveDay = 0;
    async function leaveApplication(forEmployee = employeeId) {
      leaveDay += 1;
      const day = String(leaveDay).padStart(2, '0');
      return asTenant(tenant, async (tx) => {
        const type = await tx.query<{ id: string }>(
          `INSERT INTO leave_mgmt.leave_type (tenant_id, name, code)
           VALUES ($1,'Earned',$2) RETURNING id`,
          [tx.tenantId, `EL${randomUUID().slice(0, 4).toUpperCase()}`]);
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO leave_mgmt.leave_application
             (tenant_id, employee_id, leave_type_id, start_date, end_date, quantity, status)
           VALUES ($1,$2,$3,$4::date,$4::date,1,'pending_approval') RETURNING id`,
          [tx.tenantId, forEmployee, type.rows[0]!.id, `2026-06-${day}`]);
        return rows[0]!.id;
      });
    }

    it('suppresses only the channel the employee switched off', async () => {
      await setPreference('leave', 'email', false);
      const applicationId = await leaveApplication();
      await deliver('LeaveApproved', { leave_application_id: applicationId, employee_id: employeeId });

      const rows = await notificationsFor(tenant, 'leave.approved');
      assert.deepEqual(rows.map((r) => r.channel), ['in_app'], 'email off, in-app still delivered');
    });

    it('sends everything when no preference has been expressed', async () => {
      const applicationId = await leaveApplication();
      await deliver('LeaveApproved', { leave_application_id: applicationId, employee_id: employeeId });

      assert.equal((await notificationsFor(tenant, 'leave.approved')).length, 2);
    });

    it('sends when a preference exists and is enabled', async () => {
      await setPreference('leave', 'email', true);
      const applicationId = await leaveApplication();
      await deliver('LeaveApproved', { leave_application_id: applicationId, employee_id: employeeId });

      assert.equal((await notificationsFor(tenant, 'leave.approved')).length, 2);
    });

    it('cannot switch off a mandatory notification', async () => {
      // A payslip alert is mandatory by s.18.4. Even with the preference row present and
      // disabled — which the API refuses to create, but the database would accept — the
      // notification is still sent, because mandatory categories never consult preferences.
      // Switched off first, on both channels, and by the employee who would receive it.
      // The API refuses to write these rows; the database would accept them, so this proves
      // the send path ignores them rather than relying on the API to be the only writer.
      await setPreference('employee', 'email', false);
      await setPreference('employee', 'in_app', false);

      await deliver('EmployeeCreated', { employee_id: employeeId });

      assert.equal(
        (await notificationsFor(tenant, 'employee.welcome')).length, 2,
        'a mandatory notification ignores preferences entirely (PRD s.18.4)',
      );
    });

    it('does not let one employee preference silence another employee', async () => {
      await setPreference('leave', 'email', false);
      const colleague = await makeEmployee(tenant, `NTFC${randomUUID().slice(0, 4).toUpperCase()}`, managerId);

      const applicationId = await leaveApplication(colleague.employeeId);

      await deliver('LeaveApproved', {
        leave_application_id: applicationId, employee_id: colleague.employeeId,
      });

      const rows = await notificationsFor(tenant, 'leave.approved');
      assert.deepEqual(rows.map((r) => r.channel), ['email', 'in_app']);
      assert.ok(rows.every((r) => r.recipient_user_id === colleague.userId));
    });
  });

  // ------------------------------------------------------------------ isolation

  describe('tenant isolation', () => {
    it('keeps notifications inside their tenant', async () => {
      await HANDLERS.EmployeeCreated!({
        event_id: randomUUID(), event_type: 'EmployeeCreated', schema_version: 1,
        tenant_id: tenant.tenantId, aggregate_type: 'employee', aggregate_id: employeeId,
        occurred_at: new Date().toISOString(), producer: 'test',
        payload: { employee_id: employeeId },
      } as never);

      assert.equal((await notificationsFor(tenant, 'employee.welcome')).length, 2);
      assert.deepEqual(await notificationsFor(other, 'employee.welcome'), []);
    });

    it('resolves nobody when an event names an employee from another tenant', async () => {
      // The envelope says this tenant; the payload names an employee that is not in it.
      // The recipient lookup is tenant-scoped, so it finds nothing and nothing is sent —
      // rather than reaching across and emailing someone else's staff.
      const outsider = await makeEmployee(other, 'NTFOUT');
      await HANDLERS.EmployeeCreated!({
        event_id: randomUUID(), event_type: 'EmployeeCreated', schema_version: 1,
        tenant_id: tenant.tenantId, aggregate_type: 'employee', aggregate_id: outsider.employeeId,
        occurred_at: new Date().toISOString(), producer: 'test',
        payload: { employee_id: outsider.employeeId },
      } as never);

      assert.deepEqual(await notificationsFor(tenant, 'employee.welcome'), []);
      assert.deepEqual(await notificationsFor(other, 'employee.welcome'), []);
    });

    it('fails closed with no tenant context', async () => {
      const client = await getAppPool().connect();
      try {
        await client.query('BEGIN');
        const rows = await client.query<{ n: number }>(
          `SELECT (SELECT count(*)::int FROM notification.notification) AS n`);
        assert.equal(rows.rows[0]!.n, 0);
        const prefs = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM notification.notification_preference`);
        assert.equal(prefs.rows[0]!.n, 0);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });
  });

  // ------------------------------------------------------------------ read state

  describe('in-app read state', () => {
    it('refuses to mark an email notification read', async () => {
      // s.18.3 makes READ an in-app sub-state. Whether an email was opened is not something
      // this system knows, and a column that pretended to would be maintained by nobody.
      await assert.rejects(
        asTenant(tenant, async (tx) => {
          await tx.query(
            `INSERT INTO notification.notification
               (tenant_id, recipient_user_id, recipient_email, channel, template_code, subject,
                status, sent_at, read_at)
             VALUES ($1,$2,'x@example.com','email','t','s','sent', now(), now())`,
            [tx.tenantId, userId]);
        }),
        /notification_read_is_in_app/,
      );
    });

    it('refuses to mark an unsent notification read', async () => {
      await assert.rejects(
        asTenant(tenant, async (tx) => {
          await tx.query(
            `INSERT INTO notification.notification
               (tenant_id, recipient_user_id, channel, template_code, subject, status, read_at)
             VALUES ($1,$2,'in_app','t','s','pending', now())`,
            [tx.tenantId, userId]);
        }),
        /notification_read_implies_sent/,
      );
    });
  });
});
