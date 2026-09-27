import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, parseBody } from '../../http/context.ts';
import { withPlatform, withTenant } from '../../infra/db/pool.ts';
import { audit } from '../../infra/audit.ts';
import { unauthorized, unprocessable } from '../../infra/errors.ts';
import * as identity from './service.ts';
import {
  beginEnrolment,
  confirmEnrolment,
  disableMfa,
  holdsSensitivePermission,
  mfaState,
  signChallengeToken,
  verifyChallengeToken,
  verifySecondFactor,
} from './mfa.ts';

/**
 * Multi-factor endpoints.
 *
 * Two audiences, deliberately separate:
 *
 *   * `/api/auth/mfa/*` — reached with a **challenge token** during a half-finished login.
 *     These accept no bearer token, because the caller does not have a session yet.
 *   * `/api/account/mfa/*` — reached with a normal session, for someone managing their own
 *     factor after the fact.
 *
 * Every rate limit here is tight. An unauthenticated endpoint that checks a six-digit code
 * is a brute-force target, and six digits is a million possibilities — which a determined
 * attacker exhausts in minutes if the limit is generous.
 */

const codeSchema = z.string().trim().min(6).max(10);

export async function mfaRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Starts enrolment mid-login, for a privileged account that has no factor yet.
   *
   * The secret and recovery codes are returned once and never again. Returning them from an
   * endpoint reachable with only a challenge token is safe precisely because the challenge
   * token proves the password step and expires in five minutes.
   */
  app.post(
    '/api/auth/mfa/enroll',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request) => {
      const body = parseBody(request, z.object({ challenge_token: z.string().min(10) }));
      const challenge = await verifyChallengeToken(body.challenge_token);

      const context = await loadEnrolmentContext(challenge.sub, challenge.tid);
      const offer = await beginEnrolment({
        userId: challenge.sub,
        email: context.email,
        tenantName: context.tenantName,
      });

      return {
        secret: offer.secret,
        otpauth_uri: offer.otpauthUri,
        // Shown once. They are stored hashed, so this response is the only copy.
        recovery_codes: offer.recoveryCodes,
      };
    },
  );

  /**
   * Confirms enrolment and completes the login in one step.
   *
   * Combined on purpose: a separate "now log in again" step after enrolment is where people
   * abandon the flow, and an administrator who abandons enrolment is an administrator
   * without a second factor.
   */
  app.post(
    '/api/auth/mfa/confirm',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request) => {
      const body = parseBody(
        request,
        z.object({ challenge_token: z.string().min(10), code: codeSchema }),
      );
      const challenge = await verifyChallengeToken(body.challenge_token);
      await confirmEnrolment(challenge.sub, body.code);

      const context = await loadEnrolmentContext(challenge.sub, challenge.tid);
      await auditMfa(challenge.tid, challenge.sub, context.fullName, 'auth.mfa.enrolled', {
        method: 'totp',
      });

      return sessionResponse(
        await identity.issueSession({
          tenantId: challenge.tid,
          tenantName: context.tenantName,
          tenantSlug: context.tenantSlug,
          userId: challenge.sub,
          fullName: context.fullName,
          membershipId: challenge.mid,
          email: context.email,
          mfa: true,
        }),
      );
    },
  );

  /** Completes a login for an account that already has an authenticator. */
  app.post(
    '/api/auth/mfa/verify',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request) => {
      const body = parseBody(
        request,
        z
          .object({
            challenge_token: z.string().min(10),
            code: codeSchema.optional(),
            recovery_code: z.string().trim().min(8).max(32).optional(),
          })
          .refine((v) => Boolean(v.code) !== Boolean(v.recovery_code), {
            message: 'Provide either a code or a recovery code',
          }),
      );

      const challenge = await verifyChallengeToken(body.challenge_token);
      if (challenge.stage !== 'verify') {
        throw unprocessable('enrolment_required', 'This account must set up an authenticator first');
      }

      const result = await verifySecondFactor({
        userId: challenge.sub,
        code: body.code,
        recoveryCode: body.recovery_code,
      });

      const context = await loadEnrolmentContext(challenge.sub, challenge.tid);
      if (result.method === 'recovery') {
        // A recovery code being used is a signal worth keeping: it means a lost device, or
        // someone who should not have had the codes.
        const remaining = (await mfaState(challenge.sub)).unusedRecoveryCodes;
        await auditMfa(challenge.tid, challenge.sub, context.fullName, 'auth.mfa.recovery_code_used', {
          remaining_codes: remaining,
        });
      }

      return sessionResponse(
        await identity.issueSession({
          tenantId: challenge.tid,
          tenantName: context.tenantName,
          tenantSlug: context.tenantSlug,
          userId: challenge.sub,
          fullName: context.fullName,
          membershipId: challenge.mid,
          email: context.email,
          mfa: true,
        }),
      );
    },
  );

  /** What the signed-in person's own factor looks like. Never reports on anyone else. */
  app.get('/api/account/mfa', { preHandler: [authenticate] }, async (request) => {
    const principal = request.principal!;
    const state = await mfaState(principal.userId);
    const privileged = await withTenant(
      principal.tenantId,
      { userId: principal.userId, employeeId: principal.employeeId, label: principal.displayName },
      (tx) => holdsSensitivePermission(tx, principal.membershipId),
    );
    return {
      enrolled: state.enrolled,
      status: state.status,
      unused_recovery_codes: state.unusedRecoveryCodes,
      required: privileged,
      session_verified: principal.mfaVerified,
    };
  });

  /**
   * Enrolment (or re-enrolment) from inside a session.
   *
   * Re-enrolling replaces the secret and every recovery code, so a person who still has
   * their session but lost their phone can recover without an administrator handling their
   * credentials — and an old authenticator stops working the moment a new one is confirmed.
   */
  app.post(
    '/api/account/mfa/enroll',
    { preHandler: [authenticate], config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request) => {
      const principal = request.principal!;
      const context = await loadEnrolmentContext(principal.userId, principal.tenantId);
      const offer = await beginEnrolment({
        userId: principal.userId,
        email: context.email,
        tenantName: context.tenantName,
      });
      return { secret: offer.secret, otpauth_uri: offer.otpauthUri, recovery_codes: offer.recoveryCodes };
    },
  );

  app.post(
    '/api/account/mfa/confirm',
    { preHandler: [authenticate], config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request) => {
      const principal = request.principal!;
      const body = parseBody(request, z.object({ code: codeSchema }));
      await confirmEnrolment(principal.userId, body.code);
      await auditMfa(principal.tenantId, principal.userId, principal.displayName, 'auth.mfa.enrolled', {
        method: 'totp',
      });
      // The current access token predates the factor. The client must refresh to get a
      // session that claims `mfa: true`; saying so beats letting it wonder.
      return { status: 'active', reauthenticate: true };
    },
  );

  /**
   * Removes the factor. Requires the password and a current code — a hijacked session must
   * not be able to strip the control that would have stopped it — and is refused outright
   * for anyone holding privileged permissions.
   */
  app.post(
    '/api/account/mfa/disable',
    { preHandler: [authenticate], config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request) => {
      const principal = request.principal!;
      const body = parseBody(
        request,
        z.object({ password: z.string().min(1).max(200), code: codeSchema }),
      );

      const privileged = await withTenant(
        principal.tenantId,
        { userId: principal.userId, employeeId: principal.employeeId, label: principal.displayName },
        (tx) => holdsSensitivePermission(tx, principal.membershipId),
      );

      await disableMfa({
        userId: principal.userId,
        password: body.password,
        code: body.code,
        privileged,
      });

      await auditMfa(principal.tenantId, principal.userId, principal.displayName, 'auth.mfa.disabled', {});
      return { status: 'removed' };
    },
  );
}

