-- 0032 proof verification: who checked it, when, and what it was before.
--
-- Most of what this phase needs already existed and was never wired up. Migration 0024 added
-- `payroll.tax_year.proof_cutoff_date` (per tenant, per tax year) and
-- `payroll.tenant_payroll_policy.require_proof_after_cutoff`, and 0031 gave declaration items
-- the declared/verified/rejected lifecycle. So there is no new cutoff table here, and no
-- second declaration model: this adds the proof *metadata* those states were missing, and one
-- policy flag.
--
-- Note what is NOT here: no column on payroll.salary_slip, and therefore no change to
-- payroll.guard_finalized_slip. The cutoff changes what a snapshot says, not what a payslip
-- stores, so the guard is left exactly as it is. Every protection it carries is asserted in
-- apps/api/test/integration/finalized-slip-guard.test.ts and must stay green.

-- ---------------------------------------------------------------------------
-- 1. Proof metadata.
--
-- `note` was carrying too much: it was the employee's remark, the verifier's remark and the
-- rejection reason all at once, with no way to tell which. A rejection has to survive as a
-- rejection — an employee asking why their 80C gave nothing deserves the reason, the person
-- who decided, and the date, not a free-text field that the next amendment overwrites.
-- ---------------------------------------------------------------------------

ALTER TABLE compensation.tax_declaration_item
  -- Who accepted or refused the proof. Nullable because most rows are never assessed.
  ADD COLUMN verified_by uuid,
  ADD COLUMN verified_at timestamptz,
  -- Why, in the verifier's words. Distinct from `note`, which belongs to whoever declared.
  ADD COLUMN proof_outcome_reason text,
  -- What the row was immediately before this outcome. The full history is in the audit log;
  -- this is the one step back, so a list screen can say "was verified, now rejected" without
  -- a join to audit.
  ADD COLUMN previous_status text
    CHECK (previous_status IS NULL OR previous_status IN ('declared', 'verified', 'rejected'));

-- A verified or rejected row records who decided and when. A declared row has not been
-- assessed, so it must not claim to have been.
ALTER TABLE compensation.tax_declaration_item
  ADD CONSTRAINT tax_declaration_item_proof_outcome CHECK (
    (status IN ('verified', 'rejected') AND verified_at IS NOT NULL)
    OR (status = 'declared' AND verified_at IS NULL AND verified_by IS NULL)
  );

COMMENT ON COLUMN compensation.tax_declaration_item.verified_by IS
  'The user who accepted or refused the proof. Never the employee themselves: verifying requires tax.proof.verify, which the Employee role does not hold.';

COMMENT ON COLUMN compensation.tax_declaration_item.previous_status IS
  'The status immediately before the current one. One step back for display; the full transition history is in audit.audit_log.';

CREATE INDEX idx_tax_declaration_item_unverified
  ON compensation.tax_declaration_item (tenant_id, tax_year_id)
  WHERE status = 'declared';

-- ---------------------------------------------------------------------------
-- 2. Whether a tenant insists on having a cutoff at all.
--
-- `require_proof_after_cutoff` (0024) answers a different question: given that a cutoff
-- exists, does an unproved declaration stop counting once it passes. It cannot also mean
-- "a cutoff must exist", because it defaults to true for everyone — reading it that way
-- would fail closed on every tenant that has never configured a date, which is all of them.
--
-- So the assertion is its own flag, and it is opt-in. A tenant that turns it on is saying
-- every tax year must have a cutoff configured, and payroll should refuse rather than guess
-- if one is missing. Default false preserves 0024's documented behaviour exactly: no cutoff
-- date means no cutoff, and declarations are honoured all year.
-- ---------------------------------------------------------------------------

ALTER TABLE payroll.tenant_payroll_policy
  ADD COLUMN require_proof_cutoff boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN payroll.tenant_payroll_policy.require_proof_cutoff IS
  'When true, every tax year must have a proof_cutoff_date and payroll refuses an employee whose year has none, rather than silently honouring unproved declarations. Opt-in: false reproduces the behaviour from before this column existed.';

COMMENT ON COLUMN payroll.tenant_payroll_policy.require_proof_after_cutoff IS
  'Given that a cutoff exists and has passed, whether an unproved declaration stops reducing tax. True is the conservative setting and the default, because the employer carries the liability for under-deduction. Distinct from require_proof_cutoff, which is about whether a cutoff must be configured at all.';

-- ---------------------------------------------------------------------------
-- 3. Verifying proof is its own permission.
--
-- `tax.manage` is broad — it covers reading and amending anyone's declarations. Accepting
-- proof is the step that turns a statement into a deduction, so it gets its own permission,
-- mirroring tax.rent.verify from 0025. The Employee role holds tax.declare.self and neither
-- of these, so nobody can verify their own proof.
-- ---------------------------------------------------------------------------

INSERT INTO identity.permission (code, description, sensitive) VALUES
  ('tax.proof.verify', 'Accept or refuse proof for a tax exemption declaration', true)
ON CONFLICT (code) DO UPDATE
  SET description = EXCLUDED.description, sensitive = EXCLUDED.sensitive;

-- Existing tenants: anyone who could already verify (tax.manage) keeps being able to, so
-- turning this into a separate permission does not lock a live tenant out of their own
-- January proof run.
INSERT INTO identity.role_permission (tenant_id, role_id, permission_code)
SELECT rp.tenant_id, rp.role_id, 'tax.proof.verify'
  FROM identity.role_permission rp
 WHERE rp.permission_code = 'tax.manage'
ON CONFLICT DO NOTHING;
