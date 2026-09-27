import { randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { config } from '../../config.ts';
import { withPlatform, type Queryable } from '../../infra/db/pool.ts';
import { decryptField, encryptField, hashPassword, verifyPassword } from '../../infra/crypto.ts';
import { forbidden, unauthorized, unprocessable } from '../../infra/errors.ts';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../../infra/totp.ts';

/**
 * Multi-factor authentication.
 *
 * Enforcement rule, in one sentence: **anyone who holds a sensitive permission must have an
 * active authenticator, and cannot complete a login without one.** "Sensitive" is not a
 * second list maintained here — it is `identity.permission.sensitive`, the same flag that
 * already decides what the audit trail treats as privileged. One definition, so a permission
 * added later cannot quietly escape the requirement.
 *
 * The factor lives on the global user, not the membership: a person has one authenticator
 * across every workspace. Enforcement is per tenant, because whether they are privileged
 * depends on which workspace they are logging into.
 */

const encoder = new TextEncoder();
const ISSUER = 'hrms-api';
const MFA_AUDIENCE = 'hrms-mfa';

/**
 * How long a half-finished login stays resumable.
 *
 * Long enough to open an authenticator app, short enough that a stolen challenge is worth
 * little. This token proves the password step only; it grants no access on its own.
 */
const CHALLENGE_TTL_SECONDS = 300;

const RECOVERY_CODE_COUNT = 10;

const challengeSchema = z.object({
  sub: z.string().uuid(),
  tid: z.string().uuid(),
  mid: z.string().uuid(),
  /** `verify` = enrolled, prove a code. `enroll` = privileged but not enrolled yet. */
  stage: z.enum(['verify', 'enroll']),
});

export type MfaChallenge = z.infer<typeof challengeSchema>;

/**
 * A short-lived token that proves the password step and nothing else.
 *
 * Separate audience from an access token on purpose: without that, a challenge token would
 * be accepted by `authenticate` and the second factor would be optional in practice.
 */
export async function signChallengeToken(claims: MfaChallenge): Promise<string> {
  return new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(MFA_AUDIENCE)
    .setExpirationTime(`${CHALLENGE_TTL_SECONDS}s`)
    .sign(encoder.encode(config().JWT_SECRET));
}

export async function verifyChallengeToken(token: string): Promise<MfaChallenge> {
  const cfg = config();
  const secrets = [cfg.JWT_SECRET, cfg.JWT_PREVIOUS_SECRET].filter(Boolean) as string[];

  for (const secret of secrets) {
    try {
      const { payload } = await jwtVerify(token, encoder.encode(secret), {
        issuer: ISSUER,
        audience: MFA_AUDIENCE,
      });
      return challengeSchema.parse(payload);
    } catch {
      // try the next secret
    }
  }
  throw unauthorized('This sign-in attempt has expired. Start again.');
}

export const CHALLENGE_TTL = CHALLENGE_TTL_SECONDS;

export type MfaState = {
  enrolled: boolean;
  status: 'none' | 'pending' | 'active';
  unusedRecoveryCodes: number;
};

/**
 * Reads the factor on the global user record.
 *
 * Runs on the platform connection because `identity.user_mfa` is not tenant-scoped — a
 * person's authenticator is not owned by any one workspace. This is one of the narrow,
 * deliberate uses of that role.
 */
export async function mfaState(userId: string): Promise<MfaState> {
  return withPlatform('maintenance', async (tx) => {
    const { rows } = await tx.query<{ status: string }>(
      'SELECT status FROM identity.user_mfa WHERE user_id = $1',
      [userId],
    );
    const codes = await tx.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM identity.mfa_recovery_code
        WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    const status = rows[0]?.status;
    return {
      enrolled: status === 'active',
      status: status === 'active' ? 'active' : status === 'pending' ? 'pending' : 'none',
      unusedRecoveryCodes: codes.rows[0]?.count ?? 0,
    };
  });
}

/**
 * Whether this membership holds any permission the catalog marks sensitive.
 *
 * Derived from `identity.permission.sensitive` rather than a hardcoded list, so a
 * permission added in a later migration is covered without anyone remembering to.
 */
export async function holdsSensitivePermission(tx: Queryable, membershipId: string): Promise<boolean> {
  const { rows } = await tx.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM identity.membership_role mr
         JOIN identity.role_permission rp ON rp.role_id = mr.role_id
         JOIN identity.permission p ON p.code = rp.permission_code
        WHERE mr.membership_id = $1 AND p.sensitive
     ) AS exists`,
    [membershipId],
  );
  return rows[0]?.exists ?? false;
}

export type EnrolmentOffer = {
  secret: string;
  otpauthUri: string;
  recoveryCodes: string[];
};

/**
 * Starts (or restarts) enrolment.
 *
 * The secret is replaced every time, and the factor is left `pending` until a code proves
 * the user actually scanned it. Activating on enrolment instead would lock out anyone whose
 * scan failed — with a payroll administrator, that is an outage, not an inconvenience.
 *
 * Recovery codes are returned exactly once. They are stored hashed, so there is no way to
 * show them again, which is the property that makes them a credential rather than a note.
 */
export async function beginEnrolment(input: {
  userId: string;
  email: string;
  tenantName: string;
}): Promise<EnrolmentOffer> {
  const secret = generateTotpSecret();
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => formatRecoveryCode(randomBytes(5)));
  const hashes = await Promise.all(codes.map((code) => hashPassword(code)));

  await withPlatform('maintenance', async (tx) => {
    await tx.query(
      `INSERT INTO identity.user_mfa (user_id, method, secret_encrypted, status, last_used_counter, confirmed_at)
       VALUES ($1, 'totp', $2, 'pending', NULL, NULL)
       ON CONFLICT (user_id) DO UPDATE
         SET secret_encrypted = EXCLUDED.secret_encrypted,
             status = 'pending',
             last_used_counter = NULL,
             confirmed_at = NULL`,
      [input.userId, encryptField(secret)],
    );

    // Codes from an abandoned enrolment must not still open the door.
    await tx.query('DELETE FROM identity.mfa_recovery_code WHERE user_id = $1', [input.userId]);
    for (const hash of hashes) {
      await tx.query('INSERT INTO identity.mfa_recovery_code (user_id, code_hash) VALUES ($1, $2)', [
        input.userId,
        hash,
      ]);
    }
  });

  return {
    secret,
    otpauthUri: otpauthUri({ secret, account: input.email, issuer: `HRMS ${input.tenantName}`.trim() }),
    recoveryCodes: codes,
  };
}

/** Activates a pending factor once a generated code proves the authenticator works. */
export async function confirmEnrolment(userId: string, code: string): Promise<void> {
  const record = await loadFactor(userId);
  if (!record) throw unprocessable('mfa_not_started', 'Start enrolment before confirming it');

  const result = verifyTotp(record.secret, code, { lastUsedCounter: record.lastUsedCounter });
  if (!result.valid) {
    throw unprocessable('invalid_code', 'That code is not valid. Check your authenticator app.');
  }

  await withPlatform('maintenance', (tx) =>
    tx.query(
      `UPDATE identity.user_mfa
          SET status = 'active', confirmed_at = now(), last_used_counter = $2
        WHERE user_id = $1`,
      [userId, result.counter ?? null],
    ),
  );
}

/**
 * Checks a code at login, accepting either a TOTP code or one recovery code.
 *
 * Both paths burn what they use: the TOTP step is recorded so the same code cannot be
 * replayed inside its window, and a recovery code is marked used. A recovery code that
 * still works after use is just a password that never expires.
 */
export async function verifySecondFactor(input: {
  userId: string;
  code?: string;
  recoveryCode?: string;
}): Promise<{ method: 'totp' | 'recovery' }> {
  const record = await loadFactor(input.userId);
  if (!record || record.status !== 'active') {
    throw unauthorized('Multi-factor authentication is not set up for this account');
  }

  if (input.code) {
    const result = verifyTotp(record.secret, input.code, { lastUsedCounter: record.lastUsedCounter });
    if (!result.valid) throw unauthorized('Invalid verification code');

    await withPlatform('maintenance', (tx) =>
      tx.query('UPDATE identity.user_mfa SET last_used_counter = $2 WHERE user_id = $1', [
        input.userId,
        result.counter ?? null,
      ]),
    );
    return { method: 'totp' };
  }

  if (input.recoveryCode) {
    const normalised = input.recoveryCode.trim().toUpperCase();
    const candidates = await withPlatform('maintenance', async (tx) => {
      const { rows } = await tx.query<{ id: string; code_hash: string }>(
        'SELECT id, code_hash FROM identity.mfa_recovery_code WHERE user_id = $1 AND used_at IS NULL',
        [input.userId],
      );
      return rows;
    });

    for (const candidate of candidates) {
      if (await verifyPassword(normalised, candidate.code_hash)) {
        const { rowCount } = await withPlatform('maintenance', (tx) =>
          // `used_at IS NULL` in the predicate, not just the read: two requests presenting
          // the same code concurrently must not both succeed.
          tx.query(
            'UPDATE identity.mfa_recovery_code SET used_at = now() WHERE id = $1 AND used_at IS NULL',
            [candidate.id],
          ),
        );
        if ((rowCount ?? 0) === 0) break;
        return { method: 'recovery' };
      }
    }
    throw unauthorized('Invalid verification code');
  }

  throw unprocessable('code_required', 'Provide an authenticator code or a recovery code');
}

/**
 * Removes the factor.
 *
 * Requires the password *and* a current code: an attacker holding a hijacked session must
 * not be able to strip the control that would have stopped them. Privileged users are
 * refused outright — turning MFA off is not theirs to choose while they can approve payroll.
 */
export async function disableMfa(input: {
  userId: string;
  password: string;
  code: string;
  privileged: boolean;
}): Promise<void> {
  if (input.privileged) {
    throw forbidden('Multi-factor authentication cannot be removed while you hold privileged permissions');
  }

  const user = await withPlatform('maintenance', async (tx) => {
    const { rows } = await tx.query<{ password_hash: string }>(
      'SELECT password_hash FROM identity.app_user WHERE id = $1',
      [input.userId],
    );
    return rows[0];
  });
  if (!user || !(await verifyPassword(input.password, user.password_hash))) {
    throw unauthorized('Invalid credentials');
  }

  await verifySecondFactor({ userId: input.userId, code: input.code });

  await withPlatform('maintenance', async (tx) => {
    await tx.query('DELETE FROM identity.mfa_recovery_code WHERE user_id = $1', [input.userId]);
    await tx.query('DELETE FROM identity.user_mfa WHERE user_id = $1', [input.userId]);
  });
}

type Factor = { secret: string; status: string; lastUsedCounter: number | null };

async function loadFactor(userId: string): Promise<Factor | undefined> {
  return withPlatform('maintenance', async (tx) => {
    const { rows } = await tx.query<{
      secret_encrypted: string;
      status: string;
      last_used_counter: string | number | null;
    }>('SELECT secret_encrypted, status, last_used_counter FROM identity.user_mfa WHERE user_id = $1', [
      userId,
    ]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      secret: decryptField(row.secret_encrypted),
      status: row.status,
      lastUsedCounter: row.last_used_counter == null ? null : Number(row.last_used_counter),
    };
  });
}

/** Grouped for transcription: someone reads these off paper under pressure. */
function formatRecoveryCode(bytes: Buffer): string {
  const raw = bytes.toString('hex').toUpperCase();
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
}
