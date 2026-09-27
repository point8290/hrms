import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, created, inTenant, parseBody, parseParams, parseQuery } from '../../http/context.ts';
import { hasPermission, requirePermission, resolveTargetEmployee } from '../../http/auth.ts';
import { forbidden, notFound } from '../../infra/errors.ts';
import type { TenantTx } from '../../infra/db/pool.ts';
import type { Principal } from '../../http/auth.ts';
import * as coreHr from './service.ts';

const uuid = z.string().uuid();
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const idParam = z.object({ id: uuid });

/**
 * Enforces "who may see this employee".
 *
 * `employee.read` grants the whole directory. A manager without it may still read anyone
 * in their reporting line, resolved recursively so skip-level reports are included.
 */
export async function assertCanViewEmployee(
  tx: TenantTx,
  principal: Principal,
  employeeId: string,
): Promise<void> {
  if (employeeId === principal.employeeId && hasPermission(principal, 'employee.read.self')) return;
  if (hasPermission(principal, 'employee.read')) return;

  if (hasPermission(principal, 'employee.read.team') && principal.employeeId) {
    const { rowCount } = await tx.query(
      `WITH RECURSIVE reports AS (
         SELECT id FROM core.employee WHERE tenant_id = $1 AND manager_employee_id = $2
         UNION
         SELECT e.id FROM core.employee e
           JOIN reports r ON e.manager_employee_id = r.id
          WHERE e.tenant_id = $1
       )
       SELECT 1 FROM reports WHERE id = $3`,
      [tx.tenantId, principal.employeeId, employeeId],
    );
    if (rowCount) return;
  }

  throw forbidden('You do not have access to this employee record');
}

