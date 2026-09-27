import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app.ts';
import { closePools } from '../../src/infra/db/pool.ts';
import { closeRedis } from '../../src/infra/redis.ts';
import { signAccessToken } from '../../src/http/auth.ts';
import * as identity from '../../src/modules/identity/service.ts';
import { createTestTenant, dropTestTenant, skipWithoutDb, type TestTenant } from './helpers.ts';

/**
 * The workflows the product experience phase completed: creating an employee, moving them
 * through their employment, starting onboarding, and setting the organization up.
 *
 * These are the paths that turn an empty workspace into a working one, so the questions worth
 * asking are the boring ones — does an unprivileged caller get refused, does a neighbouring
 * tenant stay invisible, and does the record actually change when the API says it did.
 */
describe('lifecycle and organization workflows', skipWithoutDb, () => {
  let app: FastifyInstance;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let hr: string;
  let plain: string;
  let hrB: string;
  let companyId: string;

  async function member(t: TestTenant, permissions: string[]) {
    const email = `lc-${randomUUID().slice(0, 8)}@lifecycle.example`;
    const membership = await t.as((tx) =>
      identity.inviteUser(tx, {
        email, fullName: 'Lifecycle Tester', password: 'LifecyclePass1', roleNames: [],
      }),
    );
    return signAccessToken({
      sub: membership.userId, tid: t.tenantId, mid: membership.membershipId,
      eid: null, perms: permissions, name: 'Lifecycle Tester', mfa: true,
    });
  }

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const HR_PERMS = [
    'employee.manage', 'employee.read', 'employee.lifecycle',
    'onboarding.manage', 'onboarding.read', 'org.read', 'org.manage',
  ];

  before(async () => {
    process.env.LOG_LEVEL = 'error';
    app = await buildApp();
    await app.ready();

    tenantA = await createTestTenant('lc-a');
    tenantB = await createTestTenant('lc-b');

    hr = await member(tenantA, HR_PERMS);
    plain = await member(tenantA, ['employee.read.self']);
    hrB = await member(tenantB, HR_PERMS);

    companyId = tenantA.companyId;
  });

  after(async () => {
    await app.close();
    await dropTestTenant(tenantA.tenantId);
    await dropTestTenant(tenantB.tenantId);
    await closePools();
    await closeRedis();
  });

  // ------------------------------------------------------------------ employee creation

  describe('creating an employee', () => {
    const create = (token: string, body: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/employees', headers: auth(token), payload: body });

    const valid = () => ({
      firstName: 'Asha', lastName: 'Menon',
      companyId, joiningDate: '2026-04-01',
      employeeCode: `LC${randomUUID().slice(0, 6).toUpperCase()}`,
      employmentStatus: 'onboarding',
    });

    it('creates the employee and returns it in the directory', async () => {
      const response = await create(hr, valid());
      assert.equal(response.statusCode, 201);
      const { id } = response.json() as { id: string };

      const listed = (await app.inject({
        method: 'GET', url: '/api/employees?scope=all&limit=200', headers: auth(hr),
      })).json() as { employees: Array<{ id: string; employment_status: string }> };

      const found = listed.employees.find((e) => e.id === id);
      assert.ok(found, 'a created employee must appear in the directory immediately');
      assert.equal(found.employment_status, 'onboarding');
    });

    it('refuses a caller without employee.manage', async () => {
      assert.equal((await create(plain, valid())).statusCode, 403);
    });

    it('refuses an unauthenticated caller', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/employees', payload: valid(),
      });
      assert.equal(response.statusCode, 401);
    });

    it('validates what the product depends on', async () => {
      // A company is what ties the employee to payroll and statutory registration.
      const { companyId: _drop, ...noCompany } = valid();
      assert.equal((await create(hr, noCompany)).statusCode, 400);
      assert.equal((await create(hr, { ...valid(), joiningDate: 'not-a-date' })).statusCode, 400);
      assert.equal((await create(hr, { ...valid(), firstName: '' })).statusCode, 400);
      assert.equal((await create(hr, { ...valid(), workEmail: 'not-an-email' })).statusCode, 400);
    });

    it('will not attach an employee to another tenant\'s company', async () => {
      // The company id is a real uuid, just not one this tenant owns — RLS means the insert
      // cannot see it, so this must fail rather than silently creating a cross-tenant link.
      const response = await create(hr, { ...valid(), companyId: tenantB.companyId });
      assert.ok(response.statusCode >= 400, `expected a refusal, got ${response.statusCode}`);
    });

    it('keeps one tenant\'s people out of another\'s directory', async () => {
      const created = await create(hr, valid());
      const { id } = created.json() as { id: string };

      const fromB = await app.inject({
        method: 'GET', url: `/api/employees/${id}`, headers: auth(hrB),
      });
      assert.equal(fromB.statusCode, 404);
    });
  });

  // ------------------------------------------------------------------ lifecycle

  describe('employment changes', () => {
    let employeeId: string;

    before(async () => {
      const created = await app.inject({
        method: 'POST', url: '/api/employees', headers: auth(hr),
        payload: {
          firstName: 'Ravi', lastName: 'Kulkarni', companyId, joiningDate: '2026-01-05',
          employeeCode: `LCC${randomUUID().slice(0, 5).toUpperCase()}`,
          employmentStatus: 'probation',
        },
      });
      employeeId = (created.json() as { id: string }).id;
    });

    it('records a change and moves the authoritative status', async () => {
      const response = await app.inject({
        method: 'POST', url: `/api/employees/${employeeId}/lifecycle`, headers: auth(hr),
        payload: {
          changeReason: 'confirmation',
          effectiveFrom: '2026-07-01',
          employmentStatus: 'active',
        },
      });
      assert.equal(response.statusCode, 201);

      const after = (await app.inject({
        method: 'GET', url: `/api/employees/${employeeId}`, headers: auth(hr),
      })).json() as { employment_status: string };
      assert.equal(after.employment_status, 'active', 'the server state is what changed');
    });

    it('writes the change to employment history', async () => {
      const history = (await app.inject({
        method: 'GET', url: `/api/employees/${employeeId}/employment-history`, headers: auth(hr),
      })).json() as { history: Array<{ change_reason: string }> };
      assert.ok(history.history.some((row) => row.change_reason === 'confirmation'));
    });

    it('refuses a caller without employee.lifecycle', async () => {
      const response = await app.inject({
        method: 'POST', url: `/api/employees/${employeeId}/lifecycle`, headers: auth(plain),
        payload: { changeReason: 'promotion', effectiveFrom: '2026-08-01' },
      });
      assert.equal(response.statusCode, 403);
    });

    it('rejects a reason the backend does not define', async () => {
      const response = await app.inject({
        method: 'POST', url: `/api/employees/${employeeId}/lifecycle`, headers: auth(hr),
        payload: { changeReason: 'vibes', effectiveFrom: '2026-08-01' },
      });
      assert.equal(response.statusCode, 400);
    });

    it('cannot be driven from another tenant', async () => {
      const response = await app.inject({
        method: 'POST', url: `/api/employees/${employeeId}/lifecycle`, headers: auth(hrB),
        payload: { changeReason: 'promotion', effectiveFrom: '2026-08-01' },
      });
      assert.ok(response.statusCode === 404 || response.statusCode === 403,
        `expected a refusal, got ${response.statusCode}`);
    });

    it('records separation with a mandatory reason', async () => {
      assert.equal(
        (await app.inject({
          method: 'POST', url: `/api/employees/${employeeId}/separate`, headers: auth(hr),
          payload: { exitDate: '2026-09-30' },
        })).statusCode,
        400,
        'a separation with no reason must be refused',
      );

      const response = await app.inject({
        method: 'POST', url: `/api/employees/${employeeId}/separate`, headers: auth(hr),
        payload: { exitDate: '2026-09-30', reason: 'Resigned to study' },
      });
      assert.equal(response.statusCode, 200);

      const after = (await app.inject({
        method: 'GET', url: `/api/employees/${employeeId}`, headers: auth(hr),
      })).json() as { exit_date: string | null };
      assert.equal(after.exit_date, '2026-09-30');
    });
  });

  // ------------------------------------------------------------------ onboarding

  describe('starting onboarding', () => {
    let employeeId: string;

    before(async () => {
      const created = await app.inject({
        method: 'POST', url: '/api/employees', headers: auth(hr),
        payload: {
          firstName: 'Nisha', lastName: 'Verma', companyId, joiningDate: '2026-05-04',
          employeeCode: `LCO${randomUUID().slice(0, 5).toUpperCase()}`,
          employmentStatus: 'onboarding',
        },
      });
      employeeId = (created.json() as { id: string }).id;

      const template = await app.inject({
        method: 'POST', url: '/api/onboarding/templates', headers: auth(hr),
        payload: {
          name: 'Standard joiner',
          tasks: [
            { sequenceNo: 1, title: 'Sign the contract', category: 'document', isMandatory: true, dueOffsetDays: 0 },
            { sequenceNo: 2, title: 'Set up the laptop', category: 'it_asset', isMandatory: false, dueOffsetDays: 1 },
          ],
        },
      });
      // Asserted, so a template that failed to build cannot masquerade as a plan defect.
      assert.equal(template.statusCode, 201, 'the template must exist before a plan can use it');
    });

    it('creates a plan with its tasks', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/onboarding/plans', headers: auth(hr),
        payload: { employeeId },
      });
      assert.equal(response.statusCode, 201);

      const body = response.json() as { id: string; task_count: number };
      assert.ok(body.task_count > 0, 'starting onboarding must actually generate tasks');

      const plan = (await app.inject({
        method: 'GET', url: `/api/onboarding/plans/${body.id}`, headers: auth(hr),
      })).json() as { tasks: Array<{ title: string; status: string }> };
      assert.equal(plan.tasks.length, body.task_count);
      assert.ok(plan.tasks.every((t) => t.status === 'pending'));
    });

    it('refuses a caller without onboarding.manage', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/onboarding/plans', headers: auth(plain),
        payload: { employeeId },
      });
      assert.equal(response.statusCode, 403);
    });

    it('cannot start a plan for another tenant\'s employee', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/onboarding/plans', headers: auth(hrB),
        payload: { employeeId },
      });
      assert.ok(response.statusCode >= 400, `expected a refusal, got ${response.statusCode}`);
    });
  });

  // ------------------------------------------------------------------ organization setup

  describe('organization setup', () => {
    it('creates and lists each collection the setup screen uses', async () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['companies', { name: `Co ${randomUUID().slice(0, 5)}`, legalName: 'Co Private Limited' }],
        ['locations', { name: `Loc ${randomUUID().slice(0, 5)}`, timezone: 'Asia/Kolkata', stateCode: 'KA' }],
        ['departments', { name: `Dept ${randomUUID().slice(0, 5)}` }],
        ['designations', { name: `Desig ${randomUUID().slice(0, 5)}` }],
      ];

      for (const [path, payload] of cases) {
        const created = await app.inject({
          method: 'POST', url: `/api/${path}`, headers: auth(hr), payload,
        });
        assert.equal(created.statusCode, 201, `${path} should have been created`);

        const listed = (await app.inject({
          method: 'GET', url: `/api/${path}`, headers: auth(hr),
        })).json() as Record<string, Array<{ id: string }>>;
        const { id } = created.json() as { id: string };
        assert.ok(listed[path]!.some((row) => row.id === id), `${path} should list what it created`);
      }
    });

    it('refuses an unprivileged caller', async () => {
      assert.equal(
        (await app.inject({
          method: 'POST', url: '/api/departments', headers: auth(plain), payload: { name: 'Nope' },
        })).statusCode,
        403,
      );
      assert.equal(
        (await app.inject({ method: 'GET', url: '/api/departments', headers: auth(plain) })).statusCode,
        403,
      );
    });

    it('validates before writing', async () => {
      assert.equal(
        (await app.inject({
          method: 'POST', url: '/api/companies', headers: auth(hr), payload: { name: 'Missing legal name' },
        })).statusCode,
        400,
      );
    });

    it('keeps each tenant\'s organization to itself', async () => {
      const name = `Iso ${randomUUID().slice(0, 6)}`;
      await app.inject({
        method: 'POST', url: '/api/departments', headers: auth(hr), payload: { name },
      });

      const fromB = (await app.inject({
        method: 'GET', url: '/api/departments', headers: auth(hrB),
      })).json() as { departments: Array<{ name: string }> };

      assert.equal(fromB.departments.some((d) => d.name === name), false,
        'a department created in one tenant must be invisible in another');
    });
  });
});
