import { config } from '../../config.ts';
import { audit } from '../../infra/audit.ts';
import {
  burnPasswordTime,
  hashPassword,
  hashToken,
  newOpaqueToken,
  verifyPassword,
} from '../../infra/crypto.ts';
import { withPlatform, withTenant, type TenantTx, SYSTEM_ACTOR } from '../../infra/db/pool.ts';
import { conflict, isPgError, notFound, unauthorized, unprocessable, PG_UNIQUE_VIOLATION } from '../../infra/errors.ts';
import { signAccessToken } from '../../http/auth.ts';
import { CHALLENGE_TTL, holdsSensitivePermission, mfaState, signChallengeToken } from './mfa.ts';
import {
  assertPasswordStrength,
  clearFailedLogins,
  isLocked,
  recordFailedLogin,
} from './auth-flows.ts';

/**
 * Built-in roles created with every tenant.
 *
 * Self-service permissions are separate from administrative ones by design: an Employee
 * can read their own leave and payslips and nothing else, and a Manager gains team scope
 * without gaining salary visibility.
 */
/**
 * The workspace owner holds every permission, including the sensitive ones.
 *
 * Kept as a distinct role rather than folded into Tenant Admin so separation of duties
 * stays real: Tenant Admin configures the workspace but cannot read salary, bank or tax
 * data, and the accounts that can are visible as such in the role listing.
 */
export const OWNER_ROLE = 'Owner';

export const SYSTEM_ROLES: Record<string, string[]> = {
  'Tenant Admin': [
    'tenant.read', 'tenant.manage', 'org.read', 'org.manage', 'user.manage', 'role.manage',
    'employee.read', 'employee.read.self', 'employee.read.team', 'employee.manage', 'employee.lifecycle',
    'shift.read', 'shift.manage', 'attendance.read', 'attendance.read.self', 'attendance.checkin',
    'attendance.checkin.other', 'attendance.manage', 'attendance.correct',
    'leave.read', 'leave.read.self', 'leave.apply', 'leave.approve', 'leave.manage',
    'expense.read', 'expense.read.self', 'expense.submit', 'expense.approve', 'expense.manage',
    'leave.run_jobs', 'onboarding.read', 'onboarding.read.self', 'onboarding.manage',
    'document.read', 'document.read.self', 'document.manage', 'workflow.manage', 'audit.read',
  ],
  'HR Admin': [
    'org.read', 'org.manage', 'employee.read', 'employee.read.self', 'employee.read.team',
    'employee.manage', 'employee.lifecycle', 'employee.bank.read', 'employee.bank.manage',
    'employee.tax.read', 'employee.tax.manage',
    'shift.read', 'shift.manage', 'attendance.read', 'attendance.read.self', 'attendance.checkin',
    'attendance.checkin.other', 'attendance.manage', 'attendance.correct',
    'leave.read', 'leave.read.self', 'leave.apply', 'leave.approve', 'leave.manage', 'leave.adjust',
    'expense.read', 'expense.read.self', 'expense.submit', 'expense.approve', 'expense.manage',
    'leave.run_jobs', 'onboarding.read', 'onboarding.read.self', 'onboarding.manage',
    'document.read', 'document.read.self', 'document.manage', 'workflow.manage',
  ],
  'Payroll Admin': [
    'employee.read', 'employee.read.self', 'employee.bank.read', 'employee.tax.read', 'employee.tax.manage',
    'compensation.read', 'compensation.manage',
    'payroll.read', 'payroll.run', 'payroll.approve',
    'attendance.read', 'leave.read', 'document.read', 'payslip.read.self', 'audit.read',
    // Verifying proof is separate from managing declarations, so a tenant can give
    // one without the other. Payroll Admin holds both; Employee holds neither.
    'tax.manage', 'tax.declare.self', 'tax.proof.verify',
  ],
  'Finance': [
    'payroll.read', 'payroll.approve', 'payroll.finalize', 'compensation.read',
    'employee.read', 'employee.bank.read', 'audit.read',
    // Finance decides how much of a claim the company pays, and records the payment.
    'expense.read', 'expense.read.self', 'expense.finance', 'expense.manage',
    'payroll.pay',
  ],
  'Manager': [
    'employee.read.self', 'employee.read.team', 'org.read',
    'attendance.read.self', 'attendance.read', 'attendance.checkin', 'attendance.correct',
    'leave.read.self', 'leave.read', 'leave.apply', 'leave.approve',
    'expense.read.self', 'expense.read', 'expense.submit', 'expense.approve',
    'onboarding.read.self', 'onboarding.read',
    'document.read.self', 'payslip.read.self', 'shift.read',
  ],
  'Employee': [
    'employee.read.self', 'org.read',
    'attendance.read.self', 'attendance.checkin',
    'leave.read.self', 'leave.apply',
    'expense.read.self', 'expense.submit',
    'onboarding.read.self', 'tax.declare.self',
    'document.read.self', 'payslip.read.self', 'shift.read',
  ],
};

