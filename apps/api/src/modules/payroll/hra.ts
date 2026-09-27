import type { TenantTx } from '../../infra/db/pool.ts';
import { audit } from '../../infra/audit.ts';
import { conflict, notFound, unprocessable } from '../../infra/errors.ts';
import { ensureTaxYear } from './tax-year.ts';
import { tenantFinancialYearStart } from './tax-opening.ts';

/**
 * HRA exemption inputs: rent declarations, metro classification, and the forward plan the
 * engine annualises from.
 *
 * The architectural rule this file exists to serve:
 *
 *     HRA exemption = a period-level calculation
 *                   + a tax-year accumulation and projection
 *
 * The exemption is *not* an annual figure divided by twelve, and it is not this month's
 * figure multiplied by twelve. Each payroll period has its own basic, its own allowance and
 * its own rent, and the least-of-three is evaluated against those. The year is then the sum
 * of the periods that have actually been paid plus the periods still to come, each evaluated
 * on the inputs that will actually apply to it.
 *
 * That distinction is not pedantry. An employee who is promoted in July, or who moves house
 * in October, or who joins in September, gets a materially different exemption under the two
 * readings — and the naive one is wrong in a direction that under-deducts, which is the
 * employer's liability under section 192.
 *
 * Node's job here is to resolve *inputs* and freeze them. It deliberately does not compute
 * the exemption: the least-of-three needs basic and HRA as actually paid, which means after
 * percentage resolution and after loss of pay, and both of those already live in the Python
 * engine. Computing them here would be a second implementation of the thing ADR-003 says
 * belongs on the other side of the boundary.
 */

export type MetroClassification = 'metro' | 'non_metro';

export type RentDeclaration = {
  id: string;
  employee_id: string;
  tax_year_id: string;
  period_start: string;
  period_end: string;
  monthly_rent: string;
  metro_classification: MetroClassification | null;
  status: 'declared' | 'verified' | 'rejected';
  verified_monthly_rent: string | null;
  note: string | null;
};

export type RecordRentInput = {
  employeeId: string;
  periodStart: string;
  periodEnd: string;
  monthlyRent: number;
  metroClassification?: MetroClassification;
  note?: string;
};

/**
 * Records a rent declaration for a stretch of a tax year.
 *
 * Refused once a slip overlapping that stretch has been finalized, on the same reasoning as
 * an opening balance (ADR-014): the figure has been acted on, and changing it would make a
 * finalized payslip unexplainable. A correction after that point is a supplementary run.
 */
