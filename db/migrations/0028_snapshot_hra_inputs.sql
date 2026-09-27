-- 0028 the snapshot gains an HRA section.
--
-- Numbered 0028 rather than 0026 because 0026 and 0027 were burned: a line-ending fix
-- truncated both files to zero bytes, and the runner recorded two empty migrations as
-- applied before anyone noticed. Their checksums cannot be reclaimed, so the content moved
-- to fresh numbers. The repository already has one such gap at 0012.
--
-- Separate from 0025 because 0025 was already applied and migrations are immutable, and
-- separate in substance too: 0025 added the domain model (what a component *is*, where an
-- employee rents, whether a workplace is a metro), and this adds the place those inputs are
-- frozen for a particular payroll run.
--
-- A column rather than another key inside tax_json. The snapshot's shape is one jsonb per
-- concern, and this is a concern: it carries not only the period's figures but a forward
-- plan — what rent and what salary apply to each *remaining* period of the tax year — which
-- is what makes the annualisation something other than a multiplication.

ALTER TABLE payroll.payroll_input_snapshot
  ADD COLUMN hra_json jsonb NOT NULL DEFAULT '{"applicable": false}'::jsonb;

COMMENT ON COLUMN payroll.payroll_input_snapshot.hra_json IS
  'HRA exemption inputs: the period''s rent, metro classification and tax year, plus a per-segment projection of the remaining periods. The engine reads rent, location and salary from here and never from the live tables.';

-- The default makes every snapshot written before this migration explicit rather than null:
-- those runs had no rent declarations and no exemption, and `applicable: false` says so.
-- Recalculating one of them reproduces exactly the figures it originally produced.
