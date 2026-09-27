import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../../config.ts';
import { withPlatform, withTenant, SYSTEM_ACTOR } from '../../infra/db/pool.ts';
import { burnPasswordTime, hashPassword, hashToken, verifyPassword } from '../../infra/crypto.ts';
import { audit } from '../../infra/audit.ts';
import { unauthorized, unprocessable } from '../../infra/errors.ts';

/**
 * Password reset, email verification and login throttling.
 *
 * These run against the global `identity.app_user`, before any tenant is chosen — a person
 * resetting their password has not told us which workspace they mean, and asking would leak
 * which workspaces they belong to. So they use the platform connection, and every response
 * is deliberately uninformative about whether an account exists.
 */

const RESET_TTL_MINUTES = 30;
const VERIFICATION_TTL_HOURS = 48;

/** Failed attempts before a temporary lock. */
export const MAX_FAILED_LOGINS = 8;
/** How long the lock lasts. Long enough to break credential stuffing, short enough that a
 *  real user is not denied service for the rest of the day. */
export const LOCK_MINUTES = 15;

export function assertPasswordStrength(password: string): void {
  if (password.length < 12) {
    throw unprocessable('weak_password', 'Password must be at least 12 characters');
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    throw unprocessable('weak_password', 'Password must contain upper case, lower case and a digit');
  }
}

function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export type ResetRequest = {
  /** Present only when an account matched. Delivered by email; never returned to the caller. */
  token?: string;
  userId?: string;
  email: string;
};

/**
 * Starts a password reset.
 *
 * Always reports success. Telling the caller whether an address is registered turns this
 * endpoint into an account-enumeration oracle, which is worth more to an attacker than the
 * convenience is worth to a user who mistyped their address.
 */
export async function requestPasswordReset(email: string, ip?: string): Promise<ResetRequest> {
  const normalised = email.trim().toLowerCase();

  return withPlatform('tenant-provisioning', async (tx) => {
    const { rows } = await tx.query<{ id: string; status: string }>(
      'SELECT id, status FROM identity.app_user WHERE lower(email) = $1',
      [normalised],
    );
    const user = rows[0];

    if (!user || user.status !== 'active') {
      // Same work, same shape of response, so timing does not reveal the difference either.
      await burnPasswordTime();
      return { email: normalised };
    }

    // Any earlier unconsumed reset is invalidated: only the most recent link works.
    await tx.query(
      `UPDATE identity.auth_token SET consumed_at = now()
        WHERE user_id = $1 AND purpose = 'password_reset' AND consumed_at IS NULL`,
      [user.id],
    );

    const { token, hash } = newToken();
    await tx.query(
      `INSERT INTO identity.auth_token (user_id, purpose, token_hash, expires_at, requested_ip)
       VALUES ($1, 'password_reset', $2, now() + make_interval(mins => $3), $4::inet)`,
      [user.id, hash, RESET_TTL_MINUTES, ip ?? null],
    );

    return { token, userId: user.id, email: normalised };
  });
}

/**
 * Completes a password reset.
 *
 * Consuming the token, changing the password and revoking every existing session happen in
 * one transaction. A reset that left old sessions alive would not actually lock out whoever
 * the user is resetting because of.
 */
export async function completePasswordReset(token: string, newPassword: string): Promise<{ userId: string }> {
  assertPasswordStrength(newPassword);
  const hash = hashToken(token);
  const passwordHash = await hashPassword(newPassword);

  return withPlatform('tenant-provisioning', async (tx) => {
    const { rows } = await tx.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM identity.auth_token
        WHERE token_hash = $1 AND purpose = 'password_reset'
          AND consumed_at IS NULL AND expires_at > now()
        FOR UPDATE`,
      [hash],
    );
    const record = rows[0];
    if (!record) throw unauthorized('This reset link is invalid or has expired');

    await tx.query('UPDATE identity.auth_token SET consumed_at = now() WHERE id = $1', [record.id]);
    await tx.query(
      `UPDATE identity.app_user
          SET password_hash = $2, password_changed_at = now(),
              failed_login_count = 0, locked_until = NULL
        WHERE id = $1`,
      [record.user_id, passwordHash],
    );

    // Every session, in every tenant this person belongs to.
    await tx.query(
      `UPDATE identity.refresh_token SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [record.user_id],
    );

    return { userId: record.user_id };
  });
}