export async function recordRentDeclaration(
  tx: TenantTx,
  input: RecordRentInput,
): Promise<{ id: string; amended: boolean; taxYearLabel: string }> {
  if (input.periodEnd < input.periodStart) {
    throw unprocessable('invalid_period', 'A rent declaration must end on or after it starts');
  }
  if (input.monthlyRent < 0) {
    throw unprocessable('negative_rent', 'Rent cannot be negative');
  }

  const employee = await tx.query<{ id: string }>(
    'SELECT id FROM core.employee WHERE tenant_id = $1 AND id = $2',
    [tx.tenantId, input.employeeId],
  );
  if (!employee.rows[0]) throw notFound('Employee');

  const fyStartMonth = await tenantFinancialYearStart(tx);
  const year = await ensureTaxYear(tx, input.periodEnd, fyStartMonth);

  // A declaration that straddles 31 March would belong to two years at once, and the
  // exemption is assessed per year. Two declarations, not one.
  if (input.periodStart < year.start_date) {
    throw unprocessable(
      'rent_period_crosses_tax_year',
      `This period starts in ${year.label === '' ? 'an earlier year' : 'a different tax year'}. `
        + `Split it at ${year.start_date}: HRA exemption is assessed per tax year, so a lease `
        + 'spanning the year boundary is two declarations.',
      { tax_year: year.label, tax_year_start: year.start_date, tax_year_end: year.end_date },
    );
  }
  if (year.status === 'closed') {
    throw conflict('tax_year_closed', `Tax year ${year.label} is closed.`);
  }

  const finalized = await tx.query<{ count: string }>(
    `SELECT count(*) AS count
       FROM payroll.salary_slip
      WHERE tenant_id = $1 AND employee_id = $2 AND status = 'finalized'
        AND period_start <= $4::date AND period_end >= $3::date`,
    [tx.tenantId, input.employeeId, input.periodStart, input.periodEnd],
  );
  if (Number(finalized.rows[0]?.count ?? 0) > 0) {
    throw conflict(
      'payroll_already_finalized',
      'A payslip overlapping this period has been finalized. The rent declared for it was used '
        + 'to compute the exemption and can no longer be changed; correct it through a '
        + 'supplementary run.',
    );
  }

  const existing = await tx.query<{ id: string; monthly_rent: string; status: string }>(
    `SELECT id, monthly_rent, status FROM compensation.rent_declaration
      WHERE tenant_id = $1 AND employee_id = $2
        AND period_start = $3::date AND period_end = $4::date`,
    [tx.tenantId, input.employeeId, input.periodStart, input.periodEnd],
  );
  const before = existing.rows[0];

  let id: string;
  try {
    if (before) {
      // Amending resets the proof lifecycle: a figure that has changed has not been proved.
      await tx.query(
        `UPDATE compensation.rent_declaration
            SET monthly_rent = $3, metro_classification = $4, note = $5,
                status = 'declared', verified_monthly_rent = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [tx.tenantId, before.id, input.monthlyRent, input.metroClassification ?? null, input.note ?? null],
      );
      id = before.id;
    } else {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO compensation.rent_declaration
           (tenant_id, employee_id, tax_year_id, period_start, period_end, monthly_rent,
            metro_classification, note, created_by)
         VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9)
         RETURNING id`,
        [
          tx.tenantId, input.employeeId, year.id, input.periodStart, input.periodEnd,
          input.monthlyRent, input.metroClassification ?? null, input.note ?? null,
          tx.actor.userId,
        ],
      );
      id = rows[0]!.id;
    }
  } catch (err) {
    if (isExclusionViolation(err)) {
      throw conflict(
        'rent_declaration_overlaps',
        'Another rent declaration already covers part of this period. Rent for a given day has '
          + 'to have one answer, because it decides how much tax is withheld. Amend or remove '
          + 'the overlapping declaration first.',
        { employee_id: input.employeeId, period_start: input.periodStart, period_end: input.periodEnd },
      );
    }
    throw err;
  }

  await audit(tx, {
    entityType: 'rent_declaration',
    entityId: id,
    action: before ? 'tax.rent.amended' : 'tax.rent.declared',
    before: before ? { monthly_rent: before.monthly_rent, status: before.status } : undefined,
    after: {
      employee_id: input.employeeId,
      tax_year: year.label,
      period: `${input.periodStart}..${input.periodEnd}`,
      monthly_rent: input.monthlyRent,
      metro_classification: input.metroClassification ?? 'from work location',
    },
  });

  return { id, amended: Boolean(before), taxYearLabel: year.label };
}

/**
 * Records the outcome of examining proof.
 *
 * Phase 2 stores the outcome and honours a rejection; it does not yet enforce a cutoff date,
 * which is phase 4. A verified declaration is calculated on its verified amount, because
 * that is the figure someone actually looked at a receipt for.
 */
export async function setRentProofOutcome(
  tx: TenantTx,
  declarationId: string,
  outcome: { status: 'verified' | 'rejected'; verifiedMonthlyRent?: number; note?: string },
): Promise<RentDeclaration> {
  if (outcome.status === 'verified' && outcome.verifiedMonthlyRent === undefined) {
    throw unprocessable(
      'verified_amount_required',
      'Verifying a rent declaration requires the amount that was actually proved',
    );
  }
  if (outcome.status === 'rejected' && outcome.verifiedMonthlyRent !== undefined) {
    throw unprocessable(
      'verified_amount_not_allowed',
      'A rejected declaration has no verified amount',
    );
  }

  const { rows } = await tx.query<RentDeclaration>(
    `UPDATE compensation.rent_declaration
        SET status = $3,
            verified_monthly_rent = $4,
            note = COALESCE($5, note)
      WHERE tenant_id = $1 AND id = $2
      RETURNING id, employee_id, tax_year_id,
                to_char(period_start, 'YYYY-MM-DD') AS period_start,
                to_char(period_end, 'YYYY-MM-DD') AS period_end,
                monthly_rent, metro_classification, status, verified_monthly_rent, note`,
    [
      tx.tenantId, declarationId, outcome.status,
      outcome.status === 'verified' ? outcome.verifiedMonthlyRent : null,
      outcome.note ?? null,
    ],
  );
  const declaration = rows[0];
  if (!declaration) throw notFound('Rent declaration');

  await audit(tx, {
    entityType: 'rent_declaration',
    entityId: declaration.id,
    action: 'tax.rent.proof_reviewed',
    after: {
      employee_id: declaration.employee_id,
      status: declaration.status,
      declared_monthly_rent: declaration.monthly_rent,
      verified_monthly_rent: declaration.verified_monthly_rent,
    },
  });

  return declaration;
}

