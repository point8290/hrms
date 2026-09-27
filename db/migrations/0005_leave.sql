-- 0005 leave: policy, allocation, application and the append-only ledger.
--
-- Invariant (ADR-006): leave_ledger_entry is the balance authority.
-- Balance is always SUM(quantity) over the ledger. No mutable balance column exists.

CREATE TABLE leave_mgmt.leave_type (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  code                  text NOT NULL,
  is_paid               boolean NOT NULL DEFAULT true,
  allow_half_day        boolean NOT NULL DEFAULT true,
  allow_negative_balance boolean NOT NULL DEFAULT false,
  max_negative_balance  numeric(6, 2) NOT NULL DEFAULT 0 CHECK (max_negative_balance >= 0),
  carry_forward_enabled boolean NOT NULL DEFAULT false,
  max_carry_forward     numeric(6, 2),
  carry_forward_expiry_days integer,
  encashment_enabled    boolean NOT NULL DEFAULT false,
  include_holidays      boolean NOT NULL DEFAULT false,
  requires_approval     boolean NOT NULL DEFAULT true,
  is_lop                boolean NOT NULL DEFAULT false,
  is_comp_off           boolean NOT NULL DEFAULT false,
  max_consecutive_days  integer,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
SELECT app.enable_tenant_rls('leave_mgmt.leave_type');
SELECT app.add_updated_at_trigger('leave_mgmt.leave_type');
COMMENT ON COLUMN leave_mgmt.leave_type.include_holidays IS
  'false means holidays and weekly offs inside a leave range are not consumed (standard HR practice).';

CREATE TABLE leave_mgmt.leave_policy (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  name           text NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, effective_from)
);
SELECT app.enable_tenant_rls('leave_mgmt.leave_policy');
SELECT app.add_updated_at_trigger('leave_mgmt.leave_policy');

CREATE TABLE leave_mgmt.leave_policy_rule (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  leave_policy_id   uuid NOT NULL REFERENCES leave_mgmt.leave_policy(id) ON DELETE CASCADE,
  leave_type_id     uuid NOT NULL REFERENCES leave_mgmt.leave_type(id),
  annual_allocation numeric(6, 2) NOT NULL CHECK (annual_allocation >= 0),
  accrual_frequency text NOT NULL DEFAULT 'annual'
                      CHECK (accrual_frequency IN ('annual', 'monthly', 'quarterly')),
  max_carry_forward numeric(6, 2),
  expiry_days       integer,
  min_service_days  integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (leave_policy_id, leave_type_id)
);
SELECT app.enable_tenant_rls('leave_mgmt.leave_policy_rule');

CREATE TABLE leave_mgmt.leave_policy_assignment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id     uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  leave_policy_id uuid NOT NULL REFERENCES leave_mgmt.leave_policy(id),
  effective_from  date NOT NULL,
  effective_to    date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leave_policy_assignment_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
SELECT app.enable_tenant_rls('leave_mgmt.leave_policy_assignment');
ALTER TABLE leave_mgmt.leave_policy_assignment
  ADD CONSTRAINT leave_policy_assignment_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    app.daterange_of(effective_from, effective_to) WITH &&
  );

CREATE TABLE leave_mgmt.leave_allocation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  leave_type_id uuid NOT NULL REFERENCES leave_mgmt.leave_type(id),
  quantity      numeric(6, 2) NOT NULL CHECK (quantity >= 0),
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  source        text NOT NULL DEFAULT 'policy'
                  CHECK (source IN ('policy', 'manual', 'carry_forward', 'comp_off', 'pro_rata')),
  idempotency_key text,
  notes         text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leave_allocation_period CHECK (period_end >= period_start)
);
SELECT app.enable_tenant_rls('leave_mgmt.leave_allocation');
CREATE INDEX idx_leave_allocation_employee
  ON leave_mgmt.leave_allocation (tenant_id, employee_id, leave_type_id, period_start);
-- Re-running an accrual job must not grant entitlement twice.
CREATE UNIQUE INDEX idx_leave_allocation_idempotency
  ON leave_mgmt.leave_allocation (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE leave_mgmt.leave_application (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id       uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  leave_type_id     uuid NOT NULL REFERENCES leave_mgmt.leave_type(id),
  start_date        date NOT NULL,
  end_date          date NOT NULL,
  start_half_day    boolean NOT NULL DEFAULT false,
  end_half_day      boolean NOT NULL DEFAULT false,
  quantity          numeric(5, 2) NOT NULL CHECK (quantity > 0),
  reason            text,
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'submitted', 'pending_approval', 'approved', 'rejected', 'cancelled')),
  workflow_instance_id uuid,
  decided_by        uuid,
  decided_at        timestamptz,
  decision_note     text,
  cancelled_at      timestamptz,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leave_application_range CHECK (end_date >= start_date)
);
SELECT app.enable_tenant_rls('leave_mgmt.leave_application');
SELECT app.add_updated_at_trigger('leave_mgmt.leave_application');
CREATE INDEX idx_leave_application_tenant_employee
  ON leave_mgmt.leave_application (tenant_id, employee_id, start_date);
CREATE INDEX idx_leave_application_status
  ON leave_mgmt.leave_application (tenant_id, status) WHERE status IN ('submitted', 'pending_approval');
-- Blocks double-booking the same day across applications that still hold the dates.
ALTER TABLE leave_mgmt.leave_application
  ADD CONSTRAINT leave_application_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (status IN ('submitted', 'pending_approval', 'approved'));

-- THE balance authority. Append-only, enforced by trigger.
CREATE TABLE leave_mgmt.leave_ledger_entry (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  leave_type_id  uuid NOT NULL REFERENCES leave_mgmt.leave_type(id),
  entry_type     text NOT NULL
                   CHECK (entry_type IN ('allocation', 'consumption', 'adjustment', 'carry_forward',
                                         'expiry', 'encashment', 'reversal')),
  quantity       numeric(8, 2) NOT NULL,
  effective_date date NOT NULL,
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  source_type    text NOT NULL
                   CHECK (source_type IN ('leave_allocation', 'leave_application', 'leave_encashment',
                                          'manual_adjustment', 'carry_forward_job', 'expiry_job')),
  source_id      uuid,
  reverses_entry_id uuid REFERENCES leave_mgmt.leave_ledger_entry(id),
  notes          text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_sign CHECK (
    (entry_type IN ('allocation', 'carry_forward') AND quantity > 0)
    OR (entry_type IN ('consumption', 'expiry', 'encashment') AND quantity < 0)
    OR (entry_type IN ('adjustment', 'reversal'))
  )
);
SELECT app.enable_tenant_rls('leave_mgmt.leave_ledger_entry');
SELECT app.make_append_only('leave_mgmt.leave_ledger_entry');
CREATE INDEX idx_leave_ledger_balance
  ON leave_mgmt.leave_ledger_entry (tenant_id, employee_id, leave_type_id, effective_date);
CREATE INDEX idx_leave_ledger_source
  ON leave_mgmt.leave_ledger_entry (tenant_id, source_type, source_id);
COMMENT ON TABLE leave_mgmt.leave_ledger_entry IS
  'Append-only. Balance = SUM(quantity). Corrections append a reversal, never UPDATE or DELETE.';

CREATE TABLE leave_mgmt.leave_encashment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  leave_type_id uuid NOT NULL REFERENCES leave_mgmt.leave_type(id),
  quantity      numeric(6, 2) NOT NULL CHECK (quantity > 0),
  amount        numeric(14, 2),
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'paid')),
  payroll_run_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('leave_mgmt.leave_encashment');
SELECT app.add_updated_at_trigger('leave_mgmt.leave_encashment');