function sessionResponse(result: identity.LoginResult) {
  return {
    access_token: result.accessToken,
    refresh_token: result.refreshToken,
    token_type: 'Bearer',
    expires_in: result.expiresIn,
    tenant: result.tenant,
    user: result.user,
    permissions: result.permissions,
    mfa: result.mfa,
  };
}

/**
 * Reads the identity a challenge token points at, and re-checks that it is still usable.
 *
 * Re-checked rather than trusted from the token: an account disabled in the five minutes
 * between the password step and the code step must not complete the login.
 */
async function loadEnrolmentContext(
  userId: string,
  tenantId: string,
): Promise<{ email: string; fullName: string; tenantName: string; tenantSlug: string }> {
  const row = await withPlatform('maintenance', async (tx) => {
    const { rows } = await tx.query<{
      email: string;
      full_name: string;
      tenant_name: string;
      tenant_slug: string;
      user_status: string;
      membership_status: string;
      tenant_status: string;
    }>(
      `SELECT u.email, u.full_name, t.name AS tenant_name, t.slug AS tenant_slug,
              u.status AS user_status, m.status AS membership_status, t.status AS tenant_status
         FROM identity.app_user u
         JOIN identity.tenant_membership m ON m.user_id = u.id
         JOIN identity.tenant t ON t.id = m.tenant_id
        WHERE u.id = $1 AND t.id = $2`,
      [userId, tenantId],
    );
    return rows[0];
  });

  if (
    !row ||
    row.user_status !== 'active' ||
    row.membership_status !== 'active' ||
    row.tenant_status !== 'active'
  ) {
    throw unauthorized('Invalid credentials');
  }

  return {
    email: row.email,
    fullName: row.full_name,
    tenantName: row.tenant_name,
    tenantSlug: row.tenant_slug,
  };
}

async function auditMfa(
  tenantId: string,
  userId: string,
  label: string,
  action: string,
  after: Record<string, unknown>,
): Promise<void> {
  await withTenant(tenantId, { userId, employeeId: null, label }, (tx) =>
    audit(tx, { entityType: 'user_mfa', entityId: userId, action, after }),
  );
}

export { signChallengeToken };
