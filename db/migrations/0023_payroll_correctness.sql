-- 0023 payroll correctness.
--
-- Seven changes, all of them fixing a number that is currently wrong rather than adding a
-- feature. Each is explained where it is made; the common thread is that payroll was
-- producing a plausible figure in situations where it should either have produced a
-- different figure or refused.

-- ---------------------------------------------------------------------------
-- 1. Additional salary can overwrite a structure component.
--
-- "This month only, HRA is X because the employee relocated mid-month" is ordinary. The
-- only route today is a second, additive line, which produces a payslip with two HRA-ish
-- rows that do not read as a correction — and, worse, leaves percentage components that
-- depend on HRA resolving against the *uncorrected* figure.
--
-- An overwrite replaces the component's value before pro-rating, so dependents follow.
-- ---------------------------------------------------------------------------

ALTER TABLE compensation.additional_salary
  ADD COLUMN overwrites_structure boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN compensation.additional_salary.overwrites_structure IS
  'Replaces the structure component''s amount for this period instead of adding to it. Applied before pro-rating so dependent percentage components use the corrected value.';

-- At most one overwrite per component per date. Two overwrites for one component in one
-- period is not a merge problem, it is an ambiguity — the snapshot builder refuses that
-- case for the whole period, and this index catches the exact-date duplicate cheaply.
CREATE UNIQUE INDEX idx_additional_salary_one_overwrite
  ON compensation.additional_salary (tenant_id, employee_id, salary_component_id, payroll_date)
  WHERE overwrites_structure AND status IN ('draft', 'approved');

-- ---------------------------------------------------------------------------
-- 2. Additional salary can name what produced it.
--
-- Leave encashment debits the leave ledger and, until now, paid nobody: the code comment
-- claimed "the money reaches the employee through payroll as an additional salary line"
-- and nothing created that line. Gratuity will need the same path.
--
-- The unique index is the idempotency guarantee: one compensation row per source document,
-- however many times the event that creates it is delivered.
-- ---------------------------------------------------------------------------

ALTER TABLE compensation.additional_salary
  ADD COLUMN source_type text
    CHECK (source_type IS NULL OR source_type IN ('leave_encashment', 'gratuity', 'expense_claim')),
  ADD COLUMN source_id uuid;

ALTER TABLE compensation.additional_salary
  ADD CONSTRAINT additional_salary_source_complete
  CHECK ((source_type IS NULL) = (source_id IS NULL));

CREATE UNIQUE INDEX idx_additional_salary_source
  ON compensation.additional_salary (tenant_id, source_type, source_id)
  WHERE source_type IS NOT NULL;

COMMENT ON COLUMN compensation.additional_salary.source_type IS
  'The document that caused this amount. Unique with source_id, so a redelivered event cannot pay twice.';

-- ---------------------------------------------------------------------------
-- 3. Leave encashment gets a price and a link to the money.
--
-- The per-day rate lives on the salary assignment because it is a compensation fact, not a
-- leave-policy one — two employees encashing the same leave type are owed different
-- amounts. It is deliberately nullable with no default: an unset rate refuses the
-- encashment rather than guessing a daily wage, because a guess here silently underpays or
-- overpays a real person.
-- ---------------------------------------------------------------------------

ALTER TABLE compensation.salary_assignment
  ADD COLUMN leave_encashment_amount_per_day numeric(14, 2)
    CHECK (leave_encashment_amount_per_day IS NULL OR leave_encashment_amount_per_day >= 0);

COMMENT ON COLUMN compensation.salary_assignment.leave_encashment_amount_per_day IS
  'What one encashed leave day is worth for this employee. NULL refuses encashment rather than guessing.';

ALTER TABLE leave_mgmt.leave_encashment
  ADD COLUMN salary_component_id uuid REFERENCES compensation.salary_component(id),
  ADD COLUMN per_day_amount numeric(14, 2) CHECK (per_day_amount IS NULL OR per_day_amount >= 0),
  ADD COLUMN additional_salary_id uuid REFERENCES compensation.additional_salary(id);

COMMENT ON COLUMN leave_mgmt.leave_encashment.additional_salary_id IS
  'The compensation row that actually pays this. Present from approval onward; its absence means the employee was never paid.';

-- ---------------------------------------------------------------------------
-- 4. Explicit tax classification on salary components.
--
-- `taxable` already existed on the component, was carried into every snapshot, and was read
-- by nothing — so a reimbursement marked non-taxable was taxed. The other half was missing
-- entirely: in India, employee PF is deductible under 80C and professional tax under
-- section 16(iii), and we were taxing employees as though neither existed.
-- ---------------------------------------------------------------------------

ALTER TABLE compensation.salary_component
  ADD COLUMN exempted_from_income_tax boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN compensation.salary_component.exempted_from_income_tax IS
  'A deduction that reduces taxable income (employee PF, professional tax). Meaningless on an earning; use `taxable` there.';

