import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, created, inTenant, parseBody } from '../../http/context.ts';
import { requirePermission } from '../../http/auth.ts';
import { config } from '../../config.ts';
import * as identity from './service.ts';
import { revokeAllSessions } from './service.ts';
import * as authFlows from './auth-flows.ts';
import { queueAuthEmail } from './auth-mail.ts';
import { mfaRoutes } from './mfa-routes.ts';

const uuid = z.string().uuid();

export async function identityRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Self-service tenant signup. Unauthenticated by necessity — there is no tenant to
   * authenticate against yet — so it is rate limited harder than the rest of the API.
   */
  app.post(
    '/api/tenants',
    // Five an hour in production, and the configuration refuses to boot with anything looser
    // there. Development raises it so a demo can be rehearsed without waiting out a limiter.
    {
      config: {
        rateLimit: {
          max: config().SIGNUP_RATE_LIMIT_MAX,
          timeWindow: config().SIGNUP_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const body = parseBody(
        request,
        z.object({
          tenantName: z.string().min(2).max(120),
          slug: z.string().min(3).max(40),
          timezone: z.string().optional(),
          currency: z.string().length(3).optional(),
          countryCode: z.string().length(2).optional(),
          adminEmail: z.string().email(),
          adminPassword: z.string().min(12).max(200),
          adminName: z.string().min(2).max(120),
        }),
      );
      const result = await identity.provisionTenant(body);
      return created(reply, { tenant_id: result.tenantId, user_id: result.userId });
    },
  );

  /** One shape for every path that produces a session, so they cannot drift apart. */
  function loginResponse(result: identity.LoginResult) {
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

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (request) => {
      const body = parseBody(
        request,
        z.object({
          slug: z.string().min(1),
          email: z.string().email(),
          password: z.string().min(1).max(200),
        }),
      );
      const result = await identity.login(body);
      if (identity.isChallenge(result)) {
        // 200, not 401: the password was correct and the client must continue, not retry.
        // The body carries no access of any kind.
        return {
          mfa_required: true,
          stage: result.stage,
          challenge_token: result.challengeToken,
          expires_in: result.expiresIn,
          tenant: result.tenant,
          user: result.user,
        };
      }
      return loginResponse(result);
    },
  );

  await mfaRoutes(app);

  app.post(
    '/api/auth/refresh',
    { config: { rateLimit: { max: 60, timeWindow: '5 minutes' } } },
    async (request) => {
      const body = parseBody(request, z.object({ tenant_id: uuid, refresh_token: z.string().min(10) }));
      const result = await identity.refresh(body.tenant_id, body.refresh_token);
      return {
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
        token_type: 'Bearer',
        expires_in: result.expiresIn,
        permissions: result.permissions,
      };
    },
  );

  app.post('/api/auth/logout', { preHandler: [authenticate] }, async (request, reply) => {
    await inTenant(request, async (tx, principal) => revokeAllSessions(tx, principal.userId));
    reply.code(204);
    return null;
  });

  /**
   * Starts a password reset.
   *
   * Always answers the same way. Reporting whether an address is registered would turn
   * this into an account-enumeration oracle; the rate limit is tight for the same reason.
   */
  app.post(
    '/api/auth/forgot-password',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = parseBody(request, z.object({ email: z.string().email() }));
      const result = await authFlows.requestPasswordReset(body.email, request.ip);

      if (result.token && result.userId) {
        await queueAuthEmail({
          userId: result.userId,
          email: result.email,
          template: 'auth.password_reset',
          token: result.token,
        });
      }

      reply.code(202);
      return { status: 'accepted', message: 'If that address has an account, a reset link is on its way.' };
    },
  );

  app.post(
    '/api/auth/reset-password',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request) => {
      const body = parseBody(
        request,
        z.object({ token: z.string().min(20), password: z.string().min(12).max(200) }),
      );
      await authFlows.completePasswordReset(body.token, body.password);
      // Every session is revoked by the reset itself, so there is nothing to return.
      return { status: 'reset', message: 'Password changed. Sign in with your new password.' };
    },
  );

  app.post('/api/auth/change-password', { preHandler: [authenticate] }, async (request) => {
    const body = parseBody(
      request,
      z.object({
        currentPassword: z.string().min(1).max(200),
        newPassword: z.string().min(12).max(200),
      }),
    );
    const principal = request.principal!;
    await authFlows.changePassword(
      principal.tenantId,
      principal.userId,
      body.currentPassword,
      body.newPassword,
    );
    return { status: 'changed', message: 'Password changed. Other devices have been signed out.' };
  });

  app.post(
    '/api/auth/verify-email',
    { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } },
    async (request) => {
      const body = parseBody(request, z.object({ token: z.string().min(20) }));
      await authFlows.verifyEmail(body.token);
      return { status: 'verified' };
    },
  );

  app.post('/api/auth/resend-verification', { preHandler: [authenticate] }, async (request, reply) => {
    const principal = request.principal!;
    const { token } = await authFlows.issueEmailVerification(principal.userId);
    await queueAuthEmail({
      userId: principal.userId,
      email: '',
      template: 'auth.verify_email',
      token,
      tenantId: principal.tenantId,
    });
    reply.code(202);
    return { status: 'accepted' };
  });

  app.get('/api/auth/me', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const { rows } = await tx.query(
        `SELECT u.id, u.email, u.full_name, e.id AS employee_id, e.employee_code,
                t.name AS tenant_name, t.slug AS tenant_slug, t.timezone, t.currency
           FROM identity.app_user u
           JOIN identity.tenant t ON t.id = $1
           LEFT JOIN core.employee e ON e.tenant_id = $1 AND e.user_id = u.id
          WHERE u.id = $2`,
        [tx.tenantId, principal.userId],
      );
      return { ...rows[0], permissions: [...principal.permissions].sort() };
    }),
  );

  app.post('/api/users', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'user.manage');
      const body = parseBody(
        request,
        z.object({
          email: z.string().email(),
          fullName: z.string().min(2).max(120),
          password: z.string().min(12).max(200),
          roleNames: z.array(z.string().min(1)).min(1),
          employeeId: uuid.optional(),
        }),
      );
      const result = await identity.inviteUser(tx, body);
      return created(reply, { user_id: result.userId, membership_id: result.membershipId });
    }),
  );

  app.get('/api/roles', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'role.manage', 'user.manage');
      const { rows } = await tx.query(
        `SELECT r.id, r.name, r.description, r.is_system,
                COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code)
                         FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
           FROM identity.role r
           LEFT JOIN identity.role_permission rp ON rp.role_id = r.id
          WHERE r.tenant_id = $1
          GROUP BY r.id
          ORDER BY r.is_system DESC, r.name`,
        [tx.tenantId],
      );
      return { roles: rows };
    }),
  );

  app.get('/api/permissions', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'role.manage');
      const { rows } = await tx.query('SELECT code, description, sensitive FROM identity.permission ORDER BY code');
      return { permissions: rows };
    }),
  );
}
