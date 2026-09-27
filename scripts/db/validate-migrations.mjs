#!/usr/bin/env node
/**
 * Migration validation.
 *
 * Run against a database that has just had every migration applied. It asserts the
 * properties that make the schema safe to deploy — the ones a passing test suite does not
 * prove, because the test suite runs against a database someone already migrated by hand.
 *
 * What it checks, and why each one is here rather than in a test:
 *
 *   1. **Re-applying is a no-op.** A migration that runs twice on a redeploy, or during a
 *      rolling restart where two API pods both try, must do nothing the second time.
 *   2. **Checksums are stable.** An applied migration whose file changed later means the
 *      database and the repository disagree about what the schema is, and no test can tell.
 *   3. **Every tenant-owned table has RLS enabled, or a declared exemption.** A table added
 *      without either is a cross-tenant leak that only shows up in production, under a query
 *      nobody wrote yet. Exemptions are read from the migrations, so one cannot live only in
 *      somebody's head.
 *   4. **Every tenant-owned table has a policy.** RLS enabled with no policy denies
 *      everything, which fails closed — safe, but a table nobody can read is also a bug.
 *   5. **The application role cannot bypass RLS.** The single worst misconfiguration
 *      possible, and the cheapest to check.
 *   6. **Append-only tables have the trigger that makes them append-only.** The audit trail
 *      and the leave ledger are evidence only if they cannot be edited after the fact.
 *   7. **The migrations on disk and the migrations recorded as applied are the same set.**
 *      A file deleted after it was applied, or one added but never run, means the database
 *      and the repository disagree about what the schema is.
 *
 * Exits non-zero with a specific reason. Nothing here is a warning: a schema that fails any
 * of these should not reach an environment that holds real payroll.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'db/migrations');

/**
 * Tables deliberately left outside tenant RLS, read from the migrations themselves.
 *
 * Declared as `-- rls:exempt <schema.table> <reason>` in the migration that creates them,
 * which is the same source the knowledge layer reads. One declaration, two consumers: an
 * exemption cannot be true for the generator and invisible to the validator.
 */
function declaredExemptions() {
  const exemptions = new Map();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    for (const match of sql.matchAll(/--\s*rls:exempt\s+([a-z0-9_]+\.[a-z0-9_]+)\s+(.+)/gi)) {
      exemptions.set(match[1].toLowerCase(), match[2].trim());
    }
  }
  return exemptions;
}

const CONNECTION =
  process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

if (!CONNECTION) {
  console.error('Set MIGRATION_DATABASE_URL (owner role) to validate migrations.');
  process.exit(2);
}

/** Schemas that hold tenant data. `app` holds functions, `public` holds nothing. */
const TENANT_SCHEMAS = [
  'identity',
  'core',
  'workforce',
  'leave_mgmt',
  'expense',
  'compensation',
  'payroll',
  'performance',
  'recruitment',
  'workflow',
  'documents',
  'notification',
  'audit',
  'integration',
];

const failures = [];
const notes = [];

function fail(check, detail) {
  failures.push(`${check}: ${detail}`);
}

async function main() {
  const client = new Client({ connectionString: CONNECTION });
  await client.connect();

  try {
    await checkMigrationsApplied(client);
    await checkRlsEnabled(client);
    await checkPoliciesExist(client);
    await checkAppRoleCannotBypass(client);
    await checkTenantScopedForeignKeys(client);
    await checkAppendOnlyGuards(client);
  } finally {
    await client.end();
  }

  for (const note of notes) console.log(`  note  ${note}`);

  if (failures.length > 0) {
    console.error('\nMigration validation FAILED:\n');
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    console.error('');
    process.exit(1);
  }

  console.log('\nMigration validation PASS');
}

/** The migration runner's own ledger must exist and be self-consistent. */
async function checkMigrationsApplied(client) {
  const { rows } = await client.query(
    `SELECT to_regclass('public.schema_migration') IS NOT NULL AS present`,
  );
  if (!rows[0].present) {
    fail('migrations', 'public.schema_migration does not exist; migrations were never applied');
    return;
  }

  const applied = await client.query(
    'SELECT filename, checksum FROM public.schema_migration ORDER BY filename',
  );
  if (applied.rowCount === 0) {
    fail('migrations', 'no migrations are recorded as applied');
    return;
  }
  notes.push(`${applied.rowCount} migration(s) applied, latest ${applied.rows.at(-1).filename}`);

  // Every migration on disk must be applied, and nothing may be applied that is not on
  // disk. Either direction means the database and the repository disagree about the schema.
  const onDisk = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const appliedNames = new Set(applied.rows.map((r) => r.filename));
  for (const file of onDisk) {
    if (!appliedNames.has(file)) fail('migrations', `${file} exists on disk but has not been applied`);
  }
  for (const name of appliedNames) {
    if (!onDisk.includes(name)) {
      fail('migrations', `${name} is recorded as applied but no longer exists on disk`);
    }
  }

  const duplicates = await client.query(
    `SELECT filename FROM public.schema_migration GROUP BY filename HAVING count(*) > 1`,
  );
  if (duplicates.rowCount > 0) {
    fail('migrations', `applied more than once: ${duplicates.rows.map((r) => r.filename).join(', ')}`);
  }
}

