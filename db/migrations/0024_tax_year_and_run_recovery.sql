-- 0024 tax year as its own concept, and recovery for a run nobody is working on.
--
-- Two unrelated problems that share a migration because both are structural rather than
-- statutory, and the statutory work that follows depends on the first of them.

-- ---------------------------------------------------------------------------
-- 1. Stuck payroll runs.
--
-- `calculating -> cancelled` is illegal on purpose: a run must not be cancelled out from
-- under an engine that might be halfway through four thousand employees. The cost was that
-- a run whose engine never answered needed an operator to mark it failed by hand, and
-- nothing told them it had happened.
--
-- The fix is not to loosen the transition. It is to notice. A run records when it last made
-- progress; a scheduled sweep moves one that has made none for long enough to `failed`,
-- where the existing retry path already applies. The engine writes progress as it goes, so
-- a genuinely busy run is never mistaken for a dead one.
-- ---------------------------------------------------------------------------

ALTER TABLE payroll.payroll_run
  -- Touched by the engine as it works. Distinct from started_at, which never moves: a run
  -- that has been calculating for two hours but wrote a slip a minute ago is healthy.
  ADD COLUMN last_progress_at timestamptz,
  -- How many times calculation has been attempted. Bounded, so a run that fails structurally
  -- stops being retried and starts being someone's problem.
  ADD COLUMN calculation_attempts integer NOT NULL DEFAULT 0
    CHECK (calculation_attempts >= 0),
  ADD COLUMN recovered_at timestamptz,
  ADD COLUMN recovery_reason text;

-- Existing runs are treated as having last progressed when they started, which is the
-- conservative reading: an old run with no progress recorded is exactly the case the sweep
-- exists to find.
UPDATE payroll.payroll_run SET last_progress_at = COALESCE(started_at, created_at);

COMMENT ON COLUMN payroll.payroll_run.last_progress_at IS
  'When the engine last did something for this run. The stale sweep measures from here, not from started_at, so a long but healthy run is never reclaimed.';

-- The sweep's only predicate. Partial, because the steady state is that almost no run is
-- calculating.
CREATE INDEX idx_payroll_run_in_progress
  ON payroll.payroll_run (last_progress_at)
  WHERE status IN ('validating', 'calculating');

-- ---------------------------------------------------------------------------
-- 2. The tax year.
--
-- `payroll_period` was doing two jobs: the monthly cycle an employee is paid for, and the
-- year income tax is assessed over. The year was derived in application code from a date
-- and a start month, which worked but left nowhere to hang anything — no tax-year status,
-- no way to say "this year is closed", and a financial-year label on tax records that
-- nothing validated against a year that exists.
--
-- Separating them is what makes the statutory work that follows possible: exemption caps,
-- proof cutoffs and surcharge rules are all facts about a *year*, not about a month.
-- ---------------------------------------------------------------------------

CREATE TABLE payroll.tax_year (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  -- Display label, e.g. '2026-27'. Derived from the boundaries, stored because every tax
  -- record and every statutory rule is keyed by it and a join to recompute it would be
  -- noise on every query.
  label      text NOT NULL CHECK (label ~ '^\d{4}-\d{2}$'),
  start_date date NOT NULL,
  end_date   date NOT NULL,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  -- The day after which an unverified declaration stops counting. Null means the tenant
  -- has no cutoff and declarations are honoured all year.
  proof_cutoff_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tax_year_range CHECK (end_date > start_date),
  CONSTRAINT tax_year_cutoff_inside CHECK (
    proof_cutoff_date IS NULL
    OR (proof_cutoff_date >= start_date AND proof_cutoff_date <= end_date)
  ),
  UNIQUE (tenant_id, label)
);
SELECT app.enable_tenant_rls('payroll.tax_year');
SELECT app.add_updated_at_trigger('payroll.tax_year');

-- Two tax years that overlap would make "which year is this period in" ambiguous, and the
-- answer decides how much tax is withheld. The database settles it.
ALTER TABLE payroll.tax_year
  ADD CONSTRAINT tax_year_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  );

COMMENT ON TABLE payroll.tax_year IS
  'The year income tax is assessed over. Distinct from payroll_period, which is the cycle an employee is paid for; a year contains many periods.';

-- ---------------------------------------------------------------------------
-- 3. Every payroll period belongs to exactly one tax year.
-- ---------------------------------------------------------------------------

ALTER TABLE payroll.payroll_period
  ADD COLUMN tax_year_id uuid REFERENCES payroll.tax_year(id);

-- Backfill. Existing periods were assigned to a year derived from the tenant's configured
-- start month, which is exactly what the application code was computing, so no period
-- changes the year it was already being treated as being in.
INSERT INTO payroll.tax_year (tenant_id, label, start_date, end_date)
SELECT DISTINCT
       p.tenant_id,
       to_char(y.start_date, 'YYYY') || '-' ||
         to_char(y.start_date + INTERVAL '1 year', 'YY') AS label,
       y.start_date,
       (y.start_date + INTERVAL '1 year' - INTERVAL '1 day')::date AS end_date
  FROM payroll.payroll_period p
  JOIN identity.tenant t ON t.id = p.tenant_id
  CROSS JOIN LATERAL (
    SELECT make_date(
             CASE WHEN EXTRACT(MONTH FROM p.period_end) >= t.fy_start_month
                  THEN EXTRACT(YEAR FROM p.period_end)::int
                  ELSE EXTRACT(YEAR FROM p.period_end)::int - 1 END,
             t.fy_start_month,
             1
           ) AS start_date
  ) y
