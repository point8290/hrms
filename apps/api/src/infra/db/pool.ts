import pg from 'pg';
import { config } from '../../config.ts';
import { AppError } from '../errors.ts';

const { Pool } = pg;

// numeric/int8 arrive as strings by default so large values keep precision.
// Money and leave quantities are handled as strings and converted deliberately.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Queryable = {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
};

/** Identity of whoever caused a change. Flows into audit rows and event envelopes. */
export type ActorContext = {
  userId: string | null;
  employeeId: string | null;
  label: string;
  requestId?: string;
  correlationId?: string;
  ip?: string;
};

export type TenantTx = Queryable & {
  readonly tenantId: string;
  readonly actor: ActorContext;
  /** Runs after the transaction commits. Used for post-commit side effects only. */
  onCommit(fn: () => void | Promise<void>): void;
};

export const SYSTEM_ACTOR: ActorContext = {
  userId: null,
  employeeId: null,
  label: 'system',
};

let appPool: pg.Pool | undefined;
let platformPool: pg.Pool | undefined;

function createPool(connectionString: string, label: string): pg.Pool {
  const cfg = config();
  const pool = new Pool({
    connectionString,
    max: cfg.DB_POOL_MAX,
    statement_timeout: cfg.DB_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: cfg.DB_STATEMENT_TIMEOUT_MS,
    application_name: `hrms-${label}`,
  });
  pool.on('error', (err) => {
    // An idle client failed; pg removes it from the pool. Surface it, do not crash.
    console.error(JSON.stringify({ level: 'error', msg: 'idle db client error', pool: label, err: String(err) }));
  });
  return pool;
}

export function getAppPool(): pg.Pool {
  appPool ??= createPool(config().DATABASE_URL, 'app');
  return appPool;
}

export function getPlatformPool(): pg.Pool {
  const cfg = config();
  platformPool ??= createPool(cfg.PLATFORM_DATABASE_URL ?? cfg.DATABASE_URL, 'platform');
  return platformPool;
}

export async function closePools(): Promise<void> {
  await Promise.all([appPool?.end(), platformPool?.end()]);
  appPool = undefined;
  platformPool = undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` inside a transaction whose tenant context is set with SET LOCAL.
 *
 * This is the ONLY sanctioned way to touch tenant data. Transaction-local scoping is
 * deliberate: a session-level setting would survive on a pooled connection and leak
 * into the next tenant's request (ADR-002).
 */
export async function withTenant<T>(
  tenantId: string,
  actor: ActorContext,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    // Never interpolate an unvalidated value into SET LOCAL, and never proceed without
    // a real tenant: RLS would filter everything and the failure would look like "no data".
    throw new AppError(500, 'invalid_tenant_context', 'Tenant context is not a valid UUID');
  }

  const client = await getAppPool().connect();
  const afterCommit: Array<() => void | Promise<void>> = [];

  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    if (actor.userId) {
      await client.query("SELECT set_config('app.actor_id', $1, true)", [actor.userId]);
    }

    const tx: TenantTx = {
      tenantId,
      actor,
      query: (text, values) => client.query(text, values as unknown[]),
      onCommit: (cb) => {
        afterCommit.push(cb);
      },
    };

    const result = await fn(tx);
    await client.query('COMMIT');

    for (const cb of afterCommit) {
      try {
        await cb();
      } catch (err) {
        // A post-commit side effect must never undo committed business state.
        console.error(JSON.stringify({ level: 'error', msg: 'post-commit hook failed', err: String(err) }));
      }
    }
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken; pg discards it */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cross-tenant transaction using the BYPASSRLS platform role.
 *
 * Legitimate uses are narrow and must stay narrow: tenant provisioning, the outbox
 * publisher, and migrations. Anything that serves a user request belongs in withTenant.
 */
export async function withPlatform<T>(
  reason: 'tenant-provisioning' | 'outbox-publisher' | 'migration' | 'maintenance',
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  const client = await getPlatformPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('application_name', $1, true)", [`hrms-platform:${reason}`]);
    const result = await fn({ query: (text, values) => client.query(text, values as unknown[]) });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export type RlsProbeResult =
  | { enforced: true }
  | { enforced: false; reason: string };

/**
 * Proves at boot that the API's own connection is actually subject to RLS.
 *
 * Without this, pointing DATABASE_URL at the schema owner would silently disable every
 * tenant policy — the isolation model would be a comment rather than a control. The
 * probe writes nothing: it checks role attributes, ownership, and then confirms that a
 * tenant-scoped read really does return zero rows with no tenant context set.
 */
export async function probeRlsEnforcement(pool: pg.Pool = getAppPool()): Promise<RlsProbeResult> {
  const client = await pool.connect();
  try {
    const role = await client.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    const row = role.rows[0];
    if (!row) return { enforced: false, reason: 'current_user not found in pg_roles' };
    if (row.rolsuper) {
      return { enforced: false, reason: `connected as superuser "${row.rolname}"; RLS is bypassed` };
    }
    if (row.rolbypassrls) {
      return { enforced: false, reason: `role "${row.rolname}" has BYPASSRLS; RLS is bypassed` };
    }

    const owned = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM pg_tables
        WHERE schemaname IN ('identity','core','workforce','leave_mgmt','compensation','payroll',
                             'workflow','documents','notification','audit','integration')
          AND tableowner = current_user`,
    );
    const ownedCount = owned.rows[0]?.count ?? 0;
    if (ownedCount > 0) {
      return {
        enforced: false,
        reason: `role "${row.rolname}" owns ${ownedCount} business table(s); an owner is not subject to its own policies`,
      };
    }

    // Behavioural check: with no tenant context, a policy-protected table must be empty.
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.tenant_id', '', true)");
      const probe = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM core.employee',
      );
      if ((probe.rows[0]?.count ?? 0) > 0) {
        return {
          enforced: false,
          reason: 'core.employee returned rows without tenant context; the isolation policy is missing or ineffective',
        };
      }
    } finally {
      await client.query('ROLLBACK');
    }

    return { enforced: true };
  } finally {
    client.release();
  }
}
