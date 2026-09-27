import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, created, inTenant, parseBody, parseParams } from '../../http/context.ts';
import { requirePermission } from '../../http/auth.ts';
import { forbidden, notFound } from '../../infra/errors.ts';
import { roleIdsFor } from '../identity/service.ts';
import * as expense from '../expense/service.ts';
import * as leave from '../leave/service.ts';
import * as workforce from '../workforce/service.ts';
import * as workflow from './service.ts';

const idParam = z.object({ id: z.string().uuid() });

export async function workflowRoutes(app: FastifyInstance): Promise<void> {
  app.put('/api/workflows/:entityType', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'workflow.manage');
      const params = parseParams(request, z.object({ entityType: z.enum(workflow.WORKFLOW_ENTITIES) }));
      const body = parseBody(
        request,
        z.object({
          name: z.string().min(1).max(120),
          steps: z.array(workflow.stepSchema).min(1).max(10),
        }),
      );
      const result = await workflow.upsertDefinition(tx, {
        name: body.name,
        entityType: params.entityType,
        steps: body.steps,
      });
      return created(reply, { id: result.id, version: result.version });
    }),
  );

  app.get('/api/workflows', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'workflow.manage');
      const { rows } = await tx.query(
        `SELECT id, name, entity_type, version, definition, status
           FROM workflow.workflow_definition
          WHERE tenant_id = $1
          ORDER BY entity_type, version DESC`,
        [tx.tenantId],
      );
      return { workflows: rows };
    }),
  );

  /**
   * Delegates approval authority.
   *
   * A user may delegate their own authority; delegating someone else's requires
   * `workflow.manage`, which is the permission that already governs who configures the
   * approval engine. Without that split, anyone could write a row naming a senior colleague
   * as delegator and themselves as delegate — a self-service promotion.
   */
  app.post('/api/workflow-delegations', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      const body = parseBody(
        request,
        z.object({
          delegatorUserId: z.string().uuid().optional(),
          delegateUserId: z.string().uuid(),
          entityTypes: z.array(z.enum(workflow.WORKFLOW_ENTITIES)).min(1),
          startsAt: z.coerce.date(),
          endsAt: z.coerce.date(),
        }),
      );

      const delegator = body.delegatorUserId ?? principal.userId;
      if (delegator !== principal.userId) {
        requirePermission(principal, 'workflow.manage');
      }

      const result = await workflow.createDelegation(tx, {
        delegatorUserId: delegator,
        delegateUserId: body.delegateUserId,
        entityTypes: body.entityTypes,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
      });
      return created(reply, result);
    }),
  );

  app.get('/api/workflow-delegations', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const all = await workflow.listDelegations(tx);
      // Everyone sees the delegations they are party to; seeing the tenant's whole
      // delegation map is an administrative view.
      if (principal.permissions.has('workflow.manage')) return { delegations: all };
      return {
        delegations: all.filter(
          (d) => d.delegator_user_id === principal.userId || d.delegate_user_id === principal.userId,
        ),
      };
    }),
  );

  app.post('/api/workflow-delegations/:id/revoke', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const params = parseParams(request, idParam);
      const existing = (await workflow.listDelegations(tx)).find((d) => d.id === params.id);
      // Absent, or another tenant's: the same answer either way, so an id cannot be probed.
      if (!existing) throw notFound('Delegation');
      if (existing.delegator_user_id !== principal.userId) {
        requirePermission(principal, 'workflow.manage');
      }
      await workflow.revokeDelegation(tx, params.id);
      return { id: params.id, status: 'revoked' };
    }),
  );

  /**
   * Starts a fresh attempt at a rejected request.
   *
   * The rejected instance is untouched — this creates a new one that points back at it, so
   * "why was this refused the first time" remains answerable (PRD s.16.5).
   */
  app.post('/api/workflows/instances/:id/resubmit', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      const params = parseParams(request, idParam);
      if (!principal.employeeId) {
        throw forbidden('Only users linked to an employee record can resubmit a request');
      }
      const result = await workflow.resubmitWorkflow(tx, params.id);
      return created(reply, {
        instance_id: result.instanceId,
        attempt_no: result.attemptNo,
        status: result.status,
        supersedes_instance_id: params.id,
      });
    }),
  );

  /** The approver's inbox: only tasks that are actually theirs and actually next. */
  app.get('/api/approvals', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      if (!principal.employeeId) return { approvals: [] };
      const roleIds = await roleIdsFor(tx, principal.membershipId);
      return { approvals: await workflow.pendingTasksFor(tx, principal.employeeId, roleIds) };
    }),
  );


  /**
   * One approval, with the context needed to decide it.
   *
   * Authorization is assignment, checked in the same query that fetches the row, so a task
   * that is not this person's is indistinguishable from one that does not exist.
   */
  app.get('/api/approvals/:id', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const params = parseParams(request, idParam);
      if (!principal.employeeId) throw notFound('Approval');

      const roleIds = await roleIdsFor(tx, principal.membershipId);
      const detail = await workflow.approvalDetail(tx, params.id, principal.employeeId, roleIds);
      if (!detail) throw notFound('Approval');
      return detail;
    }),
  );
  /**
   * Records a decision and applies it to the underlying business entity in the same
   * transaction. Splitting those would allow an approved leave with no ledger entry.
   */
  app.post('/api/approvals/:id/decision', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const params = parseParams(request, idParam);
      const body = parseBody(
        request,
        z.object({
          decision: z.enum(['approved', 'rejected']),
          note: z.string().max(500).optional(),
        }),
      );

      if (!principal.employeeId) {
        throw forbidden('Only users linked to an employee record can approve requests');
      }

      const roleIds = await roleIdsFor(tx, principal.membershipId);
      const result = await workflow.decide(tx, params.id, body.decision, body.note, principal.employeeId, roleIds);

      if (result.outcome !== 'in_progress') {
        switch (result.entityType) {
          case 'leave_application':
            requirePermission(principal, 'leave.approve');
            await leave.applyWorkflowOutcome(tx, result.entityId, result.outcome, body.note);
            break;
          case 'attendance_correction':
            requirePermission(principal, 'attendance.correct');
            await workforce.finaliseCorrection(tx, result.entityId, result.outcome, body.note);
            break;
          case 'expense_claim':
            requirePermission(principal, 'expense.approve');
            // Manager approval moves the claim to finance review; it does not release money.
            await expense.applyWorkflowOutcome(tx, result.entityId, result.outcome, body.note);
            break;
          default:
            // Other entity types record the decision; their settlement lives in their own
            // module and is wired in when that flow is implemented.
            break;
        }
      }

      return {
        task_id: params.id,
        decision: body.decision,
        entity_type: result.entityType,
        entity_id: result.entityId,
        outcome: result.outcome,
      };
    }),
  );
}
