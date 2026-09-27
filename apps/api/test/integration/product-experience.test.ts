import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app.ts';
import { closePools, withTenant, SYSTEM_ACTOR } from '../../src/infra/db/pool.ts';
import { closeRedis } from '../../src/infra/redis.ts';
import { signAccessToken } from '../../src/http/auth.ts';
import * as identity from '../../src/modules/identity/service.ts';
import * as workflow from '../../src/modules/workflow/service.ts';
import {
  createEmployee, createTestTenant, dropTestTenant, skipWithoutDb, type TestTenant,
} from './helpers.ts';

/**
 * The product surfaces added for the experience phase: tenant branding, and the approval
 * context an approver needs in order to decide.
 *
 * Both are new attack surface as much as new features. Branding is tenant data that is read
 * *before* anyone authenticates, and approval detail exposes the substance of somebody's
 * leave or expense claim — so the questions worth testing are who may read them, who may
 * write them, and whether either can be made to cross a tenant boundary.
 */
describe('product experience surfaces', skipWithoutDb, () => {
  let app: FastifyInstance;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let adminA: string;
  let plainA: string;
  let adminB: string;
  let slugA: string;

  /** A signed-in member holding exactly the permissions named. */
  async function member(t: TestTenant, email: string, permissions: string[], employeeId?: string) {
    const membership = await t.as((tx) =>
      identity.inviteUser(tx, {
        email, fullName: email.split('@')[0]!, password: 'ProductPassword1', roleNames: [],
      }),
    );
    return signAccessToken({
      sub: membership.userId,
      tid: t.tenantId,
      mid: membership.membershipId,
      eid: employeeId ?? null,
      perms: permissions,
      name: email,
      mfa: true,
    });
  }

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  before(async () => {
    process.env.LOG_LEVEL = 'error';
    app = await buildApp();
    await app.ready();

    tenantA = await createTestTenant('px-a');
    tenantB = await createTestTenant('px-b');

    adminA = await member(tenantA, `admin-${randomUUID().slice(0, 6)}@a.example`, ['tenant.manage', 'tenant.read']);
    plainA = await member(tenantA, `plain-${randomUUID().slice(0, 6)}@a.example`, ['employee.read.self']);
    adminB = await member(tenantB, `admin-${randomUUID().slice(0, 6)}@b.example`, ['tenant.manage', 'tenant.read']);

    slugA = await tenantA.as(async (tx) => {
      const { rows } = await tx.query<{ slug: string }>(
        'SELECT slug FROM identity.tenant WHERE id = $1', [tx.tenantId]);
      return rows[0]!.slug;
    });
  });

  after(async () => {
    await app.close();
    await dropTestTenant(tenantA.tenantId);
    await dropTestTenant(tenantB.tenantId);
    await closePools();
    await closeRedis();
  });

  // ------------------------------------------------------------------ branding

  describe('tenant branding', () => {
    const put = (token: string, payload: unknown) =>
      app.inject({
        method: 'PUT', url: '/api/tenant/branding',
        headers: auth(token), payload: payload as object,
      });

    it('stores and returns a brand for the caller\'s own tenant', async () => {
      const response = await put(adminA, {
        displayName: 'Northwind', primaryColor: '#0b6b4f', density: 'compact', radius: 'round',
      });
      assert.equal(response.statusCode, 200);

      const read = await app.inject({
        method: 'GET', url: '/api/tenant/branding', headers: auth(adminA),
      });
      const body = read.json() as Record<string, string>;
      assert.equal(body.display_name, 'Northwind');
      assert.equal(body.primary_color, '#0b6b4f');
      assert.equal(body.density, 'compact');
    });

    it('falls back to the tenant name when no brand has been set', async () => {
      const body = (await app.inject({
        method: 'GET', url: '/api/tenant/branding', headers: auth(adminB),
      })).json() as Record<string, string | null>;
      assert.ok(body.display_name, 'an unbranded tenant still has a name to show');
      assert.equal(body.primary_color, null);
    });

    it('lets any member read their own tenant\'s brand', async () => {
      // It is what they already see on every screen; hiding it behind a permission would
      // only mean the product could not paint itself for most of its users.
      const response = await app.inject({
        method: 'GET', url: '/api/tenant/branding', headers: auth(plainA),
      });
      assert.equal(response.statusCode, 200);
    });

    it('refuses to let an ordinary member change it', async () => {
      assert.equal((await put(plainA, { displayName: 'Nope' })).statusCode, 403);
    });

    it('never lets one tenant write another tenant\'s brand', async () => {
      // There is no tenant parameter on the route at all — the tenant comes from the signed
      // token — so this asserts the consequence: B writing only ever changes B.
      await put(adminB, { displayName: 'Kestrel' });

      const a = (await app.inject({
        method: 'GET', url: '/api/tenant/branding', headers: auth(adminA),
      })).json() as Record<string, string>;
      const b = (await app.inject({
        method: 'GET', url: '/api/tenant/branding', headers: auth(adminB),
      })).json() as Record<string, string>;

      assert.equal(a.display_name, 'Northwind');
      assert.equal(b.display_name, 'Kestrel');
    });

    it('rejects a colour the stylesheet could not use', async () => {
      for (const bad of ['red', '#12345', 'rgb(1,2,3)', '#ffffff; background: url(x)']) {
        const response = await put(adminA, { primaryColor: bad });
        assert.equal(response.statusCode, 400, `accepted ${bad}`);
      }
    });

    it('rejects an asset URL that could execute script', async () => {
      // A logo URL ends up in an <img src>. `javascript:` and `data:` belong nowhere near it.
      for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'http://insecure.example/logo.png']) {
        const response = await put(adminA, { logoUrl: bad });
        assert.equal(response.statusCode, 400, `accepted ${bad}`);
      }
      assert.equal((await put(adminA, { logoUrl: 'https://cdn.example/logo.png' })).statusCode, 200);
      assert.equal((await put(adminA, { logoUrl: '/assets/logo.png' })).statusCode, 200);
    });

    it('rejects a density or radius outside the supported set', async () => {
      assert.equal((await put(adminA, { density: 'airy' })).statusCode, 400);
      assert.equal((await put(adminA, { radius: 'circle' })).statusCode, 400);
    });

    it('audits every change', async () => {
      await put(adminA, { displayName: `Audited ${randomUUID().slice(0, 6)}` });
      const count = await tenantA.as(async (tx) => {
        const { rows } = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit.audit_log
            WHERE tenant_id = $1 AND action = 'tenant.branding.changed'`,
          [tx.tenantId],
        );
        return rows[0]!.n;
      });
      assert.ok(count > 0, 'a branding change is an administrative act and is recorded');
    });
  });

  describe('public branding', () => {
    it('serves a brand to somebody who has not signed in', async () => {
      await app.inject({
        method: 'PUT', url: '/api/tenant/branding', headers: auth(adminA),
        payload: { displayName: 'Northwind', primaryColor: '#0b6b4f' },
      });

      const response = await app.inject({
        method: 'GET', url: `/api/branding?slug=${encodeURIComponent(slugA)}`,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json() as Record<string, string>;
      assert.equal(body.display_name, 'Northwind');
      assert.equal(body.primary_color, '#0b6b4f');
    });

    it('answers the same way for an unknown workspace as for an unbranded one', async () => {
      // Otherwise the sign-in screen becomes a way to discover which companies use the
      // product, which is a customer list nobody agreed to publish.
      const missing = (await app.inject({
        method: 'GET', url: '/api/branding?slug=definitely-not-a-tenant',
      })).json() as Record<string, unknown>;
      assert.equal(missing.display_name, null);
      assert.equal(Object.keys(missing).length, 2, 'slug and a null name, nothing more');
    });

    it('exposes nothing beyond what a sign-in screen paints', async () => {
      const body = (await app.inject({
        method: 'GET', url: `/api/branding?slug=${encodeURIComponent(slugA)}`,
      })).json() as Record<string, unknown>;

      const allowed = new Set([
        'slug', 'display_name', 'logo_url', 'favicon_url',
        'primary_color', 'secondary_color', 'density', 'radius', 'login_tagline',
      ]);
      for (const key of Object.keys(body)) {
        assert.ok(allowed.has(key), `public branding leaked "${key}"`);
      }
      // Notably absent: the tenant id, its status, and the email footer.
      assert.equal('id' in body, false);
      assert.equal('email_footer' in body, false);
    });
  });

  // ------------------------------------------------------------------ approval context

  describe('approval detail', () => {
    let approver: { employeeId: string; userId: string };
    let subject: { employeeId: string; userId: string };
    let approverToken: string;
    let strangerToken: string;
    let taskId: string;

    async function actor(t: TestTenant, code: string) {
      const employeeId = await createEmployee(t, { code, joiningDate: '2025-01-01' });
      const membership = await t.as((tx) =>
        identity.inviteUser(tx, {
          email: `${code.toLowerCase()}-${randomUUID().slice(0, 6)}@px.example`,
          fullName: code, password: 'ProductPassword1', roleNames: [],
        }),
      );
      await t.as((tx) => tx.query(
        'UPDATE core.employee SET user_id = $3 WHERE tenant_id = $1 AND id = $2',
        [tx.tenantId, employeeId, membership.userId],
      ).then(() => undefined));
      return { employeeId, userId: membership.userId };
    }

    before(async () => {
      approver = await actor(tenantA, `PXAPP${randomUUID().slice(0, 4).toUpperCase()}`);
      subject = await actor(tenantA, `PXSUB${randomUUID().slice(0, 4).toUpperCase()}`);

      approverToken = await tokenFor(tenantA, approver, ['leave.approve']);
      const stranger = await actor(tenantA, `PXSTR${randomUUID().slice(0, 4).toUpperCase()}`);
      strangerToken = await tokenFor(tenantA, stranger, ['leave.approve']);

      await tenantA.as((tx) =>
        workflow.upsertDefinition(tx, {
          name: 'Leave', entityType: 'employee_change',
          steps: [{ sequence: 1, approver: 'employee', employee_id: approver.employeeId, skip_if_unresolved: false }],
        }).then(() => undefined),
      );

      const started = await withTenant(
        tenantA.tenantId,
        { ...SYSTEM_ACTOR, label: 'product-test', userId: subject.userId },
        (tx) => workflow.startWorkflow(tx, 'employee_change', randomUUID(), subject.employeeId),
      );

      const tasks = await tenantA.as(async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          'SELECT id FROM workflow.approval_task WHERE tenant_id = $1 AND workflow_instance_id = $2',
          [tx.tenantId, started.instanceId],
        );
        return rows;
      });
      taskId = tasks[0]!.id;
    });

    async function tokenFor(
      t: TestTenant,
      who: { employeeId: string; userId: string },
      perms: string[],
    ) {
      const membershipId = await t.as(async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          'SELECT id FROM identity.tenant_membership WHERE tenant_id = $1 AND user_id = $2',
          [tx.tenantId, who.userId],
        );
        return rows[0]!.id;
      });
      return signAccessToken({
        sub: who.userId, tid: t.tenantId, mid: membershipId,
        eid: who.employeeId, perms, name: 'Actor', mfa: true,
      });
    }

    it('gives the assigned approver the task, its routing and its history', async () => {
      const response = await app.inject({
        method: 'GET', url: `/api/approvals/${taskId}`, headers: auth(approverToken),
      });
      assert.equal(response.statusCode, 200);

      const body = response.json() as {
        task: Record<string, unknown>;
        history: unknown[];
        context: unknown;
      };
      assert.equal(body.task.id, taskId);
      assert.ok(body.task.subject_name, 'the approver can see whose request this is');
      assert.equal(body.task.instance_status, 'in_progress');
      assert.equal(body.history.length, 1, 'one step so far');
    });

    it('returns no preview for an entity type the product cannot render', async () => {
      // `employee_change` has no business-context case, and that must degrade to "nothing to
      // preview" rather than breaking the approver's screen.
      const body = (await app.inject({
        method: 'GET', url: `/api/approvals/${taskId}`, headers: auth(approverToken),
      })).json() as { context: unknown };
      assert.equal(body.context, null);
    });

    it('hides a task from someone it is not assigned to', async () => {
      const response = await app.inject({
        method: 'GET', url: `/api/approvals/${taskId}`, headers: auth(strangerToken),
      });
      assert.equal(response.statusCode, 404,
        'not 403 — "exists but not yours" would confirm the id');
    });

    it('hides a task from the person who raised it', async () => {
      const subjectToken = await tokenFor(tenantA, subject, ['leave.approve']);
      assert.equal(
        (await app.inject({
          method: 'GET', url: `/api/approvals/${taskId}`, headers: auth(subjectToken),
        })).statusCode,
        404,
      );
    });

    it('is unreachable from another tenant', async () => {
      assert.equal(
        (await app.inject({
          method: 'GET', url: `/api/approvals/${taskId}`, headers: auth(adminB),
        })).statusCode,
        404,
      );
    });

    it('refuses an unauthenticated caller', async () => {
      assert.equal(
        (await app.inject({ method: 'GET', url: `/api/approvals/${taskId}` })).statusCode,
        401,
      );
    });

    it('answers the same way for an id that does not exist', async () => {
      assert.equal(
        (await app.inject({
          method: 'GET', url: `/api/approvals/${randomUUID()}`, headers: auth(approverToken),
        })).statusCode,
        404,
      );
    });
  });
});