-- Backfill the two the statute names, for any tenant that already configured them as
-- structure components rather than relying on the built-in statutory calculation.
UPDATE compensation.salary_component
   SET exempted_from_income_tax = true
 WHERE component_type = 'deduction'
   AND statutory_type IN ('pf_employee', 'professional_tax');

-- ---------------------------------------------------------------------------
-- 5. Employee tax-year opening facts.
--
-- A mid-year joiner arrives with income already earned and tax already deducted by their
-- previous employer. Without those two numbers the annual liability is computed on our
-- months alone, and the employee is under-deducted all year — a section 192(2) exposure for
-- the employer and a self-assessment bill for the employee.
--
-- A tax-year fact, not a monthly transaction: keyed by employee and financial year, and
-- deliberately not on the salary assignment, where a mid-year compensation revision would
-- create a second row carrying the same opening balance.
-- ---------------------------------------------------------------------------

CREATE TABLE payroll.employee_tax_opening (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id              uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  -- Label form, e.g. '2026-27'. Matches compensation.tax_declaration.financial_year.
  financial_year           text NOT NULL CHECK (financial_year ~ '^\d{4}-\d{2}$'),

  opening_taxable_earnings numeric(14, 2) NOT NULL DEFAULT 0
                             CHECK (opening_taxable_earnings >= 0),
  opening_tds              numeric(14, 2) NOT NULL DEFAULT 0
                             CHECK (opening_tds >= 0),

  source                   text NOT NULL DEFAULT 'previous_employer'
                             CHECK (source IN ('previous_employer', 'migration', 'correction')),
  note                     text,
  created_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, employee_id, financial_year)
);
SELECT app.enable_tenant_rls('payroll.employee_tax_opening');
SELECT app.add_updated_at_trigger('payroll.employee_tax_opening');

COMMENT ON TABLE payroll.employee_tax_opening IS
  'Taxable income and TDS an employee brought into the financial year. Frozen into every payroll snapshot; amendable only until a slip in that year is finalized.';

-- ---------------------------------------------------------------------------
-- 6. Salary slips record the taxable base they were computed on.
--
-- Next month's annualisation needs *actual* taxable earnings so far, not gross. Gross
-- includes non-taxable reimbursements and excludes the pre-tax deductions that reduce the
-- base, so deriving it after the fact would give a different number than the one the
-- calculation used.
-- ---------------------------------------------------------------------------

ALTER TABLE payroll.salary_slip
  ADD COLUMN taxable_earnings numeric(14, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN payroll.salary_slip.taxable_earnings IS
  'Earnings that entered the income-tax base for this slip, after pre-tax deductions. The input to next period''s annualisation.';

-- The finalized-slip guard must protect this like any other figure: a taxable base edited
-- after finalization would silently change every later month's TDS.
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
       OR NEW.taxable_earnings IS DISTINCT FROM OLD.taxable_earnings
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

-- ---------------------------------------------------------------------------
-- 7. Runs are sequenced, so slip numbers are unique across run types.
--
-- `slip_number` was derived as '{YYYY-MM}-{employee_code}'. A supplementary run for the
-- same month generates the identical string and UNIQUE (tenant_id, slip_number) rejects it
-- — so the duplicate-payment bug was masked by an opaque 409 rather than prevented.
--
-- The sequence is assigned at run creation and is stable for the life of the run, which is
-- what makes the slip number deterministic: recalculating a run reproduces it exactly.
-- ---------------------------------------------------------------------------

ALTER TABLE payroll.payroll_run
  ADD COLUMN run_sequence integer;

-- Existing runs keep a stable number: ordered by creation within their period.
WITH ordered AS (
  SELECT id, row_number() OVER (
           PARTITION BY tenant_id, payroll_period_id ORDER BY created_at, id
         ) AS seq
    FROM payroll.payroll_run
)
UPDATE payroll.payroll_run r
   SET run_sequence = ordered.seq
  FROM ordered
 WHERE r.id = ordered.id;

ALTER TABLE payroll.payroll_run
  ALTER COLUMN run_sequence SET NOT NULL,
  ADD CONSTRAINT payroll_run_sequence_positive CHECK (run_sequence > 0);

-- Cancelled runs release their sequence so a replacement can reuse the slot; a live run
-- owns it exclusively.
CREATE UNIQUE INDEX idx_payroll_run_sequence
  ON payroll.payroll_run (tenant_id, payroll_period_id, run_sequence)
  WHERE status <> 'cancelled';

COMMENT ON COLUMN payroll.payroll_run.run_sequence IS
  'Position of this run within its period. Part of every slip number, so numbering is deterministic across a regular run and its supplementaries.';

-- ---------------------------------------------------------------------------
-- 8. Permission for maintaining tax-year opening balances.
--
-- Sensitive: the figure directly changes how much tax is withheld from someone's pay.
-- ---------------------------------------------------------------------------

INSERT INTO identity.permission (code, description, sensitive) VALUES
  ('tax.opening.manage', 'Record previous-employer taxable income and TDS', true)
ON CONFLICT (code) DO UPDATE
  SET description = EXCLUDED.description, sensitive = EXCLUDED.sensitive;
