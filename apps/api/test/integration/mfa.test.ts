import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { closePools, withPlatform } from '../../src/infra/db/pool.ts';
import { currentCounter, generateTotpSecret, totpAt, verifyTotp } from '../../src/infra/totp.ts';
import * as identity from '../../src/modules/identity/service.ts';
import {
  beginEnrolment,
  confirmEnrolment,
  disableMfa,
  mfaState,
  verifySecondFactor,
} from '../../src/modules/identity/mfa.ts';
import { createTestTenant, dropTestTenant, skipWithoutDb, type TestTenant } from './helpers.ts';

/**
 * TOTP arithmetic, checked against RFC 6238's published vectors.
 *
 * These matter more than they look: a wrong byte order or a wrong truncation produces codes
 * that are stable, plausible and rejected by every real authenticator app — a bug nobody
 * finds until an administrator is locked out.
 */
describe('TOTP', () => {
  // RFC 6238 Appendix B, SHA-1: the ASCII secret "12345678901234567890" base32-encoded.
  const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  it('matches the RFC 6238 SHA-1 test vectors', () => {
    // counter = unix time / 30
    assert.equal(totpAt(RFC_SECRET, Math.floor(59 / 30)), '287082');
    assert.equal(totpAt(RFC_SECRET, Math.floor(1111111109 / 30)), '081804');
    assert.equal(totpAt(RFC_SECRET, Math.floor(1111111111 / 30)), '050471');
    assert.equal(totpAt(RFC_SECRET, Math.floor(1234567890 / 30)), '005924');
    assert.equal(totpAt(RFC_SECRET, Math.floor(2000000000 / 30)), '279037');
  });

  it('accepts one step of clock drift either side, and no more', () => {
    const secret = generateTotpSecret();
    const now = new Date();
    const counter = currentCounter(now);

    assert.equal(verifyTotp(secret, totpAt(secret, counter), { now }).valid, true);
    assert.equal(verifyTotp(secret, totpAt(secret, counter - 1), { now }).valid, true);
    assert.equal(verifyTotp(secret, totpAt(secret, counter + 1), { now }).valid, true);
    // Two steps out is a 90-second-old code. Accepting it would widen the replay window
    // for no real benefit — a phone that far out of sync needs fixing, not tolerating.
    assert.equal(verifyTotp(secret, totpAt(secret, counter - 2), { now }).valid, false);
  });

  it('refuses a code that was already used, inside its own window', () => {
    const secret = generateTotpSecret();
    const now = new Date();
    const counter = currentCounter(now);
    const code = totpAt(secret, counter);

    const first = verifyTotp(secret, code, { now });
    assert.equal(first.valid, true);
    // The same code, still within its thirty seconds: a shoulder-surfed code must be spent.
    assert.equal(verifyTotp(secret, code, { now, lastUsedCounter: first.counter }).valid, false);
  });

  it('rejects malformed input rather than throwing', () => {
    const secret = generateTotpSecret();
    assert.equal(verifyTotp(secret, '').valid, false);
    assert.equal(verifyTotp(secret, '12345').valid, false);
    assert.equal(verifyTotp(secret, 'abcdef').valid, false);
  });
});

/**
 * MFA enrolment and enforcement.
 *
 * The property that matters: an account that can approve payroll cannot end up with a
 * session that never presented a second factor — by any path, including a role granted
 * after the session began.
 */
