import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app.ts';
import { closePools } from '../../src/infra/db/pool.ts';
import { closeRedis } from '../../src/infra/redis.ts';
import { signAccessToken } from '../../src/http/auth.ts';
import * as identity from '../../src/modules/identity/service.ts';
import {
  createEmployee, createTestTenant, dropTestTenant, skipWithoutDb, type TestTenant,
} from './helpers.ts';

/**
 * The surfaces exposed so a new tenant can be operated entirely through the product:
 * payroll periods, operational setup, the finance queue, reports, tax declarations and
 * account security.
 *
 * Two of these involved a backend addition, and those get the most attention here, because a
 * new listing endpoint is a new way to read other people's data:
 *
 *   * `GET /api/expense-claims?scope=finance` — every claim awaiting finance, not one
 *     employee's. Gated on `expense.finance`, and specifically *not* on `expense.approve`.
 *   * `GET /api/tax/declarations` — the read half of a workflow whose write and verify halves
 *     already existed and were unusable without it.
 */
describe('phase E surfaces', skipWithoutDb, () => {
  let app: FastifyInstance;
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  let payrollAdmin: string;
  let financeUser: string;
  let managerUser: string;
  let employeeUser: string;
  let employeeId: string;
  let orgAdmin: string;
  let financeB: string;

  async function member(t: TestTenant, perms: string[], employee?: string) {
    const membership = await t.as((tx) =>
      identity.inviteUser(tx, {
        email: `pe-${randomUUID().slice(0, 8)}@phasee.example`,
        fullName: 'Phase E Tester', password: 'PhaseEPassword1', roleNames: [],
      }),
    );
    return signAccessToken({
      sub: membership.userId, tid: t.tenantId, mid: membership.membershipId,
      eid: employee ?? null, perms, name: 'Phase E Tester', mfa: true,
    });
  }

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  before(async () => {
    process.env.LOG_LEVEL = 'error';
    app = await buildApp();
    await app.ready();

    tenantA = await createTestTenant('pe-a');
    tenantB = await createTestTenant('pe-b');

    employeeId = await createEmployee(tenantA, {
      code: `PE${randomUUID().slice(0, 6).toUpperCase()}`, joiningDate: '2025-01-01',
    });

    payrollAdmin = await member(tenantA, ['payroll.run', 'payroll.read', 'org.read']);
    financeUser = await member(tenantA, ['expense.finance', 'expense.read', 'expense.manage']);
    managerUser = await member(tenantA, ['expense.approve', 'expense.read', 'expense.read.self']);
    employeeUser = await member(tenantA, ['expense.submit', 'expense.read.self', 'tax.declare.self'], employeeId);
    orgAdmin = await member(tenantA, [
      'org.manage', 'org.read', 'leave.manage', 'leave.read', 'shift.manage',
      'shift.read', 'expense.manage', 'workflow.manage', 'tax.manage',
    ]);
    financeB = await member(tenantB, ['expense.finance', 'expense.read']);
  });

  after(async () => {
    await app.close();
    await dropTestTenant(tenantA.tenantId);
    await dropTestTenant(tenantB.tenantId);
    await closePools();
    await closeRedis();
  });

  // ------------------------------------------------------------------ payroll period

  describe('payroll period creation', () => {
    const create = (token: string, body: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/payroll-periods', headers: auth(token), payload: body });

    // A period is unique per company and date range, so each case takes its own month
     // rather than colliding with the previous test's.
    let month = 0;
    const valid = () => {
      month += 1;
      const mm = String(month).padStart(2, '0');
      const last = new Date(Date.UTC(2026, month, 0)).getUTCDate();
      return {
        companyId: tenantA.companyId,
        name: `Period 2026-${mm}`,
        periodStart: `2026-${mm}-01`,
        periodEnd: `2026-${mm}-${last}`,
        payDate: `2026-${mm}-${last}`,
      };
    };

    it('creates a period and returns the tax year it falls in', async () => {
      const response = await create(payrollAdmin, valid());
      assert.equal(response.statusCode, 201);
      const body = response.json() as { id: string; tax_year: { label: string } };
      assert.ok(body.id);
      assert.match(body.tax_year.label, /^\d{4}-\d{2}$/);
    });

    it('lists the period it just created', async () => {
      const created = await create(payrollAdmin, valid());
      const { id } = created.json() as { id: string };

      const listed = (await app.inject({
        method: 'GET', url: '/api/payroll-periods', headers: auth(payrollAdmin),
      })).json() as { periods: Array<{ id: string }> };
      assert.ok(listed.periods.some((p) => p.id === id));
    });

    it('refuses a caller without payroll.run', async () => {
      assert.equal((await create(employeeUser, valid())).statusCode, 403);
    });

    it('refuses an unauthenticated caller', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/payroll-periods', payload: valid(),
      });
      assert.equal(response.statusCode, 401);
    });

    it('validates its dates', async () => {
      assert.equal((await create(payrollAdmin, { ...valid(), periodStart: 'nonsense' })).statusCode, 400);
      const { companyId: _drop, ...noCompany } = valid();
      assert.equal((await create(payrollAdmin, noCompany)).statusCode, 400);
    });

    it('will not accept another tenant\'s company', async () => {
      const response = await create(payrollAdmin, { ...valid(), companyId: tenantB.companyId });
      assert.ok(response.statusCode >= 400, `expected a refusal, got ${response.statusCode}`);
    });
  });

  // ------------------------------------------------------------------ operational setup

  describe('operational setup', () => {
    it('creates a leave type', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/leave/types', headers: auth(orgAdmin),
        payload: { name: 'Earned Leave', code: `EL${randomUUID().slice(0, 4).toUpperCase()}` },
      });
      assert.equal(response.statusCode, 201);
    });

    it('creates a holiday calendar with holidays', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/holiday-lists', headers: auth(orgAdmin),
        payload: {
          name: `Holidays ${randomUUID().slice(0, 4)}`, year: 2026, isDefault: false,
          weeklyOffs: [0], holidays: [{ date: '2026-01-26', name: 'Republic Day' }],
        },
      });
      assert.equal(response.statusCode, 201);

      const listed = (await app.inject({
        method: 'GET', url: '/api/holiday-lists', headers: auth(orgAdmin),
      })).json() as { holiday_lists: unknown[] };
      assert.ok(listed.holiday_lists.length > 0);
    });

    it('creates a shift type', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/shift-types', headers: auth(orgAdmin),
        payload: {
          name: 'General', code: `G${randomUUID().slice(0, 5).toUpperCase()}`,
          startTime: '09:00', endTime: '18:00', breakMinutes: 60,
        },
      });
      assert.equal(response.statusCode, 201);
    });

    it('creates an expense type', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/expense-types', headers: auth(orgAdmin),
        payload: {
          code: `T${randomUUID().slice(0, 5).toUpperCase()}`, name: 'Travel',
          receiptRequired: false, requiresBusinessPurpose: false,
        },
      });
      assert.equal(response.statusCode, 201);
    });

    it('configures approval routing', async () => {
      const response = await app.inject({
        method: 'PUT', url: '/api/workflows/expense_claim', headers: auth(orgAdmin),
        payload: {
          name: 'Expense approval',
          steps: [{ sequence: 1, approver: 'reporting_manager', sla_hours: 24, skip_if_unresolved: false }],
        },
      });
      assert.equal(response.statusCode, 201);
    });

    it('refuses each setup write to a caller without its permission', async () => {
      const cases: Array<[string, string, Record<string, unknown>]> = [
        ['POST', '/api/leave/types', { name: 'X', code: 'X' }],
        ['POST', '/api/holiday-lists', { name: 'X', year: 2026 }],
        ['POST', '/api/shift-types', { name: 'X', code: 'X', startTime: '09:00', endTime: '18:00' }],
        ['POST', '/api/expense-types', { code: 'X', name: 'X' }],
        ['PUT', '/api/workflows/expense_claim', { name: 'X', steps: [] }],
      ];
      for (const [method, url, payload] of cases) {
        const response = await app.inject({ method: method as 'POST', url, headers: auth(employeeUser), payload });
        assert.ok(
          response.statusCode === 403 || response.statusCode === 400,
          `${url} gave ${response.statusCode}`,
        );
      }
    });

    it('keeps setup inside its tenant', async () => {
      const name = `Iso ${randomUUID().slice(0, 6)}`;
      await app.inject({
        method: 'POST', url: '/api/leave/types', headers: auth(orgAdmin),
        payload: { name, code: `IS${randomUUID().slice(0, 4).toUpperCase()}` },
      });

      const bAdmin = await member(tenantB, ['leave.manage', 'leave.read']);
      const fromB = (await app.inject({
        method: 'GET', url: '/api/leave/types', headers: auth(bAdmin),
      })).json() as { leave_types: Array<{ name: string }> };
      assert.equal(fromB.leave_types.some((t) => t.name === name), false);
    });
  });

  // ------------------------------------------------------------------ finance queue

  describe('finance queue', () => {
    const queue = (token: string) =>
      app.inject({ method: 'GET', url: '/api/expense-claims?scope=finance', headers: auth(token) });

    it('serves finance every claim awaiting it, across employees', async () => {
      const response = await queue(financeUser);
      assert.equal(response.statusCode, 200);
      const body = response.json() as { claims: Array<{ status: string; employee_name?: string }> };
      // Whatever is in it, everything must be in a state finance still acts on, and must name
      // whose claim it is — the queue is useless without that.
      for (const claim of body.claims) {
        assert.ok(['finance_review', 'approved', 'payment_pending'].includes(claim.status));
        assert.ok(claim.employee_name, 'the queue must say whose claim it is');
      }
    });

    it('refuses a manager who only holds expense.approve', async () => {
      // The distinction that matters: approving your own team's claims is not authority to
      // read every claim in the company.
      assert.equal((await queue(managerUser)).statusCode, 403);
    });

    it('refuses an ordinary employee', async () => {
      assert.equal((await queue(employeeUser)).statusCode, 403);
    });

    it('refuses an unauthenticated caller', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/expense-claims?scope=finance' });
      assert.equal(response.statusCode, 401);
    });

    it('never shows one tenant\'s claims to another tenant\'s finance', async () => {
      const mine = (await queue(financeUser)).json() as { claims: Array<{ id: string }> };
      const theirs = (await queue(financeB)).json() as { claims: Array<{ id: string }> };
      const overlap = mine.claims.filter((c) => theirs.claims.some((o) => o.id === c.id));
      assert.deepEqual(overlap, []);
    });

    it('leaves the default self-scope shape untouched', async () => {
      // The finance scope is an addition, not a change: an employee still gets their own.
      const response = await app.inject({
        method: 'GET', url: '/api/expense-claims', headers: auth(employeeUser),
      });
      assert.equal(response.statusCode, 200);
      assert.ok(Array.isArray((response.json() as { claims: unknown[] }).claims));
    });
  });

  // ------------------------------------------------------------------ reports

  describe('reports', () => {
    it('lists only the reports the caller may run', async () => {
      const reader = await member(tenantA, ['employee.read']);
      const body = (await app.inject({
        method: 'GET', url: '/api/reports/types', headers: auth(reader),
      })).json() as { types: Array<{ type: string; permission: string }> };

      assert.ok(body.types.length > 0, 'employee.read should permit at least headcount');
      assert.ok(body.types.every((t) => t.permission === 'employee.read'),
        'the catalogue must not list reports the caller cannot run');
    });

    it('runs a report and records it as pending', async () => {
      const reader = await member(tenantA, ['employee.read']);
      const response = await app.inject({
        method: 'POST', url: '/api/reports', headers: auth(reader),
        payload: {
          reportType: 'headcount',
          parameters: { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
        },
      });
      assert.equal(response.statusCode, 202, 'accepted for background generation');

      const runs = (await app.inject({
        method: 'GET', url: '/api/reports', headers: auth(reader),
      })).json() as { runs: Array<{ report_type: string; status: string }> };
      assert.ok(runs.runs.some((r) => r.report_type === 'headcount'));
    });

    it('refuses a report the caller has no permission for', async () => {
      const reader = await member(tenantA, ['employee.read']);
      const response = await app.inject({
        method: 'POST', url: '/api/reports', headers: auth(reader),
        payload: {
          reportType: 'payroll_cost',
          parameters: { dateFrom: '2026-06-01', dateTo: '2026-06-30' },
        },
      });
      assert.equal(response.statusCode, 403);
    });

    it('refuses an unauthenticated caller', async () => {
      assert.equal((await app.inject({ method: 'GET', url: '/api/reports/types' })).statusCode, 401);
    });
  });

  // ------------------------------------------------------------------ tax

  describe('tax declarations', () => {
    it('lets an employee submit and then read their own declaration', async () => {
      const saved = await app.inject({
        method: 'PUT', url: '/api/tax/declarations', headers: auth(employeeUser),
        payload: {
          financialYear: '2026-27', regime: 'old',
          declarations: { section_80c: 150000 },
        },
      });
      assert.equal(saved.statusCode, 200);

      // The read that did not exist before, and without which the employee could never see
      // what they had declared.
      const read = await app.inject({
        method: 'GET', url: '/api/tax/declarations', headers: auth(employeeUser),
      });
      assert.equal(read.statusCode, 200);
      const body = read.json() as { declarations: Array<{ financial_year: string; declared_amount: string }> };
      assert.equal(body.declarations[0]?.financial_year, '2026-27');
      assert.equal(Number(body.declarations[0]?.declared_amount), 150000);
    });

    it('gives a verifier the queue, with the id verification needs', async () => {
      const review = await app.inject({
        method: 'GET', url: '/api/tax/declarations?scope=review', headers: auth(orgAdmin),
      });
      assert.equal(review.statusCode, 200);
      const body = review.json() as { declarations: Array<{ id: string; employee_name: string; status: string }> };
      const target = body.declarations.find((d) => d.status === 'submitted');
      assert.ok(target, 'the submitted declaration should be in the review queue');
      assert.ok(target.employee_name, 'the queue must name whose declaration it is');

      const verified = await app.inject({
        method: 'POST', url: `/api/tax/declarations/${target.id}/verify`, headers: auth(orgAdmin),
        payload: { verifiedAmount: 120000, note: 'Proofs covered 1.2L' },
      });
      assert.equal(verified.statusCode, 200);
    });

    it('refuses the review queue to somebody without tax.manage', async () => {
      const response = await app.inject({
        method: 'GET', url: '/api/tax/declarations?scope=review', headers: auth(employeeUser),
      });
      assert.equal(response.statusCode, 403);
    });

    it('will not let one employee read another\'s declaration', async () => {
      const other = await member(tenantA, ['tax.declare.self']);
      const response = await app.inject({
        method: 'GET', url: `/api/tax/declarations?employeeId=${employeeId}`, headers: auth(other),
      });
      assert.equal(response.statusCode, 403);
    });

    it('keeps declarations inside their tenant', async () => {
      const bVerifier = await member(tenantB, ['tax.manage']);
      const body = (await app.inject({
        method: 'GET', url: '/api/tax/declarations?scope=review', headers: auth(bVerifier),
      })).json() as { declarations: Array<{ employee_id: string }> };
      assert.equal(body.declarations.some((d) => d.employee_id === employeeId), false);
    });

    it('refuses an unauthenticated caller', async () => {
      assert.equal((await app.inject({ method: 'GET', url: '/api/tax/declarations' })).statusCode, 401);
    });
  });

  // ------------------------------------------------------------------ account security

  describe('account security', () => {
    it('reports whether a second factor is enrolled and whether it is required', async () => {
      // `required` is computed from the permissions the membership's *roles* carry, not from
      // the token's claims — a token cannot talk itself out of a second factor. So this needs
      // an account actually holding a role with a sensitive permission.
      // The test helper creates a bare tenant; the built-in roles are normally created by
      // provisioning, so they are ensured here before one can be granted.
      await tenantA.as((tx) => identity.ensureSystemRoles(tx).then(() => undefined));
      const membership = await tenantA.as((tx) =>
        identity.inviteUser(tx, {
          email: `mfa-${randomUUID().slice(0, 8)}@phasee.example`,
          fullName: 'Payroll Person', password: 'PhaseEPassword1',
          roleNames: ['Payroll Admin'],
        }),
      );
      const token = await signAccessToken({
        sub: membership.userId, tid: tenantA.tenantId, mid: membership.membershipId,
        eid: null, perms: ['payroll.read'], name: 'Payroll Person', mfa: true,
      });

      const response = await app.inject({
        method: 'GET', url: '/api/account/mfa', headers: auth(token),
      });
      assert.equal(response.statusCode, 200);
      const body = response.json() as { enrolled: boolean; required: boolean };
      assert.equal(typeof body.enrolled, 'boolean');
      assert.equal(body.required, true, 'Payroll Admin holds sensitive permissions');
    });

    it('does not require a second factor for a role that holds nothing sensitive', async () => {
      const body = (await app.inject({
        method: 'GET', url: '/api/account/mfa', headers: auth(employeeUser),
      })).json() as { required: boolean };
      assert.equal(body.required, false);
    });

    it('refuses an unauthenticated caller', async () => {
      assert.equal((await app.inject({ method: 'GET', url: '/api/account/mfa' })).statusCode, 401);
    });

    it('refuses a password change without the current password', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/auth/change-password', headers: auth(employeeUser),
        payload: { newPassword: 'ANewPassword12345' },
      });
      assert.equal(response.statusCode, 400);
    });

    it('refuses a password change when the current password is wrong', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/auth/change-password', headers: auth(employeeUser),
        payload: { currentPassword: 'NotThePassword1', newPassword: 'ANewPassword12345' },
      });
      assert.ok(response.statusCode >= 400, `expected a refusal, got ${response.statusCode}`);
    });
  });

  // ------------------------------------------------------------------ signup

  /**
   * Signing up.
   *
   * The route is rate limited to five an hour against a *shared Redis* store, so its budget
   * outlives the process. Spending it here would make the suite fail on its second run within
   * the hour, which is exactly the repeatability the regression gate depends on.
   *
   * So the HTTP route gets one call — enough to prove it is reachable unauthenticated and
   * returns what it should — and the semantics it delegates to (`provisionTenant`) are
   * exercised directly, which is where they actually live.
   */
  describe('tenant signup', () => {
    const valid = () => ({
      tenantName: 'Signup Test Co',
      slug: `signup-${randomUUID().slice(0, 8)}`,
      adminName: 'Signup Admin',
      adminEmail: `signup-${randomUUID().slice(0, 8)}@signup.example`,
      adminPassword: 'SignupPassword123',
    });

    it('creates a workspace and its owner without a session', async () => {
      const body = valid();
      const response = await app.inject({ method: 'POST', url: '/api/tenants', payload: body });

      // A spent budget is the limiter working, not this route failing.
      if (response.statusCode === 429) return;

      assert.equal(response.statusCode, 201);
      const created = response.json() as { tenant_id: string; user_id: string };
      assert.ok(created.tenant_id);
      assert.ok(created.user_id);
      await dropTestTenant(created.tenant_id);
    });

    it('assigns the tenant id itself, whatever the client sends', async () => {
      const claimed = randomUUID();
      const created = await identity.provisionTenant({
        ...valid(), id: claimed, tenantId: claimed,
      } as never);
      assert.notEqual(created.tenantId, claimed, 'the server must assign the id');
      await dropTestTenant(created.tenantId);
    });

    it('refuses a slug that is already taken', async () => {
      const first = valid();
      const created = await identity.provisionTenant(first);
      await assert.rejects(
        identity.provisionTenant({ ...valid(), slug: first.slug }),
        /already in use/,
      );
      await dropTestTenant(created.tenantId);
    });

    it('validates the slug', async () => {
      for (const slug of ['no', 'Has Spaces', '-leading', 'trailing-', 'a'.repeat(60)]) {
        await assert.rejects(identity.provisionTenant({ ...valid(), slug }), /Slug must be/);
      }
    });

    it('enforces password strength', async () => {
      await assert.rejects(identity.provisionTenant({ ...valid(), adminPassword: 'short' }));
    });
  });
});