export type ProvisionInput = {
  tenantName: string;
  slug: string;
  timezone?: string;
  currency?: string;
  countryCode?: string;
  adminEmail: string;
  adminPassword: string;
  adminName: string;
};

/**
 * Creates a tenant and its first administrator.
 *
 * The tenant row is written through the platform (BYPASSRLS) connection because no tenant
 * context can exist before the tenant does. Everything after that switches immediately to
 * a normal tenant-scoped transaction, keeping the privileged surface as small as possible.
 */
export async function provisionTenant(input: ProvisionInput): Promise<{ tenantId: string; userId: string }> {
  const slug = input.slug.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) {
    throw unprocessable('invalid_slug', 'Slug must be 3-40 lowercase alphanumeric characters or hyphens');
  }
  assertPasswordStrength(input.adminPassword);

  const passwordHash = await hashPassword(input.adminPassword);
  const email = input.adminEmail.trim().toLowerCase();

  const { tenantId, userId } = await withPlatform('tenant-provisioning', async (tx) => {
    let tenantRow: { id: string };
    try {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO identity.tenant (name, slug, timezone, currency, country_code)
         VALUES ($1, $2, COALESCE($3, 'Asia/Kolkata'), COALESCE($4, 'INR'), COALESCE($5, 'IN'))
         RETURNING id`,
        [input.tenantName, slug, input.timezone ?? null, input.currency ?? null, input.countryCode ?? null],
      );
      tenantRow = rows[0]!;
    } catch (err) {
      if (isPgError(err, PG_UNIQUE_VIOLATION)) {
        throw conflict('slug_taken', `The workspace address "${slug}" is already in use`);
      }
      throw err;
    }

    // A person may already have a login from another tenant; reuse it rather than
    // forcing a second account for the same human.
    const existing = await tx.query<{ id: string }>(
      'SELECT id FROM identity.app_user WHERE lower(email) = $1',
      [email],
    );
    let userRow = existing.rows[0];
    if (!userRow) {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO identity.app_user (email, password_hash, full_name, status, email_verified)
         VALUES ($1, $2, $3, 'active', false)
         RETURNING id`,
        [email, passwordHash, input.adminName],
      );
      userRow = created.rows[0]!;
    }

    await tx.query(
      `INSERT INTO identity.tenant_membership (tenant_id, user_id, status, is_owner)
       VALUES ($1, $2, 'active', true)`,
      [tenantRow.id, userRow.id],
    );

    return { tenantId: tenantRow.id, userId: userRow.id };
  });

  await withTenant(tenantId, { ...SYSTEM_ACTOR, label: 'tenant-provisioning' }, async (tx) => {
    const roleIds = await ensureSystemRoles(tx);
    const membership = await tx.query<{ id: string }>(
      'SELECT id FROM identity.tenant_membership WHERE tenant_id = $1 AND user_id = $2',
      [tenantId, userId],
    );
    await tx.query(
      'INSERT INTO identity.membership_role (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)',
      [tenantId, membership.rows[0]!.id, roleIds[OWNER_ROLE]],
    );

    await audit(tx, {
      entityType: 'tenant',
      entityId: tenantId,
      action: 'tenant.provisioned',
      after: { name: input.tenantName, slug, admin_email: email },
    });
  });

  return { tenantId, userId };
}

