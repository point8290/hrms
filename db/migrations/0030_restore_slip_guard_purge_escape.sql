-- 0030 restore the purge escape the previous migration dropped.
--
-- 0029 added `hra_exemption` to the finalized-slip guard and rebuilt the function from the
-- 0006 text to do it. That text predates two later changes, so recreating it silently
-- reverted both:
--
--   * 0010's purge escape on DELETE, without which identity.purge_tenant cannot erase a
--     tenant that has ever finalized a payslip — a half-purged tenant, which 0010 exists
--     precisely to prevent
--   * 0023's `snapshot_id` and `calculation_version` clauses on UPDATE, without which a
--     finalized slip could be re-pointed at a different snapshot or relabelled with a
--     different engine version
--
-- Both are restored here alongside the exemption. The lesson, which is why this comment is
-- longer than the change: CREATE OR REPLACE FUNCTION in a migration replaces whatever is
-- live, not whatever the migration's author was reading. The whole current definition has to
-- be carried forward, and the only safe source for it is the most recent migration that
-- defined it — never the original.

CREATE OR REPLACE FUNCTION payroll.guard_finalized_slip()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A finalized slip can be removed wholesale during an authorised tenant purge, and
    -- never otherwise. History stays honest; it does not become undeletable (0010).
    IF OLD.status = 'finalized' AND coalesce(current_setting('app.purge_mode', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'finalized salary slip % cannot be deleted', OLD.id
        USING ERRCODE = 'restrict_violation',
              HINT = 'Use a reversal or supplementary payroll run; wholesale removal requires a tenant purge.';
    END IF;
    RETURN OLD;
  END IF;

  -- No purge escape hatch for UPDATE: a finalized payslip is never rewritten.
  IF OLD.status = 'finalized' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.gross_amount IS DISTINCT FROM OLD.gross_amount
       OR NEW.deduction_amount IS DISTINCT FROM OLD.deduction_amount
       OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount
       OR NEW.net_amount IS DISTINCT FROM OLD.net_amount
       OR NEW.taxable_earnings IS DISTINCT FROM OLD.taxable_earnings
       -- The reason the taxable earnings are what they are. A finalized payslip whose
       -- explanation could still be edited is not explained at all.
       OR NEW.hra_exemption IS DISTINCT FROM OLD.hra_exemption
       OR NEW.payable_days IS DISTINCT FROM OLD.payable_days
       OR NEW.lop_days IS DISTINCT FROM OLD.lop_days
       OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
       OR NEW.calculation_version IS DISTINCT FROM OLD.calculation_version THEN
      RAISE EXCEPTION 'finalized salary slip % is immutable; use an adjustment or supplementary run', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
