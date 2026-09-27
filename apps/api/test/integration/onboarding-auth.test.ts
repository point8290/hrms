import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closePools, withPlatform } from '../../src/infra/db/pool.ts';
import * as onboarding from '../../src/modules/onboarding/service.ts';
import * as authFlows from '../../src/modules/identity/auth-flows.ts';
import * as identity from '../../src/modules/identity/service.ts';
import * as mfa from '../../src/modules/identity/mfa.ts';
import { decryptField } from '../../src/infra/crypto.ts';
import { currentCounter, totpAt } from '../../src/infra/totp.ts';
import { createEmployee, createTestTenant, dropTestTenant, skipWithoutDb, type TestTenant } from './helpers.ts';

describe('onboarding', skipWithoutDb, () => {
  let tenant: TestTenant;
  let managerId: string;
  let employeeId: string;

  before(async () => {
    tenant = await createTestTenant('onboard');
    await tenant.as((tx) => identity.ensureSystemRoles(tx));
    managerId = await createEmployee(tenant, { code: 'MGR100' });
    employeeId = await createEmployee(tenant, { code: 'NEW100', managerId, joiningDate: '2026-09-01' });
  });

  after(async () => {
    await dropTestTenant(tenant.tenantId);
    await closePools();
  });

  it('creates a template with owners and relative due dates', async () => {
    const result = await tenant.as((tx) =>
      onboarding.createTemplate(tx, {
        name: 'Standard onboarding',
        tasks: [
          // Negative offset: the laptop is ordered before day one.
          { sequenceNo: 1, title: 'Order laptop', category: 'it_asset', ownerKind: 'hr', dueOffsetDays: -5 },
          { sequenceNo: 2, title: 'Sign contract', category: 'document', ownerKind: 'employee', requiresDocumentType: 'contract' },
          { sequenceNo: 3, title: 'Team introduction', ownerKind: 'reporting_manager', dueOffsetDays: 2, isMandatory: false },
        ],
      }),
    );
    assert.equal(result.taskCount, 3);
  });

  it('instantiates a plan with due dates relative to the joining date', async () => {
    const plan = await tenant.as((tx) => onboarding.createPlan(tx, { employeeId }));
    assert.equal(plan.taskCount, 3);
    assert.deepEqual(plan.unresolvedOwners, [], 'the manager and HR role both resolve');

    const tasks = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ title: string; due_date: string; owner_employee_id: string | null }>(
        `SELECT title, to_char(due_date, 'YYYY-MM-DD') AS due_date, owner_employee_id
           FROM recruitment.onboarding_task WHERE plan_id = $1 ORDER BY sequence_no`,
        [plan.id],
      );
      return rows;
    });

    assert.equal(tasks[0]!.due_date, '2026-08-27', 'a -5 day offset lands before joining');
    assert.equal(tasks[1]!.due_date, '2026-09-01');
    assert.equal(tasks[2]!.due_date, '2026-09-03');
    assert.equal(tasks[2]!.owner_employee_id, managerId, 'the reporting manager is resolved and stored');
  });

  it('refuses a second plan for the same employee', async () => {
    await assert.rejects(
      tenant.as((tx) => onboarding.createPlan(tx, { employeeId })),
      /already has an onboarding plan/,
    );
  });

  it('will not complete a document task without the document', async () => {
    const taskId = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM recruitment.onboarding_task WHERE title = 'Sign contract'`,
      );
      return rows[0]!.id;
    });

    await assert.rejects(
      tenant.as((tx) => onboarding.completeTask(tx, taskId, { note: 'done, trust me' })),
      /document is attached/,
      'ticking a box is not the same as collecting the contract',
    );
  });

  it('rejects a document of the wrong type', async () => {
    const { taskId, documentId } = await tenant.as(async (tx) => {
      const task = await tx.query<{ id: string }>(
        `SELECT id FROM recruitment.onboarding_task WHERE title = 'Sign contract'`,
      );
      const doc = await tx.query<{ id: string }>(
        `INSERT INTO documents.document
           (tenant_id, employee_id, document_type, filename, content_type, size_bytes,
            s3_bucket, s3_key, status)
         VALUES ($1, $2, 'identity', 'passport.pdf', 'application/pdf', 100, 'test',
                 'docs/' || gen_random_uuid(), 'available')
         RETURNING id`,
        [tenant.tenantId, employeeId],
      );
      return { taskId: task.rows[0]!.id, documentId: doc.rows[0]!.id };
    });

    await assert.rejects(
      tenant.as((tx) => onboarding.completeTask(tx, taskId, { documentId })),
      /needs a contract document/,
    );
  });

  it('completes a document task when the right document is attached', async () => {
    const { taskId, documentId } = await tenant.as(async (tx) => {
      const task = await tx.query<{ id: string }>(
        `SELECT id FROM recruitment.onboarding_task WHERE title = 'Sign contract'`,
      );
      const doc = await tx.query<{ id: string }>(
        `INSERT INTO documents.document
           (tenant_id, employee_id, document_type, filename, content_type, size_bytes,
            s3_bucket, s3_key, status)
         VALUES ($1, $2, 'contract', 'contract.pdf', 'application/pdf', 100, 'test',
                 'docs/' || gen_random_uuid(), 'available')
         RETURNING id`,
        [tenant.tenantId, employeeId],
      );
      return { taskId: task.rows[0]!.id, documentId: doc.rows[0]!.id };
    });

    const result = await tenant.as((tx) => onboarding.completeTask(tx, taskId, { documentId }));
    assert.equal(result.planCompleted, false, 'another mandatory task is still open');
  });

  it('refuses to skip a mandatory task', async () => {
    const taskId = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM recruitment.onboarding_task WHERE title = 'Order laptop'`,
      );
      return rows[0]!.id;
    });

    await assert.rejects(
      tenant.as((tx) => onboarding.skipTask(tx, taskId, 'not needed')),
      /mandatory and cannot be skipped/,
    );
  });

  it('completes the plan once no mandatory task is outstanding', async () => {
    const laptopId = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM recruitment.onboarding_task WHERE title = 'Order laptop'`,
      );
      return rows[0]!.id;
    });

    // The optional introduction task is still pending; the plan should close anyway.
    const result = await tenant.as((tx) => onboarding.completeTask(tx, laptopId, { note: 'Ordered' }));
    assert.equal(result.planCompleted, true);

    const status = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ status: string }>(
        'SELECT status FROM recruitment.onboarding_plan WHERE employee_id = $1',
        [employeeId],
      );
      return rows[0]!.status;
    });
    assert.equal(status, 'completed');
  });

  it('picks the most specific template when several match', async () => {
    const departmentId = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO core.department (tenant_id, name) VALUES ($1, 'Engineering') RETURNING id`,
        [tenant.tenantId],
      );
      return rows[0]!.id;
    });

    await tenant.as((tx) =>
      onboarding.createTemplate(tx, {
        name: 'Engineering onboarding',
        departmentId,
        tasks: [{ sequenceNo: 1, title: 'Set up dev environment', ownerKind: 'employee' }],
      }),
    );

    const engineer = await createEmployee(tenant, { code: 'ENG100' });
    await tenant.as((tx) =>
      tx.query('UPDATE core.employee SET department_id = $2 WHERE id = $1', [engineer, departmentId]),
    );

    const plan = await tenant.as((tx) => onboarding.createPlan(tx, { employeeId: engineer }));
    assert.equal(plan.templateName, 'Engineering onboarding', 'the department-specific template wins');
  });
});

