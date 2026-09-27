import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { config } from '../config.ts';
import { forbidden, unauthorized } from '../infra/errors.ts';
import type { ActorContext } from '../infra/db/pool.ts';

const claimsSchema = z.object({
  sub: z.string().uuid(),
  tid: z.string().uuid(),
  mid: z.string().uuid(),
  eid: z.string().uuid().nullable().optional(),
  perms: z.array(z.string()),
  name: z.string(),
  /** Whether this session passed a second factor. Absent on tokens issued before MFA. */
  mfa: z.boolean().optional(),
});

export type AccessClaims = z.infer<typeof claimsSchema>;

/**
 * The authenticated caller for the current request.
 *
 * tenantId comes from the verified token, never from a header, path or body: a
 * client-supplied tenant is a cross-tenant escalation waiting to happen.
 */
export type Principal = {
  userId: string;
  tenantId: string;
  membershipId: string;
  employeeId: string | null;
  permissions: ReadonlySet<string>;
  displayName: string;
  /** Whether a second factor was presented for this session. */
  mfaVerified: boolean;
};

const encoder = new TextEncoder();
const ISSUER = 'hrms-api';
const AUDIENCE = 'hrms-client';

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  const cfg = config();
  return new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${cfg.JWT_ACCESS_TTL_SECONDS}s`)
    .sign(encoder.encode(cfg.JWT_SECRET));
}

/**
 * Verifies against the current secret and, if configured, the previous one. That makes
 * secret rotation a deploy rather than a forced logout for every active session.
 */
export async function verifyAccessToken(token: string): Promise<Principal> {
  const cfg = config();
  const secrets = [cfg.JWT_SECRET, cfg.JWT_PREVIOUS_SECRET].filter(Boolean) as string[];

  for (const secret of secrets) {
    try {
      const { payload } = await jwtVerify(token, encoder.encode(secret), {
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const claims = claimsSchema.parse(payload);
      return {
        userId: claims.sub,
        tenantId: claims.tid,
        membershipId: claims.mid,
        employeeId: claims.eid ?? null,
        permissions: new Set(claims.perms),
        displayName: claims.name,
        mfaVerified: claims.mfa === true,
      };
    } catch {
      // try the next secret; a genuinely invalid token fails on all of them
    }
  }
  throw unauthorized('Invalid or expired access token');
}

export function actorFrom(
  principal: Principal,
  meta: { requestId?: string; correlationId?: string; ip?: string } = {},
): ActorContext {
  return {
    userId: principal.userId,
    employeeId: principal.employeeId,
    label: principal.displayName,
    ...meta,
  };
}

export function hasPermission(principal: Principal, permission: string): boolean {
  return principal.permissions.has(permission);
}

export function requirePermission(principal: Principal, ...anyOf: string[]): void {
  if (!anyOf.some((p) => principal.permissions.has(p))) {
    throw forbidden(`Requires one of: ${anyOf.join(', ')}`);
  }
}

/**
 * Resolves the employee record a caller may act on for "self or other" endpoints.
 *
 * Self-service permissions are deliberately separate from the broad ones: an employee
 * with only `leave.read.self` can read their own leave and nothing else, and the check
 * lives here rather than being re-derived (and eventually forgotten) in each route.
 */
export function resolveTargetEmployee(
  principal: Principal,
  requested: string | undefined,
  perms: { self: string; others: string },
): { employeeId: string; scope: 'self' | 'others' } {
  const target = requested ?? principal.employeeId;
  if (!target) {
    throw forbidden('This account is not linked to an employee record');
  }
  if (target === principal.employeeId && hasPermission(principal, perms.self)) {
    return { employeeId: target, scope: 'self' };
  }
  requirePermission(principal, perms.others);
  return { employeeId: target, scope: 'others' };
}
