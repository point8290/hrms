-- 0029 the payslip records the exemption, and keeps it.
--
-- An HRA exemption is neither an earning nor a deduction. It does not reach the employee's
-- bank account and it does not come out of their pay; it reduces the income the tax is
-- computed on, and nothing else. Modelling it as a deduction would understate net pay by the
-- exemption, and modelling it as a negative earning would understate gross.
--
-- So it gets its own line type, present on the payslip for explanation and absent from every
-- total. `validate()` in the engine already sums by type, so an exemption line is excluded
-- from the gross reconciliation without any change there.

ALTER TABLE payroll.salary_slip_component
  DROP CONSTRAINT salary_slip_component_component_type_check;

ALTER TABLE payroll.salary_slip_component
  ADD CONSTRAINT salary_slip_component_component_type_check
  CHECK (component_type IN ('earning', 'deduction', 'employer_contribution', 'exemption'));

COMMENT ON COLUMN payroll.salary_slip_component.component_type IS
  'earning and deduction move money. employer_contribution is paid on the employee''s behalf. exemption moves no money at all: it reduces the income tax is assessed on, and is excluded from gross, deductions and net.';

-- ---------------------------------------------------------------------------
-- The figure itself, on the slip.
--
-- Duplicated from the component line on purpose. The line explains the exemption; this
-- column is what the next period's annualisation and any year-end statement read, and a
-- query that had to unpack a jsonb detail to find it would be both slow and fragile.
-- ---------------------------------------------------------------------------

ALTER TABLE payroll.salary_slip
  ADD COLUMN hra_exemption numeric(14, 2) NOT NULL DEFAULT 0 CHECK (hra_exemption >= 0);

COMMENT ON COLUMN payroll.salary_slip.hra_exemption IS
  'Section 10(13A) exemption for this period, already subtracted from taxable_earnings. Zero for every slip written before this column existed, which is what those slips actually applied.';

-- ---------------------------------------------------------------------------
-- Immutability.
--
-- guard_finalized_slip already refuses to let a finalized slip's money change. The exemption
-- is part of the same promise: it is the reason the taxable earnings are what they are, and a
-- finalized payslip whose explanation could still be edited is not explained at all.
--
-- Recreated in full rather than patched, because CREATE OR REPLACE FUNCTION has no way to
-- add one condition to an existing body.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION payroll.guard_finalized_slip()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'finalized' THEN
      RAISE EXCEPTION 'finalized salary slip % cannot be deleted', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'finalized' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.gross_amount IS DISTINCT FROM OLD.gross_amount
       OR NEW.deduction_amount IS DISTINCT FROM OLD.deduction_amount
       OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount
       OR NEW.net_amount IS DISTINCT FROM OLD.net_amount
       OR NEW.payable_days IS DISTINCT FROM OLD.payable_days
       OR NEW.lop_days IS DISTINCT FROM OLD.lop_days
       OR NEW.taxable_earnings IS DISTINCT FROM OLD.taxable_earnings
       OR NEW.hra_exemption IS DISTINCT FROM OLD.hra_exemption
    THEN
      RAISE EXCEPTION 'finalized salary slip % is immutable', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- The lines of a finalized slip are immutable too.
--
-- A gap that predates this migration and that the exemption makes material: the slip's
-- figures were protected, but nothing stopped an UPDATE to one of its component rows. The
-- explanation of an exemption lives in exactly such a row, and an explanation that can be
-- quietly rewritten after the fact is worth nothing in a dispute.
--
-- Draft lines stay editable, and a purge still works: both go through the same escape the
-- rest of the append-only tables use.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION payroll.guard_finalized_slip_component()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  slip_status text;
BEGIN
  IF current_setting('app.purge_mode', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT status INTO slip_status
    FROM payroll.salary_slip
   WHERE id = COALESCE(NEW.salary_slip_id, OLD.salary_slip_id);

  IF slip_status = 'finalized' THEN
    RAISE EXCEPTION 'component lines of finalized salary slip % cannot be changed',
      COALESCE(NEW.salary_slip_id, OLD.salary_slip_id)
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER guard_finalized_slip_component
  BEFORE UPDATE OR DELETE ON payroll.salary_slip_component
  FOR EACH ROW EXECUTE FUNCTION payroll.guard_finalized_slip_component();

COMMENT ON FUNCTION payroll.guard_finalized_slip_component() IS
  'Component lines of a finalized slip are as immutable as the slip. Draft lines are still deleted and rewritten by a recalculation; identity.purge_tenant still erases everything.';
