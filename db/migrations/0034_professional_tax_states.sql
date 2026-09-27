-- 0034 professional tax: explicit jurisdictions, special months, and an annual ceiling.
--
-- Most of what this phase needs already existed. `payroll.statutory_rule` has carried
-- `rule_type = 'professional_tax'` with a `state_code` since 0006 — state-specific,
-- effective-dated, versioned, tenant-overridable and RLS-protected — and 0008 seeded
-- Karnataka and Maharashtra. `core.tax_profile.pt_state_code` is effective-dated and both
-- the snapshot builder and employee selection already resolve it as at the period end, so
-- historical jurisdiction works and a state transfer is already a new tax-profile row.
--
-- So this migration closes the gaps rather than rebuilding any of that. There is no new
-- statutory-rule framework, no PT-specific rule table, and no column on payroll.salary_slip
-- — PT is already a statutory deduction line — and therefore no change to
-- payroll.guard_finalized_slip, which was inspected and left alone.
--
-- The gaps:
--
--   1. Maharashtra's schedule has a February instalment of 300 and an annual ceiling of
--      2,500. The seeded rule had a flat 200 and no way to express either.
--   2. The rules said nothing about what the slab thresholds are measured against. The
--      engine used gross earnings; nothing recorded that as the intended basis.
--   3. An employee whose state resolved from their work location, in a state with no
--      configured rule, silently deducted nothing. "This state levies no PT" and "nobody has
--      configured this state" looked identical.

-- ---------------------------------------------------------------------------
-- 1. Whether a tenant insists every employee has a resolvable PT jurisdiction.
--
-- ADR-014 decided deliberately that an explicit `pt_state_code` on the tax profile is an
-- assertion of liability and makes PT mandatory, while a state inherited from the work
-- location is a location fact and does not. That stays: reversing it would fail closed on
-- every tenant with an office in a state nobody has configured.
--
-- This flag is the opt-in for tenants who do want that stricter reading — every employee
-- must resolve to a configured PT rule, or payroll refuses them rather than deducting
-- nothing. Default false reproduces today's behaviour exactly.
-- ---------------------------------------------------------------------------

ALTER TABLE payroll.tenant_payroll_policy
  ADD COLUMN require_professional_tax boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN payroll.tenant_payroll_policy.require_professional_tax IS
  'When true, an employee whose resolved PT state has no configured rule fails payroll instead of deducting zero. Opt-in: false reproduces the behaviour from before this column, where only an explicit tax_profile.pt_state_code made PT mandatory (ADR-014, ADR-020).';

-- ---------------------------------------------------------------------------
-- 2. Supersede the seeded rules.
--
-- ADR-005: a version consumed by a finalized run is never edited. Version 1 keeps exactly
-- the slabs it has always had and stops at the end of FY 2025-26; version 2 carries the same
-- amounts plus the structure that was missing. Runs already finalized are unaffected either
-- way — they froze the config in their snapshot and the engine reads that, never this table.
--
-- Both states keep producing the same monthly figure they always did for an ordinary month,
-- so no existing payroll output moves. Only February in Maharashtra changes, and only from
-- FY 2026-27 onward.
-- ---------------------------------------------------------------------------

UPDATE payroll.statutory_rule
   SET effective_to = DATE '2026-03-31'
 WHERE rule_type = 'professional_tax'
   AND tenant_id IS NULL
   AND version = 1
   AND effective_to IS NULL;

-- Karnataka: a flat 200 above the exemption limit, every month, with no February instalment
-- and no annual ceiling. The structure is spelled out anyway so a reader of the frozen
-- snapshot can see that the absence is deliberate rather than unconfigured.
INSERT INTO payroll.statutory_rule
  (tenant_id, country_code, state_code, rule_type, version, effective_from, rule_config)
VALUES (
  NULL, 'IN', 'KA', 'professional_tax', 2, DATE '2026-04-01',
  jsonb_build_object(
    'applicable', true,
    'state_name', 'Karnataka',
    -- What the thresholds are measured against. Gross earnings for the payroll period is
    -- what the engine has always used and what the slab figures below are scaled for;
    -- naming it means a future state whose basis differs has somewhere to say so.
    'wage_basis', 'gross_earnings',
    'frequency', 'monthly',
    'slabs', jsonb_build_array(
      jsonb_build_object('upto', 24999, 'amount', 0,   'label', 'up to 24,999'),
      jsonb_build_object('upto', NULL,  'amount', 200, 'label', '25,000 and above')
    )
  )
);

-- Maharashtra: 175 in the middle band, 200 above it — except February, which carries 300 so
-- the year totals 2,500. The special instalment sits on the slab it modifies rather than in
-- a separate month table, because that is where the ambiguity would otherwise be: the 175
-- band has no February instalment, and a month-keyed list beside the slabs would not say so.
INSERT INTO payroll.statutory_rule
  (tenant_id, country_code, state_code, rule_type, version, effective_from, rule_config)
VALUES (
  NULL, 'IN', 'MH', 'professional_tax', 2, DATE '2026-04-01',
  jsonb_build_object(
    'applicable', true,
    'state_name', 'Maharashtra',
    'wage_basis', 'gross_earnings',
    'frequency', 'monthly',
    'slabs', jsonb_build_array(
      jsonb_build_object('upto', 7500,  'amount', 0,   'label', 'up to 7,500'),
      jsonb_build_object('upto', 10000, 'amount', 175, 'label', '7,501 to 10,000'),
      jsonb_build_object(
        'upto', NULL, 'amount', 200, 'label', 'above 10,000',
        -- Keyed by calendar month number. The engine reads the month from the payroll
        -- period it is calculating, so no month is named anywhere in Python.
        'special_months', jsonb_build_object('2', 300)
      )
    ),
    -- The ceiling for the whole tax year. Never binding for a full year at these amounts
    -- (eleven months at 200 plus February at 300 is exactly 2,500), so it only ever matters
    -- for an employee who changes state or whose earnings move between bands mid-year.
    'annual_cap', 2500
  )
);

COMMENT ON COLUMN payroll.statutory_rule.state_code IS
  'The jurisdiction a state-scoped rule applies to, e.g. professional tax. NULL for a rule that is not state-scoped. Resolved for an employee from tax_profile.pt_state_code where one is asserted, otherwise from the work location''s state (ADR-020).';
