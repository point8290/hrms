-- Privileges for the runtime roles. Re-applied after every migration by `npm run db:migrate`.
-- Idempotent.
--
-- Schemas are discovered rather than listed. A hand-written list is a trap: adding a schema
-- in a migration and forgetting it here produces "permission denied for schema X" at
-- runtime, long after the migration reported success.

DO $$
DECLARE
  app_schemas text[];
  schema_name text;
BEGIN
  SELECT array_agg(nspname ORDER BY nspname) INTO app_schemas
    FROM pg_namespace
   WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'public')
     AND nspname NOT LIKE 'pg_%';

  FOREACH schema_name IN ARRAY app_schemas LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO hrms_app, hrms_platform', schema_name);

    -- The `app` schema holds isolation helpers, not data.
    IF schema_name <> 'app' THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO hrms_app, hrms_platform',
        schema_name);
      EXECUTE format(
        'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO hrms_app, hrms_platform',
        schema_name);
    END IF;
  END LOOP;
END;
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO hrms_app, hrms_platform;

-- The application must not be able to redefine isolation helpers or alter policies.
REVOKE EXECUTE ON FUNCTION app.enable_tenant_rls(regclass) FROM hrms_app;
REVOKE EXECUTE ON FUNCTION app.make_append_only(regclass) FROM hrms_app;
REVOKE EXECUTE ON FUNCTION app.add_updated_at_trigger(regclass) FROM hrms_app;

-- identity.tenant carries its own RLS policy (id = current tenant). The app may read its
-- own row; creating, suspending and deleting tenants is platform-only.
REVOKE INSERT, UPDATE, DELETE ON identity.tenant FROM hrms_app;
GRANT SELECT ON identity.tenant TO hrms_app;

-- Permission codes are a global catalog: readable by all, writable by migrations only.
REVOKE INSERT, UPDATE, DELETE ON identity.permission FROM hrms_app, hrms_platform;

-- Local dev transport is platform-only.
REVOKE ALL ON integration.local_queue_message FROM hrms_app;

-- Password reset and email verification happen before any tenant context exists, so these
-- tokens are handled exclusively through the platform connection.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'identity' AND tablename = 'auth_token') THEN
    REVOKE ALL ON identity.auth_token FROM hrms_app;
  END IF;
END;
$$;

-- Tenant purge is a platform-only administrative action (see db/migrations/0009).
REVOKE ALL ON FUNCTION identity.purge_tenant(uuid, text) FROM PUBLIC, hrms_app;
GRANT EXECUTE ON FUNCTION identity.purge_tenant(uuid, text) TO hrms_platform;
REVOKE ALL ON identity.tenant_purge_log FROM hrms_app;
GRANT SELECT, INSERT ON identity.tenant_purge_log TO hrms_platform;
GRANT USAGE, SELECT ON SEQUENCE identity.tenant_purge_log_id_seq TO hrms_platform;
