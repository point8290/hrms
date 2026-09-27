-- 0006 compensation, statutory rules and payroll.
--
-- Invariant (ADR-005): payroll calculates from payroll_input_snapshot only.
-- Finalized payroll_run / salary_slip rows are immutable.

CREATE TABLE compensation.salary_component (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  code             text NOT NULL,
  name             text NOT NULL,
  component_type   text NOT NULL CHECK (component_type IN ('earning', 'deduction')),
  calculation_type text NOT NULL
                     CHECK (calculation_type IN ('fixed', 'percentage', 'formula', 'statutory', 'variable')),
  depends_on_code  text,
  taxable          boolean NOT NULL DEFAULT true,
  statutory_type   text CHECK (statutory_type IN ('pf_employee', 'pf_employer', 'esi_employee',
                                                  'esi_employer', 'professional_tax', 'income_tax', 'gratuity')),
  affects_lop      boolean NOT NULL DEFAULT true,
  display_order    integer NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
SELECT app.enable_tenant_rls('compensation.salary_component');
SELECT app.add_updated_at_trigger('compensation.salary_component');
COMMENT ON COLUMN compensation.salary_component.affects_lop IS
  'true means the component is pro-rated by paid days. Fixed reimbursements usually set false.';

CREATE TABLE compensation.salary_structure (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  name           text NOT NULL,
  version        integer NOT NULL DEFAULT 1,
  currency       text NOT NULL DEFAULT 'INR',
  effective_from date NOT NULL,
  effective_to   date,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, version)
);
SELECT app.enable_tenant_rls('compensation.salary_structure');
SELECT app.add_updated_at_trigger('compensation.salary_structure');

CREATE TABLE compensation.salary_structure_component (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  salary_structure_id uuid NOT NULL REFERENCES compensation.salary_structure(id) ON DELETE CASCADE,
  salary_component_id uuid NOT NULL REFERENCES compensation.salary_component(id),
  sequence_no         integer NOT NULL,
  fixed_amount        numeric(14, 2),
  percentage          numeric(7, 4),
  percentage_of_code  text,
  formula             text,
  max_amount          numeric(14, 2),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (salary_structure_id, salary_component_id),
  CONSTRAINT structure_component_has_basis CHECK (
    fixed_amount IS NOT NULL OR percentage IS NOT NULL OR formula IS NOT NULL
  )
);
SELECT app.enable_tenant_rls('compensation.salary_structure_component');
CREATE INDEX idx_structure_component_order
  ON compensation.salary_structure_component (salary_structure_id, sequence_no);

CREATE TABLE compensation.salary_assignment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  salary_structure_id uuid NOT NULL REFERENCES compensation.salary_structure(id),
  annual_ctc          numeric(14, 2) NOT NULL CHECK (annual_ctc >= 0),
  base_amount         numeric(14, 2) NOT NULL CHECK (base_amount >= 0),
  effective_from      date NOT NULL,
  effective_to        date,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT salary_assignment_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
SELECT app.enable_tenant_rls('compensation.salary_assignment');
SELECT app.add_updated_at_trigger('compensation.salary_assignment');
CREATE INDEX idx_salary_assignment_employee
  ON compensation.salary_assignment (tenant_id, employee_id, effective_from DESC);
ALTER TABLE compensation.salary_assignment
  ADD CONSTRAINT salary_assignment_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    app.daterange_of(effective_from, effective_to) WITH &&
  );
COMMENT ON COLUMN compensation.salary_assignment.base_amount IS
  'Monthly basis the structure computes from. Payroll resolves the row effective during the period.';

CREATE TABLE compensation.compensation_revision (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id            uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  previous_assignment_id uuid REFERENCES compensation.salary_assignment(id),
  new_assignment_id      uuid NOT NULL REFERENCES compensation.salary_assignment(id),
  effective_date         date NOT NULL,
  reason                 text NOT NULL,
  approved_by            uuid,
  created_at             timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('compensation.compensation_revision');

CREATE TABLE compensation.additional_salary (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  salary_component_id uuid NOT NULL REFERENCES compensation.salary_component(id),
  amount              numeric(14, 2) NOT NULL,
  payroll_date        date NOT NULL,
  kind                text NOT NULL DEFAULT 'one_time'
                        CHECK (kind IN ('one_time', 'arrear', 'bonus', 'incentive', 'recovery')),
  reason              text,
  status              text NOT NULL DEFAULT 'approved'
                        CHECK (status IN ('draft', 'approved', 'consumed', 'cancelled')),
  consumed_by_run_id  uuid,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('compensation.additional_salary');
SELECT app.add_updated_at_trigger('compensation.additional_salary');
CREATE INDEX idx_additional_salary_pending
  ON compensation.additional_salary (tenant_id, employee_id, payroll_date) WHERE status = 'approved';

CREATE TABLE compensation.tax_declaration (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  financial_year  text NOT NULL,
  regime          text NOT NULL DEFAULT 'new' CHECK (regime IN ('old', 'new')),
  declarations    jsonb NOT NULL DEFAULT '{}'::jsonb,
  declared_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (declared_amount >= 0),
  verified_amount numeric(14, 2),
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'submitted', 'verified', 'rejected')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_id, financial_year)
);
SELECT app.enable_tenant_rls('compensation.tax_declaration');
SELECT app.add_updated_at_trigger('compensation.tax_declaration');