export async function coreHrRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/employees', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'employee.manage');
      const body = parseBody(
        request,
        z.object({
          employeeCode: z.string().min(1).max(32).optional(),
          companyId: uuid,
          branchId: uuid.optional(),
          locationId: uuid.optional(),
          departmentId: uuid.optional(),
          designationId: uuid.optional(),
          managerEmployeeId: uuid.optional(),
          firstName: z.string().min(1).max(80),
          lastName: z.string().min(1).max(80),
          personalEmail: z.string().email().optional(),
          workEmail: z.string().email().optional(),
          phone: z.string().max(24).optional(),
          dateOfBirth: dateString.optional(),
          gender: z.enum(['male', 'female', 'other', 'undisclosed']).optional(),
          employmentType: z.enum(['full_time', 'part_time', 'contract', 'intern']).optional(),
          employmentStatus: z.enum(['onboarding', 'probation', 'active']).optional(),
          joiningDate: dateString,
          userId: uuid.optional(),
        }),
      );
      const result = await coreHr.createEmployee(tx, body);
      return created(reply, { id: result.id, employee_code: result.employeeCode });
    }),
  );

  app.get('/api/employees', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const query = parseQuery(
        request,
        z.object({
          status: z.string().optional(),
          departmentId: uuid.optional(),
          search: z.string().max(80).optional(),
          scope: z.enum(['all', 'team']).default('all'),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      );

      // A caller without directory access is narrowed to their own reporting line
      // rather than being refused outright.
      const teamOnly = query.scope === 'team' || !hasPermission(principal, 'employee.read');
      if (teamOnly && !hasPermission(principal, 'employee.read.team')) {
        requirePermission(principal, 'employee.read');
      }

      const { rows } = await tx.query(
        `WITH RECURSIVE reports AS (
           SELECT id FROM core.employee WHERE tenant_id = $1 AND manager_employee_id = $6
           UNION
           SELECT e.id FROM core.employee e JOIN reports r ON e.manager_employee_id = r.id
            WHERE e.tenant_id = $1
         )
         SELECT e.id, e.employee_code, e.first_name, e.last_name, e.work_email,
                e.employment_status, e.employment_type,
                to_char(e.joining_date, 'YYYY-MM-DD') AS joining_date,
                d.name AS department, dg.name AS designation,
                m.employee_code AS manager_code
           FROM core.employee e
           LEFT JOIN core.department d ON d.id = e.department_id
           LEFT JOIN core.designation dg ON dg.id = e.designation_id
           LEFT JOIN core.employee m ON m.id = e.manager_employee_id
          WHERE e.tenant_id = $1
            AND ($2::text IS NULL OR e.employment_status = $2)
            AND ($3::uuid IS NULL OR e.department_id = $3)
            AND ($4::text IS NULL OR e.first_name || ' ' || e.last_name ILIKE '%' || $4 || '%'
                 OR e.employee_code ILIKE '%' || $4 || '%')
            AND (NOT $5::boolean OR e.id IN (SELECT id FROM reports))
          ORDER BY e.employee_code
          LIMIT $7 OFFSET $8`,
        [
          tx.tenantId,
          query.status ?? null,
          query.departmentId ?? null,
          query.search ?? null,
          teamOnly,
          principal.employeeId,
          query.limit,
          query.offset,
        ],
      );
      return { employees: rows, limit: query.limit, offset: query.offset };
    }),
  );

  app.get('/api/employees/:id', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const params = parseParams(request, idParam);
      await assertCanViewEmployee(tx, principal, params.id);

      const { rows } = await tx.query(
        `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.personal_email, e.work_email,
                e.phone, to_char(e.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, e.gender,
                e.employment_type, e.employment_status,
                to_char(e.joining_date, 'YYYY-MM-DD') AS joining_date,
                to_char(e.confirmation_date, 'YYYY-MM-DD') AS confirmation_date,
                to_char(e.exit_date, 'YYYY-MM-DD') AS exit_date,
                c.name AS company, d.name AS department, dg.name AS designation,
                l.name AS location, e.manager_employee_id,
                m.first_name || ' ' || m.last_name AS manager_name
           FROM core.employee e
           JOIN core.company c ON c.id = e.company_id
           LEFT JOIN core.department d ON d.id = e.department_id
           LEFT JOIN core.designation dg ON dg.id = e.designation_id
           LEFT JOIN core.location l ON l.id = e.location_id
           LEFT JOIN core.employee m ON m.id = e.manager_employee_id
          WHERE e.tenant_id = $1 AND e.id = $2`,
        [tx.tenantId, params.id],
      );
      if (!rows[0]) throw notFound('Employee');
      return rows[0];
    }),
  );

  app.get('/api/employees/:id/employment-history', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const params = parseParams(request, idParam);
      await assertCanViewEmployee(tx, principal, params.id);
      const { rows } = await tx.query(
        `SELECT h.id, h.change_reason,
                to_char(h.effective_from, 'YYYY-MM-DD') AS effective_from,
                to_char(h.effective_to, 'YYYY-MM-DD') AS effective_to,
                h.employment_type, h.employment_status,
                d.name AS department, dg.name AS designation, l.name AS location,
                m.employee_code AS manager_code
           FROM core.employment_history h
           LEFT JOIN core.department d ON d.id = h.department_id
           LEFT JOIN core.designation dg ON dg.id = h.designation_id
           LEFT JOIN core.location l ON l.id = h.location_id
           LEFT JOIN core.employee m ON m.id = h.manager_employee_id
          WHERE h.tenant_id = $1 AND h.employee_id = $2
          ORDER BY h.effective_from DESC`,
        [tx.tenantId, params.id],
      );
      return { history: rows };
    }),
  );

  app.post('/api/employees/:id/lifecycle', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'employee.lifecycle');
      const params = parseParams(request, idParam);
      const body = parseBody(
        request,
        z.object({
          changeReason: z.enum([
            'confirmation', 'promotion', 'transfer', 'demotion', 'manager_change', 'status_change', 'correction',
          ]),
          effectiveFrom: dateString,
          departmentId: uuid.nullable().optional(),
          designationId: uuid.nullable().optional(),
          locationId: uuid.nullable().optional(),
          managerEmployeeId: uuid.nullable().optional(),
          employmentType: z.enum(['full_time', 'part_time', 'contract', 'intern']).optional(),
          employmentStatus: z.enum(['onboarding', 'probation', 'active', 'notice', 'suspended']).optional(),
        }),
      );
      const result = await coreHr.recordLifecycleChange(tx, { employeeId: params.id, ...body });
      return created(reply, { employment_history_id: result.historyId });
    }),
  );

  app.post('/api/employees/:id/separate', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'employee.lifecycle');
      const params = parseParams(request, idParam);
      const body = parseBody(
        request,
        z.object({ exitDate: dateString, reason: z.string().min(3).max(500) }),
      );
      await coreHr.separate(tx, { employeeId: params.id, ...body });
      return { status: 'separated', employee_id: params.id, exit_date: body.exitDate };
    }),
  );

  app.get('/api/employees/:id/bank-account', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const params = parseParams(request, idParam);
      resolveTargetEmployee(principal, params.id, {
        self: 'employee.read.self',
        others: 'employee.bank.read',
      });
      // Only last4 is ever returned: the ciphertext stays in the database.
      const { rows } = await tx.query(
        `SELECT id, account_holder, bank_name, ifsc, account_number_last4,
                to_char(effective_from, 'YYYY-MM-DD') AS effective_from, is_primary
           FROM core.bank_account
          WHERE tenant_id = $1 AND employee_id = $2 AND effective_to IS NULL
          ORDER BY is_primary DESC`,
        [tx.tenantId, params.id],
      );
      return { bank_accounts: rows };
    }),
  );

  app.put('/api/employees/:id/bank-account', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'employee.bank.manage');
      const params = parseParams(request, idParam);
      const body = parseBody(
        request,
        z.object({
          accountHolder: z.string().min(2).max(120),
          accountNumber: z.string().min(6).max(24),
          bankName: z.string().min(2).max(120),
          ifsc: z.string().length(11),
          effectiveFrom: dateString,
        }),
      );
      const result = await coreHr.setBankAccount(tx, { employeeId: params.id, ...body });
      return { id: result.id, account_number_last4: result.last4 };
    }),
  );

  app.put('/api/employees/:id/tax-profile', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'employee.tax.manage');
      const params = parseParams(request, idParam);
      const body = parseBody(
        request,
        z.object({
          taxIdentifier: z.string().max(20).optional(),
          taxRegime: z.enum(['old', 'new']).default('new'),
          uan: z.string().max(20).optional(),
          pfApplicable: z.boolean().default(true),
          esiApplicable: z.boolean().default(false),
          ptStateCode: z.string().max(4).optional(),
          effectiveFrom: dateString,
        }),
      );

      await tx.query(
        `UPDATE core.tax_profile
            SET effective_to = ($3::date - INTERVAL '1 day')::date
          WHERE tenant_id = $1 AND employee_id = $2 AND effective_to IS NULL`,
        [tx.tenantId, params.id, body.effectiveFrom],
      );

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO core.tax_profile
           (tenant_id, employee_id, tax_identifier, tax_regime, uan, pf_applicable, esi_applicable,
            pt_state_code, effective_from)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          tx.tenantId,
          params.id,
          body.taxIdentifier ?? null,
          body.taxRegime,
          body.uan ?? null,
          body.pfApplicable,
          body.esiApplicable,
          body.ptStateCode ?? null,
          body.effectiveFrom,
        ],
      );

      const { audit } = await import('../../infra/audit.ts');
      await audit(tx, {
        entityType: 'tax_profile',
        entityId: rows[0]!.id,
        action: 'employee.tax_profile.updated',
        after: { employee_id: params.id, regime: body.taxRegime, effective_from: body.effectiveFrom },
      });

      return { id: rows[0]!.id };
    }),
  );
}
