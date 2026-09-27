import { config } from './config.ts';
import { buildApp } from './http/app.ts';
import { closePools, probeRlsEnforcement } from './infra/db/pool.ts';
import { closeRedis } from './infra/redis.ts';
import { initTelemetry } from './infra/telemetry.ts';

/**
 * Boot sequence.
 *
 * The RLS probe runs before the server listens. If the database connection is not
 * actually subject to row-level security, the process exits instead of serving requests
 * that would silently cross tenant boundaries (ADR-002). A misconfigured DATABASE_URL is
 * the failure this catches, and it is the single worst failure this system can have.
 */
async function main(): Promise<void> {
  const cfg = config();

  // Before the app is built, so the first request is already traced.
  await initTelemetry({ serviceName: cfg.SERVICE_NAME });

  const app = await buildApp();

  const probe = await probeRlsEnforcement();
  if (!probe.enforced) {
    const message = `Tenant isolation is not enforced for this database connection: ${probe.reason}`;
    if (cfg.ALLOW_UNVERIFIED_RLS) {
      app.log.error({ reason: probe.reason }, `${message} — continuing because ALLOW_UNVERIFIED_RLS is set`);
    } else {
      app.log.fatal(
        { reason: probe.reason },
        `${message}. Connect as a non-owner role without BYPASSRLS (see db/roles.sql).`,
      );
      await app.close();
      await Promise.all([closePools(), closeRedis()]);
      process.exit(1);
    }
  } else {
    app.log.info('tenant isolation verified: RLS is enforced for this connection');
  }

  await app.listen({ port: cfg.API_PORT, host: '0.0.0.0' });

  // Drain in-flight requests before dropping connections, so a deploy does not abort
  // a payroll finalization midway.
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await Promise.all([closePools(), closeRedis()]);
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Failed to start HRMS API:', err);
  process.exit(1);
});
