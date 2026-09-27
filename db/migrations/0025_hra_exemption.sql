-- 0025 HRA exemption under section 10(13A).
--
-- Three things were missing, and none of them is arithmetic.
--
--   1. Nothing said which salary component *is* the basic and which *is* the house rent
--      allowance. The engine would have had to match on a name or a code, and a tenant who
--      calls it "Basic Pay" or "HRA Allowance" would silently get no exemption.
--   2. Nothing recorded rent. It cannot be inferred from salary, location or bank data, and
--      guessing it would produce a confident wrong number on a real person's payslip.
--   3. Nothing said whether a workplace is in one of the four metros the Act treats
--      differently (50% of basic rather than 40%).

-- ---------------------------------------------------------------------------
-- 1. Components say what they are, not what they are called.
--
-- `statutory_type` already does this for PF, ESI and professional tax. Nothing did it for
-- the ordinary components that statute nonetheless singles out, and HRA exemption needs two
-- of them by name in the legal sense: the basic, which every one of the three limits is
-- measured against, and the allowance itself.
-- ---------------------------------------------------------------------------

ALTER TABLE compensation.salary_component
  ADD COLUMN semantic_role text
    CHECK (semantic_role IS NULL OR semantic_role IN ('basic', 'house_rent_allowance'));

COMMENT ON COLUMN compensation.salary_component.semantic_role IS
  'What this component is in the eyes of the statute, independent of its code or display name. Only roles a statutory rule actually needs are listed; a component with no role is an ordinary earning or deduction.';

-- Backfill for the codes this system has been seeding since 0006. Deliberately narrow: an
-- exact code match, nothing fuzzy. A tenant who named theirs differently sets the role
-- themselves, and until they do their exemption is zero rather than wrong.
--
-- This changes no existing payroll figure. Exemption also requires a rent declaration, and
-- the table those live in is created further down — so on the day this migration runs, every
-- employee's exemption is zero exactly as it was before.
UPDATE compensation.salary_component SET semantic_role = 'basic'
 WHERE code = 'BASIC' AND semantic_role IS NULL;
UPDATE compensation.salary_component SET semantic_role = 'house_rent_allowance'
 WHERE code = 'HRA' AND semantic_role IS NULL;

-- Finding the basic in a structure is a per-calculation lookup, and structures are small,
-- but the role is also how an administration screen lists "which component is the basic".
CREATE INDEX idx_salary_component_semantic_role
  ON compensation.salary_component (tenant_id, semantic_role)
  WHERE semantic_role IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Metro classification belongs to the workplace, explicitly.
--
-- The Act names Delhi, Mumbai, Kolkata and Chennai. It does not name them in a way any
-- database can derive from a free-text address, and a city list compiled in code would be
-- wrong the first time a tenant opened an office in a suburb.
--
-- Default 'non_metro' rather than NULL-and-refuse. The two errors are not symmetric:
-- classifying a metro as non-metro under-states the exemption and over-deducts tax, which
-- the employee reclaims when they file; the reverse under-deducts, and under-deduction is
-- the *employer's* liability under section 192. The conservative default is also the one
-- that leaves every existing tenant's figures unchanged.
-- ---------------------------------------------------------------------------

ALTER TABLE core.location
  ADD COLUMN metro_classification text NOT NULL DEFAULT 'non_metro'
    CHECK (metro_classification IN ('metro', 'non_metro'));

COMMENT ON COLUMN core.location.metro_classification IS
  'Whether HRA exemption at this workplace is measured at 50% of basic (metro) or 40% (non-metro). Set by the tenant; defaults to non_metro because over-deducting is recoverable by the employee and under-deducting is the employer''s liability.';

