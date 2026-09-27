-- 0015 expense claims, advances and reimbursement.
--
-- Business shape follows mature HR behaviour:
--   * a claim is a header with lines, each line its own type, date, amount and receipt
--   * finance may sanction LESS than the employee claimed, per line, with a reason
--   * an outstanding advance is settled against a claim before anything is reimbursed
--   * the claim, not the line, carries the approval state
--
-- States follow ArchitectureDiagram/12-state-machines.puml:
--   draft -> submitted -> manager_review -> finance_review -> approved
--         -> payment_pending -> paid, with rejected reachable from either review.

CREATE TABLE expense.expense_type (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  code             text NOT NULL,
  name             text NOT NULL,
  receipt_required boolean NOT NULL DEFAULT true,
  -- Above this the claim always goes to finance review even if policy would skip it.
  limit_amount     numeric(14, 2),
  -- A per-day cap, checked across every claim the employee has for that date.
  daily_limit_amount numeric(14, 2),
  requires_business_purpose boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
SELECT app.enable_tenant_rls('expense.expense_type');
SELECT app.add_updated_at_trigger('expense.expense_type');

CREATE TABLE expense.employee_advance (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  purpose             text NOT NULL,
  requested_amount    numeric(14, 2) NOT NULL CHECK (requested_amount > 0),
  approved_amount     numeric(14, 2) CHECK (approved_amount >= 0),
  paid_amount         numeric(14, 2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  -- Maintained by claim settlement; the outstanding balance is derived from these.
  claimed_amount      numeric(14, 2) NOT NULL DEFAULT 0 CHECK (claimed_amount >= 0),
  returned_amount     numeric(14, 2) NOT NULL DEFAULT 0 CHECK (returned_amount >= 0),
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected',
                                          'paid', 'settled', 'cancelled')),
  workflow_instance_id uuid,
  needed_by           date,
  decided_by          uuid,
  decided_at          timestamptz,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT advance_claimed_within_paid CHECK (claimed_amount + returned_amount <= paid_amount)
);
SELECT app.enable_tenant_rls('expense.employee_advance');
SELECT app.add_updated_at_trigger('expense.employee_advance');
CREATE INDEX idx_advance_outstanding
  ON expense.employee_advance (tenant_id, employee_id)
  WHERE status = 'paid';
COMMENT ON COLUMN expense.employee_advance.claimed_amount IS
  'Settled against expense claims. Outstanding = paid_amount - claimed_amount - returned_amount.';

CREATE TABLE expense.expense_claim (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  claim_number        text NOT NULL,
  claim_date          date NOT NULL,
  title               text NOT NULL,
  business_purpose    text,
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'submitted', 'manager_review', 'finance_review',
                                          'approved', 'rejected', 'payment_pending', 'paid', 'cancelled')),
  -- claimed is what the employee asked for; sanctioned is what finance agreed to pay.
  total_claimed_amount   numeric(14, 2) NOT NULL DEFAULT 0 CHECK (total_claimed_amount >= 0),
  total_sanctioned_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (total_sanctioned_amount >= 0),
  advance_adjusted_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (advance_adjusted_amount >= 0),
  reimbursable_amount    numeric(14, 2) NOT NULL DEFAULT 0,
  currency            text NOT NULL DEFAULT 'INR',
  workflow_instance_id uuid,
  submitted_at        timestamptz,
  decided_by          uuid,
  decided_at          timestamptz,
  decision_note       text,
  paid_at             timestamptz,
  payment_reference   text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, claim_number)
);
SELECT app.enable_tenant_rls('expense.expense_claim');
SELECT app.add_updated_at_trigger('expense.expense_claim');
CREATE INDEX idx_expense_claim_employee ON expense.expense_claim (tenant_id, employee_id, claim_date DESC);
CREATE INDEX idx_expense_claim_open
  ON expense.expense_claim (tenant_id, status)
  WHERE status IN ('submitted', 'manager_review', 'finance_review', 'approved', 'payment_pending');

CREATE TABLE expense.expense_line (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  expense_claim_id    uuid NOT NULL REFERENCES expense.expense_claim(id) ON DELETE CASCADE,
  expense_type_id     uuid NOT NULL REFERENCES expense.expense_type(id),
  expense_date        date NOT NULL,
  description         text NOT NULL,
  claimed_amount      numeric(14, 2) NOT NULL CHECK (claimed_amount > 0),
  -- NULL until finance decides; may be less than claimed, never more.
  sanctioned_amount   numeric(14, 2) CHECK (sanctioned_amount >= 0),
  sanction_note       text,
  tax_amount          numeric(14, 2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  receipt_document_id uuid REFERENCES documents.document(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sanctioned_not_above_claimed
    CHECK (sanctioned_amount IS NULL OR sanctioned_amount <= claimed_amount)
);
SELECT app.enable_tenant_rls('expense.expense_line');
SELECT app.add_updated_at_trigger('expense.expense_line');
CREATE INDEX idx_expense_line_claim ON expense.expense_line (expense_claim_id);
CREATE INDEX idx_expense_line_daily_limit
  ON expense.expense_line (tenant_id, expense_type_id, expense_date);

-- Which advances a claim settled, and by how much. Append-only: a settlement that was
-- reversed leaves both records, so the advance balance is always explainable.
CREATE TABLE expense.advance_settlement (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  expense_claim_id    uuid NOT NULL REFERENCES expense.expense_claim(id) ON DELETE CASCADE,
  employee_advance_id uuid NOT NULL REFERENCES expense.employee_advance(id),
  amount              numeric(14, 2) NOT NULL,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('expense.advance_settlement');
SELECT app.make_append_only('expense.advance_settlement');
CREATE INDEX idx_settlement_advance ON expense.advance_settlement (tenant_id, employee_advance_id);

-- A finalized claim is a financial record. Once paid, the amounts cannot move.
CREATE OR REPLACE FUNCTION expense.guard_paid_claim()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'paid' AND coalesce(current_setting('app.purge_mode', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'paid expense claim % cannot be deleted', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'paid'
     AND (NEW.total_sanctioned_amount IS DISTINCT FROM OLD.total_sanctioned_amount
          OR NEW.reimbursable_amount IS DISTINCT FROM OLD.reimbursable_amount
          OR NEW.advance_adjusted_amount IS DISTINCT FROM OLD.advance_adjusted_amount
          OR NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'paid expense claim % is immutable; raise an adjustment claim instead', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_paid_expense_claim
  BEFORE UPDATE OR DELETE ON expense.expense_claim
  FOR EACH ROW EXECUTE FUNCTION expense.guard_paid_claim();

INSERT INTO identity.permission (code, description, sensitive) VALUES
  ('expense.read.self',    'View own expense claims and advances', false),
  ('expense.read',         'View expense claims for permitted employees', false),
  ('expense.submit',       'Create and submit own expense claims', false),
  ('expense.approve',      'Approve or reject expense claims as a manager', false),
  ('expense.finance',      'Sanction amounts and mark claims paid', true),
  ('expense.manage',       'Manage expense types and advances', false)
ON CONFLICT (code) DO UPDATE
  SET description = EXCLUDED.description, sensitive = EXCLUDED.sensitive;
