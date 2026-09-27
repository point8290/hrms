-- 0017 leave period jobs, and payroll payment / bank export.
--
-- Two unrelated MVP gaps, together because both add a job ledger with the same shape as
-- attendance_close_run: a record that a periodic operation ran, so "did carry-forward
-- happen for FY2026?" is a query rather than a log search.

-- ---------------------------------------------------------------- leave period jobs

-- One row per tenant per leave period per job kind. UNIQUE makes the job idempotent: an
-- accrual, carry-forward or expiry run can be retried without granting entitlement twice.
CREATE TABLE leave_mgmt.leave_period_job (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  job_kind      text NOT NULL CHECK (job_kind IN ('accrual', 'carry_forward', 'expiry')),
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  leave_type_id uuid REFERENCES leave_mgmt.leave_type(id),
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  employees_processed integer NOT NULL DEFAULT 0,
  units_moved   numeric(12, 2) NOT NULL DEFAULT 0,
  last_error    text,
  started_at    timestamptz,
  completed_at  timestamptz,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, job_kind, period_start, period_end, leave_type_id)
);
SELECT app.enable_tenant_rls('leave_mgmt.leave_period_job');
SELECT app.add_updated_at_trigger('leave_mgmt.leave_period_job');

COMMENT ON TABLE leave_mgmt.leave_period_job IS
  'Evidence that a periodic leave operation ran. The ledger records the movement; this records the run.';

-- ---------------------------------------------------------------- payment

-- A batch of payments generated from a finalized payroll run. The file itself is a
-- document; this row is the record that the batch exists and what happened to it.
CREATE TABLE payroll.payment_batch (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  payroll_run_id  uuid NOT NULL REFERENCES payroll.payroll_run(id),
  batch_number    text NOT NULL,
  -- The format decides the file layout. NEFT is the common Indian bulk-transfer format.
  format          text NOT NULL DEFAULT 'neft' CHECK (format IN ('neft', 'csv')),
  value_date      date NOT NULL,
  employee_count  integer NOT NULL DEFAULT 0,
  total_amount    numeric(16, 2) NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'generated'
                    CHECK (status IN ('generated', 'exported', 'submitted', 'settled', 'failed')),
  document_id     uuid REFERENCES documents.document(id),
  -- Employees whose bank details were missing or invalid. They are not silently dropped:
  -- payroll is finalized and they are owed money, so the exclusion has to be visible.
  excluded        jsonb NOT NULL DEFAULT '[]'::jsonb,
  settled_at      timestamptz,
  settlement_reference text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, batch_number)
);
SELECT app.enable_tenant_rls('payroll.payment_batch');
SELECT app.add_updated_at_trigger('payroll.payment_batch');
-- One live batch per run; a failed batch may be regenerated.
CREATE UNIQUE INDEX idx_payment_batch_live
  ON payroll.payment_batch (tenant_id, payroll_run_id)
  WHERE status <> 'failed';

CREATE TABLE payroll.payment_line (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  payment_batch_id uuid NOT NULL REFERENCES payroll.payment_batch(id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL REFERENCES core.employee(id),
  salary_slip_id   uuid NOT NULL REFERENCES payroll.salary_slip(id),
  -- Snapshotted, not joined: a bank account change after the batch is generated must not
  -- silently redirect a payment that has already been submitted to the bank.
  account_holder_snapshot text NOT NULL,
  account_number_last4 text NOT NULL,
  ifsc_snapshot    text NOT NULL,
  amount           numeric(14, 2) NOT NULL CHECK (amount > 0),
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'submitted', 'settled', 'returned')),
  return_reason    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_batch_id, salary_slip_id)
);
SELECT app.enable_tenant_rls('payroll.payment_line');
SELECT app.add_updated_at_trigger('payroll.payment_line');
CREATE INDEX idx_payment_line_batch ON payroll.payment_line (payment_batch_id);

COMMENT ON COLUMN payroll.payment_line.account_number_last4 IS
  'Only the last four digits are stored here. The full number is decrypted at file-generation time and never persisted in the batch.';

INSERT INTO identity.permission (code, description, sensitive) VALUES
  ('payroll.pay',       'Generate payment batches and record settlement', true),
  ('leave.run_jobs',    'Run accrual, carry-forward and expiry jobs', false),
  ('tax.declare.self',  'Submit own tax declaration', false),
  ('tax.manage',        'Verify declarations and manage statutory rules', true)
ON CONFLICT (code) DO UPDATE
  SET description = EXCLUDED.description, sensitive = EXCLUDED.sensitive;