-- ---------------------------------------------------------------------------
-- 3. Rent declarations.
--
-- Effective-dated rather than one figure per year, because rent genuinely changes mid-year:
-- people move, and a lease renews. A year with two declarations produces two segments, each
-- calculated on its own rent, which is the whole reason this is a period-level calculation
-- rather than an annual one.
--
-- Kept separate from compensation.tax_declaration, which is one row per employee per year
-- holding a single declared investment total. Rent has dates, its own proof lifecycle and
-- its own verified amount; folding it into that row's jsonb would make all three
-- unqueryable and would give a mid-year rent change nowhere to go.
-- ---------------------------------------------------------------------------

CREATE TABLE compensation.rent_declaration (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  -- The year the exemption is assessed in. A declaration cannot straddle two tax years:
  -- the exemption is computed per year, so a lease spanning 31 March is two declarations.
  tax_year_id uuid NOT NULL REFERENCES payroll.tax_year(id),

  -- The stretch of the year this rent applies to. Inclusive at both ends.
  period_start date NOT NULL,
  period_end   date NOT NULL,

  monthly_rent numeric(14, 2) NOT NULL CHECK (monthly_rent >= 0),

  -- Where the employee *rents*, which is not always where they work: someone may work in a
  -- satellite town and rent in the metro next to it, or the reverse. Null means the
  -- workplace classification applies.
  metro_classification text
    CHECK (metro_classification IS NULL OR metro_classification IN ('metro', 'non_metro')),

  -- The proof lifecycle, which phase 4 acts on and this phase only records.
  --   declared - the employee has said so; no proof has been examined ("unverified")
  --   verified - proof examined and accepted; verified_monthly_rent is the authority
  --   rejected - proof examined and refused; contributes nothing to the exemption
  status text NOT NULL DEFAULT 'declared'
    CHECK (status IN ('declared', 'verified', 'rejected')),
  verified_monthly_rent numeric(14, 2) CHECK (verified_monthly_rent IS NULL OR verified_monthly_rent >= 0),

  note       text,
  -- No foreign key, matching employee_tax_opening: the actor may be the system.
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rent_declaration_range CHECK (period_end >= period_start),
  -- A verified declaration must say what was verified, and only a verified one may.
  CONSTRAINT rent_declaration_verified_amount CHECK (
    (status = 'verified' AND verified_monthly_rent IS NOT NULL)
    OR (status <> 'verified' AND verified_monthly_rent IS NULL)
  )
);
SELECT app.enable_tenant_rls('compensation.rent_declaration');
SELECT app.add_updated_at_trigger('compensation.rent_declaration');

-- Two declarations covering the same day would make "what rent applied in August" have two
-- answers, and the answer changes how much tax is withheld from a real person. The database
-- settles it, exactly as it does for salary assignments and tax years.
ALTER TABLE compensation.rent_declaration
  ADD CONSTRAINT rent_declaration_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    daterange(period_start, period_end, '[]') WITH &&
  );

CREATE INDEX idx_rent_declaration_employee_year
  ON compensation.rent_declaration (tenant_id, employee_id, tax_year_id, period_start);

COMMENT ON TABLE compensation.rent_declaration IS
  'Rent an employee declares for a stretch of a tax year, for HRA exemption under section 10(13A). Effective-dated because rent changes mid-year, and the exemption is calculated per payroll period on the rent that applied to that period.';

COMMENT ON COLUMN compensation.rent_declaration.status IS
  'declared = stated but unproved (what phase 4 will call unverified), verified = proof accepted, rejected = proof refused. A rejected declaration contributes nothing.';

-- ---------------------------------------------------------------------------
-- 4. Permissions.
-- ---------------------------------------------------------------------------

INSERT INTO identity.permission (code, description, sensitive) VALUES
  -- Sensitive: the rent figure changes how much tax is withheld from someone's pay for the
  -- rest of the year, in the same way an opening balance does.
  ('tax.rent.manage', 'Record and amend rent declarations for HRA exemption', true),
  ('tax.rent.verify', 'Verify or reject rent proof', true)
ON CONFLICT (code) DO UPDATE
  SET description = EXCLUDED.description, sensitive = EXCLUDED.sensitive;
