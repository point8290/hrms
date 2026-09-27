-- 0009 controlled purge for append-only tables.
--
-- Deleting a tenant cascades into audit_log, the leave ledger, check-ins and the outbox —
-- all of which are append-only by trigger, so a purge is blocked. That is the correct
-- default: nothing in normal operation may erase those records.
--
-- Tenant offboarding and data-erasure requests are real obligations though, so there is
-- exactly one way through, and it is deliberate, narrow and visible:
--
--   BEGIN;
--   SELECT set_config('app.purge_mode', 'on', true);   -- transaction-local
--   DELETE FROM identity.tenant WHERE id = ...;
--   COMMIT;
--
-- Properties that keep this from becoming a back door:
--   * transaction-local, so it cannot linger on a pooled connection
--   * DELETE only — UPDATE of an append-only row stays impossible in every mode, so
--     history can be removed wholesale but never quietly rewritten
--   * EXECUTE on identity.purge_tenant is granted to the platform role only; the
--     application role cannot call it (see db/grants.sql)

CREATE OR REPLACE FUNCTION app.forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.purge_mode', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = CASE
                   WHEN TG_OP = 'DELETE'
                   THEN 'Tenant purge must set app.purge_mode transaction-locally; see identity.purge_tenant().'
                   ELSE 'Append a compensating record instead of modifying history.'
                 END;
END;
$$;

-- Finalized payroll is immutable in every mode, including a purge of individual slips.
-- A tenant purge removes the whole tenant; it never edits a slip.
CREATE OR REPLACE FUNCTION identity.purge_tenant(target_tenant uuid, reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  tenant_name text;
BEGIN
  SELECT name INTO tenant_name FROM identity.tenant WHERE id = target_tenant;
  IF tenant_name IS NULL THEN
    RAISE EXCEPTION 'tenant % does not exist', target_tenant USING ERRCODE = 'no_data_found';
  END IF;

  IF coalesce(reason, '') = '' THEN
    RAISE EXCEPTION 'a purge reason is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Recorded outside the tenant's own (about to vanish) audit trail so the platform
  -- retains evidence that the erasure happened, who asked for it and why.
  INSERT INTO identity.tenant_purge_log (tenant_id, tenant_name, reason, purged_by)
  VALUES (target_tenant, tenant_name, reason, current_user);

  PERFORM set_config('app.purge_mode', 'on', true);
  DELETE FROM identity.tenant WHERE id = target_tenant;
  PERFORM set_config('app.purge_mode', 'off', true);
END;
$$;

CREATE TABLE IF NOT EXISTS identity.tenant_purge_log (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  tenant_name text NOT NULL,
  reason      text NOT NULL,
  purged_by   text NOT NULL,
  purged_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE identity.tenant_purge_log IS
  'Survives the tenant it records. Not tenant-scoped: it is platform evidence of an erasure.';
