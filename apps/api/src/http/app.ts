import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config } from '../config.ts';
import { AppError, isPgError, PG_CHECK_VIOLATION, PG_EXCLUSION_VIOLATION, PG_FOREIGN_KEY_VIOLATION, PG_RESTRICT_VIOLATION, PG_UNIQUE_VIOLATION } from '../infra/errors.ts';
import { describeConstraintViolation } from '../modules/core-hr/service.ts';
import { getRedis } from '../infra/redis.ts';
import { fieldErrors } from './context.ts';
import { healthRoutes } from './health.ts';
import { currentTrace, formatTraceparent, newSpanId, newTraceId, parseTraceparent, recordSpan, runInTrace } from '../infra/telemetry.ts';
import { identityRoutes } from '../modules/identity/routes.ts';
import { tenantRoutes } from '../modules/tenant/routes.ts';
import { coreHrRoutes } from '../modules/core-hr/routes.ts';
import { workforceRoutes } from '../modules/workforce/routes.ts';
import { leaveRoutes } from '../modules/leave/routes.ts';
import { workflowRoutes } from '../modules/workflow/routes.ts';
import { compensationRoutes, payrollRoutes } from '../modules/payroll/routes.ts';
import { auditRoutes, documentRoutes } from '../modules/documents/routes.ts';
import { reportingRoutes } from '../modules/reporting/routes.ts';
import { notificationRoutes } from '../modules/notification/routes.ts';
import { expenseRoutes } from '../modules/expense/routes.ts';
import { onboardingRoutes } from '../modules/onboarding/routes.ts';

