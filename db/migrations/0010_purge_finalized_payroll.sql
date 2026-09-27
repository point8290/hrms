-- 0010 let a tenant purge remove finalized payroll.
--
-- The finalized-slip guard (0006) correctly refuses to delete a payslip, which also
-- blocked identity.purge_tenant. Erasing a tenant is a legitimate, separately authorised
-- operation and it must be able to complete — a half-purged tenant is worse than either
-- outcome.
--
-- The distinction preserved here is the one that matters: a finalized slip can be removed
-- *wholesale* during an authorised purge, but it can never be edited, in any mode. History
-- stays honest; it does not become undeletable.

CREATE OR REPLACE FUNCTION payroll.guard_finalized_slip()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
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