/** Changes a password for a signed-in user. Requires the current one. */
export async function changePassword(
  tenantId: string,
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  assertPasswordStrength(newPassword);

  const stored = await withPlatform('tenant-provisioning', async (tx) => {
    const { rows } = await tx.query<{ password_hash: string }>(
      'SELECT password_hash FROM identity.app_user WHERE id = $1',
      [userId],
    );
    return rows[0]?.password_hash;
  });
  if (!stored) throw unauthorized('Account not found');

  // Knowing the current password is what distinguishes the account owner from someone who
  // walked up to an unlocked screen.
  if (!(await verifyPassword(currentPassword, stored))) {
    throw unauthorized('Current password is incorrect');
  }
  if (await verifyPassword(newPassword, stored)) {
    throw unprocessable('password_reused', 'The new password must differ from the current one');
  }

  const passwordHash = await hashPassword(newPassword);

  await withPlatform('tenant-provisioning', async (tx) => {
    await tx.query(
      'UPDATE identity.app_user SET password_hash = $2, password_changed_at = now() WHERE id = $1',
      [userId, passwordHash],
    );
    // Other devices are signed out; the current session keeps its access token until it
    // expires, which is short.
    await tx.query(
      `UPDATE identity.refresh_token SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  });

  await withTenant(tenantId, { ...SYSTEM_ACTOR, userId, label: 'password-change' }, (tx) =>
    audit(tx, {
      entityType: 'app_user',
      entityId: userId,
      action: 'auth.password_changed',
      after: { sessions_revoked: true },
    }),
  );
}

export async function issueEmailVerification(userId: string): Promise<{ token: string }> {
  const { token, hash } = newToken();

  await withPlatform('tenant-provisioning', (tx) =>
    tx.query(
      `INSERT INTO identity.auth_token (user_id, purpose, token_hash, expires_at)
       VALUES ($1, 'email_verification', $2, now() + make_interval(hours => $3))`,
      [userId, hash, VERIFICATION_TTL_HOURS],
    ),
  );

  return { token };
}

export async function verifyEmail(token: string): Promise<{ userId: string }> {
  const hash = hashToken(token);

  return withPlatform('tenant-provisioning', async (tx) => {
    const { rows } = await tx.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM identity.auth_token
        WHERE token_hash = $1 AND purpose = 'email_verification'
          AND consumed_at IS NULL AND expires_at > now()
        FOR UPDATE`,
      [hash],
    );
    const record = rows[0];
    if (!record) throw unauthorized('This verification link is invalid or has expired');

    await tx.query('UPDATE identity.auth_token SET consumed_at = now() WHERE id = $1', [record.id]);
    await tx.query('UPDATE identity.app_user SET email_verified = true WHERE id = $1', [record.user_id]);

    return { userId: record.user_id };
  });
}

export type LockState = { locked: boolean; until?: Date };

/**
 * Records a failed login and locks the account after repeated failures.
 *
 * A temporary lock, not a permanent one: a permanent lock hands an attacker a denial-of-
 * service against any account whose address they know.
 */
export async function recordFailedLogin(userId: string): Promise<LockState> {
  return withPlatform('tenant-provisioning', async (tx) => {
    const { rows } = await tx.query<{ failed_login_count: number; locked_until: Date | null }>(
      `UPDATE identity.app_user
          SET failed_login_count = failed_login_count + 1,
              locked_until = CASE
                WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3)
                ELSE locked_until
              END
        WHERE id = $1
        RETURNING failed_login_count, locked_until`,
      [userId, MAX_FAILED_LOGINS, LOCK_MINUTES],
    );
    const row = rows[0];
    return row?.locked_until && row.locked_until > new Date()
      ? { locked: true, until: row.locked_until }
      : { locked: false };
  });
}

export async function clearFailedLogins(userId: string): Promise<void> {
  await withPlatform('tenant-provisioning', (tx) =>
    tx.query(
      'UPDATE identity.app_user SET failed_login_count = 0, locked_until = NULL WHERE id = $1',
      [userId],
    ),
  );
}

export function isLocked(lockedUntil: Date | null): boolean {
  return lockedUntil !== null && lockedUntil > new Date();
}

/**
 * Compares a supplied token against a stored hash in constant time.
 *
 * Exported for tests; the flows above compare via the unique index, which is already
 * constant-time with respect to the secret.
 */
export function tokenMatches(supplied: string, storedHash: string): boolean {
  const a = Buffer.from(createHash('sha256').update(supplied).digest('hex'));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export { config };