export async function buildApp(): Promise<FastifyInstance> {
  const cfg = config();

  const app = Fastify({
    logger: {
      level: cfg.LOG_LEVEL,
      // Structured logs; never log tokens, passwords or account numbers.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.adminPassword',
          'req.body.accountNumber',
          'req.body.refresh_token',
        ],
        censor: '[redacted]',
      },
      serializers: {
        req: (req) => ({ method: req.method, url: req.url, id: req.id }),
      },
    },
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: cfg.isProduction ? (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean) : true,
    credentials: true,
  });
  // Distributed rate limiting. Without a shared store the limit is per-process, so the
  // effective allowance silently multiplies by the instance count — the limit would stop
  // meaning anything the moment the API scales past one node.
  const redis = await getRedis();
  if (!redis && cfg.isProduction) {
    throw new Error('Redis is required in production: rate limiting must be shared across instances');
  }
  if (!redis) {
    app.log.warn('rate limiting is per-process; set REDIS_URL to share it across instances');
  }

  await app.register(rateLimit, {
    max: cfg.RATE_LIMIT_MAX,
    timeWindow: cfg.RATE_LIMIT_WINDOW,
    ...(redis ? { redis } : {}),
    // Namespaced so a shared Redis (or a key dump) cannot be confused with other data.
    nameSpace: 'hrms:rl:',
    // Rate limit per authenticated session where possible, so one noisy tenant cannot
    // exhaust another's budget from behind a shared NAT.
    keyGenerator: (request) => {
      const auth = request.headers.authorization;
      return auth ? `${request.ip}:${auth.slice(-24)}` : request.ip;
    },
    /**
     * Fail open when the shared store is unreachable.
     *
     * A Redis outage must not take the API down with it. Rate limiting is a protection
     * against abuse, not a correctness control — tenant isolation and authorization are
     * enforced elsewhere and are unaffected — so degrading to "allow" is the right trade
     * for a brief outage.
     */
    skipOnError: true,
  });

  /**
   * Raw body for the local-storage PUT endpoint; every other route is JSON.
   *
   * A presigned upload carries the *file's* content type, not `application/octet-stream` —
   * that is what the presign hands the client and what S3 expects to receive. Fastify has no
   * parser for those, so it answered 415 and document upload could never work against the
   * local driver, while the same code worked against S3 because those bytes never reach
   * Fastify at all. Registering the types the document API already accepts closes that gap;
   * the upload endpoint still verifies its own signature, and `/api` routes remain JSON.
   */
  for (const contentType of [
    'application/octet-stream',
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]) {
    app.addContentTypeParser(contentType, { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });
  }

  // Action endpoints (/review, /approve, /finalize, /logout) take no body. Clients
  // routinely still send `content-type: application/json`, and Fastify's default parser
  // rejects that as a malformed request. Treating an empty body as `{}` keeps those calls
  // working without loosening validation: the route's own schema still decides what is
  // required.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (text === '') return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError(400, 'invalid_json', 'Request body is not valid JSON'), undefined);
    }
  });

  /**
   * Opens a trace for every request, continuing the caller's if it sent one.
   *
   * Two hooks rather than a wrapper, because Fastify's lifecycle starts and ends in
   * separate callbacks. `done()` is called *inside* the context, so everything downstream —
   * the handler, the database transaction, the events it emits — inherits the trace id
   * without anyone having to thread it through.
   *
   * Health checks are excluded: a probe every second would be the overwhelming majority of
   * the trace volume and it observes nothing.
   */
  app.addHook('onRequest', (request, reply, done) => {
    if (request.url.startsWith('/health')) return done();

    const parent = parseTraceparent(request.headers.traceparent as string | undefined);
    const context = {
      traceId: parent?.traceId ?? newTraceId(),
      spanId: newSpanId(),
      flags: parent?.flags ?? '01',
    };
    (request as { traceContext?: typeof context; traceStartedAt?: number }).traceContext = context;
    (request as { traceStartedAt?: number }).traceStartedAt = Date.now();
    (request as { traceParentSpanId?: string }).traceParentSpanId = parent?.spanId;

    runInTrace(context, done);
  });

  app.addHook('onResponse', async (request, reply) => {
    const tagged = request as {
      traceContext?: { traceId: string; spanId: string; flags: string };
      traceStartedAt?: number;
      traceParentSpanId?: string;
    };
    if (!tagged.traceContext || tagged.traceStartedAt === undefined) return;

    recordSpan({
      name: `${request.method} ${request.routeOptions?.url ?? 'unmatched'}`,
      context: tagged.traceContext,
      parentSpanId: tagged.traceParentSpanId,
      startedAt: tagged.traceStartedAt,
      status: reply.statusCode >= 500 ? 'error' : 'ok',
      attributes: {
        'http.method': request.method,
        'http.route': request.routeOptions?.url ?? 'unmatched',
        'http.status_code': reply.statusCode,
        // The tenant, never the user: a tenant id is an operational dimension, a user id in
        // a third-party trace store is personal data.
        'tenant.id': request.principal?.tenantId,
        component: 'api',
      },
    });
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    const trace = currentTrace();
    if (trace) reply.header('traceparent', formatTraceparent(trace));
  });

  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;

    if (error instanceof AppError) {
      // Client errors are expected traffic; only log the server-side ones loudly.
      if (error.statusCode >= 500) request.log.error({ err: error }, error.message);
      else request.log.info({ code: error.code, status: error.statusCode }, error.message);
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details, request_id: requestId },
      });
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'validation_failed',
          message: 'Request validation failed',
          details: fieldErrors(error),
          request_id: requestId,
        },
      });
    }

    // Translate the database's own integrity guarantees into meaningful responses
    // rather than leaking constraint names as 500s.
    const friendly = describeConstraintViolation(error);
    if (friendly) {
      return reply.code(409).send({ error: { code: 'constraint_violation', message: friendly, request_id: requestId } });
    }
    if (isPgError(error, PG_UNIQUE_VIOLATION)) {
      return reply.code(409).send({
        error: { code: 'duplicate', message: 'That record already exists', request_id: requestId },
      });
    }
    if (isPgError(error, PG_EXCLUSION_VIOLATION)) {
      return reply.code(409).send({
        error: { code: 'overlapping_record', message: 'This overlaps an existing record', request_id: requestId },
      });
    }
    if (isPgError(error, PG_FOREIGN_KEY_VIOLATION)) {
      return reply.code(422).send({
        error: { code: 'invalid_reference', message: 'A referenced record does not exist', request_id: requestId },
      });
    }
    if (isPgError(error, PG_CHECK_VIOLATION)) {
      return reply.code(422).send({
        error: { code: 'invalid_value', message: 'A value violates a database constraint', request_id: requestId },
      });
    }
    if (isPgError(error, PG_RESTRICT_VIOLATION)) {
      // Append-only tables and the finalized-payslip guard land here.
      return reply.code(409).send({
        error: {
          code: 'immutable_record',
          message: String((error as Error).message ?? 'This record cannot be modified').replace(/^.*?: /, ''),
          request_id: requestId,
        },
      });
    }

    // Framework errors (rate limit, malformed body, payload too large) already carry a
    // meaningful status. Reporting them as 500 would tell the client to retry a request
    // that will never succeed, and would hide genuine server faults in the noise.
    const frameworkStatus = (error as { statusCode?: number }).statusCode;
    if (typeof frameworkStatus === 'number' && frameworkStatus >= 400 && frameworkStatus < 500) {
      const framework = error as { code?: string; message?: string };
      request.log.info({ code: framework.code }, framework.message ?? 'bad request');
      return reply.code(frameworkStatus).send({
        error: {
          code: framework.code ?? 'bad_request',
          message: framework.message ?? 'Bad request',
          request_id: requestId,
        },
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({
      error: { code: 'internal_error', message: 'An unexpected error occurred', request_id: requestId },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: { code: 'not_found', message: `${request.method} ${request.url} is not a route`, request_id: request.id },
    });
  });

  await app.register(healthRoutes);

  await app.register(identityRoutes);
  await app.register(tenantRoutes);
  await app.register(coreHrRoutes);
  await app.register(workforceRoutes);
  await app.register(leaveRoutes);
  await app.register(workflowRoutes);
  await app.register(compensationRoutes);
  await app.register(payrollRoutes);
  await app.register(expenseRoutes);
  await app.register(onboardingRoutes);
  await app.register(documentRoutes);
  await app.register(auditRoutes);
  await app.register(reportingRoutes);
  await app.register(notificationRoutes);

  return app;
}
