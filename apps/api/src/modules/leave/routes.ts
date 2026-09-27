import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, created, inTenant, parseBody, parseParams, parseQuery } from '../../http/context.ts';
import { requirePermission, resolveTargetEmployee } from '../../http/auth.ts';
import { audit } from '../../infra/audit.ts';
import { conflict, forbidden, isPgError, notFound, PG_UNIQUE_VIOLATION } from '../../infra/errors.ts';
import { assertCanViewEmployee } from '../core-hr/routes.ts';
import * as leave from './service.ts';
import * as periodJobs from './period-jobs.ts';

const uuid = z.string().uuid();
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const idParam = z.object({ id: uuid });
const today = () => new Date().toISOString().slice(0, 10);

export async function leaveRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/leave/types', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'leave.manage');
      const body = parseBody(
        request,
        z.object({
          name: z.string().min(1).max(120),
          code: z.string().min(1).max(32),
          isPaid: z.boolean().default(true),
          allowHalfDay: z.boolean().default(true),
          allowNegativeBalance: z.boolean().default(false),
          maxNegativeBalance: z.number().min(0).max(365).default(0),
          carryForwardEnabled: z.boolean().default(false),
          maxCarryForward: z.number().min(0).max(365).optional(),
          encashmentEnabled: z.boolean().default(false),
          // false = holidays and weekly offs inside the range are not consumed.
          includeHolidays: z.boolean().default(false),
          requiresApproval: z.boolean().default(true),
          isLop: z.boolean().default(false),
          isCompOff: z.boolean().default(false),
          maxConsecutiveDays: z.number().int().min(1).max(365).optional(),
        }),
      );

      try {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO leave_mgmt.leave_type
             (tenant_id, name, code, is_paid, allow_half_day, allow_negative_balance, max_negative_balance,
              carry_forward_enabled, max_carry_forward, encashment_enabled, include_holidays,
              requires_approval, is_lop, is_comp_off, max_consecutive_days)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING id`,
          [
            tx.tenantId, body.name, body.code, body.isPaid, body.allowHalfDay,
            body.allowNegativeBalance, body.maxNegativeBalance, body.carryForwardEnabled,
            body.maxCarryForward ?? null, body.encashmentEnabled, body.includeHolidays,
            body.requiresApproval, body.isLop, body.isCompOff, body.maxConsecutiveDays ?? null,
          ],
        );
        await audit(tx, {
          entityType: 'leave_type',
          entityId: rows[0]!.id,
          action: 'leave_type.created',
          after: body as Record<string, unknown>,
        });
        return created(reply, { id: rows[0]!.id });
      } catch (err) {
        if (isPgError(err, PG_UNIQUE_VIOLATION)) {
          throw conflict('leave_type_code_taken', `Leave type code ${body.code} already exists`);
        }
        throw err;
      }
    }),
  );

  app.get('/api/leave/types', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'leave.read.self', 'leave.read', 'leave.manage');
      const { rows } = await tx.query(
        `SELECT id, name, code, is_paid, allow_half_day, include_holidays, requires_approval,
                is_lop, carry_forward_enabled, max_carry_forward, max_consecutive_days, status
           FROM leave_mgmt.leave_type WHERE tenant_id = $1 AND status = 'active' ORDER BY name`,
        [tx.tenantId],
      );
      return { leave_types: rows };
    }),
  );

  app.post('/api/leave/allocations', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'leave.manage');
      const body = parseBody(
        request,
        z.object({
          employeeId: uuid,
          leaveTypeId: uuid,
          quantity: z.number().min(0).max(365),
          periodStart: dateString,
          periodEnd: dateString,
          proRateFromJoining: z.boolean().default(false),
          source: z.enum(['policy', 'manual', 'carry_forward', 'comp_off', 'pro_rata']).default('manual'),
          idempotencyKey: z.string().max(120).optional(),
          notes: z.string().max(300).optional(),
        }),
      );
      const result = await leave.allocate(tx, body);
      return created(reply, { id: result.allocationId, quantity: result.quantity });
    }),
  );

  app.get('/api/leave/balance', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const query = parseQuery(
        request,
        z.object({ employeeId: uuid.optional(), asOf: dateString.optional() }),
      );
      const target = resolveTargetEmployee(principal, query.employeeId, {
        self: 'leave.read.self',
        others: 'leave.read',
      });
      if (target.scope === 'others') {
        await assertCanViewEmployee(tx, principal, target.employeeId);
      }
      return {
        employee_id: target.employeeId,
        as_of: query.asOf ?? today(),
        // Always derived from the ledger; there is no stored balance to drift (ADR-006).
        balances: await leave.getBalanceSummary(tx, target.employeeId, query.asOf ?? today()),
      };
    }),
  );

  app.get('/api/leave/ledger', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const query = parseQuery(
        request,
        z.object({
          employeeId: uuid.optional(),
          leaveTypeId: uuid.optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      );
      const target = resolveTargetEmployee(principal, query.employeeId, {
        self: 'leave.read.self',
        others: 'leave.read',
      });
      const { rows } = await tx.query(
        `SELECT l.id, l.entry_type, l.quantity,
                to_char(l.effective_date, 'YYYY-MM-DD') AS effective_date,
                l.source_type, l.source_id, l.notes, l.created_at, lt.code AS leave_type
           FROM leave_mgmt.leave_ledger_entry l
           JOIN leave_mgmt.leave_type lt ON lt.id = l.leave_type_id
          WHERE l.tenant_id = $1 AND l.employee_id = $2
            AND ($3::uuid IS NULL OR l.leave_type_id = $3)
          ORDER BY l.effective_date DESC, l.created_at DESC
          LIMIT $4`,
        [tx.tenantId, target.employeeId, query.leaveTypeId ?? null, query.limit],
      );
      return { entries: rows };
    }),
  );

  app.post('/api/leave/applications', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      const body = parseBody(
        request,
        z.object({
          employeeId: uuid.optional(),
          leaveTypeId: uuid,
          startDate: dateString,
          endDate: dateString,
          startHalfDay: z.boolean().default(false),
          endHalfDay: z.boolean().default(false),
          reason: z.string().max(500).optional(),
        }),
      );

      // Applying for someone else is an HR action, not self-service.
      const target = resolveTargetEmployee(principal, body.employeeId, {
        self: 'leave.apply',
        others: 'leave.manage',
      });

      try {
        const result = await leave.apply(tx, { ...body, employeeId: target.employeeId });
        return created(reply, {
          id: result.id,
          status: result.status,
          quantity: result.quantity,
          excluded_days: result.excludedDays,
          workflow_instance_id: result.workflowInstanceId,
        });
      } catch (err) {
        if (isPgError(err, '23P01')) {
          throw conflict('overlapping_leave', 'This employee already has leave booked for part of that range');
        }
        throw err;
      }
    }),
  );

  app.get('/api/leave/applications', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const query = parseQuery(
        request,
        z.object({
          employeeId: uuid.optional(),
          status: z.string().optional(),
          from: dateString.optional(),
          to: dateString.optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      );
      const target = resolveTargetEmployee(principal, query.employeeId, {
        self: 'leave.read.self',
        others: 'leave.read',
      });
      const { rows } = await tx.query(
        `SELECT la.id, la.employee_id, lt.code AS leave_type, lt.name AS leave_type_name,
                to_char(la.start_date, 'YYYY-MM-DD') AS start_date,
                to_char(la.end_date, 'YYYY-MM-DD') AS end_date,
                la.start_half_day, la.end_half_day, la.quantity, la.status, la.reason,
                la.decided_at, la.decision_note, la.created_at
           FROM leave_mgmt.leave_application la
           JOIN leave_mgmt.leave_type lt ON lt.id = la.leave_type_id
          WHERE la.tenant_id = $1 AND la.employee_id = $2
            AND ($3::text IS NULL OR la.status = $3)
            AND ($4::date IS NULL OR la.end_date >= $4::date)
            AND ($5::date IS NULL OR la.start_date <= $5::date)
          ORDER BY la.start_date DESC
          LIMIT $6`,
        [tx.tenantId, target.employeeId, query.status ?? null, query.from ?? null, query.to ?? null, query.limit],
      );
      return { applications: rows };
    }),
  );

  app.post('/api/leave/applications/:id/cancel', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const params = parseParams(request, idParam);
      const body = parseBody(request, z.object({ reason: z.string().max(300).optional() }));

      const { rows } = await tx.query<{ employee_id: string }>(
        'SELECT employee_id FROM leave_mgmt.leave_application WHERE tenant_id = $1 AND id = $2',
        [tx.tenantId, params.id],
      );
      const application = rows[0];
      if (!application) throw notFound('Leave application');

      // Employees cancel their own; cancelling someone else's needs leave.manage.
      if (application.employee_id !== principal.employeeId) {
        requirePermission(principal, 'leave.manage');
      } else if (!principal.permissions.has('leave.apply')) {
        throw forbidden('You cannot cancel leave');
      }

      await leave.cancel(tx, params.id, body.reason);
      return { id: params.id, status: 'cancelled' };
    }),
  );

  app.post('/api/leave/policies/:id/assign', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'leave.manage');
      const params = parseParams(request, idParam);
      const body = parseBody(
        request,
        z.object({
          employeeId: uuid,
          effectiveFrom: dateString,
          effectiveTo: dateString.optional(),
        }),
      );
      const result = await periodJobs.assignPolicy(tx, { ...body, leavePolicyId: params.id });
      return created(reply, { id: result.id });
    }),
  );

  /**
   * Grants the annual entitlement for a period.
   *
   * Idempotent by period: running it twice does not double-allocate, so a scheduler can
   * retry freely and an operator can rerun without checking first.
   */
  app.post('/api/leave/jobs/accrual', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'leave.run_jobs', 'leave.manage');
      const body = parseBody(
        request,
        z.object({
          periodStart: dateString,
          periodEnd: dateString,
          leaveTypeId: uuid.optional(),
        }),
      );
      const result = await periodJobs.runAccrual(tx, body);
      return {
        job_id: result.jobId,
        employees_processed: result.employeesProcessed,
        units_allocated: result.unitsMoved,
        already_run: result.alreadyRun,
      };
    }),
  );

  app.post('/api/leave/jobs/carry-forward', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'leave.run_jobs', 'leave.manage');
      const body = parseBody(
        request,
        z.object({
          fromPeriodStart: dateString,
          fromPeriodEnd: dateString,
          toPeriodStart: dateString,
          toPeriodEnd: dateString,
        }),
      );
      const result = await periodJobs.runCarryForward(tx, body);
      return {
        job_id: result.jobId,
        employees_processed: result.employeesProcessed,
        units_carried: result.unitsMoved,
        already_run: result.alreadyRun,
      };
    }),
  );

  app.post('/api/leave/encashments', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'leave.manage');
      const body = parseBody(
        request,
        z.object({
          employeeId: uuid,
          leaveTypeId: uuid,
          quantity: z.number().positive().max(365),
          periodStart: dateString,
          periodEnd: dateString,
          salaryComponentId: uuid.optional(),
          payrollDate: dateString.optional(),
        }),
      );
      const result = await periodJobs.requestEncashment(tx, body);
      return created(reply, {
        id: result.id,
        quantity: result.quantity,
        amount: result.amount,
        additional_salary_id: result.additionalSalaryId,
        note: 'Balance is deducted now; the amount is queued as compensation for the next payroll run covering that date.',
      });
    }),
  );

  app.post('/api/leave/adjustments', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'leave.adjust');
      const body = parseBody(
        request,
        z.object({
          employeeId: uuid,
          leaveTypeId: uuid,
          quantity: z.number().refine((v) => v !== 0, 'Adjustment must be non-zero'),
          effectiveDate: dateString,
          reason: z.string().min(3).max(300),
        }),
      );
      await leave.adjust(tx, body);
      return created(reply, { status: 'adjusted', employee_id: body.employeeId, quantity: body.quantity });
    }),
  );
}
