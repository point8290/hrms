import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accepted, authenticate, created, inTenant, parseBody, parseParams, parseQuery } from '../../http/context.ts';
import { requirePermission, resolveTargetEmployee } from '../../http/auth.ts';
import { audit } from '../../infra/audit.ts';
import { conflict, notFound, unprocessable } from '../../infra/errors.ts';
import * as compensation from '../compensation/service.ts';
import { closeCoverage } from '../workforce/close-schedule.ts';
import * as payment from './payment.ts';
import * as payroll from './service.ts';
import * as taxOpening from './tax-opening.ts';
import * as taxYear from './tax-year.ts';
import * as recovery from './run-recovery.ts';
import * as hra from './hra.ts';
import * as exemptions from './exemptions.ts';

const uuid = z.string().uuid();
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const idParam = z.object({ id: uuid });

export async function compensationRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/compensation/components', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'compensation.manage');
      const body = parseBody(
        request,
        z.object({
          code: z.string().min(1).max(32).regex(/^[A-Z0-9_]+$/, 'Use upper case letters, digits and underscores'),
          name: z.string().min(1).max(120),
          componentType: z.enum(['earning', 'deduction']),
          calculationType: z.enum(['fixed', 'percentage', 'formula', 'statutory', 'variable']),
          taxable: z.boolean().default(true),
          statutoryType: z
            .enum(['pf_employee', 'pf_employer', 'esi_employee', 'esi_employer', 'professional_tax', 'income_tax', 'gratuity'])
            .optional(),
          /**
           * What this component is to the statute, independent of what it is called.
           *
           * HRA exemption needs the basic and the allowance by their legal meaning. Without
           * a role the exemption is zero — which is the safe direction, and visible on the
           * payslip as a reason rather than as a silent absence.
           */
          semanticRole: z.enum(['basic', 'house_rent_allowance']).optional(),
          // false keeps the amount whole when there is LOP (typical for reimbursements).
          affectsLop: z.boolean().default(true),
          displayOrder: z.number().int().min(0).default(0),
        }),
      );
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO compensation.salary_component
           (tenant_id, code, name, component_type, calculation_type, taxable, statutory_type,
            semantic_role, affects_lop, display_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          tx.tenantId, body.code, body.name, body.componentType, body.calculationType,
          body.taxable, body.statutoryType ?? null, body.semanticRole ?? null,
          body.affectsLop, body.displayOrder,
        ],
      );
      return created(reply, { id: rows[0]!.id });
    }),
  );

  app.post('/api/compensation/structures', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'compensation.manage');
      const body = parseBody(
        request,
        z.object({
          name: z.string().min(1).max(120),
          effectiveFrom: dateString,
          currency: z.string().length(3).default('INR'),
          components: z
            .array(
              z.object({
                componentId: uuid,
                sequenceNo: z.number().int().min(1),
                fixedAmount: z.number().optional(),
                percentage: z.number().min(0).max(100).optional(),
                // Percentages resolve against another component's code, e.g. HRA = 40% of BASIC.
                percentageOfCode: z.string().max(32).optional(),
                maxAmount: z.number().optional(),
              }),
            )
            .min(1),
        }),
      );

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO compensation.salary_structure (tenant_id, name, version, currency, effective_from, status)
         SELECT $1, $2, COALESCE(MAX(version), 0) + 1, $3, $4, 'active'
           FROM compensation.salary_structure WHERE tenant_id = $1 AND name = $2
         RETURNING id`,
        [tx.tenantId, body.name, body.currency, body.effectiveFrom],
      );
      const structureId = rows[0]!.id;

      for (const component of body.components) {
        await tx.query(
          `INSERT INTO compensation.salary_structure_component
             (tenant_id, salary_structure_id, salary_component_id, sequence_no, fixed_amount,
              percentage, percentage_of_code, max_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            tx.tenantId, structureId, component.componentId, component.sequenceNo,
            component.fixedAmount ?? null, component.percentage ?? null,
            component.percentageOfCode ?? null, component.maxAmount ?? null,
          ],
        );
      }

      await audit(tx, {
        entityType: 'salary_structure',
        entityId: structureId,
        action: 'compensation.structure.created',
        after: { name: body.name, components: body.components.length },
      });

      return created(reply, { id: structureId });
    }),
  );

  /**
   * The salary components defined for this tenant.
   *
   * Added because a structure references components by id, and without a way to read them
   * only the first structure could ever be built from the product — a second one would try to
   * recreate components that already exist and have nowhere to look up what it collided with.
   */
  app.get('/api/compensation/components', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'compensation.read', 'compensation.manage');
      const { rows } = await tx.query(
        `SELECT id, code, name, component_type, calculation_type, taxable, semantic_role
           FROM compensation.salary_component
          WHERE tenant_id = $1
          ORDER BY code`,
        [tx.tenantId],
      );
      return { components: rows };
    }),
  );

  app.get('/api/compensation/structures', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'compensation.read');
      const { rows } = await tx.query(
        `SELECT s.id, s.name, s.version, s.currency, to_char(s.effective_from, 'YYYY-MM-DD') AS effective_from,
                s.status, COUNT(sc.id)::int AS component_count
           FROM compensation.salary_structure s
           LEFT JOIN compensation.salary_structure_component sc ON sc.salary_structure_id = s.id
          WHERE s.tenant_id = $1
          GROUP BY s.id
          ORDER BY s.name, s.version DESC`,
        [tx.tenantId],
      );
      return { structures: rows };
    }),
  );

  app.post('/api/compensation/assignments', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'compensation.manage');
      const body = parseBody(
        request,
        z.object({
          employeeId: uuid,
          salaryStructureId: uuid,
          annualCtc: z.number().min(0),
          baseAmount: z.number().min(0),
          effectiveFrom: dateString,
          reason: z.string().max(300).optional(),
        }),
      );
      const result = await compensation.assign(tx, body);
      return created(reply, { id: result.id, superseded_assignment_id: result.supersededId });
    }),
  );

  app.get('/api/compensation/assignments/:id', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'compensation.read');
      const params = parseParams(request, idParam);
      const query = parseQuery(request, z.object({ asOf: dateString.optional() }));
      const resolved = await compensation.resolveAsOf(
        tx,
        params.id,
        query.asOf ?? new Date().toISOString().slice(0, 10),
      );
      if (!resolved) throw notFound('Salary assignment for this employee and date');
      return resolved;
    }),
  );

  app.post('/api/compensation/additional', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'compensation.manage');
      const body = parseBody(
        request,
        z.object({
          employeeId: uuid,
          salaryComponentId: uuid,
          amount: z.number(),
          payrollDate: dateString,
          kind: z.enum(['one_time', 'arrear', 'bonus', 'incentive', 'recovery']).default('one_time'),
          reason: z.string().max(300).optional(),
          /**
           * Replace the structure component for this period rather than adding to it.
           * Applied before pro-rating, so dependent percentage components follow.
           */
          overwritesStructure: z.boolean().default(false),
        }),
      );
      const result = await compensation.addAdditionalSalary(tx, body);
      return created(reply, { id: result.id, overwrites_structure: body.overwritesStructure });
    }),
  );
}

