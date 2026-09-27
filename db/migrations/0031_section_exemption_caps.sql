-- 0031 section exemption caps: 80C, 80D and friends, capped per financial year.
--
-- What was there before: `compensation.tax_declaration.declarations` was a free-form
-- `{key: number}` jsonb, blindly summed into `declared_amount`, applied **uncapped** to the
-- old regime and ignored entirely by the new one. An employee could declare two million
-- rupees under a key spelled anything at all and the engine would deduct all of it.
--
-- What this adds is the missing middle: a configured catalogue of sections, each with a
-- maximum that belongs to a financial year and a tax regime, so a declaration is checked
-- against something rather than trusted.

-- ---------------------------------------------------------------------------
-- 1. The rule catalogue.
--
-- A table of its own rather than more keys inside payroll.statutory_rule.rule_config. That
-- table holds one jsonb per (tenant, country, state, rule_type, version), and the dimension
-- that matters here is the *section*: 80C's limit can change in a year 80D's does not, and
-- expressing that inside a single income-tax rule version would mean reissuing the whole
-- slab table to move one cap. It would also leave no column to put an exclusion constraint
-- on, and no way to ask "which sections are configured" without unpacking jsonb.
--
-- Everything else about the shape is copied deliberately from statutory_rule, because that
-- is the established pattern here: nullable tenant_id for a platform default that a tenant
-- may override, integer version, effective dates, and the same RLS policy.
-- ---------------------------------------------------------------------------

