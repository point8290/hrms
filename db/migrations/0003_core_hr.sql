-- 0003 employee master and effective-dated employment history.

CREATE TABLE core.employee (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_code       text NOT NULL,
  user_id             uuid REFERENCES identity.app_user(id),
  company_id          uuid NOT NULL REFERENCES core.company(id),
  branch_id           uuid REFERENCES core.branch(id),
  location_id         uuid REFERENCES core.location(id),
  department_id       uuid REFERENCES core.department(id),
  designation_id      uuid REFERENCES core.designation(id),
  manager_employee_id uuid REFERENCES core.employee(id),
  first_name          text NOT NULL,
  last_name           text NOT NULL,
  personal_email      text,
  work_email          text,
  phone               text,
  date_of_birth       date,
  gender              text CHECK (gender IN ('male', 'female', 'other', 'undisclosed')),
  employment_type     text NOT NULL DEFAULT 'full_time'
                        CHECK (employment_type IN ('full_time', 'part_time', 'contract', 'intern')),
  employment_status   text NOT NULL DEFAULT 'active'
                        CHECK (employment_status IN ('onboarding', 'probation', 'active', 'notice', 'separated', 'suspended')),
  joining_date        date NOT NULL,
  confirmation_date   date,
  exit_date           date,
  exit_reason         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_code),
  CONSTRAINT employee_exit_after_joining CHECK (exit_date IS NULL OR exit_date >= joining_date),
  CONSTRAINT employee_not_own_manager CHECK (manager_employee_id IS DISTINCT FROM id)
);
SELECT app.enable_tenant_rls('core.employee');
SELECT app.add_updated_at_trigger('core.employee');
CREATE INDEX idx_employee_tenant_status ON core.employee (tenant_id, employment_status);
CREATE INDEX idx_employee_tenant_manager ON core.employee (tenant_id, manager_employee_id);
CREATE UNIQUE INDEX idx_employee_user ON core.employee (tenant_id, user_id) WHERE user_id IS NOT NULL;
COMMENT ON TABLE core.employee IS
  'Current-state projection. core.employment_history is the authority for what was true on a past date.';

-- The authority for historical org placement. Payroll and reporting read this, not core.employee.
CREATE TABLE core.employment_history (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES core.company(id),
  department_id       uuid REFERENCES core.department(id),
  designation_id      uuid REFERENCES core.designation(id),
  location_id         uuid REFERENCES core.location(id),
  manager_employee_id uuid REFERENCES core.employee(id),
  employment_type     text NOT NULL,
  employment_status   text NOT NULL,
  change_reason       text NOT NULL
                        CHECK (change_reason IN ('joining', 'confirmation', 'promotion', 'transfer',
                                                 'demotion', 'manager_change', 'status_change', 'separation', 'correction')),
  effective_from      date NOT NULL,
  effective_to        date,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employment_history_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
SELECT app.enable_tenant_rls('core.employment_history');
CREATE INDEX idx_employment_history_employee
  ON core.employment_history (tenant_id, employee_id, effective_from DESC);
-- One active placement per employee per day.
ALTER TABLE core.employment_history
  ADD CONSTRAINT employment_history_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    app.daterange_of(effective_from, effective_to) WITH &&
  );

CREATE TABLE core.bank_account (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id              uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  account_holder           text NOT NULL,
  account_number_encrypted text NOT NULL,
  account_number_last4     text NOT NULL,
  bank_name                text NOT NULL,
  ifsc                     text NOT NULL,
  is_primary               boolean NOT NULL DEFAULT true,
  effective_from           date NOT NULL,
  effective_to             date,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('core.bank_account');
SELECT app.add_updated_at_trigger('core.bank_account');
CREATE UNIQUE INDEX idx_bank_account_primary
  ON core.bank_account (tenant_id, employee_id) WHERE is_primary AND effective_to IS NULL;
COMMENT ON COLUMN core.bank_account.account_number_encrypted IS
  'Envelope-encrypted at the application layer. Never returned by an API; only last4 is exposed.';

CREATE TABLE core.tax_profile (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  tax_identifier text,
  tax_regime     text NOT NULL DEFAULT 'new' CHECK (tax_regime IN ('old', 'new')),
  pf_number      text,
  uan            text,
  esi_number     text,
  pf_applicable  boolean NOT NULL DEFAULT true,
  esi_applicable boolean NOT NULL DEFAULT false,
  pt_state_code  text,
  effective_from date NOT NULL,
  effective_to   date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('core.tax_profile');
SELECT app.add_updated_at_trigger('core.tax_profile');
CREATE INDEX idx_tax_profile_employee ON core.tax_profile (tenant_id, employee_id, effective_from DESC);

CREATE TABLE core.emergency_contact (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  name         text NOT NULL,
  relationship text NOT NULL,
  phone        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('core.emergency_contact');
SELECT app.add_updated_at_trigger('core.emergency_contact');
