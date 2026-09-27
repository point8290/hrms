import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, created, inTenant, parseBody, parseParams, parseQuery } from '../../http/context.ts';
import { requirePermission, resolveTargetEmployee } from '../../http/auth.ts';
import { notFound } from '../../infra/errors.ts';
import { roleIdsFor } from '../identity/service.ts';
import * as onboarding from './service.ts';

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });

export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/onboarding/templates', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'onboarding.manage');
      const body = parseBody(
        request,
        z.object({
          name: z.string().min(1).max(120),
          departmentId: uuid.optional(),
          designationId: uuid.optional(),
          employmentType: z.enum(['full_time', 'part_time', 'contract', 'intern']).optional(),
          tasks: z
            .array(
              z.object({
                sequenceNo: z.number().int().min(1),
                title: z.string().min(1).max(200),
                description: z.string().max(1000).optional(),
                category: z
                  .enum(['general', 'document', 'it_asset', 'training', 'bank_details', 'tax_declaration', 'introduction'])
                  .optional(),
                ownerKind: z.enum(['employee', 'reporting_manager', 'hr', 'role']).optional(),
                ownerRoleName: z.string().max(120).optional(),
                // Negative is valid: asset ordering and paperwork happen before day one.
                dueOffsetDays: z.number().int().min(-90).max(365).optional(),
                isMandatory: z.boolean().optional(),
                requiresDocumentType: z.string().max(40).optional(),
              }),
            )
            .min(1)
            .max(60),
        }),
      );
      const result = await onboarding.createTemplate(tx, body);
      return created(reply, { id: result.id, task_count: result.taskCount });
    }),
  );

  app.get('/api/onboarding/templates', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'onboarding.manage', 'onboarding.read');
      const { rows } = await tx.query(
        `SELECT t.id, t.name, t.department_id, t.designation_id, t.employment_type, t.status,
                COUNT(tt.id)::int AS task_count
           FROM recruitment.onboarding_template t
           LEFT JOIN recruitment.onboarding_template_task tt ON tt.template_id = t.id
          WHERE t.tenant_id = $1
          GROUP BY t.id
          ORDER BY t.name`,
        [tx.tenantId],
      );
      return { templates: rows };
    }),
  );

  app.post('/api/onboarding/plans', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'onboarding.manage');
      const body = parseBody(request, z.object({ employeeId: uuid, templateId: uuid.optional() }));
      const result = await onboarding.createPlan(tx, body);
      return created(reply, {
        id: result.id,
        template: result.templateName,
        task_count: result.taskCount,
        // Surfaced rather than hidden: a task nobody owns is a task nobody will chase.
        unresolved_owners: result.unresolvedOwners,
      });
    }),
  );

  app.get('/api/onboarding/plans/:id', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const params = parseParams(request, idParam);
      const header = await tx.query<{ employee_id: string }>(
        `SELECT id, employee_id, template_name, to_char(joining_date, 'YYYY-MM-DD') AS joining_date,
                status, completed_at
           FROM recruitment.onboarding_plan WHERE tenant_id = $1 AND id = $2`,
        [tx.tenantId, params.id],
      );
      const plan = header.rows[0];
      if (!plan) throw notFound('Onboarding plan');

      resolveTargetEmployee(principal, plan.employee_id, {
        self: 'onboarding.read.self',
        others: 'onboarding.read',
      });

      const tasks = await tx.query(
        `SELECT id, sequence_no, title, description, category,
                to_char(due_date, 'YYYY-MM-DD') AS due_date,
                is_mandatory, requires_document_type, status, completed_at, completion_note,
                document_id, due_date < CURRENT_DATE AND status IN ('pending','in_progress') AS overdue
           FROM recruitment.onboarding_task
          WHERE tenant_id = $1 AND plan_id = $2
          ORDER BY sequence_no`,
        [tx.tenantId, params.id],
      );

      return { ...plan, tasks: tasks.rows };
    }),
  );

  app.get('/api/onboarding/plans', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'onboarding.read', 'onboarding.manage');
      const query = parseQuery(request, z.object({ status: z.string().max(20).optional() }));
      const { rows } = await tx.query(
        `SELECT p.id, p.employee_id, e.employee_code, e.first_name || ' ' || e.last_name AS employee_name,
                p.template_name, to_char(p.joining_date, 'YYYY-MM-DD') AS joining_date, p.status,
                COUNT(t.id) FILTER (WHERE t.status IN ('completed','skipped'))::int AS done_count,
                COUNT(t.id)::int AS total_count,
                COUNT(t.id) FILTER (
                  WHERE t.status IN ('pending','in_progress') AND t.due_date < CURRENT_DATE
                )::int AS overdue_count
           FROM recruitment.onboarding_plan p
           JOIN core.employee e ON e.id = p.employee_id
           LEFT JOIN recruitment.onboarding_task t ON t.plan_id = p.id
          WHERE p.tenant_id = $1 AND ($2::text IS NULL OR p.status = $2)
          GROUP BY p.id, e.employee_code, e.first_name, e.last_name
          ORDER BY p.joining_date DESC`,
        [tx.tenantId, query.status ?? null],
      );
      return { plans: rows };
    }),
  );

  /** Tasks waiting on the caller, whether assigned directly or through a role. */
  app.get('/api/onboarding/my-tasks', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      if (!principal.employeeId) return { tasks: [] };
      const roleIds = await roleIdsFor(tx, principal.membershipId);
      return { tasks: await onboarding.tasksFor(tx, principal.employeeId, roleIds) };
    }),
  );

  app.post('/api/onboarding/tasks/:id/complete', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const params = parseParams(request, idParam);
      const body = parseBody(
        request,
        z.object({ note: z.string().max(500).optional(), documentId: uuid.optional() }),
      );

      await assertCanActOnTask(tx, principal, params.id);
      const result = await onboarding.completeTask(tx, params.id, body);
      return { id: params.id, status: 'completed', plan_completed: result.planCompleted };
    }),
  );

  app.post('/api/onboarding/tasks/:id/skip', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'onboarding.manage');
      const params = parseParams(request, idParam);
      const body = parseBody(request, z.object({ reason: z.string().min(3).max(300) }));
      const result = await onboarding.skipTask(tx, params.id, body.reason);
      return { id: params.id, status: 'skipped', plan_completed: result.planCompleted };
    }),
  );
}

/**
 * A task may be completed by its owner, or by anyone who administers onboarding.
 *
 * Checked here rather than in the service so the service stays a pure domain operation and
 * the authorization rule lives next to the other route-level checks.
 */
async function assertCanActOnTask(tx: any, principal: any, taskId: string): Promise<void> {
  if (principal.permissions.has('onboarding.manage')) return;

  const roleIds = await roleIdsFor(tx, principal.membershipId);
  const { rowCount } = await tx.query(
    `SELECT 1 FROM recruitment.onboarding_task
      WHERE tenant_id = $1 AND id = $2
        AND (owner_employee_id = $3 OR owner_role_id = ANY($4::uuid[]))`,
    [tx.tenantId, taskId, principal.employeeId, roleIds],
  );
  if (!rowCount) {
    const { forbidden } = await import('../../infra/errors.ts');
    throw forbidden('This onboarding task is assigned to someone else');
  }
}