export async function payrollRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/payroll-periods', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'payroll.run');
      const body = parseBody(
        request,
        z.object({
          companyId: uuid,
          name: z.string().min(1).max(120),
          periodStart: dateString,
          periodEnd: dateString,
          payDate: dateString,
        }),
      );
      const period = await payroll.createPeriod(tx, body);
      return created(reply, {
        id: period.id,
        tax_year: { id: period.taxYear.id, label: period.taxYear.label },
      });
    }),
  );

  app.get('/api/payroll-periods', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'payroll.read');
      // The latest run per period comes back with the list so the UI can reach it.
      // Without this the run detail page is only ever reachable in the moments after
      // starting a run — every finalized period becomes a dead end.
      // Read-only: no schema, guard or calculation semantics are touched here.
      const { rows } = await tx.query(
        `SELECT p.id, p.name, to_char(p.period_start, 'YYYY-MM-DD') AS period_start,
                to_char(p.period_end, 'YYYY-MM-DD') AS period_end,
                to_char(p.pay_date, 'YYYY-MM-DD') AS pay_date, p.status,
                r.id AS latest_run_id, r.status AS latest_run_status
           FROM payroll.payroll_period p
           LEFT JOIN LATERAL (
             SELECT id, status
               FROM payroll.payroll_run
              WHERE tenant_id = p.tenant_id AND payroll_period_id = p.id
              ORDER BY started_at DESC NULLS LAST, id DESC
              LIMIT 1
           ) r ON true
          WHERE p.tenant_id = $1
          ORDER BY p.period_start DESC`,
        [tx.tenantId],
      );
      return { periods: rows };
    }),
  );

  app.post('/api/payroll-runs', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'payroll.run');
      const body = parseBody(
        request,
        z.object({
          payrollPeriodId: uuid,
          runType: z.enum(['regular', 'supplementary', 'off_cycle']).default('regular'),
          employeeIds: z.array(uuid).max(5000).optional(),
          parentRunId: uuid.optional(),
          allowIncompleteAttendance: z.boolean().default(false),
          incompleteAttendanceReason: z.string().min(10).max(500).optional(),
        }),
      );
      const result = await payroll.createRun(tx, body);
      // 202: inputs are frozen and committed; the engine calculates asynchronously.
      return accepted(reply, {
        id: result.id,
        status: result.status,
        employee_count: result.employeeCount,
        skipped: result.skipped,
        attendance_coverage: result.attendanceCoverage,
      });
    }),
  );

  /**
   * Whether attendance has been closed for a period.
   *
   * A payroll administrator can check this before starting a run rather than discovering
   * the refusal, and an operator can see which days a scheduler outage left unevaluated.
   */
  app.get('/api/payroll-periods/:id/attendance-readiness', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'payroll.read', 'attendance.manage');
      const params = parseParams(request, idParam);
      const { rows } = await tx.query<{ period_start: string; period_end: string }>(
        `SELECT to_char(period_start, 'YYYY-MM-DD') AS period_start,
                to_char(period_end, 'YYYY-MM-DD') AS period_end
           FROM payroll.payroll_period WHERE tenant_id = $1 AND id = $2`,
        [tx.tenantId, params.id],
      );
      const period = rows[0];
      if (!period) throw notFound('Payroll period');

      const coverage = await closeCoverage(tx, period.period_start, period.period_end);
      return { period_start: period.period_start, period_end: period.period_end, ...coverage };
    }),
  );

  app.get('/api/payroll-runs/:id', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'payroll.read');
      const params = parseParams(request, idParam);
      const { rows } = await tx.query(
        `SELECT r.id, r.status, r.run_type, r.calculation_version, r.employee_count,
                r.total_gross, r.total_deduction, r.total_net, r.failure_reason,
                r.started_at, r.calculated_at, r.approved_at, r.finalized_at,
                p.name AS period_name,
                to_char(p.period_start, 'YYYY-MM-DD') AS period_start,
                to_char(p.period_end, 'YYYY-MM-DD') AS period_end,
                (SELECT count(*) FROM payroll.payroll_employee pe
                  WHERE pe.payroll_run_id = r.id AND pe.status = 'failed')::int AS failed_count
           FROM payroll.payroll_run r
           JOIN payroll.payroll_period p ON p.id = r.payroll_period_id
          WHERE r.tenant_id = $1 AND r.id = $2`,
        [tx.tenantId, params.id],
      );
      if (!rows[0]) throw notFound('Payroll run');
      return rows[0];
    }),
  );

  app.get('/api/payroll-runs/:id/employees', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'payroll.read');
      const params = parseParams(request, idParam);
      const { rows } = await tx.query(
        `SELECT pe.employee_id, e.employee_code, e.first_name || ' ' || e.last_name AS name,
                pe.status, pe.gross_amount, pe.deduction_amount, pe.tax_amount, pe.net_amount,
                pe.failure_reason, s.id AS salary_slip_id, s.lop_days, s.payable_days
           FROM payroll.payroll_employee pe
           JOIN core.employee e ON e.id = pe.employee_id
           LEFT JOIN payroll.salary_slip s ON s.payroll_employee_id = pe.id
          WHERE pe.tenant_id = $1 AND pe.payroll_run_id = $2
          ORDER BY e.employee_code`,
        [tx.tenantId, params.id],
      );
      return { employees: rows };
    }),
  );

  app.post('/api/payroll-runs/:id/review', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'payroll.run');
      const params = parseParams(request, idParam);
      await payroll.submitForReview(tx, params.id);
      return { id: params.id, status: 'under_review' };
    }),
  );

  app.post('/api/payroll-runs/:id/approve', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'payroll.approve');
      const params = parseParams(request, idParam);
      await payroll.approve(tx, params.id);
      return { id: params.id, status: 'approved' };
    }),
  );

  app.post('/api/payroll-runs/:id/finalize', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      // Separate permission from approval: finalization is the irreversible step.
      requirePermission(principal, 'payroll.finalize');
      const params = parseParams(request, idParam);
      const result = await payroll.finalize(tx, params.id);
      return { id: params.id, status: 'finalized', slips_finalized: result.slipCount };
    }),
  );

  app.post('/api/payroll-runs/:id/recalculate', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'payroll.run');
      const params = parseParams(request, idParam);
      const result = await payroll.recalculate(tx, params.id);
      return accepted(reply, { id: params.id, status: 'calculating', employee_count: result.employeeCount });
    }),
  );

  /**
   * Recovers a run whose calculation stalled.
   *
   * Deliberately not a way to cancel a run that is merely slow: without `force` the call is
   * refused until the run has genuinely made no progress for the threshold, and `force`
   * needs the operational permission and is audited. The run lands in `failed`, which is
   * where the existing retry path already starts.
   */
  app.post('/api/payroll-runs/:id/recover', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'payroll.recover');
      const params = parseParams(request, idParam);
      const body = parseBody(
        request,
        z.object({ force: z.boolean().default(false), reason: z.string().min(3).max(300).optional() }),
      );
      if (body.force && !body.reason) {
        throw unprocessable(
          'override_reason_required',
          'Forcing recovery of a run that may still be calculating requires a reason',
        );
      }
      const result = await recovery.recoverRun(tx, params.id, { force: body.force });
      return {
        id: params.id,
        recovered: result.recovered,
        retryable: !result.exhausted,
        reason: result.reason,
      };
    }),
  );

  /** Runs the sweep would act on, so an operator can look before anything is changed. */
  app.get('/api/payroll-runs/stalled', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'payroll.recover', 'payroll.read');
      return {
        threshold_minutes: recovery.STALL_THRESHOLD_MINUTES,
        max_attempts: recovery.MAX_CALCULATION_ATTEMPTS,
        runs: await recovery.findStalledRuns(tx),
      };
    }),
  );

  app.post('/api/payroll-runs/:id/cancel', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'payroll.run');
      const params = parseParams(request, idParam);
      const body = parseBody(request, z.object({ reason: z.string().min(3).max(300) }));
      await payroll.cancel(tx, params.id, body.reason);
      return { id: params.id, status: 'cancelled' };
    }),
  );

  // ---------------------------------------------------------------- payment

  app.post('/api/payroll-runs/:id/payment-batch', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'payroll.pay');
      const params = parseParams(request, idParam);
      const body = parseBody(
        request,
        z.object({ valueDate: dateString, format: z.enum(['neft', 'csv']).default('neft') }),
      );
      const result = await payment.createBatch(tx, { payrollRunId: params.id, ...body });
      return created(reply, {
        id: result.id,
        batch_number: result.batchNumber,
        employee_count: result.employeeCount,
        total_amount: result.totalAmount,
        // Reported, never silently dropped: these people are owed money.
        excluded: result.excluded,
      });
    }),
  );

  /**
   * Downloads the bank file.
   *
   * Returned inline rather than through a presigned URL: it contains decrypted account
   * numbers, so it is generated on demand for an authorized caller and never persisted to
   * object storage.
   */
  app.get('/api/payment-batches/:id/file', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'payroll.pay');
      const params = parseParams(request, idParam);
      const file = await payment.renderBatchFile(tx, params.id);
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${file.filename}"`)
        .header('cache-control', 'no-store');
      return file.content;
    }),
  );

  app.get('/api/payment-batches', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'payroll.read');
      const { rows } = await tx.query(
        `SELECT b.id, b.batch_number, b.format, to_char(b.value_date, 'YYYY-MM-DD') AS value_date,
                b.employee_count, b.total_amount, b.status, b.excluded, b.settled_at,
                b.settlement_reference, p.name AS period_name
           FROM payroll.payment_batch b
           JOIN payroll.payroll_run r ON r.id = b.payroll_run_id
           JOIN payroll.payroll_period p ON p.id = r.payroll_period_id
          WHERE b.tenant_id = $1
          ORDER BY b.created_at DESC`,
        [tx.tenantId],
      );
      return { batches: rows };
    }),
  );

  app.post('/api/payment-batches/:id/settle', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'payroll.pay');
      const params = parseParams(request, idParam);
      const body = parseBody(
        request,
        z.object({
          reference: z.string().min(1).max(120),
          returned: z
            .array(z.object({ employeeCode: z.string().max(32), reason: z.string().max(300) }))
            .optional(),
        }),
      );
      const result = await payment.recordSettlement(tx, params.id, body);
      return {
        id: params.id,
        settled: result.settled,
        returned: result.returned,
        // Only true when nothing came back; a returned payment means someone is still owed.
        run_marked_paid: result.runPaid,
      };
    }),
  );

  // ---------------------------------------------------------------- tax

  app.put('/api/tax/declarations', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const body = parseBody(
        request,
        z.object({
          employeeId: uuid.optional(),
          financialYear: z.string().regex(/^\d{4}-\d{2}$/, 'Expected a year like 2026-27'),
          regime: z.enum(['old', 'new']),
          declarations: z.record(z.number().nonnegative()).default({}),
        }),
      );
      const target = resolveTargetEmployee(principal, body.employeeId, {
        self: 'tax.declare.self',
        others: 'tax.manage',
      });

      const declared = Object.values(body.declarations).reduce((sum, v) => sum + v, 0);

      const { rows } = await tx.query<{ id: string; status: string }>(
        `INSERT INTO compensation.tax_declaration
           (tenant_id, employee_id, financial_year, regime, declarations, declared_amount, status)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,'submitted')
         ON CONFLICT (tenant_id, employee_id, financial_year) DO UPDATE
           SET regime = EXCLUDED.regime,
               declarations = EXCLUDED.declarations,
               declared_amount = EXCLUDED.declared_amount,
               status = 'submitted'
           WHERE compensation.tax_declaration.status <> 'verified'
         RETURNING id, status`,
        [tx.tenantId, target.employeeId, body.financialYear, body.regime,
         JSON.stringify(body.declarations), declared],
      );

      // A verified declaration is not silently reopened by a resubmission: payroll may
      // already have consumed the verified figure.
      if (!rows[0]) {
        throw conflict('already_verified', 'This declaration has been verified and cannot be changed');
      }

      await audit(tx, {
        entityType: 'tax_declaration',
        entityId: rows[0].id,
        action: 'tax.declaration.submitted',
        after: {
          employee_id: target.employeeId,
          financial_year: body.financialYear,
          regime: body.regime,
          declared,
        },
      });

      return { id: rows[0].id, status: rows[0].status, declared_amount: declared };
    }),
  );

  /**
   * Reading tax declarations.
   *
   * Added because the write and the verify halves of this workflow already existed and were
   * unusable without it: an employee could submit a declaration and never see it again, and a
   * verifier had no way to obtain the id that `POST /api/tax/declarations/:id/verify` needs.
   *
   * Two shapes, with different authorization:
   *
   *   * by employee — the caller's own, or somebody named, on the same self-vs-others rule the
   *     rest of the tax surface uses;
   *   * `scope=review` — the verifier's queue, which requires `tax.manage` outright.
   */
  app.get('/api/tax/declarations', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const query = parseQuery(
        request,
        z.object({
          employeeId: uuid.optional(),
          financialYear: z.string().regex(/^\d{4}-\d{2}$/).optional(),
          status: z.enum(['submitted', 'verified', 'rejected']).optional(),
          scope: z.enum(['self', 'review']).default('self'),
        }),
      );

      if (query.scope === 'review') {
        requirePermission(principal, 'tax.manage');
        const { rows } = await tx.query(
          `SELECT d.id, d.employee_id, d.financial_year, d.regime, d.declarations,
                  d.declared_amount, d.verified_amount, d.status,
                  e.first_name || ' ' || e.last_name AS employee_name,
                  e.employee_code
             FROM compensation.tax_declaration d
             JOIN core.employee e ON e.id = d.employee_id AND e.tenant_id = d.tenant_id
            WHERE d.tenant_id = $1
              AND ($2::text IS NULL OR d.financial_year = $2)
              AND ($3::text IS NULL OR d.status = $3)
            ORDER BY d.status, e.employee_code`,
          [tx.tenantId, query.financialYear ?? null, query.status ?? null],
        );
        return { declarations: rows };
      }

      const target = resolveTargetEmployee(principal, query.employeeId, {
        self: 'tax.declare.self',
        others: 'tax.manage',
      });
      const { rows } = await tx.query(
        `SELECT id, employee_id, financial_year, regime, declarations,
                declared_amount, verified_amount, status
           FROM compensation.tax_declaration
          WHERE tenant_id = $1 AND employee_id = $2
            AND ($3::text IS NULL OR financial_year = $3)
          ORDER BY financial_year DESC`,
        [tx.tenantId, target.employeeId, query.financialYear ?? null],
      );
      return { declarations: rows };
    }),
  );

  app.post('/api/tax/declarations/:id/verify', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'tax.manage');
      const params = parseParams(request, idParam);
      const body = parseBody(
        request,
        z.object({ verifiedAmount: z.number().min(0), note: z.string().max(300).optional() }),
      );

      const { rows } = await tx.query<{ declared_amount: string; employee_id: string }>(
        `UPDATE compensation.tax_declaration
            SET status = 'verified', verified_amount = $3
          WHERE tenant_id = $1 AND id = $2 AND status = 'submitted'
          RETURNING declared_amount, employee_id`,
        [tx.tenantId, params.id, body.verifiedAmount],
      );
      if (!rows[0]) throw notFound('Submitted tax declaration');

      await audit(tx, {
        entityType: 'tax_declaration',
        entityId: params.id,
        action: 'tax.declaration.verified',
        before: { declared: rows[0].declared_amount },
        after: { verified: body.verifiedAmount, note: body.note ?? null },
      });

      return { id: params.id, status: 'verified', verified_amount: body.verifiedAmount };
    }),
  );

  /**
   * The exemption sections configured for a tax year, with their ceilings.
   *
   * Read-only here: a ceiling consumed by a finalized payroll run is never edited, so a
   * change is a new rule version rather than an API call, exactly as for statutory rules
   * (ADR-005).
   */
  app.get('/api/tax/exemption-rules', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'tax.manage', 'tax.declare.self');
      const query = parseQuery(request, z.object({ taxYearId: uuid.optional() }));
      return { exemption_rules: await exemptions.listExemptionRules(tx, query.taxYearId) };
    }),
  );

  /**
   * Declares an amount under one chapter VI-A section for a tax year.
   *
   * One section per call, and one live row per section: amending replaces, and the previous
   * figure lives in the audit trail. A section the tenant has no configured ceiling for is
   * refused here rather than at calculation time, so the employee finds out while they can
   * still do something about it.
   */
  app.put('/api/tax/exemption-declarations', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const body = parseBody(
        request,
        z.object({
          employeeId: uuid.optional(),
          financialYear: z.string().regex(/^\d{4}-\d{2}$/, 'Expected a year like 2026-27'),
          regime: z.enum(['old', 'new']).optional(),
          sectionCode: z.string().min(2).max(16),
          declaredAmount: z.number().min(0),
          note: z.string().max(300).optional(),
        }),
      );
      const target = resolveTargetEmployee(principal, body.employeeId, {
        self: 'tax.declare.self',
        others: 'tax.manage',
      });

      const result = await exemptions.declareSection(tx, {
        ...body,
        employeeId: target.employeeId,
      });
      return {
        id: result.id,
        status: result.amended ? 'amended' : 'recorded',
        section_code: result.sectionCode,
        tax_year: result.taxYearLabel,
        note: 'The statutory ceiling is applied when payroll is calculated, not here.',
      };
    }),
  );

  /**
   * Records the outcome of examining proof: accepted, and for how much, or refused.
   *
   * `tax.proof.verify` rather than the broad `tax.manage`, because this is the step that
   * turns a statement into a deduction. The Employee role holds `tax.declare.self` and
   * neither of these, so nobody can verify their own proof.
   *
   * Accepted late is still accepted: the cutoff decides what an *unproved* declaration is
   * worth, not whether proof may still be examined.
   */
  app.post('/api/tax/exemption-declarations/:id/proof', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'tax.proof.verify');
      const params = parseParams(request, idParam);
      const body = parseBody(
        request,
        z.object({
          status: z.enum(['verified', 'rejected']),
          eligibleAmount: z.number().min(0).optional(),
          reason: z.string().max(300).optional(),
        }),
      );
      const item = await exemptions.setProofOutcome(tx, params.id, body);
      return {
        id: item.id,
        section_code: item.section_code,
        status: item.status,
        previous_status: item.previous_status,
        declared_amount: item.declared_amount,
        eligible_amount: item.verified_amount,
        verified_at: item.verified_at,
        reason: item.proof_outcome_reason,
      };
    }),
  );

  app.get('/api/tax/exemption-declarations', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const query = parseQuery(
        request,
        z.object({ employeeId: uuid.optional(), taxYearId: uuid.optional() }),
      );
      const target = resolveTargetEmployee(principal, query.employeeId, {
        self: 'tax.declare.self',
        others: 'tax.manage',
      });
      return {
        declarations: await exemptions.listDeclarationItems(tx, {
          ...query,
          employeeId: target.employeeId,
        }),
      };
    }),
  );

  /**
   * Rent declared for a stretch of a tax year, for HRA exemption under section 10(13A).
   *
   * Effective-dated rather than one figure per year, because rent genuinely changes: people
   * move, and a lease renews. Each payroll period is then calculated on the rent that
   * applied to it.
   *
   * Sensitive: the figure changes how much tax is withheld from someone's pay for the rest
   * of the year, exactly as an opening balance does.
   */
  app.put('/api/tax/rent-declarations', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'tax.rent.manage');
      const body = parseBody(
        request,
        z.object({
          employeeId: uuid,
          periodStart: dateString,
          periodEnd: dateString,
          monthlyRent: z.number().min(0),
          // Where they rent, which is not always where they work. Omitted means the work
          // location's classification applies.
          metroClassification: z.enum(['metro', 'non_metro']).optional(),
          note: z.string().max(300).optional(),
        }),
      );

      const result = await hra.recordRentDeclaration(tx, body);
      return {
        id: result.id,
        status: result.amended ? 'amended' : 'recorded',
        tax_year: result.taxYearLabel,
        note: 'Frozen into every payroll snapshot from the next run onward.',
      };
    }),
  );

  /**
   * The outcome of examining proof.
   *
   * Phase 2 records it and honours a rejection; the cutoff date that makes an unproved
   * declaration stop counting is phase 4 and is not implemented here.
   */
  app.post('/api/tax/rent-declarations/:id/proof', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'tax.rent.verify');
      const params = parseParams(request, idParam);
      const body = parseBody(
        request,
        z.object({
          status: z.enum(['verified', 'rejected']),
          verifiedMonthlyRent: z.number().min(0).optional(),
          note: z.string().max(300).optional(),
        }),
      );
      const declaration = await hra.setRentProofOutcome(tx, params.id, body);
      return {
        id: declaration.id,
        status: declaration.status,
        verified_monthly_rent: declaration.verified_monthly_rent,
      };
    }),
  );

  app.get('/api/tax/rent-declarations', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const query = parseQuery(
        request,
        z.object({ employeeId: uuid.optional(), taxYearId: uuid.optional() }),
      );
      // An employee may read their own; anything wider needs the management permission.
      const target = resolveTargetEmployee(principal, query.employeeId, {
        self: 'payslip.read.self',
        others: 'tax.rent.manage',
      });
      return {
        rent_declarations: await hra.listRentDeclarations(tx, {
          ...query,
          employeeId: target.employeeId,
        }),
      };
    }),
  );

  /**
   * The tax years this tenant has used.
   *
   * Created on demand by the first period or opening balance that needs one, so this is a
   * report of what exists rather than a thing to be set up in advance.
   */
  app.get('/api/tax/years', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'tax.manage', 'payroll.read');
      return { tax_years: await taxYear.listTaxYears(tx) };
    }),
  );

  /**
   * The date after which an unproved declaration stops reducing tax.
   *
   * Sensitive: moving it changes the withholding of every employee in the year who declared
   * an exemption and has not produced proof.
   */
  app.put('/api/tax/years/:id/proof-cutoff', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'tax.year.manage');
      const params = parseParams(request, idParam);
      const body = parseBody(request, z.object({ proofCutoffDate: dateString.nullable() }));
      const year = await taxYear.setProofCutoff(tx, params.id, body.proofCutoffDate);
      return { id: year.id, label: year.label, proof_cutoff_date: year.proof_cutoff_date };
    }),
  );

  /**
   * Previous-employer taxable income and TDS for the financial year.
   *
   * Sensitive: this figure directly changes how much tax is withheld from someone's pay for
   * the rest of the year, so it needs its own permission and is audited either way.
   */
  app.put('/api/tax/openings', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'tax.opening.manage');
      const body = parseBody(
        request,
        z.object({
          employeeId: uuid,
          financialYear: z.string().regex(/^\d{4}-\d{2}$/, 'Expected a year like 2026-27'),
          openingTaxableEarnings: z.number().min(0),
          openingTds: z.number().min(0),
          source: z.enum(['previous_employer', 'migration', 'correction']).optional(),
          note: z.string().max(300).optional(),
        }),
      );

      const result = await taxOpening.recordOpening(tx, body);
      return {
        id: result.id,
        status: result.amended ? 'amended' : 'recorded',
        note: 'Frozen into every payroll snapshot from the next run onward.',
      };
    }),
  );

  app.get('/api/tax/openings', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const query = parseQuery(
        request,
        z.object({
          employeeId: uuid.optional(),
          financialYear: z.string().regex(/^\d{4}-\d{2}$/).optional(),
        }),
      );
      // An employee may read their own; anything wider needs the management permission.
      const target = resolveTargetEmployee(principal, query.employeeId, {
        self: 'payslip.read.self',
        others: 'tax.opening.manage',
      });
      return { openings: await taxOpening.listOpenings(tx, { ...query, employeeId: target.employeeId }) };
    }),
  );

  /**
   * The statutory rules in force on a date.
   *
   * Read-only: a rule version consumed by a finalized payroll run is never edited, so a
   * change is a new migration, not an API call (ADR-005).
   */
  app.get('/api/tax/statutory-rules', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'tax.manage', 'payroll.read');
      const query = parseQuery(request, z.object({ asOf: dateString.optional() }));
      const { rows } = await tx.query(
        `SELECT rule_type, state_code, version,
                to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
                to_char(effective_to, 'YYYY-MM-DD') AS effective_to,
                CASE WHEN tenant_id IS NULL THEN 'platform' ELSE 'tenant' END AS source,
                rule_config
           FROM payroll.statutory_rule
          WHERE effective_from <= $1::date
            AND (effective_to IS NULL OR effective_to >= $1::date)
          ORDER BY rule_type, state_code NULLS FIRST, version DESC`,
        [query.asOf ?? new Date().toISOString().slice(0, 10)],
      );
      return { rules: rows };
    }),
  );

  app.get('/api/payslips', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const query = parseQuery(request, z.object({ employeeId: uuid.optional() }));
      const target = resolveTargetEmployee(principal, query.employeeId, {
        self: 'payslip.read.self',
        others: 'payroll.read',
      });
      const { rows } = await tx.query(
        `SELECT id, slip_number, to_char(period_start, 'YYYY-MM-DD') AS period_start,
                to_char(period_end, 'YYYY-MM-DD') AS period_end,
                payable_days, lop_days, gross_amount, deduction_amount, tax_amount, net_amount,
                currency, status, document_id, finalized_at
           FROM payroll.salary_slip
          WHERE tenant_id = $1 AND employee_id = $2 AND status = 'finalized'
          ORDER BY period_start DESC`,
        [tx.tenantId, target.employeeId],
      );
      return { payslips: rows };
    }),
  );

  app.get('/api/payslips/:id', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const params = parseParams(request, idParam);
      const { rows } = await tx.query<{ employee_id: string }>(
        'SELECT employee_id FROM payroll.salary_slip WHERE tenant_id = $1 AND id = $2',
        [tx.tenantId, params.id],
      );
      const slip = rows[0];
      if (!slip) throw notFound('Payslip');
      resolveTargetEmployee(principal, slip.employee_id, {
        self: 'payslip.read.self',
        others: 'payroll.read',
      });

      const header = await tx.query(
        `SELECT s.id, s.slip_number, to_char(s.period_start, 'YYYY-MM-DD') AS period_start,
                to_char(s.period_end, 'YYYY-MM-DD') AS period_end,
                s.total_days, s.payable_days, s.lop_days, s.gross_amount, s.deduction_amount,
                s.tax_amount, s.employer_contribution, s.net_amount, s.currency, s.status,
                -- The tax base and the exemption that produced it. An employee asking why
                -- their TDS is what it is gets the answer from their own payslip.
                s.taxable_earnings, s.hra_exemption, s.section_exemption_total,
                s.calculation_version, s.finalized_at,
                e.employee_code, e.first_name || ' ' || e.last_name AS employee_name
           FROM payroll.salary_slip s
           JOIN core.employee e ON e.id = s.employee_id
          WHERE s.tenant_id = $1 AND s.id = $2`,
        [tx.tenantId, params.id],
      );

      const components = await tx.query(
        `SELECT component_code_snapshot AS code, component_name_snapshot AS name,
                component_type, amount, is_statutory, calculation_detail
           FROM payroll.salary_slip_component
          WHERE tenant_id = $1 AND salary_slip_id = $2
          ORDER BY component_type, display_order, component_code_snapshot`,
        [tx.tenantId, params.id],
      );

      return { ...header.rows[0], components: components.rows };
    }),
  );
}