ON CONFLICT (tenant_id, label) DO NOTHING;

UPDATE payroll.payroll_period p
   SET tax_year_id = ty.id
  FROM payroll.tax_year ty
 WHERE ty.tenant_id = p.tenant_id
   AND p.period_end BETWEEN ty.start_date AND ty.end_date
   AND p.tax_year_id IS NULL;

-- A period with no tax year cannot be paid, because there is no year to assess its tax in.
-- Enforced only once the backfill has run.
ALTER TABLE payroll.payroll_period
  ALTER COLUMN tax_year_id SET NOT NULL;

CREATE INDEX idx_payroll_period_tax_year
  ON payroll.payroll_period (tenant_id, tax_year_id, period_start);

COMMENT ON COLUMN payroll.payroll_period.tax_year_id IS
  'The tax year this period is assessed in. A period spanning a year boundary belongs to the year its end date falls in, which is where the income is taxed.';

-- ---------------------------------------------------------------------------
-- 4. Opening balances hang off the tax year, not off a label.
-- ---------------------------------------------------------------------------

ALTER TABLE payroll.employee_tax_opening
  ADD COLUMN tax_year_id uuid REFERENCES payroll.tax_year(id);

-- Create any year an opening balance names but no period covers yet, then link.
INSERT INTO payroll.tax_year (tenant_id, label, start_date, end_date)
SELECT DISTINCT
       o.tenant_id,
       o.financial_year,
       make_date(split_part(o.financial_year, '-', 1)::int, t.fy_start_month, 1),
       (make_date(split_part(o.financial_year, '-', 1)::int, t.fy_start_month, 1)
          + INTERVAL '1 year' - INTERVAL '1 day')::date
  FROM payroll.employee_tax_opening o
  JOIN identity.tenant t ON t.id = o.tenant_id
ON CONFLICT (tenant_id, label) DO NOTHING;

UPDATE payroll.employee_tax_opening o
   SET tax_year_id = ty.id
  FROM payroll.tax_year ty
 WHERE ty.tenant_id = o.tenant_id AND ty.label = o.financial_year
   AND o.tax_year_id IS NULL;

ALTER TABLE payroll.employee_tax_opening
  ALTER COLUMN tax_year_id SET NOT NULL;

-- `financial_year` stays as the human-readable label and is kept in step by the service.
-- Dropping it would break every query that reads a snapshot written before this migration.
COMMENT ON COLUMN payroll.employee_tax_opening.financial_year IS
  'Label of the tax year, denormalised from tax_year.label. tax_year_id is the authority.';

-- ---------------------------------------------------------------------------
-- 5. Tenant payroll policy.
--
-- Choices a tenant makes that change what a payslip says, and which therefore have to be
-- snapshotted alongside the figures they produce. One row per tenant, created lazily with
-- defaults that reproduce today's behaviour exactly — this migration must not change any
-- existing tenant's numbers.
-- ---------------------------------------------------------------------------

CREATE TABLE payroll.tenant_payroll_policy (
  tenant_id uuid PRIMARY KEY REFERENCES identity.tenant(id) ON DELETE CASCADE,

  -- Whether holidays and weekly offs count towards the denominator that pro-rates salary.
  --   calendar - every day in the period. One LOP day costs monthly/30.
  --   working  - calendar less holidays and weekly offs. One LOP day costs more.
  -- Both conventions are used by real Indian employers. `calendar` is the default because
  -- it is what this system already did, and changing it silently would reprice every
  -- existing tenant's loss of pay.
  working_days_basis text NOT NULL DEFAULT 'calendar'
    CHECK (working_days_basis IN ('calendar', 'working')),

  -- Whether an exemption that was declared but never proved still reduces tax after the
  -- year's cutoff. Employers differ; the conservative setting is the default because the
  -- employer carries the liability for under-deduction.
  require_proof_after_cutoff boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('payroll.tenant_payroll_policy');
SELECT app.add_updated_at_trigger('payroll.tenant_payroll_policy');

COMMENT ON TABLE payroll.tenant_payroll_policy IS
  'Tenant choices that change payroll figures. Defaults reproduce the behaviour before this migration; every value is snapshotted with the run it affected.';

-- ---------------------------------------------------------------------------
-- 6. Permissions.
-- ---------------------------------------------------------------------------

INSERT INTO identity.permission (code, description, sensitive) VALUES
  ('payroll.recover',    'Recover a payroll run whose calculation stalled', false),
  ('tax.year.manage',    'Open, close and configure tax years', true),
  ('payroll.policy.manage', 'Change tenant payroll policy', true)
ON CONFLICT (code) DO UPDATE
  SET description = EXCLUDED.description, sensitive = EXCLUDED.sensitive;