-- Versioned statutory configuration. tenant_id NULL = platform default.
-- Never edited once a finalized run consumed it; supersede with a new version.
CREATE TABLE payroll.statutory_rule (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES identity.tenant(id) ON DELETE CASCADE,
  country_code   text NOT NULL DEFAULT 'IN',
  state_code     text,
  rule_type      text NOT NULL
                   CHECK (rule_type IN ('income_tax', 'pf', 'esi', 'professional_tax', 'gratuity', 'bonus')),
  version        integer NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  rule_config    jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- COALESCE keys the uniqueness so platform defaults (NULL tenant/state) still conflict.
CREATE UNIQUE INDEX statutory_rule_version_key ON payroll.statutory_rule (
  COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
  country_code,
  COALESCE(state_code, '*'),
  rule_type,
  version
);
-- Tenant-scoped rows are isolated; platform defaults (tenant_id IS NULL) are readable by all.
ALTER TABLE payroll.statutory_rule ENABLE ROW LEVEL SECURITY;
CREATE POLICY statutory_rule_isolation ON payroll.statutory_rule
  USING (tenant_id IS NULL OR tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE INDEX idx_statutory_rule_lookup
  ON payroll.statutory_rule (country_code, rule_type, effective_from DESC);

-- ---------------------------------------------------------------- payroll

CREATE TABLE payroll.payroll_period (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES core.company(id),
  name         text NOT NULL,
  period_start date NOT NULL,
  period_end   date NOT NULL,
  pay_date     date NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'closed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, period_start, period_end),
  CONSTRAINT payroll_period_range CHECK (period_end >= period_start)
);
SELECT app.enable_tenant_rls('payroll.payroll_period');
SELECT app.add_updated_at_trigger('payroll.payroll_period');

CREATE TABLE payroll.payroll_run (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  payroll_period_id uuid NOT NULL REFERENCES payroll.payroll_period(id),
  company_id        uuid NOT NULL REFERENCES core.company(id),
  run_type          text NOT NULL DEFAULT 'regular'
                      CHECK (run_type IN ('regular', 'supplementary', 'off_cycle')),
  parent_run_id     uuid REFERENCES payroll.payroll_run(id),
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'validating', 'calculating', 'calculated',
                                        'under_review', 'approved', 'finalized',
                                        'payment_pending', 'paid', 'failed', 'cancelled')),
  calculation_version text NOT NULL,
  employee_count    integer NOT NULL DEFAULT 0,
  total_gross       numeric(16, 2) NOT NULL DEFAULT 0,
  total_deduction   numeric(16, 2) NOT NULL DEFAULT 0,
  total_net         numeric(16, 2) NOT NULL DEFAULT 0,
  failure_reason    text,
  started_at        timestamptz,
  calculated_at     timestamptz,
  approved_by       uuid,
  approved_at       timestamptz,
  finalized_by      uuid,
  finalized_at      timestamptz,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('payroll.payroll_run');
SELECT app.add_updated_at_trigger('payroll.payroll_run');
CREATE INDEX idx_payroll_run_period ON payroll.payroll_run (tenant_id, payroll_period_id, status);
-- At most one live regular run per period; cancelled runs may be retried.
CREATE UNIQUE INDEX idx_payroll_run_one_regular
  ON payroll.payroll_run (tenant_id, payroll_period_id)
  WHERE run_type = 'regular' AND status <> 'cancelled';

CREATE TABLE payroll.payroll_employee (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  payroll_run_id   uuid NOT NULL REFERENCES payroll.payroll_run(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES core.employee(id),
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'calculated', 'failed', 'excluded')),
  gross_amount     numeric(14, 2) NOT NULL DEFAULT 0,
  deduction_amount numeric(14, 2) NOT NULL DEFAULT 0,
  tax_amount       numeric(14, 2) NOT NULL DEFAULT 0,
  net_amount       numeric(14, 2) NOT NULL DEFAULT 0,
  failure_reason   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payroll_run_id, employee_id)
);
SELECT app.enable_tenant_rls('payroll.payroll_employee');
SELECT app.add_updated_at_trigger('payroll.payroll_employee');
CREATE INDEX idx_payroll_employee_tenant_run
  ON payroll.payroll_employee (tenant_id, payroll_run_id);