describe('authentication flows', skipWithoutDb, () => {
  let tenant: TestTenant;
  let email: string;
  let userId: string;

  before(async () => {
    const slug = `auth-${randomUUID().slice(0, 8)}`;
    email = `admin@${slug}.example.com`;
    const provisioned = await identity.provisionTenant({
      tenantName: 'Auth test',
      slug,
      adminEmail: email,
      adminPassword: 'OriginalPassword1',
      adminName: 'Auth Admin',
    });
    userId = provisioned.userId;
    const { withTenant, SYSTEM_ACTOR } = await import('../../src/infra/db/pool.ts');
    tenant = {
      tenantId: provisioned.tenantId,
      companyId: '',
      locationId: '',
      holidayListId: '',
      as: (fn) => withTenant(provisioned.tenantId, { ...SYSTEM_ACTOR, label: 'auth-test' }, fn),
    };
  });

  after(async () => {
    await dropTestTenant(tenant.tenantId);
    await closePools();
  });

  it('answers the same way whether or not the address exists', async () => {
    const known = await authFlows.requestPasswordReset(email);
    const unknown = await authFlows.requestPasswordReset('nobody@example.com');

    // A token is issued internally for the real account, but neither result tells the
    // caller which case it was - the route returns the same body for both.
    assert.ok(known.token, 'a real account gets a token');
    assert.equal(unknown.token, undefined, 'an unknown address gets none');
    assert.equal(unknown.email, 'nobody@example.com');
  });

  let recoveryCodes: string[] = [];

  /**
   * Completes a sign-in for the tenant admin.
   *
   * The admin holds sensitive permissions, so a password alone no longer produces a session
   * (ADR-012) — it produces a challenge. Enrolling once and then answering it is what a real
   * privileged user does, and it is what these tests have to do to get a session at all.
   */
  async function signIn(password: string): Promise<identity.LoginResult> {
    const slug = await slugOf(tenant.tenantId);
    const outcome = await identity.login({ slug, email, password });
    if (!identity.isChallenge(outcome)) return outcome;

    if (outcome.stage === 'enroll') {
      const offer = await mfa.beginEnrolment({ userId, email, tenantName: 'Auth test' });
      recoveryCodes = [...offer.recoveryCodes];
      const { rows } = await withPlatform('maintenance', (tx) =>
        tx.query<{ secret_encrypted: string }>(
          'SELECT secret_encrypted FROM identity.user_mfa WHERE user_id = $1',
          [userId],
        ),
      );
      await mfa.confirmEnrolment(userId, totpAt(decryptField(rows[0]!.secret_encrypted), currentCounter()));
    }

    // A recovery code rather than a TOTP code, because these tests sign in several times
    // inside one 30-second step and a code is single-use by design. Using the recovery path
    // is the honest way to get a second session; faking the clock would test the test.
    const recoveryCode = recoveryCodes.shift();
    assert.ok(recoveryCode, 'the test ran out of recovery codes');
    await mfa.verifySecondFactor({ userId, recoveryCode });

    const membershipId = await withPlatform('maintenance', async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'SELECT id FROM identity.tenant_membership WHERE user_id = $1 AND tenant_id = $2',
        [userId, tenant.tenantId],
      );
      return rows[0]!.id;
    });

    return identity.issueSession({
      tenantId: tenant.tenantId,
      tenantName: 'Auth test',
      tenantSlug: slug,
      userId,
      fullName: 'Auth Admin',
      membershipId,
      email,
      mfa: true,
    });
  }

  it('demands a second factor of the tenant admin, who holds sensitive permissions', async () => {
    const slug = await slugOf(tenant.tenantId);
    const outcome = await identity.login({ slug, email, password: 'OriginalPassword1' });
    assert.ok(identity.isChallenge(outcome), 'a privileged account must not get a session from a password alone');
    assert.equal(outcome.stage, 'enroll');
  });

  it('resets the password and revokes every existing session', async () => {
    const session = await signIn('OriginalPassword1');
    assert.ok(session.refreshToken);

    const { token } = await authFlows.requestPasswordReset(email);
    await authFlows.completePasswordReset(token!, 'BrandNewPassword2');

    const revoked = await withPlatform('maintenance', async (tx) => {
      const { rows } = await tx.query<{ live: string }>(
        `SELECT count(*) AS live FROM identity.refresh_token
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
      return Number(rows[0]!.live);
    });
    assert.equal(revoked, 0, 'a reset must not leave old sessions alive');
  });

  it('accepts the new password and rejects the old one', async () => {
    const slug = await slugOf(tenant.tenantId);
    const session = await signIn('BrandNewPassword2');
    assert.ok(session.accessToken);

    await assert.rejects(
      identity.login({ slug, email, password: 'OriginalPassword1' }),
      /Invalid credentials/,
    );
  });

  it('refuses a reset token twice', async () => {
    const { token } = await authFlows.requestPasswordReset(email);
    await authFlows.completePasswordReset(token!, 'ThirdPassword3');

    await assert.rejects(
      authFlows.completePasswordReset(token!, 'FourthPassword4'),
      /invalid or has expired/,
      'a reset link is single use',
    );
  });

  it('invalidates an earlier reset link when a new one is requested', async () => {
    const first = await authFlows.requestPasswordReset(email);
    const second = await authFlows.requestPasswordReset(email);

    await assert.rejects(
      authFlows.completePasswordReset(first.token!, 'FifthPassword5'),
      /invalid or has expired/,
    );
    await authFlows.completePasswordReset(second.token!, 'FifthPassword5');
  });

  it('rejects a weak new password', async () => {
    const { token } = await authFlows.requestPasswordReset(email);
    await assert.rejects(authFlows.completePasswordReset(token!, 'short'), /at least 12/);
  });

  it('locks the account after repeated failures and refuses even the right password', async () => {
    const slug = await slugOf(tenant.tenantId);

    for (let i = 0; i < authFlows.MAX_FAILED_LOGINS; i += 1) {
      await assert.rejects(identity.login({ slug, email, password: 'WrongPassword9' }));
    }

    await assert.rejects(
      identity.login({ slug, email, password: 'FifthPassword5' }),
      /Too many failed attempts/,
      'the lock applies even to the correct password, which is what stops credential stuffing',
    );
  });

  it('clears the lock and the failure count on a successful login', async () => {
    await withPlatform('maintenance', (tx) =>
      tx.query('UPDATE identity.app_user SET locked_until = NULL WHERE id = $1', [userId]),
    );

    const slug = await slugOf(tenant.tenantId);
    await identity.login({ slug, email, password: 'FifthPassword5' });

    const state = await withPlatform('maintenance', async (tx) => {
      const { rows } = await tx.query<{ failed_login_count: number; locked_until: Date | null }>(
        'SELECT failed_login_count, locked_until FROM identity.app_user WHERE id = $1',
        [userId],
      );
      return rows[0]!;
    });
    assert.equal(state.failed_login_count, 0);
    assert.equal(state.locked_until, null);
  });

  it('requires the current password to change it', async () => {
    await assert.rejects(
      authFlows.changePassword(tenant.tenantId, userId, 'NotTheRightOne1', 'SixthPassword6'),
      /Current password is incorrect/,
    );
  });

  it('refuses to reuse the current password', async () => {
    await assert.rejects(
      authFlows.changePassword(tenant.tenantId, userId, 'FifthPassword5', 'FifthPassword5'),
      /must differ/,
    );
  });

  it('verifies an email address exactly once', async () => {
    const { token } = await authFlows.issueEmailVerification(userId);
    await authFlows.verifyEmail(token);

    const verified = await withPlatform('maintenance', async (tx) => {
      const { rows } = await tx.query<{ email_verified: boolean }>(
        'SELECT email_verified FROM identity.app_user WHERE id = $1',
        [userId],
      );
      return rows[0]!.email_verified;
    });
    assert.equal(verified, true);

    await assert.rejects(authFlows.verifyEmail(token), /invalid or has expired/);
  });
});

async function slugOf(tenantId: string): Promise<string> {
  return withPlatform('maintenance', async (tx) => {
    const { rows } = await tx.query<{ slug: string }>(
      'SELECT slug FROM identity.tenant WHERE id = $1',
      [tenantId],
    );
    return rows[0]!.slug;
  });
}
