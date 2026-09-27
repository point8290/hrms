import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { getAppPool, getPlatformPool } from '../infra/db/pool.ts';
import { getRedis } from '../infra/redis.ts';
import { storage } from '../infra/storage.ts';

/**
 * Health endpoints, separated by what the answer is used for.
 *
 * Collapsing these into one `/health` is the mistake that takes a system down during a
 * partial outage: an orchestrator restarting pods because Redis is slow turns a degraded
 * dependency into an outage, and a load balancer sending traffic to a pod whose database
 * pool has not been established turns a rolling deploy into a wall of 500s.
 *
 *   /health/live   — is this process alive? No dependencies. Answers the restart question.
 *   /health/ready  — can it serve a request right now? Only what is strictly required.
 *   /health/deps   — what does it think of everything it talks to? Diagnostics, never
 *                    wired to an orchestrator.
 *
 * None of them require authentication, and none of them may leak anything: a connection
 * string, a bucket name or a queue URL in a health response is a free map of the estate.
 * Each check reports a name, a status and a duration, and nothing else.
 */

/** A dependency check must never hold a probe open; the orchestrator has its own timeout. */
const CHECK_TIMEOUT_MS = 2_000;

export type CheckStatus = 'ok' | 'degraded' | 'down' | 'not_configured';

export type CheckResult = {
  name: string;
  status: CheckStatus;
  duration_ms: number;
  /** Short, non-identifying. Never a connection string, host, bucket or credential. */
  detail?: string;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref?.(),
    ),
  ]);
}

async function timed(name: string, fn: () => Promise<CheckStatus | void>): Promise<CheckResult> {
  const started = Date.now();
  try {
    const status = (await withTimeout(Promise.resolve(fn()), CHECK_TIMEOUT_MS)) ?? 'ok';
    return { name, status, duration_ms: Date.now() - started };
  } catch (err) {
    return {
      name,
      status: 'down',
      duration_ms: Date.now() - started,
      // Message only. The stack and any connection detail stay in the logs.
      detail: err instanceof Error ? err.message.slice(0, 200) : 'check failed',
    };
  }
}

/** The database is not optional: without it the API cannot answer anything correctly. */
export async function checkDatabase(): Promise<CheckResult> {
  return timed('database', async () => {
    await getAppPool().query('SELECT 1');
  });
}

export async function checkPlatformDatabase(): Promise<CheckResult> {
  return timed('database_platform', async () => {
    await getPlatformPool().query('SELECT 1');
  });
}

/**
 * Redis is degraded-not-down on purpose. It backs rate limiting only, which fails open, so
 * an unreachable Redis costs limit accuracy rather than availability (invariants.md
 * #architecture). Reporting it as `down` would take healthy instances out of rotation over
 * a dependency the request path does not need.
 */
export async function checkRedis(): Promise<CheckResult> {
  return timed('redis', async () => {
    const cfg = config();
    if (!cfg.REDIS_URL) return 'not_configured';
    const client = (await getRedis()) as { status?: string; ping?: () => Promise<string> } | null;
    if (!client) return 'not_configured';
    if (typeof client.ping !== 'function') return client.status === 'ready' ? 'ok' : 'degraded';
    try {
      await client.ping();
      return 'ok';
    } catch {
      return 'degraded';
    }
  });
}

/**
 * Object storage is checked by a metadata call, never by writing. A health check that
 * writes is a health check that fills a bucket and costs money on every probe.
 */
export async function checkStorage(): Promise<CheckResult> {
  return timed('storage', async () => {
    await storage().healthCheck();
  });
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Liveness. Deliberately checks nothing else: if this process can run an event loop tick
   * it should not be killed. Touching the database here means a database blip restarts
   * every API pod at once, which is how a brief incident becomes a long one.
   */
  app.get('/health/live', async () => ({ status: 'alive', uptime_s: Math.round(process.uptime()) }));

  /**
   * Readiness. Only the dependencies a request genuinely cannot proceed without — which is
   * the database and nothing else. Redis, S3 and SQS all have degraded paths, so a request
   * can still be served correctly while they are unavailable.
   */
  app.get('/health/ready', async (_request, reply) => {
    const database = await checkDatabase();
    if (database.status !== 'ok') {
      return reply.code(503).send({ status: 'unavailable', checks: [database] });
    }
    return { status: 'ready', checks: [database] };
  });

  /**
   * Dependency diagnostics. Always 200 with a body describing what is wrong, because this
   * endpoint answers "what is broken" and a non-200 would tell a load balancer to act on
   * information it should not act on.
   */
  app.get('/health/deps', async () => {
    const checks = await Promise.all([
      checkDatabase(),
      checkPlatformDatabase(),
      checkRedis(),
      checkStorage(),
    ]);

    const status = checks.some((c) => c.status === 'down')
      ? 'down'
      : checks.some((c) => c.status === 'degraded')
        ? 'degraded'
        : 'ok';

    return { status, checks };
  });

  /** Kept for existing probes. Same contract as /health/live. */
  app.get('/health', async () => ({ status: 'ok' }));
}
