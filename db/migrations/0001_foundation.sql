-- 0001 foundation: schemas, tenant-context helpers and the RLS convention.
--
-- Isolation model (ADR-001, ADR-002):
--   * every tenant-owned table carries tenant_id
--   * app.current_tenant_id() reads a TRANSACTION-LOCAL setting and returns NULL when absent
--   * RLS policies compare tenant_id to that function, so a missing context yields zero rows
--     and rejects every write (fail closed)
--   * the application connects as a NON-OWNER role (hrms_app) so RLS actually applies;
--     cross-tenant platform work uses hrms_platform (BYPASSRLS). See db/roles.sql.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- btree_gist lets exclusion constraints mix uuid equality with daterange overlap,
-- which is how effective-dated tables forbid overlapping active rows.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS workforce;
CREATE SCHEMA IF NOT EXISTS leave_mgmt;
CREATE SCHEMA IF NOT EXISTS expense;
CREATE SCHEMA IF NOT EXISTS compensation;
CREATE SCHEMA IF NOT EXISTS payroll;
CREATE SCHEMA IF NOT EXISTS performance;
CREATE SCHEMA IF NOT EXISTS workflow;
CREATE SCHEMA IF NOT EXISTS documents;
CREATE SCHEMA IF NOT EXISTS notification;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS integration;

-- Returns the transaction-local tenant, or NULL when unset/blank/invalid.
-- NULL is the fail-closed value: `tenant_id = NULL` is never true.
CREATE OR REPLACE FUNCTION app.current_tenant_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  raw text;
BEGIN
  raw := current_setting('app.tenant_id', true);
  IF raw IS NULL OR raw = '' THEN
    RETURN NULL;
  END IF;
  RETURN raw::uuid;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION app.current_tenant_id() IS
  'Transaction-local tenant context. NULL when unset so RLS fails closed.';

-- Actor for audit triggers; optional, NULL when the change is system-initiated.
CREATE OR REPLACE FUNCTION app.current_actor_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  raw text;
BEGIN
  raw := current_setting('app.actor_id', true);
  IF raw IS NULL OR raw = '' THEN
    RETURN NULL;
  END IF;
  RETURN raw::uuid;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN NULL;
END;
$$;

-- Applies the standard tenant isolation policy to a table.
-- Every tenant-owned table MUST call this; validate.mjs and the API startup probe
-- both check that it was not forgotten.
CREATE OR REPLACE FUNCTION app.enable_tenant_rls(target regclass)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', target);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s
       USING (tenant_id = app.current_tenant_id())
       WITH CHECK (tenant_id = app.current_tenant_id())',
    target
  );
END;
$$;

-- Blocks UPDATE/DELETE on append-only tables (raw check-ins, ledger, audit, outbox).
CREATE OR REPLACE FUNCTION app.forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE OR REPLACE FUNCTION app.make_append_only(target regclass)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  trigger_name text := 'append_only_' || replace(target::text, '.', '_');
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', trigger_name, target);
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %s
       FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation()',
    trigger_name, target
  );
END;
$$;

CREATE OR REPLACE FUNCTION app.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.add_updated_at_trigger(target regclass)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  trigger_name text := 'touch_' || replace(target::text, '.', '_');
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', trigger_name, target);
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE UPDATE ON %s
       FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()',
    trigger_name, target
  );
END;
$$;

-- Guards effective-dated records against overlapping active rows for one owner.
-- Used by shift_assignment, salary_assignment, leave_policy_assignment, manager_assignment.
CREATE OR REPLACE FUNCTION app.daterange_of(effective_from date, effective_to date)
RETURNS daterange
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT daterange(effective_from, effective_to, '[]');
$$;