describe('multi-factor authentication', skipWithoutDb, () => {
  let tenant: TestTenant;
  let slug: string;

  // Unique per run. `identity.app_user` is global and survives a tenant purge, and so does
  // `identity.user_mfa` — a fixed address would inherit the authenticator a previous run
  // enrolled, and the "not enrolled yet" assertions would fail for the right reason on the
  // second run and never again.
  const suffix = randomUUID().slice(0, 8);
  const ordinaryEmail = `ordinary-${suffix}@example.com`;
  const adminEmail = `payroll.admin-${suffix}@example.com`;
  const password = 'CorrectHorse1Battery';

  let ordinaryUserId: string;
  let adminUserId: string;

  before(async () => {
    tenant = await createTestTenant('mfa');

    slug = await withPlatform('maintenance', async (tx) => {
      const { rows } = await tx.query<{ slug: string }>('SELECT slug FROM identity.tenant WHERE id = $1', [
        tenant.tenantId,
      ]);
      return rows[0]!.slug;
    });

    await tenant.as(async (tx) => {
      // A role with no sensitive permission, and one with payroll.finalize — which the
      // permission catalog marks sensitive, and which is therefore what triggers MFA.
      const plain = await tx.query<{ id: string }>(
        `INSERT INTO identity.role (tenant_id, name, is_system) VALUES ($1, 'Viewer', false) RETURNING id`,
        [tenant.tenantId],
      );
      await tx.query(
        `INSERT INTO identity.role_permission (tenant_id, role_id, permission_code)
         VALUES ($1, $2, 'employee.read')`,
        [tenant.tenantId, plain.rows[0]!.id],
      );

      const privileged = await tx.query<{ id: string }>(
        `INSERT INTO identity.role (tenant_id, name, is_system) VALUES ($1, 'Payroll Admin', false) RETURNING id`,
        [tenant.tenantId],
      );
      await tx.query(
        `INSERT INTO identity.role_permission (tenant_id, role_id, permission_code)
         VALUES ($1, $2, 'payroll.finalize')`,
        [tenant.tenantId, privileged.rows[0]!.id],
      );

      const a = await identity.inviteUser(tx, {
        email: ordinaryEmail,
        fullName: 'Ordinary User',
        password,
        roleNames: ['Viewer'],
      });
      ordinaryUserId = a.userId;

      const b = await identity.inviteUser(tx, {
        email: adminEmail,
        fullName: 'Payroll Admin',
        password,
        roleNames: ['Payroll Admin'],
      });
      adminUserId = b.userId;
    });
  });

  after(async () => {
    await dropTestTenant(tenant.tenantId);
    await closePools();
  });

  async function secretOf(userId: string): Promise<string> {
    const { decryptField } = await import('../../src/infra/crypto.ts');
    return withPlatform('maintenance', async (tx) => {
      const { rows } = await tx.query<{ secret_encrypted: string }>(
        'SELECT secret_encrypted FROM identity.user_mfa WHERE user_id = $1',
        [userId],
      );
      return decryptField(rows[0]!.secret_encrypted);
    });
  }

  /** A code for a counter far enough ahead that a previous test has not spent it. */
  function freshCode(secret: string, offsetSteps = 0): { code: string; now: Date } {
    const now = new Date(Date.now() + offsetSteps * 30_000);
    return { code: totpAt(secret, currentCounter(now)), now };
  }

  it('lets an ordinary account sign in with a password alone', async () => {
    const result = await identity.login({ slug, email: ordinaryEmail, password });
    assert.ok(!identity.isChallenge(result), 'no second factor should be demanded');
    assert.equal(result.mfa, false);
  });

  it('refuses to complete a privileged sign-in without a second factor', async () => {
    const result = await identity.login({ slug, email: adminEmail, password });
    assert.ok(identity.isChallenge(result), 'a privileged account must be stopped at the password step');
    assert.equal(result.stage, 'enroll', 'and told to enrol, since it has no factor yet');
    assert.ok(result.challengeToken);
    // The challenge must carry no access of any kind.
    assert.ok(!('accessToken' in result));
  });

  it('issues a secret and ten single-use recovery codes at enrolment', async () => {
    const offer = await beginEnrolment({
      userId: adminUserId,
      email: adminEmail,
      tenantName: 'Test',
    });

    assert.match(offer.secret, /^[A-Z2-7]{32}$/, 'a 160-bit base32 secret');
    assert.match(offer.otpauthUri, /^otpauth:\/\/totp\//);
    assert.match(offer.otpauthUri, /algorithm=SHA1/);
    assert.match(offer.otpauthUri, /digits=6/);
    assert.equal(offer.recoveryCodes.length, 10);
    assert.equal(new Set(offer.recoveryCodes).size, 10, 'codes must not repeat');

    const state = await mfaState(adminUserId);
    assert.equal(state.status, 'pending', 'unconfirmed enrolment must not count as protection');
    assert.equal(state.enrolled, false);
  });

  it('does not activate the factor until a real code proves the app was scanned', async () => {
    await assert.rejects(confirmEnrolment(adminUserId, '000000'), /not valid/);
    assert.equal((await mfaState(adminUserId)).enrolled, false);

    const secret = await secretOf(adminUserId);
    await confirmEnrolment(adminUserId, totpAt(secret, currentCounter()));
    assert.equal((await mfaState(adminUserId)).enrolled, true);
  });

  it('demands a code once the account is enrolled', async () => {
    const result = await identity.login({ slug, email: adminEmail, password });
    assert.ok(identity.isChallenge(result));
    assert.equal(result.stage, 'verify');
  });

  it('completes the login with a valid code and marks the session verified', async () => {
    const secret = await secretOf(adminUserId);
    // A step ahead, because confirmEnrolment already spent the current one.
    const { code } = freshCode(secret, 1);

    const verified = await verifySecondFactor({ userId: adminUserId, code });
    assert.equal(verified.method, 'totp');

    const session = await identity.issueSession({
      tenantId: tenant.tenantId,
      tenantName: 'Test',
      tenantSlug: slug,
      userId: adminUserId,
      fullName: 'Payroll Admin',
      membershipId: await membershipOf(adminUserId),
      email: adminEmail,
      mfa: true,
    });
    assert.equal(session.mfa, true);
    assert.ok(session.permissions.includes('payroll.finalize'));
  });

  it('rejects a wrong code', async () => {
    await assert.rejects(
      verifySecondFactor({ userId: adminUserId, code: '000000' }),
      /Invalid verification code/,
    );
  });

  it('accepts a recovery code exactly once', async () => {
    const offer = await beginEnrolment({ userId: ordinaryUserId, email: ordinaryEmail, tenantName: 'Test' });
    const secret = await secretOf(ordinaryUserId);
    await confirmEnrolment(ordinaryUserId, totpAt(secret, currentCounter()));

    const code = offer.recoveryCodes[0]!;
    const used = await verifySecondFactor({ userId: ordinaryUserId, recoveryCode: code });
    assert.equal(used.method, 'recovery');

    await assert.rejects(
      verifySecondFactor({ userId: ordinaryUserId, recoveryCode: code }),
      /Invalid verification code/,
      'a recovery code that still works after use is just a second password',
    );

    assert.equal((await mfaState(ordinaryUserId)).unusedRecoveryCodes, 9);
  });

  it('invalidates old recovery codes when the factor is re-enrolled', async () => {
    const first = await beginEnrolment({ userId: ordinaryUserId, email: ordinaryEmail, tenantName: 'Test' });
    const second = await beginEnrolment({ userId: ordinaryUserId, email: ordinaryEmail, tenantName: 'Test' });

    const secret = await secretOf(ordinaryUserId);
    await confirmEnrolment(ordinaryUserId, totpAt(secret, currentCounter()));

    await assert.rejects(
      verifySecondFactor({ userId: ordinaryUserId, recoveryCode: first.recoveryCodes[0]! }),
      /Invalid verification code/,
    );
    assert.equal(
      (await verifySecondFactor({ userId: ordinaryUserId, recoveryCode: second.recoveryCodes[0]! })).method,
      'recovery',
    );
  });

  it('refuses to remove the factor from a privileged account', async () => {
    const secret = await secretOf(adminUserId);
    await assert.rejects(
      disableMfa({
        userId: adminUserId,
        password,
        code: totpAt(secret, currentCounter() + 1),
        privileged: true,
      }),
      /cannot be removed while you hold privileged permissions/,
    );
    assert.equal((await mfaState(adminUserId)).enrolled, true);
  });

  it('refuses to remove the factor on a wrong password, even with a valid code', async () => {
    const secret = await secretOf(ordinaryUserId);
    await assert.rejects(
      disableMfa({
        userId: ordinaryUserId,
        password: 'NotThePassword9',
        code: totpAt(secret, currentCounter() + 1),
        privileged: false,
      }),
      /Invalid credentials/,
    );
    assert.equal((await mfaState(ordinaryUserId)).enrolled, true);
  });

  it('stores the secret encrypted, never in the clear', async () => {
    const stored = await withPlatform('maintenance', async (tx) => {
      const { rows } = await tx.query<{ secret_encrypted: string }>(
        'SELECT secret_encrypted FROM identity.user_mfa WHERE user_id = $1',
        [adminUserId],
      );
      return rows[0]!.secret_encrypted;
    });
    const plaintext = await secretOf(adminUserId);
    assert.notEqual(stored, plaintext);
    assert.ok(!stored.includes(plaintext.slice(0, 8)), 'the ciphertext must not contain the secret');
  });

  it('stores recovery codes hashed, so the database cannot be used to bypass the factor', async () => {
    const offer = await beginEnrolment({ userId: ordinaryUserId, email: ordinaryEmail, tenantName: 'Test' });
    const hashes = await withPlatform('maintenance', async (tx) => {
      const { rows } = await tx.query<{ code_hash: string }>(
        'SELECT code_hash FROM identity.mfa_recovery_code WHERE user_id = $1',
        [ordinaryUserId],
      );
      return rows.map((r) => r.code_hash);
    });

    for (const code of offer.recoveryCodes) {
      assert.ok(!hashes.some((h) => h.includes(code)), 'a recovery code must never be stored readable');
    }
  });

  async function membershipOf(userId: string): Promise<string> {
    return withPlatform('maintenance', async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'SELECT id FROM identity.tenant_membership WHERE user_id = $1 AND tenant_id = $2',
        [userId, tenant.tenantId],
      );
      return rows[0]!.id;
    });
  }
});
