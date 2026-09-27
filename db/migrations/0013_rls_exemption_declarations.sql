-- 0013 declare the tables that are deliberately not tenant-scoped.
--
-- `npm run knowledge:check` fails on any table with a tenant_id column and no RLS policy.
-- Two tables are legitimate exceptions, and this migration is where that is stated.
--
-- The declaration lives in a new migration rather than being added as a comment to the
-- migration that created the table, because applied migrations are immutable — the runner
-- refuses a file whose checksum has changed, and that guard is worth more than the
-- convenience of editing history.
--
-- Form:  -- rls:exempt <schema.table> <reason>

-- rls:exempt identity.tenant_purge_log platform evidence of an erasure; must outlive the tenant it names
-- rls:exempt integration.local_queue_message transport, not business data; reachable only by the platform role

-- Recorded in the database too, so the reason is visible to anyone inspecting the schema
-- rather than only to someone reading the migration history.
COMMENT ON TABLE identity.tenant_purge_log IS
  'RLS-exempt by design: platform evidence of a tenant erasure. Not tenant-scoped because it must outlive the tenant it names.';

COMMENT ON TABLE integration.local_queue_message IS
  'RLS-exempt by design: development transport, not business data. Reachable only by the platform role; replaced by SQS in AWS.';
