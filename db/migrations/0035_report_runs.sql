-- 0035 reporting: one aggregate record per report request.
--
-- PRD s.22 asks for core reports that are "asynchronous and exportable", and s.25 says a
-- long-running job must "expose state through a job or aggregate record rather than blocking
-- HTTP requests". That is exactly what payroll.payroll_run already does for a payroll run, so
-- this is the same shape for a report: the request is a row, the work happens elsewhere, and
-- the client asks the row how it went.
--
-- What is deliberately NOT here:
--
--   * no new job table. Execution rides the outbox -> SQS -> worker path that already carries
--     payslip generation, which is the closest existing precedent: read in a transaction,
--     write the artifact to S3 outside one, record it in a second transaction. The queue
--     supplies the claim, the retry budget, the backoff and the dead letter.
--   * no new document store. The artifact is an ordinary documents.document row, so it
--     inherits presigned download, tenant-scoped keys and the sensitivity flag.
--   * no new permission. Each report is gated on the domain permission that already protects
--     the data it reads, so "can run reports" can never become a way around
--     payroll.read or compensation.read.
--   * no payroll change of any kind. payroll.guard_finalized_slip and
--     guard_finalized_slip_component are untouched; every protection they carry is asserted
--     in apps/api/test/integration/finalized-slip-guard.test.ts and must stay green.

-- ---------------------------------------------------------------------------
-- 1. The report run.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS analytics;

CREATE TABLE analytics.report_run (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,

  -- Closed set, because an unknown report type is a request nobody can serve. The values
  -- are the reports PRD s.22 names, less attrition (no formula or measurement window is
  -- defined anywhere) and hiring (depends on recruitment, which is P2 and not built).
  report_type   text NOT NULL CHECK (report_type IN (
                  'headcount', 'attendance', 'absence', 'overtime', 'leave',
                  'payroll_cost', 'compensation', 'expenses', 'audit_activity')),

  -- What was asked for: date range and org filters, exactly as validated at the API. Kept
  -- so a finished report can say what it was a report *of* — a row count with no parameters
  -- is not a result, it is a number.
  parameters    jsonb NOT NULL DEFAULT '{}'::jsonb,

  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'failed')),

  -- Who asked. Nullable only because a user row can be removed while the evidence that the
  -- report was run should not be.
  requested_by_user_id uuid REFERENCES identity.app_user(id) ON DELETE SET NULL,
  requested_by_label   text NOT NULL,

  row_count     integer CHECK (row_count >= 0),

  -- The exported artifact. ON DELETE SET NULL rather than CASCADE: deleting the export must
  -- not delete the record that the report was run.
  document_id   uuid REFERENCES documents.document(id) ON DELETE SET NULL,

  failure_reason text,

  -- The trace that asked for it, so a report generated minutes later on another process
  -- still joins to the request that caused it (ADR-004, migration 0022).
  correlation_id uuid,

  requested_at  timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- A terminal run has to say how it ended. Without this a 'completed' row with no document
  -- and no row count is indistinguishable from one that silently produced nothing.
  CONSTRAINT report_run_terminal_state CHECK (
    (status <> 'completed' OR (completed_at IS NOT NULL AND row_count IS NOT NULL))
    AND (status <> 'failed' OR (completed_at IS NOT NULL AND failure_reason IS NOT NULL))
  )
);

-- The list a user sees: their tenant's runs, newest first.
CREATE INDEX idx_report_run_tenant_requested
  ON analytics.report_run (tenant_id, requested_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Tenant isolation.
--
-- ENABLE, not FORCE, for the reason db/grants.sql and scripts/db/validate-migrations.mjs
-- record: under FORCE, identity.purge_tenant() would silently affect zero rows and a purged
-- tenant would leave its report history behind.
-- ---------------------------------------------------------------------------

ALTER TABLE analytics.report_run ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON analytics.report_run
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

GRANT USAGE ON SCHEMA analytics TO hrms_app, hrms_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.report_run TO hrms_app, hrms_platform;

COMMENT ON TABLE analytics.report_run IS
  'One request for a report (PRD s.22). Async execution and the exported artifact hang off this row (PRD s.25).';
COMMENT ON COLUMN analytics.report_run.requested_by_label IS
  'Actor label captured at request time, so the audit trail survives the user row being removed.';

-- ---------------------------------------------------------------------------
-- 3. A report export is a document.
--
-- Rather than a second storage abstraction. `employee_id` is already nullable, which is what
-- a tenant-wide artifact needs; only the type vocabulary had to admit one.
-- ---------------------------------------------------------------------------

ALTER TABLE documents.document
  DROP CONSTRAINT document_document_type_check;

ALTER TABLE documents.document
  ADD CONSTRAINT document_document_type_check CHECK (document_type IN (
    'identity', 'address', 'education', 'offer_letter', 'contract', 'bank', 'tax',
    'certificate', 'payslip', 'expense_receipt', 'experience_letter', 'report', 'other'));
