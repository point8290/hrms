#!/usr/bin/env node
/**
 * Migration runner.
 *
 * Deliberately small: numbered .sql files applied once, in order, each inside its own
 * transaction, tracked in a ledger table. No down-migrations — a mistake is corrected by
 * a new forward migration, which is the only approach that stays honest once a migration
 * has run in production.
 *
 * Runs as the owner (MIGRATION_DATABASE_URL), not as the application role.
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations');
const GRANTS_FILE = path.join(ROOT, 'db', 'grants.sql');

const connectionString =
  process.env.MIGRATION_DATABASE_URL ?? process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.error('Set MIGRATION_DATABASE_URL (or DATABASE_URL) before running migrations.');
  process.exit(1);
}

const client = new pg.Client({ connectionString, application_name: 'hrms-migrate' });

async function main(): Promise<void> {
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migration (
      filename    text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Map(
    (await client.query<{ filename: string; checksum: string }>('SELECT filename, checksum FROM public.schema_migration'))
      .rows.map((r) => [r.filename, r.checksum]),
  );

  let ran = 0;
  for (const filename of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = applied.get(filename);

    if (previous) {
      // An edited migration means environments have diverged. Stop rather than guess.
      if (previous !== checksum) {
        throw new Error(
          `${filename} has changed since it was applied. Migrations are immutable — add a new one instead.`,
        );
      }
      continue;
    }

    const started = Date.now();
    process.stdout.write(`  applying ${filename} ... `);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO public.schema_migration (filename, checksum, duration_ms) VALUES ($1, $2, $3)',
        [filename, checksum, Date.now() - started],
      );
      await client.query('COMMIT');
      console.log(`done (${Date.now() - started}ms)`);
      ran += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      console.log('FAILED');
      throw new Error(`${filename}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Grants are re-applied every run so tables added by a migration are reachable by the
  // application role without a separate manual step.
  try {
    const grants = await readFile(GRANTS_FILE, 'utf8');
    await client.query(grants);
    console.log('  grants applied');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('does not exist') && message.includes('role')) {
      console.warn('  grants skipped: hrms_app / hrms_platform roles do not exist (run db/roles.sql first)');
    } else {
      throw err;
    }
  }

  console.log(ran === 0 ? 'Database already up to date.' : `Applied ${ran} migration(s).`);
}

main()
  .catch((err) => {
    console.error(`\nMigration failed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => client.end());
