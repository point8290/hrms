-- 0033 surcharge and marginal relief.
--
-- No new table, and that is the decision rather than an omission.
--
-- Phase 3 gave section exemptions their own table because 80C's ceiling can change in a year
-- 80D's does not, so the two must be versioned apart. Surcharge is the opposite case: the
-- bands are part of the rate structure, moved by the same Finance Act that moves the slabs,
-- and versioning them separately would let a rule version exist that has this year's slabs
-- and last year's bands. So they live together in the income-tax rule, which is already
-- tax-year aware, regime aware, effective-dated, versioned, tenant-overridable, non-
-- overlapping and RLS-protected. Nothing in §2's list is missing from it.
--
-- Also absent: any column on payroll.salary_slip, and therefore any change to
-- payroll.guard_finalized_slip. Surcharge is an annual figure inside the TDS computation and
-- is already explained by the slip's TDS calculation_detail; a monthly column holding an
-- annual number would be a second source of truth that could disagree with the trace.

-- ---------------------------------------------------------------------------
-- 1. Supersede the rule rather than edit it.
--
-- ADR-005: a rule version consumed by a finalized run is never edited. Version 1 keeps
-- exactly the slabs it has always had and stops at the end of FY 2025-26; version 2 carries
-- the identical slabs plus the surcharge bands from 2026-27 onward.
--
-- Closing v1 is supersession, not mutation — `effective_to` exists for this. Runs already
-- finalized are untouched either way: they froze their rule_config in the snapshot and the
-- engine reads that, never this table.
-- ---------------------------------------------------------------------------

UPDATE payroll.statutory_rule
   SET effective_to = DATE '2026-03-31'
 WHERE rule_type = 'income_tax'
   AND tenant_id IS NULL
   AND version = 1
   AND effective_to IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Version 2: the same slabs, plus surcharge.
--
-- The bands are explicit structured data — threshold, rate — and nothing else. No formula
-- string, no expression to evaluate: the engine walks the bands and applies arithmetic it
-- already knows. `marginal_relief` is a flag per band rather than a formula, because relief
-- is a statutory rule with one shape, not something a tenant composes.
--
-- Regime-aware because the regimes genuinely differ: section 115BAC caps surcharge at 25%
-- and has no 37% band, so an employee on the new regime with income over five crore pays a
-- materially different figure from one on the old regime. Expressing that as one shared band
-- list would be wrong for whichever regime lost.
--
-- Thresholds are measured against **annual taxable income** — the figure after the standard
-- deduction and allowed chapter VI-A exemptions — which is what the Act means by total
-- income. Not gross, and not the monthly figure.
-- ---------------------------------------------------------------------------

INSERT INTO payroll.statutory_rule
  (tenant_id, country_code, state_code, rule_type, version, effective_from, effective_to, rule_config)
VALUES (
  NULL, 'IN', NULL, 'income_tax', 2, DATE '2026-04-01', NULL,
  jsonb_build_object(
    'regimes', jsonb_build_object(
      'old', jsonb_build_object(
        'slabs', jsonb_build_array(
          jsonb_build_object('upto', 250000, 'rate', 0),
          jsonb_build_object('upto', 500000, 'rate', 0.05),
          jsonb_build_object('upto', 1000000, 'rate', 0.20),
          jsonb_build_object('upto', NULL, 'rate', 0.30)
        ),
        'standard_deduction', 50000,
        'rebate_limit', 500000,
        'rebate_max', 12500,
        'cess_rate', 0.04,
        'surcharge', jsonb_build_object(
          'applicable', true,
          -- Each band: the total income above which it applies, and the rate charged on the
          -- income tax (never on income). Ordered low to high; the highest band whose
          -- threshold is crossed is the one that applies.
          'bands', jsonb_build_array(
            jsonb_build_object('threshold', 5000000,  'rate', 0.10, 'marginal_relief', true),
            jsonb_build_object('threshold', 10000000, 'rate', 0.15, 'marginal_relief', true),
            jsonb_build_object('threshold', 20000000, 'rate', 0.25, 'marginal_relief', true),
            jsonb_build_object('threshold', 50000000, 'rate', 0.37, 'marginal_relief', true)
          )
        )
      ),
      'new', jsonb_build_object(
        'slabs', jsonb_build_array(
          jsonb_build_object('upto', 300000,  'rate', 0),
          jsonb_build_object('upto', 700000,  'rate', 0.05),
          jsonb_build_object('upto', 1000000, 'rate', 0.10),
          jsonb_build_object('upto', 1200000, 'rate', 0.15),
          jsonb_build_object('upto', 1500000, 'rate', 0.20),
          jsonb_build_object('upto', NULL,    'rate', 0.30)
        ),
        'standard_deduction', 75000,
        'rebate_limit', 700000,
        'rebate_max', 25000,
        'cess_rate', 0.04,
        'surcharge', jsonb_build_object(
          'applicable', true,
          -- Section 115BAC caps surcharge at 25%: there is no 37% band under the new regime.
          'bands', jsonb_build_array(
            jsonb_build_object('threshold', 5000000,  'rate', 0.10, 'marginal_relief', true),
            jsonb_build_object('threshold', 10000000, 'rate', 0.15, 'marginal_relief', true),
            jsonb_build_object('threshold', 20000000, 'rate', 0.25, 'marginal_relief', true)
          )
        )
      )
    )
  )
);

COMMENT ON COLUMN payroll.statutory_rule.rule_config IS
  'The whole rate structure for this version: slabs, standard deduction, rebate, cess and — from income_tax version 2 — surcharge bands. Frozen into every payroll snapshot that consumes it, so a version published later can never re-price a run already calculated. A version with no `surcharge` key predates surcharge support and is recorded as such in the calculation trace rather than silently treated as zero.';
