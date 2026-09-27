-- Database roles. Run ONCE as a superuser, before the first migration.
--
-- Why two roles (ADR-002): RLS does not apply to a table's owner. If the API connected
-- as the owner, every policy would be silently bypassed and tenant isolation would be
-- a comment rather than a control. So:
--
--   hrms_owner    owns the schema, runs migrations, never serves traffic
--   hrms_app      the API and workers - NOT the owner, so RLS is enforced
--   hrms_platform BYPASSRLS, used only by tenant provisioning and the outbox publisher
--
-- apps/api asserts at startup that its connection is actually subject to RLS and
-- refuses to boot otherwise, so a misconfigured DATABASE_URL fails loudly.

\set app_password `echo "${HRMS_APP_PASSWORD:-hrms_app_dev}"`
\set platform_password `echo "${HRMS_PLATFORM_PASSWORD:-hrms_platform_dev}"`

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_owner') THEN
    CREATE ROLE hrms_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_app') THEN
    CREATE ROLE hrms_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_platform') THEN
    CREATE ROLE hrms_platform LOGIN BYPASSRLS;
  END IF;
END;
$$;

ALTER ROLE hrms_app PASSWORD :'app_password';
ALTER ROLE hrms_platform PASSWORD :'platform_password';

-- hrms_app must never own objects or bypass RLS.
ALTER ROLE hrms_app NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE hrms_platform NOSUPERUSER NOCREATEDB NOCREATEROLE;