-- The only legitimate calculation input. Immutable once written.
CREATE TABLE payroll.payroll_input_snapshot (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  payroll_run_id   uuid NOT NULL REFERENCES payroll.payroll_run(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES core.employee(id),
  snapshot_version integer NOT NULL DEFAULT 1,
  employee_json    jsonb NOT NULL,
  attendance_json  jsonb NOT NULL,
  leave_json       jsonb NOT NULL,
  compensation_json jsonb NOT NULL,
  tax_json         jsonb NOT NULL,
  statutory_json   jsonb NOT NULL,
  additional_json  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payroll_run_id, employee_id, snapshot_version)
);
SELECT app.enable_tenant_rls('payroll.payroll_input_snapshot');
SELECT app.make_append_only('payroll.payroll_input_snapshot');
COMMENT ON TABLE payroll.payroll_input_snapshot IS
  'Frozen payroll inputs. The calculation engine reads this and nothing else.';

CREATE TABLE payroll.salary_slip (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  payroll_run_id      uuid NOT NULL REFERENCES payroll.payroll_run(id) ON DELETE CASCADE,
  payroll_employee_id uuid NOT NULL REFERENCES payroll.payroll_employee(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES core.employee(id),
  slip_number         text NOT NULL,
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  total_days          numeric(5, 2) NOT NULL,
  payable_days        numeric(5, 2) NOT NULL,
  lop_days            numeric(5, 2) NOT NULL DEFAULT 0,
  gross_amount        numeric(14, 2) NOT NULL DEFAULT 0,
  deduction_amount    numeric(14, 2) NOT NULL DEFAULT 0,
  tax_amount          numeric(14, 2) NOT NULL DEFAULT 0,
  employer_contribution numeric(14, 2) NOT NULL DEFAULT 0,
  net_amount          numeric(14, 2) NOT NULL DEFAULT 0,
  currency            text NOT NULL DEFAULT 'INR',
  calculation_version text NOT NULL,
  snapshot_id         uuid NOT NULL REFERENCES payroll.payroll_input_snapshot(id),
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'finalized', 'cancelled')),
  document_id         uuid,
  finalized_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slip_number)
);
SELECT app.enable_tenant_rls('payroll.salary_slip');
SELECT app.add_updated_at_trigger('payroll.salary_slip');
CREATE INDEX idx_salary_slip_employee ON payroll.salary_slip (tenant_id, employee_id, period_start DESC);

-- Finalized slips are immutable. Only the payslip document link may still be attached.
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
       OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
       OR NEW.calculation_version IS DISTINCT FROM OLD.calculation_version THEN
      RAISE EXCEPTION 'finalized salary slip % is immutable; use an adjustment or supplementary run', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_finalized_salary_slip
  BEFORE UPDATE OR DELETE ON payroll.salary_slip
  FOR EACH ROW EXECUTE FUNCTION payroll.guard_finalized_slip();

CREATE TABLE payroll.salary_slip_component (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  salary_slip_id          uuid NOT NULL REFERENCES payroll.salary_slip(id) ON DELETE CASCADE,
  salary_component_id     uuid REFERENCES compensation.salary_component(id),
  component_code_snapshot text NOT NULL,
  component_name_snapshot text NOT NULL,
  component_type          text NOT NULL CHECK (component_type IN ('earning', 'deduction', 'employer_contribution')),
  amount                  numeric(14, 2) NOT NULL,
  is_statutory            boolean NOT NULL DEFAULT false,
  calculation_detail      jsonb,
  display_order           integer NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('payroll.salary_slip_component');
CREATE INDEX idx_slip_component_slip ON payroll.salary_slip_component (salary_slip_id, display_order);
COMMENT ON COLUMN payroll.salary_slip_component.component_name_snapshot IS
  'Label as it was at calculation time. Renaming the component never rewrites a historical slip.';