export async function ensureSystemRoles(tx: TenantTx): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};

  // Owner is defined against the live permission catalog rather than a hard-coded list,
  // so a permission added by a later migration is covered without a code change.
  const ownerRole = await tx.query<{ id: string }>(
    `INSERT INTO identity.role (tenant_id, name, description, is_system)
     VALUES ($1, $2, 'Full access to this workspace, including salary, bank and tax data', true)
     ON CONFLICT (tenant_id, name) DO UPDATE SET is_system = true
     RETURNING id`,
    [tx.tenantId, OWNER_ROLE],
  );
  ids[OWNER_ROLE] = ownerRole.rows[0]!.id;
  await tx.query(
    `INSERT INTO identity.role_permission (tenant_id, role_id, permission_code)
     SELECT $1, $2, code FROM identity.permission
     ON CONFLICT DO NOTHING`,
    [tx.tenantId, ids[OWNER_ROLE]],
  );

  for (const [name, permissions] of Object.entries(SYSTEM_ROLES)) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO identity.role (tenant_id, name, description, is_system)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (tenant_id, name) DO UPDATE SET description = EXCLUDED.description
       RETURNING id`,
      [tx.tenantId, name, `Built-in ${name} role`],
    );
    const roleId = rows[0]!.id;
    ids[name] = roleId;

    await tx.query(
      `INSERT INTO identity.role_permission (tenant_id, role_id, permission_code)
       SELECT $1, $2, code FROM identity.permission WHERE code = ANY($3::text[])
       ON CONFLICT DO NOTHING`,
      [tx.tenantId, roleId, permissions],
    );
  }

  return ids;
}

export type LoginResult = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tenant: { id: string; name: string; slug: string };
  user: { id: string; name: string; email: string; employeeId: string | null };
  permissions: string[];
  mfa: boolean;
};

/**
 * A login that stopped after the password step.
 *
 * `verify` means the account already has an authenticator. `enroll` means it holds
 * privileged permissions (or the tenant requires MFA of everyone) and has none yet — the
 * only thing that token can do is set one up. Neither carries any access.
 */
export type LoginChallenge = {
  mfaRequired: true;
  stage: 'verify' | 'enroll';
  challengeToken: string;
  expiresIn: number;
  user: { email: string; name: string };
  tenant: { name: string; slug: string };
};

export type LoginOutcome = LoginResult | LoginChallenge;

export function isChallenge(outcome: LoginOutcome): outcome is LoginChallenge {
  return 'mfaRequired' in outcome;
}

/**
 * Authenticates against one tenant.
 *
 * The tenant is resolved from the slug supplied at login and then only ever read from the
 * signed token. Failures are deliberately indistinguishable — wrong password, unknown
 * email and no membership all return the same message after the same amount of work — so
 * the endpoint cannot be used to enumerate accounts or tenants.
 */
export async function login(input: {
  slug: string;
  email: string;
  password: string;
}): Promise<LoginOutcome> {
  const email = input.email.trim().toLowerCase();

  const lookup = await withPlatform('tenant-provisioning', async (tx) => {
    const { rows } = await tx.query<{
      tenant_id: string;
      tenant_name: string;
      tenant_slug: string;
      tenant_status: string;
      require_mfa: boolean;
      user_id: string;
      full_name: string;
      password_hash: string;
      user_status: string;
      membership_id: string;
      membership_status: string;
      locked_until: Date | null;
    }>(
      `SELECT t.id AS tenant_id, t.name AS tenant_name, t.slug AS tenant_slug, t.status AS tenant_status,
              t.require_mfa,
              u.id AS user_id, u.full_name, u.password_hash, u.status AS user_status,
              m.id AS membership_id, m.status AS membership_status, u.locked_until
         FROM identity.tenant t
         JOIN identity.tenant_membership m ON m.tenant_id = t.id
         JOIN identity.app_user u ON u.id = m.user_id
        WHERE t.slug = $1 AND lower(u.email) = $2`,
      [input.slug.toLowerCase(), email],
    );
    return rows[0];
  });

  if (!lookup) {
    await burnPasswordTime();
    throw unauthorized('Invalid credentials');
  }

  // A locked account is refused before the password is even checked, so a lockout cannot
  // be probed by timing, and so a credential-stuffing run gains nothing by continuing.
  if (isLocked(lookup.locked_until)) {
    throw unauthorized('Too many failed attempts. Try again shortly.');
  }

  const passwordOk = await verifyPassword(input.password, lookup.password_hash);
  if (!passwordOk) {
    await recordFailedLogin(lookup.user_id);
    throw unauthorized('Invalid credentials');
  }
  if (
    lookup.user_status !== 'active' ||
    lookup.membership_status !== 'active' ||
    lookup.tenant_status !== 'active'
  ) {
    throw unauthorized('Invalid credentials');
  }

  await clearFailedLogins(lookup.user_id);

  // Second factor, decided before any token is issued. The check is here rather than in a
  // route guard so that no path can reach token issuance without passing it.
  const factor = await mfaState(lookup.user_id);
  const privileged = await withTenant(
    lookup.tenant_id,
    { userId: lookup.user_id, employeeId: null, label: lookup.full_name },
    (tx) => holdsSensitivePermission(tx, lookup.membership_id),
  );

  if (factor.enrolled || privileged || lookup.require_mfa) {
    const stage = factor.enrolled ? 'verify' : 'enroll';
    return {
      mfaRequired: true,
      stage,
      challengeToken: await signChallengeToken({
        sub: lookup.user_id,
        tid: lookup.tenant_id,
        mid: lookup.membership_id,
        stage,
      }),
      expiresIn: CHALLENGE_TTL,
      user: { email, name: lookup.full_name },
      tenant: { name: lookup.tenant_name, slug: lookup.tenant_slug },
    };
  }

  return issueSession({
    tenantId: lookup.tenant_id,
    tenantName: lookup.tenant_name,
    tenantSlug: lookup.tenant_slug,
    userId: lookup.user_id,
    fullName: lookup.full_name,
    membershipId: lookup.membership_id,
    email,
    mfa: false,
  });
}

/**
 * Issues the tokens for an authenticated session.
 *
 * Shared by the password-only path and the post-MFA path so the two cannot drift: an
 * inconsistency here would mean a session created one way carries different claims, or a
 * different audit trail, from one created the other.
 */
export async function issueSession(input: {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  userId: string;
  fullName: string;
  membershipId: string;
  email: string;
  mfa: boolean;
}): Promise<LoginResult> {
  return withTenant(
    input.tenantId,
    { userId: input.userId, employeeId: null, label: input.fullName },
    async (tx) => {
      const permissions = await permissionsFor(tx, input.membershipId);
      const employee = await tx.query<{ id: string }>(
        'SELECT id FROM core.employee WHERE tenant_id = $1 AND user_id = $2',
        [input.tenantId, input.userId],
      );
      const employeeId = employee.rows[0]?.id ?? null;

      const accessToken = await signAccessToken({
        sub: input.userId,
        tid: input.tenantId,
        mid: input.membershipId,
        eid: employeeId,
        perms: permissions,
        name: input.fullName,
        mfa: input.mfa,
      });

      const refreshToken = await issueRefreshToken(tx, input.userId);

      await tx.query('UPDATE identity.app_user SET last_login_at = now() WHERE id = $1', [input.userId]);
      await audit(tx, {
        entityType: 'session',
        entityId: input.userId,
        action: 'auth.login',
        after: { email: input.email, mfa: input.mfa },
      });

      return {
        accessToken,
        refreshToken,
        expiresIn: config().JWT_ACCESS_TTL_SECONDS,
        tenant: { id: input.tenantId, name: input.tenantName, slug: input.tenantSlug },
        user: { id: input.userId, name: input.fullName, email: input.email, employeeId },
        permissions,
        mfa: input.mfa,
      };
    },
  );
}

export async function permissionsFor(tx: TenantTx, membershipId: string): Promise<string[]> {
  const { rows } = await tx.query<{ permission_code: string }>(
    `SELECT DISTINCT rp.permission_code
       FROM identity.membership_role mr
       JOIN identity.role_permission rp ON rp.role_id = mr.role_id
      WHERE mr.tenant_id = $1 AND mr.membership_id = $2`,
    [tx.tenantId, membershipId],
  );
  return rows.map((r) => r.permission_code).sort();
}

export async function roleIdsFor(tx: TenantTx, membershipId: string): Promise<string[]> {
  const { rows } = await tx.query<{ role_id: string }>(
    'SELECT role_id FROM identity.membership_role WHERE tenant_id = $1 AND membership_id = $2',
    [tx.tenantId, membershipId],
  );
  return rows.map((r) => r.role_id);
}

async function issueRefreshToken(tx: TenantTx, userId: string): Promise<string> {
  const token = newOpaqueToken();
  const ttl = config().JWT_REFRESH_TTL_SECONDS;
  await tx.query(
    `INSERT INTO identity.refresh_token (tenant_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)`,
    [tx.tenantId, userId, hashToken(token), String(ttl)],
  );
  return token;
}

/**
 * Rotates a refresh token.
 *
 * The presented token is revoked as it is exchanged, so a stolen token becomes useless
 * once the legitimate client next refreshes, and reuse of an already-revoked token is
 * visible rather than silently accepted.
 */
export async function refresh(tenantId: string, refreshToken: string): Promise<LoginResult> {
  return withTenant(tenantId, { ...SYSTEM_ACTOR, label: 'token-refresh' }, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      user_id: string;
      revoked_at: Date | null;
      recently_rotated: boolean;
    }>(
      `SELECT id, user_id, revoked_at,
              -- A client that fires two refreshes at once (a retry, or two tabs) legitimately
              -- presents the same token twice within moments of rotation. Treating that as
              -- theft would log real users out for being on a flaky network, so a short
              -- grace window is honoured; genuine reuse of an old token still trips the alarm.
              (revoked_at IS NOT NULL AND revoked_at > now() - INTERVAL '10 seconds') AS recently_rotated
         FROM identity.refresh_token
        WHERE tenant_id = $1 AND token_hash = $2 AND expires_at > now()
        FOR UPDATE`,
      [tenantId, hashToken(refreshToken)],
    );
    const stored = rows[0];
    if (!stored) throw unauthorized('Invalid or expired refresh token');

    if (stored.revoked_at && stored.recently_rotated) {
      // Inside the grace window: refuse this exchange without punishing the session. The
      // client still holds the token issued by the winning request.
      throw unauthorized('Refresh already in progress; retry with the latest token');
    }

    if (stored.revoked_at) {
      // Reuse of a rotated token: treat every session for this user as compromised.
      await tx.query(
        `UPDATE identity.refresh_token SET revoked_at = now()
          WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [tenantId, stored.user_id],
      );
      await audit(tx, {
        entityType: 'session',
        entityId: stored.user_id,
        action: 'auth.refresh_token_reuse_detected',
        after: { revoked_all_sessions: true },
      });
      throw unauthorized('Refresh token has already been used');
    }

    await tx.query('UPDATE identity.refresh_token SET revoked_at = now() WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      stored.id,
    ]);

    const context = await tx.query<{
      full_name: string;
      email: string;
      membership_id: string;
      tenant_name: string;
      tenant_slug: string;
      user_status: string;
      membership_status: string;
    }>(
      `SELECT u.full_name, u.email, m.id AS membership_id, t.name AS tenant_name, t.slug AS tenant_slug,
              u.status AS user_status, m.status AS membership_status
         FROM identity.tenant_membership m
         JOIN identity.app_user u ON u.id = m.user_id
         JOIN identity.tenant t ON t.id = m.tenant_id
        WHERE m.tenant_id = $1 AND m.user_id = $2`,
      [tenantId, stored.user_id],
    );
    const ctx = context.rows[0];
    if (!ctx || ctx.user_status !== 'active' || ctx.membership_status !== 'active') {
      throw unauthorized('Account is no longer active');
    }

    // Re-checked on every rotation, not only at login. Someone granted a privileged role
    // mid-session would otherwise keep a compliant-looking session for the life of their
    // refresh token — up to thirty days — without ever enrolling.
    const privileged = await holdsSensitivePermission(tx, ctx.membership_id);
    const factor = await mfaState(stored.user_id);
    if (privileged && !factor.enrolled) {
      await revokeAllSessions(tx, stored.user_id);
      await audit(tx, {
        entityType: 'session',
        entityId: stored.user_id,
        action: 'auth.mfa_enrolment_required',
        after: { reason: 'privileged permissions granted without an enrolled second factor' },
      });
      throw unauthorized('Multi-factor authentication is required for this account. Sign in again to set it up.');
    }

    const permissions = await permissionsFor(tx, ctx.membership_id);
    const employee = await tx.query<{ id: string }>(
      'SELECT id FROM core.employee WHERE tenant_id = $1 AND user_id = $2',
      [tenantId, stored.user_id],
    );
    const employeeId = employee.rows[0]?.id ?? null;

    const accessToken = await signAccessToken({
      sub: stored.user_id,
      tid: tenantId,
      mid: ctx.membership_id,
      eid: employeeId,
      perms: permissions,
      name: ctx.full_name,
      mfa: factor.enrolled,
    });

    return {
      accessToken,
      refreshToken: await issueRefreshToken(tx, stored.user_id),
      expiresIn: config().JWT_ACCESS_TTL_SECONDS,
      tenant: { id: tenantId, name: ctx.tenant_name, slug: ctx.tenant_slug },
      user: { id: stored.user_id, name: ctx.full_name, email: ctx.email, employeeId },
      permissions,
      mfa: factor.enrolled,
    };
  });
}

