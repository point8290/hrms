import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { AppError, badRequest, unauthorized } from '../infra/errors.ts';
import { withTenant, type TenantTx } from '../infra/db/pool.ts';
import { actorFrom, verifyAccessToken, type Principal } from './auth.ts';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/** Populates request.principal. Routes opt in via `preHandler: [authenticate]`. */
export async function authenticate(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw unauthorized('Missing bearer token');
  }
  request.principal = await verifyAccessToken(header.slice(7).trim());
}

export function principalOf(request: FastifyRequest): Principal {
  if (!request.principal) {
    // Reaching here means a route forgot `authenticate`. Fail closed and loudly.
    throw new AppError(500, 'missing_auth_preHandler', 'Route is missing authentication');
  }
  return request.principal;
}

/**
 * Opens a tenant-scoped transaction for the authenticated caller.
 *
 * Every request handler that touches tenant data goes through here, which is what makes
 * "tenant context is always established before a tenant query" a structural property
 * rather than a convention someone has to remember.
 */
export function inTenant<T>(
  request: FastifyRequest,
  fn: (tx: TenantTx, principal: Principal) => Promise<T>,
): Promise<T> {
  const principal = principalOf(request);
  const actor = actorFrom(principal, {
    requestId: request.id,
    correlationId: (request.headers['x-correlation-id'] as string | undefined) ?? request.id,
    ip: request.ip,
  });
  return withTenant(principal.tenantId, actor, (tx) => fn(tx, principal));
}

export function parseBody<S extends ZodTypeAny>(request: FastifyRequest, schema: S): z.infer<S> {
  return parse(schema, request.body);
}

export function parseParams<S extends ZodTypeAny>(request: FastifyRequest, schema: S): z.infer<S> {
  return parse(schema, request.params);
}

export function parseQuery<S extends ZodTypeAny>(request: FastifyRequest, schema: S): z.infer<S> {
  return parse(schema, request.query);
}

function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw badRequest('validation_failed', 'Request validation failed', fieldErrors(result.error));
  }
  return result.data;
}

export function fieldErrors(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

export function created(reply: FastifyReply, body: unknown): unknown {
  reply.code(201);
  return body;
}

export function accepted(reply: FastifyReply, body: unknown): unknown {
  reply.code(202);
  return body;
}

export function noContent(reply: FastifyReply): void {
  reply.code(204).send();
}