CREATE TABLE payroll.tax_exemption_rule (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL means a platform default, readable by every tenant. A non-null tenant_id is that
  -- tenant's override and outranks the default, exactly as for statutory_rule.
  tenant_id    uuid REFERENCES identity.tenant(id) ON DELETE CASCADE,
  country_code text NOT NULL DEFAULT 'IN',

  -- The stable identifier. Upper case, digits and the bracket forms the Act itself uses,
  -- e.g. 80C, 80D, 80CCD(1B). Never a display label: labels get translated and reworded,
  -- and a payroll calculation that keyed on one would change answer when someone fixed a
  -- typo in the UI.
  section_code text NOT NULL CHECK (section_code ~ '^[0-9]{1,3}[A-Z]{0,4}(\([0-9A-Z]{1,3}\))?$'),
  -- For humans. Carries no meaning for the calculation.
  name         text NOT NULL,

  version      integer NOT NULL CHECK (version >= 1),
  effective_from date NOT NULL,
  effective_to   date,

  -- The statutory ceiling for this section in this year. NOT NULL: a section with no
  -- ceiling is not something this phase models, and a nullable maximum would be read as
  -- "unlimited" by the first person who forgot to set it.
  max_amount   numeric(14, 2) NOT NULL CHECK (max_amount >= 0),

  -- Which regimes give this exemption. Section 115BAC trades most of chapter VI-A away for
  -- lower slabs, so the same section is worth its cap under the old regime and nothing at
  -- all under the new one. An empty array would mean "no regime", which is a configuration
  -- error rather than a legitimate state.
  applicable_regimes text[] NOT NULL CHECK (cardinality(applicable_regimes) > 0),

  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tax_exemption_rule_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- Tenant-scoped rows are isolated; platform defaults (tenant_id IS NULL) are readable by
-- all. Written out rather than app.enable_tenant_rls() because that helper assumes a
-- NOT NULL tenant_id, and this table's whole point is that some rows belong to nobody.
ALTER TABLE payroll.tax_exemption_rule ENABLE ROW LEVEL SECURITY;
CREATE POLICY tax_exemption_rule_isolation ON payroll.tax_exemption_rule
  USING (tenant_id IS NULL OR tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Two rules for one section whose effective ranges overlap would make "what is the 80C cap
-- for 2026-27" have two answers, and the answer decides how much tax a real person pays.
-- The database settles it, the same way it already does for tax years and rent
-- declarations. COALESCE on tenant_id so platform defaults collide with each other rather
-- than with every tenant's override.
ALTER TABLE payroll.tax_exemption_rule
  ADD CONSTRAINT tax_exemption_rule_no_overlap
  EXCLUDE USING gist (
    (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    country_code WITH =,
    section_code WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  );

CREATE UNIQUE INDEX tax_exemption_rule_version_key ON payroll.tax_exemption_rule (
  COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
  country_code,
  section_code,
  version
);

CREATE INDEX idx_tax_exemption_rule_lookup
  ON payroll.tax_exemption_rule (country_code, section_code, effective_from DESC);

COMMENT ON TABLE payroll.tax_exemption_rule IS
  'Configured exemption sections and their financial-year ceilings. Resolved by tax year, never by section code alone: a cap is an annual figure belonging to a year, so the rule in force on the year''s first day governs the whole year.';

COMMENT ON COLUMN payroll.tax_exemption_rule.section_code IS
  'Stable identifier from the Act (80C, 80D, 80CCD(1B)). Never a display label.';

-- ---------------------------------------------------------------------------
-- 2. Platform defaults.
--
-- Effective 2025-04-01 and open-ended, matching the single income_tax rule seeded by 0008,
-- so the two resolve consistently for every year this system currently knows about.
--
-- Old regime only. Under section 115BAC the new regime forfeits all three, and listing it
-- here would exempt income that is fully taxable for everyone who elected it.
-- ---------------------------------------------------------------------------

INSERT INTO payroll.tax_exemption_rule
  (tenant_id, country_code, section_code, name, version, effective_from, max_amount,
   applicable_regimes, note)
VALUES
  (NULL, 'IN', '80C', 'Investments, insurance premia and tuition fees', 1, '2025-04-01',
   150000, ARRAY['old'],
   'Section 80C read with 80CCC and 80CCD(1); the ceiling is shared across all three.'),
  (NULL, 'IN', '80D', 'Health insurance premia', 1, '2025-04-01',
   25000, ARRAY['old'],
   'Self, spouse and children. The higher senior-citizen ceiling is an eligibility question and is not modelled in this phase.'),
  (NULL, 'IN', '80CCD(1B)', 'Additional national pension scheme contribution', 1, '2025-04-01',
   50000, ARRAY['old'],
   'Over and above the 80C ceiling.');

-- ---------------------------------------------------------------------------
-- 3. Declarations gain a tax year and per-section rows.
--
-- The parent `tax_declaration` stays exactly where it is — one row per employee per year,
-- carrying the regime election and the lifecycle status. What it lacked was any structure
-- underneath: `declarations` was free-form jsonb with no section it could be checked
-- against. The items are that structure, and they hang off the existing parent rather than
-- forming a second declaration model.
-- ---------------------------------------------------------------------------

ALTER TABLE compensation.tax_declaration
  ADD COLUMN tax_year_id uuid REFERENCES payroll.tax_year(id);

-- Backfill through the tax years phase 1 created, creating any a declaration names but no
-- payroll period has needed yet.
INSERT INTO payroll.tax_year (tenant_id, label, start_date, end_date)
SELECT DISTINCT
       d.tenant_id,
       d.financial_year,
       make_date(split_part(d.financial_year, '-', 1)::int, t.fy_start_month, 1),
       (make_date(split_part(d.financial_year, '-', 1)::int, t.fy_start_month, 1)
          + INTERVAL '1 year' - INTERVAL '1 day')::date
  FROM compensation.tax_declaration d
  JOIN identity.tenant t ON t.id = d.tenant_id
 WHERE d.financial_year ~ '^\d{4}-\d{2}$'
ON CONFLICT (tenant_id, label) DO NOTHING;

UPDATE compensation.tax_declaration d
   SET tax_year_id = ty.id
  FROM payroll.tax_year ty
 WHERE ty.tenant_id = d.tenant_id AND ty.label = d.financial_year
   AND d.tax_year_id IS NULL;

-- Not NOT NULL: a declaration whose `financial_year` never matched the tenant's configured
-- year start cannot be placed in a year that exists, and refusing to migrate is worse than
-- carrying one forward unlinked. The service requires it on write, so nothing new can be
-- created without one.
COMMENT ON COLUMN compensation.tax_declaration.tax_year_id IS
  'The tax year this declaration is assessed in. Null only for rows migrated from a financial_year label that matched no tax year; every new declaration has one.';

CREATE INDEX idx_tax_declaration_tax_year
  ON compensation.tax_declaration (tenant_id, tax_year_id);

CREATE TABLE compensation.tax_declaration_item (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  tax_declaration_id  uuid NOT NULL REFERENCES compensation.tax_declaration(id) ON DELETE CASCADE,
  -- Denormalised from the parent so a snapshot query does not need the join, and so RLS
  -- has a tenant column of its own to key on.
  employee_id         uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  tax_year_id         uuid NOT NULL REFERENCES payroll.tax_year(id),

  section_code        text NOT NULL,
  declared_amount     numeric(14, 2) NOT NULL CHECK (declared_amount >= 0),

  -- What a verifier accepted, which is not the same as what the statute caps. Eligibility
  -- comes first and the cap second: an employee may declare 200,000 under 80C, have 180,000
  -- of it accepted as eligible, and still be allowed only the 150,000 ceiling.
  --
  -- Null means nobody has assessed eligibility, and the declared amount stands. That is the
  -- behaviour this system already had for the parent's verified_amount, kept deliberately.
  verified_amount     numeric(14, 2) CHECK (verified_amount IS NULL OR verified_amount >= 0),

  -- The same three-state lifecycle rent declarations use, which is the vocabulary phase 4's
  -- proof cutoff will act on. `declared` is what that phase will call unverified.
  status text NOT NULL DEFAULT 'declared'
    CHECK (status IN ('declared', 'verified', 'rejected')),

  note       text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tax_declaration_item_verified_amount CHECK (
    (status = 'verified' AND verified_amount IS NOT NULL)
    OR (status <> 'verified' AND verified_amount IS NULL)
  ),

  -- One row per section per declaration. Two live rows for 80C would have to be summed or
  -- chosen between, and neither is a rule anyone stated — so amending replaces, and the
  -- previous figure survives in the audit trail rather than in a second row.
  UNIQUE (tax_declaration_id, section_code)
);
SELECT app.enable_tenant_rls('compensation.tax_declaration_item');
SELECT app.add_updated_at_trigger('compensation.tax_declaration_item');

CREATE INDEX idx_tax_declaration_item_employee_year
  ON compensation.tax_declaration_item (tenant_id, employee_id, tax_year_id);

COMMENT ON TABLE compensation.tax_declaration_item IS
  'One declared exemption, per section, per employee, per tax year. Hangs off compensation.tax_declaration, which keeps the regime election and the lifecycle; this adds the section structure that a cap can be checked against.';

COMMENT ON COLUMN compensation.tax_declaration_item.verified_amount IS
  'Eligible amount, as assessed by a verifier. Distinct from the statutory cap: eligibility narrows what was declared, the cap then limits what is allowed.';

-- Backfill from the free-form jsonb, for keys that name a section this system knows about.
-- A key that matches nothing is deliberately *not* carried forward: an uncapped deduction
-- under an arbitrary key is the defect this migration exists to close, and silently
-- preserving it would preserve the defect. Nothing is lost — `declarations` is untouched and
-- still holds whatever was there.
INSERT INTO compensation.tax_declaration_item
  (tenant_id, tax_declaration_id, employee_id, tax_year_id, section_code, declared_amount, status)
SELECT d.tenant_id, d.id, d.employee_id, d.tax_year_id,
       upper(kv.key), (kv.value #>> '{}')::numeric,
       CASE WHEN d.status = 'verified' THEN 'declared' ELSE 'declared' END
  FROM compensation.tax_declaration d
  CROSS JOIN LATERAL jsonb_each(d.declarations) AS kv
 WHERE d.tax_year_id IS NOT NULL
   AND jsonb_typeof(kv.value) = 'number'
   AND EXISTS (
     SELECT 1 FROM payroll.tax_exemption_rule r
      WHERE r.section_code = upper(kv.key)
        AND (r.tenant_id IS NULL OR r.tenant_id = d.tenant_id)
   )
ON CONFLICT (tax_declaration_id, section_code) DO NOTHING;

COMMENT ON COLUMN compensation.tax_declaration.declarations IS
  'Legacy free-form declaration map. No longer read by payroll: tax_declaration_item is the authority, because a free-form key could not be checked against a configured ceiling.';

-- ---------------------------------------------------------------------------
-- 4. The snapshot and the slip.
-- ---------------------------------------------------------------------------

ALTER TABLE payroll.payroll_input_snapshot
  ADD COLUMN exemption_json jsonb NOT NULL DEFAULT '{"sections": []}'::jsonb;

COMMENT ON COLUMN payroll.payroll_input_snapshot.exemption_json IS
  'Section exemption inputs, frozen: for each declared section the resolved rule id, version, ceiling, declared and eligible amounts. The engine reads no rule table and no declaration.';

ALTER TABLE payroll.salary_slip
  ADD COLUMN section_exemption_total numeric(14, 2) NOT NULL DEFAULT 0
    CHECK (section_exemption_total >= 0);

COMMENT ON COLUMN payroll.salary_slip.section_exemption_total IS
  'Chapter VI-A exemptions allowed for the year after caps, as applied to this slip''s annual estimate. Zero for every slip written before this column existed, which is what those slips actually applied.';

-- ---------------------------------------------------------------------------
-- 5. The finalized-slip guard.
--
-- Built by taking the *currently stored* definition (pg_proc.prosrc) and adding one
-- condition. Not reconstructed from 0006, 0010, 0023 or 0029 — doing exactly that in 0029
-- silently reverted 0010's purge escape and 0023's snapshot_id and calculation_version
-- clauses, which 0030 then had to restore.
--
-- Preserved below, unchanged, and each one is covered by a regression test:
--   * 0010  purge escape on DELETE, so identity.purge_tenant can still erase a tenant
--   * 0006  gross, deduction, tax, net, payable_days, lop_days, status
--   * 0023  taxable_earnings, snapshot_id, calculation_version
--   * 0029  hra_exemption
-- Added here: section_exemption_total.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION payroll.guard_finalized_slip()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A finalized slip can be removed wholesale during an authorised tenant purge, and
    -- never otherwise. History stays honest; it does not become undeletable (0010).
    IF OLD.status = 'finalized' AND coalesce(current_setting('app.purge_mode', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'finalized salary slip % cannot be deleted', OLD.id
        USING ERRCODE = 'restrict_violation',
              HINT = 'Use a reversal or supplementary payroll run; wholesale removal requires a tenant purge.';
    END IF;
    RETURN OLD;
  END IF;

  -- No purge escape hatch for UPDATE: a finalized payslip is never rewritten.
  IF OLD.status = 'finalized' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.gross_amount IS DISTINCT FROM OLD.gross_amount
       OR NEW.deduction_amount IS DISTINCT FROM OLD.deduction_amount
       OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount
       OR NEW.net_amount IS DISTINCT FROM OLD.net_amount
       OR NEW.taxable_earnings IS DISTINCT FROM OLD.taxable_earnings
       -- The reason the taxable earnings are what they are. A finalized payslip whose
       -- explanation could still be edited is not explained at all.
       OR NEW.hra_exemption IS DISTINCT FROM OLD.hra_exemption
       OR NEW.section_exemption_total IS DISTINCT FROM OLD.section_exemption_total
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

-- ---------------------------------------------------------------------------
-- 6. Permissions.
-- ---------------------------------------------------------------------------

INSERT INTO identity.permission (code, description, sensitive) VALUES
  -- Sensitive: a ceiling decides how much tax is withheld from every employee in the tenant
  -- who declares under that section.
  ('tax.exemption_rule.manage', 'Configure section exemption ceilings for a tenant', true)
ON CONFLICT (code) DO UPDATE
  SET description = EXCLUDED.description, sensitive = EXCLUDED.sensitive;