export async function revokeAllSessions(tx: TenantTx, userId: string): Promise<void> {
  await tx.query(
    `UPDATE identity.refresh_token SET revoked_at = now()
      WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [tx.tenantId, userId],
  );
}

/**
 * Invites a user into the tenant and assigns roles. The account is created disabled-free
 * but unverified; an existing global user is reused so one person keeps one login.
 */
export async function inviteUser(
  tx: TenantTx,
  input: { email: string; fullName: string; password: string; roleNames: string[]; employeeId?: string },
): Promise<{ userId: string; membershipId: string }> {
  assertPasswordStrength(input.password);
  const email = input.email.trim().toLowerCase();

  const existing = await tx.query<{ id: string }>(
    'SELECT id FROM identity.app_user WHERE lower(email) = $1',
    [email],
  );

  let userId = existing.rows[0]?.id;
  if (!userId) {
    const created = await tx.query<{ id: string }>(
      `INSERT INTO identity.app_user (email, password_hash, full_name, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id`,
      [email, await hashPassword(input.password), input.fullName],
    );
    userId = created.rows[0]!.id;
  }

  let membershipId: string;
  try {
    const membership = await tx.query<{ id: string }>(
      `INSERT INTO identity.tenant_membership (tenant_id, user_id, status)
       VALUES ($1, $2, 'active')
       RETURNING id`,
      [tx.tenantId, userId],
    );
    membershipId = membership.rows[0]!.id;
  } catch (err) {
    if (isPgError(err, PG_UNIQUE_VIOLATION)) {
      throw conflict('already_member', 'That user is already a member of this workspace');
    }
    throw err;
  }

  const roles = await tx.query<{ id: string; name: string }>(
    'SELECT id, name FROM identity.role WHERE tenant_id = $1 AND name = ANY($2::text[])',
    [tx.tenantId, input.roleNames],
  );
  if (roles.rowCount !== input.roleNames.length) {
    const found = new Set(roles.rows.map((r) => r.name));
    throw notFound(`Role(s): ${input.roleNames.filter((n) => !found.has(n)).join(', ')}`);
  }

  for (const role of roles.rows) {
    await tx.query(
      'INSERT INTO identity.membership_role (tenant_id, membership_id, role_id) VALUES ($1, $2, $3)',
      [tx.tenantId, membershipId, role.id],
    );
  }

  if (input.employeeId) {
    await tx.query('UPDATE core.employee SET user_id = $3 WHERE tenant_id = $1 AND id = $2', [
      tx.tenantId,
      input.employeeId,
      userId,
    ]);
  }

  await audit(tx, {
    entityType: 'tenant_membership',
    entityId: membershipId,
    action: 'user.invited',
    after: { email, roles: input.roleNames, employee_id: input.employeeId ?? null },
  });

  return { userId, membershipId };
}