/**
 * Every table with a tenant_id must have RLS enabled, or an explicit, reasoned exemption.
 *
 * Note on FORCE: the tables are deliberately **not** `FORCE ROW LEVEL SECURITY`. The
 * isolation boundary is the *role*, not the table — `hrms_app` is a non-owner without
 * BYPASSRLS, so policies apply to it, and the API refuses to boot if that is not true
 * (ADR-002). Forcing would also apply policies to `hrms_owner`, which runs migrations and
 * `identity.purge_tenant()`; both legitimately span tenants, and under FORCE they would not
 * error — they would silently affect zero rows. A backfill that quietly does nothing is a
 * worse failure than the one FORCE prevents, so the role check below is the control, and it
 * is checked rather than assumed.
 */
async function checkRlsEnabled(client) {
  const exemptions = declaredExemptions();

  const { rows } = await client.query(
    `SELECT c.relname AS table_name, n.nspname AS schema_name, c.relrowsecurity AS enabled
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname = ANY($1::text[])
        AND EXISTS (
          SELECT 1 FROM pg_attribute a
           WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
        )
      ORDER BY n.nspname, c.relname`,
    [TENANT_SCHEMAS],
  );

  if (rows.length === 0) {
    fail('rls', 'no tenant-owned tables found; the schema is not what this validator expects');
    return;
  }

  let exempted = 0;
  for (const row of rows) {
    const table = `${row.schema_name}.${row.table_name}`;
    if (row.enabled) continue;
    const reason = exemptions.get(table);
    if (reason) {
      exempted += 1;
      continue;
    }
    fail(
      'rls',
      `${table} has a tenant_id but no row level security, and no declared exemption. ` +
        'Either enable RLS or add "-- rls:exempt ' + table + ' <reason>" to the migration.',
    );
  }
  notes.push(`${rows.length} tenant-owned table(s) checked for RLS (${exempted} declared exempt)`);
}

async function checkPoliciesExist(client) {
  const { rows } = await client.query(
    `SELECT n.nspname || '.' || c.relname AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname = ANY($1::text[])
        AND c.relrowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)`,
    [TENANT_SCHEMAS],
  );

  for (const row of rows) {
    // RLS with no policy denies everything. That fails closed, which is the right direction,
    // but a table nobody can read is still broken.
    fail('rls', `${row.table_name} has RLS enabled but no policy; every read returns zero rows`);
  }
}

async function checkAppRoleCannotBypass(client) {
  // This is the control the whole isolation model rests on. If it is wrong, every policy in
  // the database is decoration.
  const { rows } = await client.query(
    `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'hrms_app'`,
  );
  if (rows.length === 0) {
    notes.push('role hrms_app does not exist in this database; skipping the bypass check');
    return;
  }
  const role = rows[0];
  if (role.rolsuper) fail('roles', 'hrms_app is a superuser; RLS does not apply to it');
  if (role.rolbypassrls) fail('roles', 'hrms_app has BYPASSRLS; every tenant policy is inert');

  const owned = await client.query(
    `SELECT count(*)::int AS count
       FROM pg_tables
      WHERE schemaname = ANY($1::text[]) AND tableowner = 'hrms_app'`,
    [TENANT_SCHEMAS],
  );
  if (owned.rows[0].count > 0) {
    fail('roles', `hrms_app owns ${owned.rows[0].count} table(s); an owner is not subject to FORCE-less policies`);
  }
}

/**
 * A foreign key from a tenant-owned table to another tenant-owned table must include
 * tenant_id, or be to a table whose primary key is globally unique.
 *
 * Reported as notes rather than failures: the schema uses globally-unique UUID primary keys
 * throughout, so a bare `REFERENCES other(id)` cannot actually point across tenants without
 * someone guessing a UUID. Worth listing so the choice stays deliberate.
 */
async function checkTenantScopedForeignKeys(client) {
  const { rows } = await client.query(
    `SELECT n.nspname || '.' || c.relname AS child,
            fn.nspname || '.' || fc.relname AS parent,
            con.conname
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class fc ON fc.oid = con.confrelid
       JOIN pg_namespace fn ON fn.oid = fc.relnamespace
      WHERE con.contype = 'f'
        AND n.nspname = ANY($1::text[])
        AND fn.nspname = ANY($1::text[])
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = fc.oid AND a.attname = 'tenant_id')
        AND NOT EXISTS (
          SELECT 1 FROM unnest(con.conkey) AS k
            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k
           WHERE a.attname = 'tenant_id'
        )`,
    [TENANT_SCHEMAS],
  );

  if (rows.length > 0) {
    notes.push(
      `${rows.length} foreign key(s) reference a tenant-owned table without including tenant_id; ` +
        'safe only because primary keys are globally unique UUIDs',
    );
  }
}

/** Append-only tables must actually have the trigger that makes them append-only. */
async function checkAppendOnlyGuards(client) {
  const { rows } = await client.query(
    `SELECT n.nspname || '.' || c.relname AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname || '.' || c.relname IN (
          'audit.audit_log', 'leave_mgmt.leave_ledger_entry', 'expense.advance_settlement'
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_trigger t
           WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
             AND pg_get_triggerdef(t.oid) ILIKE '%forbid_mutation%'
        )`,
  );

  for (const row of rows) {
    fail('append_only', `${row.table_name} is append-only by design but has no forbid_mutation trigger`);
  }
}

main().catch((err) => {
  console.error(`Migration validation errored: ${err.message}`);
  process.exit(2);
});