export async function listRentDeclarations(
  tx: TenantTx,
  filter: { employeeId?: string; taxYearId?: string },
): Promise<RentDeclaration[]> {
  const { rows } = await tx.query<RentDeclaration>(
    `SELECT id, employee_id, tax_year_id,
            to_char(period_start, 'YYYY-MM-DD') AS period_start,
            to_char(period_end, 'YYYY-MM-DD') AS period_end,
            monthly_rent, metro_classification, status, verified_monthly_rent, note
       FROM compensation.rent_declaration
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR employee_id = $2)
        AND ($3::uuid IS NULL OR tax_year_id = $3)
      ORDER BY period_start`,
    [tx.tenantId, filter.employeeId ?? null, filter.taxYearId ?? null],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Snapshot inputs
// ---------------------------------------------------------------------------

/** One stretch of the year over which every HRA input is constant. */
export type HraSegment = {
  /** Inclusive bounds of the stretch, for the audit trail rather than the arithmetic. */
  from: string;
  to: string;
  /** Whole payroll periods in this stretch. The multiplier, and never a guess at 12. */
  periods: number;
  rent_amount: string;
  rent_declaration_id: string | null;
  rent_status: 'declared' | 'verified' | 'rejected' | 'none';
  metro_classification: MetroClassification;
  /** The salary in force, so the engine resolves basic and HRA the same way it does today. */
  base_amount: string;
  components: unknown[];
  salary_assignment_id: string | null;
};

export type HraSnapshot = {
  applicable: boolean;
  reason?: string;
  tax_year_id: string;
  metro_classification: MetroClassification;
  work_location_classification: MetroClassification;
  rent_amount: string;
  rent_declaration_id: string | null;
  rent_status: 'declared' | 'verified' | 'rejected' | 'none';
  rent_declaration_period: { start: string; end: string } | null;
  projection: HraSegment[];
};

type PeriodShape = { periodStart: string; periodEnd: string };

/**
 * Freezes everything the exemption depends on, for this period and for the rest of the year.
 *
 * `rent_amount` is the rent that applied to *this* payroll period. It is not pro-rated for
 * loss of pay: a landlord is not paid by attendance. The basic and the allowance it is
 * measured against are, and the engine takes those from the lines it has already computed —
 * which is how this reuses the existing LOP model rather than becoming a second one.
 *
 * `projection` describes the periods still to come. Each segment carries its own rent, its
 * own classification and its own salary, so a rent that ends in December contributes to nine
 * periods and not to twelve, and a raise in July is projected at the July figure rather than
 * at April's.
 */
export async function buildHraSnapshot(
  tx: TenantTx,
  employeeId: string,
  ctx: {
    taxYearId: string;
    taxYearEnd: string;
    period: PeriodShape;
    /** Periods left in the year including this one, from the phase 1 tax-year model. */
    periodsRemaining: number;
    /** Exit date, so a leaver is not projected past their last day. */
    exitDate: string | null;
    locationClassification: MetroClassification;
  },
): Promise<HraSnapshot> {
  const declarations = await tx.query<{
    id: string;
    period_start: string;
    period_end: string;
    monthly_rent: string;
    verified_monthly_rent: string | null;
    metro_classification: MetroClassification | null;
    status: 'declared' | 'verified' | 'rejected';
  }>(
    `SELECT id, to_char(period_start, 'YYYY-MM-DD') AS period_start,
            to_char(period_end, 'YYYY-MM-DD') AS period_end,
            monthly_rent, verified_monthly_rent, metro_classification, status
       FROM compensation.rent_declaration
      WHERE tenant_id = $1 AND employee_id = $2 AND tax_year_id = $3
      ORDER BY period_start`,
    [tx.tenantId, employeeId, ctx.taxYearId],
  );

  const current = declarations.rows.find(
    (d) => d.period_start <= ctx.period.periodEnd && d.period_end >= ctx.period.periodStart,
  );

  const base: HraSnapshot = {
    applicable: declarations.rows.length > 0,
    tax_year_id: ctx.taxYearId,
    metro_classification: current?.metro_classification ?? ctx.locationClassification,
    work_location_classification: ctx.locationClassification,
    rent_amount: rentOf(current),
    rent_declaration_id: current?.id ?? null,
    rent_status: current?.status ?? 'none',
    rent_declaration_period: current
      ? { start: current.period_start, end: current.period_end }
      : null,
    projection: [],
  };

  if (declarations.rows.length === 0) {
    // Nothing declared. Exemption is zero, and saying *why* on the snapshot is what stops
    // "no exemption" and "we never asked them for rent" looking identical a year later.
    base.reason = 'no rent declared for this tax year';
    return base;
  }

  base.projection = await buildProjection(
    tx,
    employeeId,
    { ...ctx, locationClassification: ctx.locationClassification },
    declarations.rows,
  );
  return base;
}

/**
 * The remaining periods of the year, grouped into stretches where nothing changes.
 *
 * Walks period by period rather than multiplying, which is the entire point. Each future
 * period is asked three questions independently — is this employee still employed, what
 * salary applies, what rent applies — and only then are adjacent periods that answer
 * identically collapsed into one segment, purely to keep the snapshot small.
 */
async function buildProjection(
  tx: TenantTx,
  employeeId: string,
  ctx: {
    taxYearEnd: string;
    period: PeriodShape;
    periodsRemaining: number;
    exitDate: string | null;
    locationClassification: MetroClassification;
  },
  declarations: readonly {
    id: string;
    period_start: string;
    period_end: string;
    monthly_rent: string;
    verified_monthly_rent: string | null;
    metro_classification: MetroClassification | null;
    status: 'declared' | 'verified' | 'rejected';
  }[],
): Promise<HraSegment[]> {
  // Future periods, as the tenant has actually defined them. Falls back to month-shaped
  // periods for the part of the year not laid out yet, matching how the phase 1
  // annualisation counts its divisor — the two must agree or the projection would cover a
  // different number of periods than the tax is divided by.
  const future = await futurePeriods(tx, ctx.period, ctx.taxYearEnd, ctx.periodsRemaining - 1);

  const segments: HraSegment[] = [];
  for (const period of future) {
    // A leaver contributes nothing after their last day, and neither does an unemployed
    // month. Projecting them would exempt income that will never be earned.
    if (ctx.exitDate && period.periodStart > ctx.exitDate) break;

    const assignment = await assignmentAsOf(tx, employeeId, period.periodEnd);
    if (!assignment) continue;

    const declaration = declarations.find(
      (d) => d.period_start <= period.periodEnd && d.period_end >= period.periodStart,
    );
    const rent = rentOf(declaration);
    // A declaration that names no city is calculated at the workplace's classification, the
    // same rule the current period uses. Falling back to a bare 'non_metro' instead would
    // quietly halve the exemption of every metro employee who did not think to state the
    // obvious.
    const classification = declaration?.metro_classification ?? ctx.locationClassification;

    const previous = segments[segments.length - 1];
    if (
      previous
      && previous.rent_amount === rent
      && previous.rent_declaration_id === (declaration?.id ?? null)
      && previous.salary_assignment_id === assignment.salary_assignment_id
      && previous.metro_classification === classification
    ) {
      previous.periods += 1;
      previous.to = period.periodEnd;
      continue;
    }

    segments.push({
      from: period.periodStart,
      to: period.periodEnd,
      periods: 1,
      rent_amount: rent,
      rent_declaration_id: declaration?.id ?? null,
      rent_status: declaration?.status ?? 'none',
      metro_classification: classification,
      base_amount: assignment.base_amount,
      components: assignment.components,
      salary_assignment_id: assignment.salary_assignment_id,
    });
  }

  return segments;
}

/** Rent to calculate on: what was proved if anything was, nothing at all if it was refused. */
function rentOf(
  declaration:
    | { monthly_rent: string; verified_monthly_rent: string | null; status: string }
    | undefined,
): string {
  if (!declaration || declaration.status === 'rejected') return '0';
  return declaration.verified_monthly_rent ?? declaration.monthly_rent;
}

type FuturePeriod = { periodStart: string; periodEnd: string };

/**
 * The periods after this one, up to `limit`.
 *
 * Defined periods first, then month-shaped ones for the remainder of the year. The fallback
 * exists because most tenants create each month's period shortly before running it, so on
 * any given day most of the year is not yet laid out — and a projection that stopped at the
 * last defined period would under-project the exemption and over-deduct tax.
 */
async function futurePeriods(
  tx: TenantTx,
  current: PeriodShape,
  taxYearEnd: string,
  limit: number,
): Promise<FuturePeriod[]> {
  if (limit <= 0) return [];

  const { rows } = await tx.query<FuturePeriod>(
    `SELECT to_char(period_start, 'YYYY-MM-DD') AS "periodStart",
            to_char(period_end, 'YYYY-MM-DD') AS "periodEnd"
       FROM payroll.payroll_period
      WHERE tenant_id = $1 AND period_start > $2::date AND period_end <= $3::date
      ORDER BY period_start
      LIMIT $4`,
    [tx.tenantId, current.periodEnd, taxYearEnd, limit],
  );

  const periods = [...rows];
  let cursor = periods.length > 0 ? periods[periods.length - 1]!.periodEnd : current.periodEnd;
  while (periods.length < limit) {
    const next = monthAfter(cursor);
    if (next.periodStart > taxYearEnd) break;
    periods.push(next);
    cursor = next.periodEnd;
  }
  return periods;
}

/** The calendar month following the one `date` falls in. */
function monthAfter(date: string): FuturePeriod {
  const [y, m] = date.split('-').map(Number);
  const startYear = m === 12 ? y! + 1 : y!;
  const startMonth = m === 12 ? 1 : m! + 1;
  const start = new Date(Date.UTC(startYear, startMonth - 1, 1));
  const end = new Date(Date.UTC(startYear, startMonth, 0));
  return { periodStart: iso(start), periodEnd: iso(end) };
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function assignmentAsOf(
  tx: TenantTx,
  employeeId: string,
  asOf: string,
): Promise<{ salary_assignment_id: string; base_amount: string; components: unknown[] } | null> {
  const { rows } = await tx.query<{
    salary_assignment_id: string;
    base_amount: string;
    salary_structure_id: string;
  }>(
    `SELECT sa.id AS salary_assignment_id, sa.base_amount, sa.salary_structure_id
       FROM compensation.salary_assignment sa
      WHERE sa.tenant_id = $1 AND sa.employee_id = $2
        AND sa.effective_from <= $3::date
        AND (sa.effective_to IS NULL OR sa.effective_to >= $3::date)
      ORDER BY sa.effective_from DESC LIMIT 1`,
    [tx.tenantId, employeeId, asOf],
  );
  const assignment = rows[0];
  if (!assignment) return null;

  const components = await tx.query(
    `SELECT c.code, c.name, c.component_type, c.calculation_type, c.semantic_role,
            c.taxable, c.affects_lop, sc.sequence_no,
            sc.fixed_amount, sc.percentage, sc.percentage_of_code, sc.max_amount
       FROM compensation.salary_structure_component sc
       JOIN compensation.salary_component c ON c.id = sc.salary_component_id
      WHERE sc.tenant_id = $1 AND sc.salary_structure_id = $2 AND c.status = 'active'
      ORDER BY sc.sequence_no`,
    [tx.tenantId, assignment.salary_structure_id],
  );

  return {
    salary_assignment_id: assignment.salary_assignment_id,
    base_amount: assignment.base_amount,
    components: components.rows,
  };
}

function isExclusionViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23P01';
}
