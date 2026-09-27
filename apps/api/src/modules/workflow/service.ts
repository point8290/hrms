import { z } from 'zod';
import type { TenantTx } from '../../infra/db/pool.ts';
import { audit } from '../../infra/audit.ts';
import { emitEvent } from '../../infra/events/outbox.ts';
import { conflict, forbidden, notFound, unprocessable } from '../../infra/errors.ts';

/**
 * Approval engine.
 *
 * Ordered steps, an explicit decision per step, and — since several steps may share a
 * sequence — parallel groups that complete by ALL, ANY or QUORUM. It exists because leave,
 * attendance corrections and payroll review all genuinely need the same behaviour.
 *
 * The additions here were built as extensions of what was already working, not a rewrite,
 * and three existing properties carry most of the weight:
 *
 *   * a running instance is pinned to `definition_version`, so editing a definition never
 *     touches an approval already under way;
 *   * `due_at` is computed when the task is created, so its SLA is frozen at the same moment;
 *   * tasks sharing a `sequence_no` already behaved as ALL, because `settleIfComplete`
 *     advances only when none remain pending at the lowest sequence.
 *
 * So ALL is the default and is literally the old behaviour; ANY and QUORUM settle a group
 * early by cancelling the tasks that can no longer change its outcome, which keeps one rule
 * for "is this group finished" — nothing left pending.
 *
 * Delegation and escalation both widen *who may act*, and neither widens *what may happen*:
 * a delegate acts only where the delegator already had authority, escalation only adds a
 * second permitted approver to an overdue task, and neither lets the requester approve their
 * own request (PRD s.17).
 */

export const WORKFLOW_ENTITIES = [
  'leave_application',
  'expense_claim',
  'attendance_correction',
  'employee_change',
  'payroll_run',
  'separation',
] as const;

export type WorkflowEntity = (typeof WORKFLOW_ENTITIES)[number];

/** How a group of steps sharing one sequence completes. */
export const GROUP_MODES = ['all', 'any', 'quorum'] as const;
export type GroupMode = (typeof GROUP_MODES)[number];

/**
 * An approver reference, used for steps and for fallback and escalation targets.
 *
 * The same three kinds everywhere, so a fallback is resolved by the same code and subject to
 * the same "does this actually exist in this tenant" check as a step approver. PRD s.16.7
 * forbids silently choosing an administrator; the way to honour that is to make fallback an
 * ordinary configured target that fails loudly when it does not resolve.
 */
export const approverRefSchema = z.object({
  approver: z.enum(['reporting_manager', 'role', 'employee']),
  role_name: z.string().min(1).optional(),
  employee_id: z.string().uuid().optional(),
});

export const stepSchema = z.object({
  sequence: z.number().int().positive(),
  /** reporting_manager resolves to the subject employee's manager at start time. */
  approver: z.enum(['reporting_manager', 'role', 'employee']),
  role_name: z.string().optional(),
  employee_id: z.string().uuid().optional(),
  sla_hours: z.number().int().positive().optional(),
  /** Skips this step instead of stalling when no approver can be resolved. */
  skip_if_unresolved: z.boolean().default(false),

  /**
   * Completion policy for the sequence this step belongs to.
   *
   * Absent means `all`, which is exactly what steps sharing a sequence already did before
   * this existed: `settleIfComplete` advances only when no task remains pending at the
   * lowest sequence. Every definition written before this field keeps behaving identically.
   *
   * Declared per step rather than in a separate group object so there is one definition
   * model, not two; steps sharing a sequence must agree, which is validated below.
   */
  mode: z.enum(GROUP_MODES).optional(),
  quorum: z.number().int().optional(),

  /** Used when the step's own approver cannot be resolved. */
  fallback: approverRefSchema.optional(),
  /** Gains authority over this task once it is overdue. Requires `sla_hours`. */
  escalate_to: approverRefSchema.optional(),
});

export const definitionSchema = z.object({
  steps: z.array(stepSchema).min(1),
});

export type ApproverRef = z.infer<typeof approverRefSchema>;

/**
 * Rejects definitions that are internally inconsistent, at write time.
 *
 * Group policy is per sequence, but declared per step, so the steps in a sequence have to
 * agree — otherwise "is this group ANY or ALL" would depend on which row was read first.
 * Quorum is checked against the number of steps in its own group, which is the only place
 * that number is knowable.
 */
export function validateDefinition(steps: readonly WorkflowStep[]): void {
  const groups = new Map<number, WorkflowStep[]>();
  for (const step of steps) {
    const group = groups.get(step.sequence) ?? [];
    group.push(step);
    groups.set(step.sequence, group);
  }

  for (const [sequence, group] of groups) {
    const modes = new Set(group.map((s) => s.mode ?? 'all'));
    if (modes.size > 1) {
      throw unprocessable(
        'workflow_group_mode_conflict',
        `Steps at sequence ${sequence} disagree about the completion mode (${[...modes].join(', ')}). ` +
          'Every step in a parallel group must declare the same mode.',
      );
    }
    const mode = [...modes][0]!;
    const quorums = new Set(group.map((s) => s.quorum).filter((q) => q !== undefined));

    if (mode === 'quorum') {
      if (quorums.size !== 1) {
        throw unprocessable(
          'workflow_quorum_required',
          `Sequence ${sequence} uses quorum mode but does not declare a single quorum value.`,
        );
      }
      const quorum = [...quorums][0]!;
      if (quorum <= 0) {
        throw unprocessable('workflow_quorum_invalid', `Sequence ${sequence} has a quorum of ${quorum}.`);
      }
      if (quorum > group.length) {
        throw unprocessable(
          'workflow_quorum_unreachable',
          `Sequence ${sequence} needs ${quorum} approvals but has only ${group.length} approver(s), ` +
            'so it could never complete.',
        );
      }
    } else if (quorums.size > 0) {
      // A quorum on an ANY or ALL group is not a harmless extra: it means the author
      // believed the group counts approvals when it does not.
      throw unprocessable(
        'workflow_quorum_not_applicable',
        `Sequence ${sequence} is "${mode}" mode and must not declare a quorum.`,
      );
    }

    for (const step of group) {
      if (step.escalate_to && !step.sla_hours) {
        throw unprocessable(
          'workflow_escalation_without_sla',
          `Sequence ${sequence} configures an escalation target but no sla_hours, so nothing could ever ` +
            'make it overdue.',
        );
      }
      for (const [label, ref] of [['fallback', step.fallback], ['escalate_to', step.escalate_to]] as const) {
        if (!ref) continue;
        if (ref.approver === 'role' && !ref.role_name) {
          throw unprocessable('workflow_target_invalid', `Sequence ${sequence} ${label} names no role.`);
        }
        if (ref.approver === 'employee' && !ref.employee_id) {
          throw unprocessable('workflow_target_invalid', `Sequence ${sequence} ${label} names no employee.`);
        }
      }
    }
  }
}

export type WorkflowStep = z.infer<typeof stepSchema>;

export type WorkflowOutcome = 'in_progress' | 'approved' | 'rejected';

export type StartResult = {
  instanceId: string | null;
  status: WorkflowOutcome;
};

/**
 * Starts the active workflow for an entity.
 *
 * Returns `{ instanceId: null, status: 'approved' }` when the tenant has configured no
 * workflow for this entity type — auto-approval is an explicit, visible outcome rather
 * than a silent skip, and the caller decides whether that is acceptable.
 */
export async function startWorkflow(
  tx: TenantTx,
  entityType: WorkflowEntity,
  entityId: string,
  subjectEmployeeId: string,
  options?: { supersedesInstanceId?: string; attemptNo?: number },
): Promise<StartResult> {
  const { rows } = await tx.query<{ id: string; version: number; definition: unknown }>(
    `SELECT id, version, definition
       FROM workflow.workflow_definition
      WHERE tenant_id = $1 AND entity_type = $2 AND status = 'active'
      ORDER BY version DESC
      LIMIT 1`,
    [tx.tenantId, entityType],
  );

  const definitionRow = rows[0];
  if (!definitionRow) return { instanceId: null, status: 'approved' };

  const parsed = definitionSchema.safeParse(definitionRow.definition);
  if (!parsed.success) {
    throw unprocessable(
      'workflow_definition_invalid',
      `Workflow definition for ${entityType} is malformed and cannot be started`,
    );
  }

  const steps = [...parsed.data.steps].sort((a, b) => a.sequence - b.sequence);

  validateDefinition(steps);

  const instance = await tx.query<{ id: string }>(
    `INSERT INTO workflow.workflow_instance
       (tenant_id, definition_id, definition_version, entity_type, entity_id, subject_employee_id,
        current_sequence, initiated_by_user_id, supersedes_instance_id, attempt_no)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      tx.tenantId, definitionRow.id, definitionRow.version, entityType, entityId, subjectEmployeeId,
      steps[0]!.sequence, tx.actor.userId ?? null,
      options?.supersedesInstanceId ?? null, options?.attemptNo ?? 1,
    ],
  );
  const instanceId = instance.rows[0]!.id;

  for (const step of steps) {
    let approver = await resolveApprover(tx, step, subjectEmployeeId);
    let fallbackReason: string | null = null;

    // Fallback, only on the trigger the workflow model can actually observe today: the
    // step's own approver did not resolve. PRD s.16.7 — never silently an administrator,
    // always a configured target, and always with the reason recorded.
    if (!approver && step.fallback) {
      approver = await resolveTarget(tx, step.fallback, subjectEmployeeId);
      if (!approver) {
        throw unprocessable(
          'workflow_fallback_unresolved',
          `Workflow step ${step.sequence} has no approver and its configured fallback does not resolve ` +
            'in this tenant either. The workflow is blocked until the definition is corrected.',
        );
      }
      fallbackReason = 'approver_unresolved';
    }

    if (!approver && !step.skip_if_unresolved) {
      throw unprocessable(
        'approver_unresolved',
        `Workflow step ${step.sequence} has no approver. Assign a reporting manager or fix the workflow definition.`,
      );
    }

    const task = await tx.query<{ id: string }>(
      `INSERT INTO workflow.approval_task
         (tenant_id, workflow_instance_id, sequence_no, approver_employee_id, approver_role_id, status,
          due_at, group_mode, group_quorum, is_fallback, fallback_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        tx.tenantId,
        instanceId,
        step.sequence,
        approver?.employeeId ?? null,
        approver?.roleId ?? null,
        approver ? 'pending' : 'skipped',
        // Frozen here, from this definition version. A later edit cannot move it.
        step.sla_hours ? new Date(Date.now() + step.sla_hours * 3_600_000) : null,
        step.mode ?? 'all',
        step.mode === 'quorum' ? (step.quorum ?? null) : null,
        fallbackReason !== null,
        fallbackReason,
      ],
    );

    if (fallbackReason) {
      await audit(tx, {
        entityType: 'workflow_instance',
        entityId: instanceId,
        action: 'workflow.fallback_activated',
        metadata: {
          task_id: task.rows[0]!.id,
          sequence: step.sequence,
          reason: fallbackReason,
          configured_approver: step.approver,
          fallback_approver: step.fallback?.approver,
        },
      });

      // Same transaction as the task it describes, so an approver substitution can never be
      // announced without having happened, or happen without being announced (ADR-004).
      await emitEvent(tx, 'WorkflowFallbackActivated', {
        aggregateType: 'workflow_instance',
        aggregateId: instanceId,
        payload: {
          workflow_instance_id: instanceId,
          task_id: task.rows[0]!.id,
          entity_type: entityType,
          sequence: step.sequence,
          reason: fallbackReason,
        },
      });
    }
  }

  // Every step skipped means nobody has to act; settle immediately rather than leaving
  // an instance that can never complete.
  const settled = await settleIfComplete(tx, instanceId);
  return { instanceId, status: settled ?? 'in_progress' };
}

type ResolvedApprover = { employeeId?: string; roleId?: string };

async function resolveApprover(
  tx: TenantTx,
  step: WorkflowStep,
  subjectEmployeeId: string,
): Promise<ResolvedApprover | null> {
  return resolveTarget(tx, step, subjectEmployeeId);
}

/**
 * Resolves an approver reference against this tenant.
 *
 * Shared by steps, fallbacks and escalation targets so all three are subject to the same
 * check: an employee id from another tenant, or a role name that does not exist here, does
 * not resolve. That is the authorization check PRD s.16.7 asks for on fallback selection —
 * every lookup is tenant-scoped and RLS applies underneath.
 */
async function resolveTarget(
  tx: TenantTx,
  ref: ApproverRef | WorkflowStep,
  subjectEmployeeId: string,
): Promise<ResolvedApprover | null> {
  if (ref.approver === 'employee') {
    if (!ref.employee_id) return null;
    const { rows } = await tx.query<{ id: string }>(
      "SELECT id FROM core.employee WHERE tenant_id = $1 AND id = $2 AND employment_status <> 'separated'",
      [tx.tenantId, ref.employee_id],
    );
    return rows[0] ? { employeeId: rows[0].id } : null;
  }

  if (ref.approver === 'reporting_manager') {
    // An inactive manager is not an approver. Resolving to one would leave a task nobody
    // can action, which is the unresolved case the fallback exists for.
    const { rows } = await tx.query<{ manager_employee_id: string | null }>(
      `SELECT e.manager_employee_id
         FROM core.employee e
         JOIN core.employee m ON m.id = e.manager_employee_id AND m.tenant_id = e.tenant_id
        WHERE e.tenant_id = $1 AND e.id = $2 AND m.employment_status <> 'separated'`,
      [tx.tenantId, subjectEmployeeId],
    );
    const managerId = rows[0]?.manager_employee_id;
    return managerId ? { employeeId: managerId } : null;
  }

  if (!ref.role_name) return null;
  const { rows } = await tx.query<{ id: string }>(
    'SELECT id FROM identity.role WHERE tenant_id = $1 AND name = $2',
    [tx.tenantId, ref.role_name],
  );
  return rows[0] ? { roleId: rows[0].id } : null;
}

type DelegatedAuthority = { delegationId: string; delegatorUserId: string };

/**
 * Finds an active delegation that would let this user act on this task.
 *
 * Precedence, and the order matters (PRD s.16.6): direct assignment and escalation are
 * checked by the caller first, and this is consulted only if neither applies. A delegation
 * confers nothing of its own — it is a claim that *the delegator* could have decided this
 * task, so the delegator's own authority is re-derived here and tested against the task
 * exactly as the delegate's would have been. A delegation from someone with no authority
 * over the task grants no authority over the task.
 *
 * Time bounds are evaluated in the database against `now()`, so an expired or not-yet-started
 * delegation simply does not match; there is no status to keep in step with the clock.
 */
async function findDelegatedAuthority(
  tx: TenantTx,
  actingUserId: string | null,
  entityType: WorkflowEntity,
  task: { approver_employee_id: string | null; approver_role_id: string | null },
): Promise<DelegatedAuthority | null> {
  if (!actingUserId) return null;

  const { rows } = await tx.query<{
    id: string;
    delegator_user_id: string;
    delegator_employee_id: string | null;
    delegator_role_ids: string[] | null;
  }>(
    `SELECT d.id,
            d.delegator_user_id,
            e.id AS delegator_employee_id,
            ARRAY(
              SELECT mr.role_id
                FROM identity.tenant_membership tm
                JOIN identity.membership_role mr
                  ON mr.membership_id = tm.id AND mr.tenant_id = tm.tenant_id
               WHERE tm.tenant_id = d.tenant_id
                 AND tm.user_id = d.delegator_user_id
                 AND tm.status = 'active'
            ) AS delegator_role_ids
       FROM workflow.workflow_delegation d
       LEFT JOIN core.employee e
              ON e.tenant_id = d.tenant_id AND e.user_id = d.delegator_user_id
      WHERE d.tenant_id = $1
        AND d.delegate_user_id = $2
        AND d.status = 'active'
        AND d.starts_at <= now()
        AND d.ends_at   >  now()
        AND $3 = ANY(d.entity_types)`,
    [tx.tenantId, actingUserId, entityType],
  );

  for (const row of rows) {
    const byEmployee =
      task.approver_employee_id !== null && task.approver_employee_id === row.delegator_employee_id;
    const byRole =
      task.approver_role_id !== null && (row.delegator_role_ids ?? []).includes(task.approver_role_id);
    if (byEmployee || byRole) {
      return { delegationId: row.id, delegatorUserId: row.delegator_user_id };
    }
  }
  return null;
}

export type Decision = 'approved' | 'rejected';

export type DecisionResult = {
  entityType: WorkflowEntity;
  entityId: string;
  outcome: WorkflowOutcome;
};

/**
 * Records one approver's decision.
 *
 * A rejection ends the whole instance: subsequent approvers are cancelled rather than
 * left pending, so an approvals inbox never shows work on a decided request.
 */
export async function decide(
  tx: TenantTx,
  taskId: string,
  decision: Decision,
  note: string | undefined,
  approverEmployeeId: string | null,
  approverRoleIds: readonly string[],
): Promise<DecisionResult> {
  const { rows } = await tx.query<{
    id: string;
    workflow_instance_id: string;
    sequence_no: number;
    approver_employee_id: string | null;
    approver_role_id: string | null;
    status: string;
    instance_status: string;
    current_sequence: number;
    entity_type: WorkflowEntity;
    entity_id: string;
    escalated_to_employee_id: string | null;
    initiated_by_user_id: string | null;
    subject_employee_id: string | null;
  }>(
    // Two locks, and both are load-bearing.
    //
    // `t` makes two simultaneous decisions on the *same task* safe: the second waits, then
    // re-reads a row that is no longer pending and is refused.
    //
    // `i` makes simultaneous decisions on *different tasks of one instance* safe, which is
    // the harder case and is not hypothetical — a parallel group is precisely a design where
    // several people are expected to decide at once. Without it each transaction counts the
    // group under READ COMMITTED and sees only its own approval: with a quorum of two and
    // three approvers deciding together, every transaction sees one approval, none settles
    // the group, and the instance ends with every task approved and its own status still
    // `in_progress`. Locking the instance serialises deciders on the same aggregate, so each
    // one's arithmetic runs against the previous one's committed effect.
    `SELECT t.id, t.workflow_instance_id, t.sequence_no, t.approver_employee_id, t.approver_role_id,
            t.status, t.escalated_to_employee_id,
            i.status AS instance_status, i.current_sequence, i.entity_type, i.entity_id,
            i.initiated_by_user_id, i.subject_employee_id
       FROM workflow.approval_task t
       JOIN workflow.workflow_instance i ON i.id = t.workflow_instance_id
      WHERE t.tenant_id = $1 AND t.id = $2
      FOR UPDATE OF t, i`,
    [tx.tenantId, taskId],
  );

  const task = rows[0];
  if (!task) throw notFound('Approval task');
  if (task.instance_status !== 'in_progress') {
    throw conflict('workflow_settled', 'This request has already been decided');
  }
  if (task.status !== 'pending') {
    throw conflict('task_settled', 'This approval task has already been actioned');
  }
  if (task.sequence_no !== task.current_sequence) {
    throw conflict('not_your_turn', 'An earlier approval step is still outstanding');
  }

  // A rejection ends someone's request. It has to say why (PRD s.16.4), and a blank or
  // whitespace note is not a reason. The database carries the same rule for new rows.
  const reason = note?.trim() ?? '';
  if (decision === 'rejected' && reason === '') {
    throw unprocessable('rejection_reason_required', 'A rejection must include a reason');
  }

  // Maker-checker, before authority is even considered, and no delegation changes it
  // (s.16.6, "delegation is not an authorization grant").
  //
  // Scoped to the *requester*, which is precisely what the PRD establishes: s.17 "A requester
  // cannot approve their own request when maker-checker is enabled", s.2.7 "a user who
  // creates a correction must not automatically be able to approve the same correction",
  // s.35 mutation 4 "allow requester self-approval", s.41 "no self-approval when
  // maker-checker applies".
  //
  // An earlier version also barred the *subject* of the request. Nothing in the PRD
  // establishes that — the word "subject" appears in it exactly once, about email subject
  // lines — so it was an invented rule and has been removed. In practice the two usually
  // coincide, because the person who raises a leave or expense request is also its subject;
  // where they differ (HR raising a change about someone else) the PRD's rule is the
  // requester's, and widening it is a product decision rather than an implementation one.
  const actingUserId = tx.actor.userId ?? null;
  if (actingUserId !== null && task.initiated_by_user_id === actingUserId) {
    throw forbidden('You cannot approve a request you raised yourself');
  }

  const direct =
    (task.approver_employee_id !== null && task.approver_employee_id === approverEmployeeId) ||
    (task.approver_role_id !== null && approverRoleIds.includes(task.approver_role_id));

  // Escalation widens who may act on an overdue task; it never decides one.
  const byEscalation =
    task.escalated_to_employee_id !== null && task.escalated_to_employee_id === approverEmployeeId;

  // Delegation is checked last and only grants what the delegator already had.
  const delegated = direct || byEscalation
    ? null
    : await findDelegatedAuthority(tx, actingUserId, task.entity_type, task);

  if (!direct && !byEscalation && !delegated) {
    throw forbidden('This approval task is assigned to someone else');
  }

  await tx.query(
    `UPDATE workflow.approval_task
        SET status = $3, decision_note = $4, decided_by = $5, decided_at = now(),
            decided_on_behalf_of_user_id = $6, delegation_id = $7
      WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
    [
      tx.tenantId, taskId, decision, reason === '' ? (note ?? null) : reason, actingUserId,
      delegated?.delegatorUserId ?? null, delegated?.delegationId ?? null,
    ],
  );

  await audit(tx, {
    entityType: 'workflow_instance',
    entityId: task.workflow_instance_id,
    action: decision === 'approved' ? 'workflow.approved' : 'workflow.rejected',
    metadata: {
      task_id: taskId,
      sequence: task.sequence_no,
      decision,
      reason: decision === 'rejected' ? reason : undefined,
      acted_via: delegated ? 'delegation' : byEscalation ? 'escalation' : 'direct',
      on_behalf_of_user_id: delegated?.delegatorUserId,
      delegation_id: delegated?.delegationId,
    },
  });

  if (decision === 'rejected') {
    // For ALL — the default, and every definition written before group modes existed — one
    // rejection ends the instance, unchanged. For ANY and QUORUM a rejection is only
    // decisive once the group can no longer be satisfied; until then the remaining
    // approvers can still carry it.
    if (!(await groupIsUnsatisfiable(tx, task.workflow_instance_id, task.sequence_no))) {
      const outcome = await settleIfComplete(tx, task.workflow_instance_id);
      return {
        entityType: task.entity_type,
        entityId: task.entity_id,
        outcome: outcome ?? 'in_progress',
      };
    }

    await tx.query(
      `UPDATE workflow.approval_task
          SET status = 'cancelled'
        WHERE tenant_id = $1 AND workflow_instance_id = $2 AND status = 'pending'`,
      [tx.tenantId, task.workflow_instance_id],
    );
    await tx.query(
      `UPDATE workflow.workflow_instance
          SET status = 'rejected', completed_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, task.workflow_instance_id],
    );
    await emitInstanceOutcome(tx, task.workflow_instance_id, task.entity_type, task.entity_id, 'rejected');
    return { entityType: task.entity_type, entityId: task.entity_id, outcome: 'rejected' };
  }

  const outcome = await settleIfComplete(tx, task.workflow_instance_id);
  if (outcome === 'approved') {
    await emitInstanceOutcome(tx, task.workflow_instance_id, task.entity_type, task.entity_id, 'approved');
  }
  return {
    entityType: task.entity_type,
    entityId: task.entity_id,
    outcome: outcome ?? 'in_progress',
  };
}

/**
 * Announces that an approval reached an outcome.
 *
 * Emitted once per instance, when it settles — not once per task, because "the third of four
 * approvers said yes" is an implementation detail of the group, not something outside the
 * engine can act on.
 *
 * The aggregate is the workflow instance. The business entity's own events (LeaveApproved and
 * friends) are emitted by their own modules and describe the entity; these describe the
 * approval. A consumer should pick one.
 */
async function emitInstanceOutcome(
  tx: TenantTx,
  instanceId: string,
  entityType: WorkflowEntity,
  entityId: string,
  outcome: 'approved' | 'rejected',
): Promise<void> {
  await emitEvent(tx, outcome === 'approved' ? 'WorkflowApproved' : 'WorkflowRejected', {
    aggregateType: 'workflow_instance',
    aggregateId: instanceId,
    payload: {
      workflow_instance_id: instanceId,
      entity_type: entityType,
      entity_id: entityId,
      outcome,
    },
  });
}

/**
 * Resolves a satisfied group, then advances or approves.
 *
 * Runs inside the deciding transaction, after that task's row lock, so two approvals landing
 * together are serialised: the second sees the first's committed effect and the counts below
 * are never computed from a stale view.
 *
 * ALL needs no arithmetic at all — it is what the original engine did, and still does:
 * nothing is settled early, so the group finishes when its last task does. ANY and QUORUM
 * are the additions, and both work by terminally cancelling the tasks that can no longer
 * change the outcome. That keeps one rule for "is this group done": no task left pending.
 */
async function settleSatisfiedGroups(tx: TenantTx, instanceId: string): Promise<void> {
  const { rows } = await tx.query<{
    sequence_no: number;
    group_mode: GroupMode;
    group_quorum: number | null;
    approved: number;
    rejected: number;
    pending: number;
  }>(
    `SELECT sequence_no,
            min(group_mode)   AS group_mode,
            min(group_quorum) AS group_quorum,
            count(*) FILTER (WHERE status = 'approved')::int AS approved,
            count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
            count(*) FILTER (WHERE status = 'pending')::int  AS pending
       FROM workflow.approval_task
      WHERE tenant_id = $1 AND workflow_instance_id = $2
      GROUP BY sequence_no
     HAVING count(*) FILTER (WHERE status = 'pending') > 0`,
    [tx.tenantId, instanceId],
  );

  for (const group of rows) {
    if (group.group_mode === 'all') continue;

    let satisfied = false;
    if (group.group_mode === 'any') {
      satisfied = group.approved >= 1;
    } else if (group.group_mode === 'quorum') {
      satisfied = group.approved >= (group.group_quorum ?? Number.POSITIVE_INFINITY);
    }
    if (!satisfied) continue;

    // The remaining approvers no longer affect the result, so their tasks are ended rather
    // than left in an inbox as work that cannot change anything.
    await tx.query(
      `UPDATE workflow.approval_task
          SET status = 'cancelled'
        WHERE tenant_id = $1 AND workflow_instance_id = $2
          AND sequence_no = $3 AND status = 'pending'`,
      [tx.tenantId, instanceId, group.sequence_no],
    );
  }
}

/**
 * True when a rejection has made this group impossible to satisfy.
 *
 * For ALL, one rejection is decisive — the existing behaviour, unchanged. For QUORUM it is
 * not: rejections only matter once too few approvers remain to reach the number, which is
 * why this is arithmetic rather than a flag. For ANY, a rejection ends the group only when
 * nobody is left who could still approve.
 */
async function groupIsUnsatisfiable(
  tx: TenantTx,
  instanceId: string,
  sequenceNo: number,
): Promise<boolean> {
  const { rows } = await tx.query<{
    group_mode: GroupMode;
    group_quorum: number | null;
    approved: number;
    pending: number;
  }>(
    `SELECT min(group_mode) AS group_mode, min(group_quorum) AS group_quorum,
            count(*) FILTER (WHERE status = 'approved')::int AS approved,
            count(*) FILTER (WHERE status = 'pending')::int  AS pending
       FROM workflow.approval_task
      WHERE tenant_id = $1 AND workflow_instance_id = $2 AND sequence_no = $3`,
    [tx.tenantId, instanceId, sequenceNo],
  );
  const group = rows[0];
  if (!group) return true;

  if (group.group_mode === 'all') return true;
  if (group.group_mode === 'any') return group.pending === 0;
  return group.approved + group.pending < (group.group_quorum ?? 0);
}

/** Advances to the next pending step, or approves the instance when none remain. */
async function settleIfComplete(tx: TenantTx, instanceId: string): Promise<WorkflowOutcome | null> {
  await settleSatisfiedGroups(tx, instanceId);

  const { rows } = await tx.query<{ sequence_no: number }>(
    `SELECT sequence_no
       FROM workflow.approval_task
      WHERE tenant_id = $1 AND workflow_instance_id = $2 AND status = 'pending'
      ORDER BY sequence_no
      LIMIT 1`,
    [tx.tenantId, instanceId],
  );

  const next = rows[0];
  if (next) {
    await tx.query(
      'UPDATE workflow.workflow_instance SET current_sequence = $3 WHERE tenant_id = $1 AND id = $2',
      [tx.tenantId, instanceId, next.sequence_no],
    );
    return null;
  }

  await tx.query(
    `UPDATE workflow.workflow_instance
        SET status = 'approved', completed_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, instanceId],
  );
  return 'approved';
}

export async function cancelWorkflow(tx: TenantTx, instanceId: string | null): Promise<void> {
  if (!instanceId) return;
  await tx.query(
    `UPDATE workflow.approval_task
        SET status = 'cancelled'
      WHERE tenant_id = $1 AND workflow_instance_id = $2 AND status = 'pending'`,
    [tx.tenantId, instanceId],
  );
  await tx.query(
    `UPDATE workflow.workflow_instance
        SET status = 'cancelled', completed_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'in_progress'`,
    [tx.tenantId, instanceId],
  );
}

export async function upsertDefinition(
  tx: TenantTx,
  input: { name: string; entityType: WorkflowEntity; steps: WorkflowStep[] },
): Promise<{ id: string; version: number }> {
  const definition = definitionSchema.parse({ steps: input.steps });
  // Rejected at write time rather than discovered when a workflow starts: an unreachable
  // quorum or a group that disagrees with itself is a definition nobody can run.
  validateDefinition(definition.steps);

  // A new version rather than an edit: instances already running keep the rules they
  // started under (workflow_instance.definition_version).
  const { rows } = await tx.query<{ id: string; version: number }>(
    `INSERT INTO workflow.workflow_definition (tenant_id, name, entity_type, version, definition, status)
     SELECT $1, $2, $3,
            COALESCE(MAX(d.version), 0) + 1,
            $4::jsonb,
            'active'
       FROM workflow.workflow_definition d
      WHERE d.tenant_id = $1 AND d.entity_type = $3
     RETURNING id, version`,
    [tx.tenantId, input.name, input.entityType, JSON.stringify(definition)],
  );
  const created = rows[0]!;

  await tx.query(
    `UPDATE workflow.workflow_definition
        SET status = 'archived'
      WHERE tenant_id = $1 AND entity_type = $2 AND id <> $3 AND status = 'active'`,
    [tx.tenantId, input.entityType, created.id],
  );

  await audit(tx, {
    entityType: 'workflow_definition',
    entityId: created.id,
    action: 'workflow.definition.published',
    after: { entity_type: input.entityType, version: created.version, steps: definition.steps },
  });

  return created;
}

export async function pendingTasksFor(
  tx: TenantTx,
  employeeId: string,
  roleIds: readonly string[],
): Promise<
  Array<{
    id: string;
    entity_type: string;
    entity_id: string;
    sequence_no: number;
    due_at: Date | null;
    subject_employee_id: string | null;
    subject_name: string | null;
  }>
> {
  const { rows } = await tx.query(
    `SELECT t.id, i.entity_type, i.entity_id, t.sequence_no, t.due_at,
            i.subject_employee_id,
            e.first_name || ' ' || e.last_name AS subject_name
       FROM workflow.approval_task t
       JOIN workflow.workflow_instance i ON i.id = t.workflow_instance_id
       LEFT JOIN core.employee e ON e.id = i.subject_employee_id
      WHERE t.tenant_id = $1
        AND t.status = 'pending'
        AND i.status = 'in_progress'
        AND t.sequence_no = i.current_sequence
        AND (t.approver_employee_id = $2 OR t.approver_role_id = ANY($3::uuid[]))
      ORDER BY t.created_at`,
    [tx.tenantId, employeeId, roleIds],
  );
  return rows as never;
}

/**
 * Everything an approver needs in order to decide, and nothing more.
 *
 * The list endpoint stays deliberately thin — it is polled for a count — so the context that
 * makes a decision possible lives here. Before this existed the approver saw only an entity
 * type and a name, which meant approving a leave request without its dates or an expense claim
 * without its amount. That is not an approval; it is a rubber stamp.
 *
 * Three boundaries are enforced:
 *
 *   * **Assignment.** The same predicate as `pendingTasksFor` — the caller must be the named
 *     approver or hold the approving role. A task belonging to somebody else answers 404, the
 *     same as a task that does not exist, so ids cannot be probed.
 *   * **Tenant.** Every query is tenant-scoped and runs under RLS.
 *   * **Need to know.** The business context is the minimum the decision requires: an expense
 *     approver sees the claimed amount because that is what they are approving, but no
 *     salary, bank or tax figure is reachable through this endpoint for any entity type.
 *     Being an approver is not a permission to browse someone's payroll.
 */
export async function approvalDetail(
  tx: TenantTx,
  taskId: string,
  employeeId: string,
  roleIds: readonly string[],
): Promise<{
  task: Record<string, unknown>;
  context: Record<string, unknown> | null;
  history: Array<Record<string, unknown>>;
} | null> {
  const { rows } = await tx.query(
    `SELECT t.id, t.sequence_no, t.status, t.due_at, t.created_at,
            t.group_mode, t.group_quorum, t.is_fallback, t.fallback_reason,
            t.escalated_at, t.escalation_reason, t.delegation_id,
            i.id AS workflow_instance_id, i.entity_type, i.entity_id,
            i.status AS instance_status, i.current_sequence, i.attempt_no,
            i.subject_employee_id,
            subject.first_name || ' ' || subject.last_name AS subject_name,
            subject.employee_code AS subject_code,
            initiator.full_name AS initiated_by_name,
            escalated.first_name || ' ' || escalated.last_name AS escalated_to_name
       FROM workflow.approval_task t
       JOIN workflow.workflow_instance i ON i.id = t.workflow_instance_id
       LEFT JOIN core.employee subject ON subject.id = i.subject_employee_id
       LEFT JOIN identity.app_user initiator ON initiator.id = i.initiated_by_user_id
       LEFT JOIN core.employee escalated ON escalated.id = t.escalated_to_employee_id
      WHERE t.tenant_id = $1
        AND t.id = $2
        AND (t.approver_employee_id = $3 OR t.approver_role_id = ANY($4::uuid[]))`,
    [tx.tenantId, taskId, employeeId, roleIds],
  );

  const task = rows[0] as Record<string, unknown> | undefined;
  if (!task) return null;

  // Every decision taken on this request so far, whoever took it.
  const history = await tx.query(
    `SELECT t.sequence_no, t.status, t.decision_note, t.decided_at,
            t.is_fallback, t.escalated_at,
            decider.full_name AS decided_by_name,
            approver.first_name || ' ' || approver.last_name AS approver_name
       FROM workflow.approval_task t
       LEFT JOIN identity.app_user decider ON decider.id = t.decided_by
       LEFT JOIN core.employee approver ON approver.id = t.approver_employee_id
      WHERE t.tenant_id = $1 AND t.workflow_instance_id = $2
      ORDER BY t.sequence_no, t.created_at`,
    [tx.tenantId, task.workflow_instance_id],
  );

  return {
    task,
    context: await businessContext(tx, String(task.entity_type), String(task.entity_id)),
    history: history.rows as Array<Record<string, unknown>>,
  };
}

/**
 * The request itself, in the vocabulary of whichever module owns it.
 *
 * An entity type with no case here returns null rather than throwing: the workflow engine is
 * generic and a new entity type should make the approval screen say "no preview available",
 * not break the approver's inbox.
 */
async function businessContext(
  tx: TenantTx,
  entityType: string,
  entityId: string,
): Promise<Record<string, unknown> | null> {
  if (entityType === 'leave_application') {
    const { rows } = await tx.query(
      `SELECT to_char(a.start_date, 'YYYY-MM-DD') AS start_date,
              to_char(a.end_date, 'YYYY-MM-DD') AS end_date,
              a.quantity, a.reason, a.status,
              a.start_half_day, a.end_half_day,
              lt.name AS leave_type_name, lt.code AS leave_type_code
         FROM leave_mgmt.leave_application a
         JOIN leave_mgmt.leave_type lt ON lt.id = a.leave_type_id AND lt.tenant_id = a.tenant_id
        WHERE a.tenant_id = $1 AND a.id = $2`,
      [tx.tenantId, entityId],
    );
    return (rows[0] as Record<string, unknown>) ?? null;
  }

  if (entityType === 'expense_claim') {
    // The claimed amount is the thing being approved, so it is in scope. The sanctioned and
    // reimbursable figures are finance's decision, not the approver's, and are left out.
    const { rows } = await tx.query(
      `SELECT claim_number, to_char(claim_date, 'YYYY-MM-DD') AS claim_date,
              title, business_purpose, status,
              total_claimed_amount, currency
         FROM expense.expense_claim
        WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, entityId],
    );
    return (rows[0] as Record<string, unknown>) ?? null;
  }

  if (entityType === 'attendance_correction') {
    const { rows } = await tx.query(
      `SELECT to_char(attendance_date, 'YYYY-MM-DD') AS attendance_date,
              reason, proposed_in_at, proposed_out_at, proposed_status, status
         FROM workforce.attendance_correction
        WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, entityId],
    );
    return (rows[0] as Record<string, unknown>) ?? null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Delegation
// ---------------------------------------------------------------------------

export type DelegationInput = {
  delegatorUserId: string;
  delegateUserId: string;
  entityTypes: WorkflowEntity[];
  startsAt: Date;
  endsAt: Date;
};

/**
 * Records a delegation of approval authority.
 *
 * Deliberately not a permission. It says "while I am away, this person may act where I could
 * have", and the check at decision time re-derives the delegator's authority rather than
 * trusting this row (see `findDelegatedAuthority`). Creating one therefore grants nothing
 * that the delegator did not already hold.
 *
 * Who may create one is enforced at the route: a user may delegate their own authority, and
 * an administrator holding `role.manage` may arrange one on someone's behalf. Delegating
 * *someone else's* authority to yourself is what that check exists to stop.
 */
export async function createDelegation(tx: TenantTx, input: DelegationInput): Promise<{ id: string }> {
  if (input.delegatorUserId === input.delegateUserId) {
    throw unprocessable('delegation_self', 'A user cannot delegate to themselves');
  }
  if (input.endsAt <= input.startsAt) {
    throw unprocessable('delegation_bounds', 'A delegation must end after it starts');
  }
  if (input.entityTypes.length === 0) {
    throw unprocessable('delegation_scope', 'A delegation must name at least one workflow type');
  }

  // Both users must be members of *this* tenant. Without this a delegation could name a user
  // id from elsewhere and the row would look perfectly valid.
  const { rows: members } = await tx.query<{ user_id: string }>(
    `SELECT user_id FROM identity.tenant_membership
      WHERE tenant_id = $1 AND user_id = ANY($2::uuid[]) AND status = 'active'`,
    [tx.tenantId, [input.delegatorUserId, input.delegateUserId]],
  );
  if (members.length !== 2) {
    throw unprocessable(
      'delegation_membership',
      'Both the delegator and the delegate must be active members of this tenant',
    );
  }

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO workflow.workflow_delegation
       (tenant_id, delegator_user_id, delegate_user_id, entity_types, starts_at, ends_at, created_by)
     VALUES ($1, $2, $3, $4::text[], $5, $6, $7)
     RETURNING id`,
    [
      tx.tenantId, input.delegatorUserId, input.delegateUserId, input.entityTypes,
      input.startsAt, input.endsAt, tx.actor.userId ?? null,
    ],
  );

  await audit(tx, {
    entityType: 'workflow_delegation',
    entityId: rows[0]!.id,
    action: 'workflow.delegated',
    after: {
      delegator_user_id: input.delegatorUserId,
      delegate_user_id: input.delegateUserId,
      entity_types: input.entityTypes,
      starts_at: input.startsAt.toISOString(),
      ends_at: input.endsAt.toISOString(),
    },
  });

  await emitEvent(tx, 'WorkflowDelegated', {
    aggregateType: 'workflow_delegation',
    aggregateId: rows[0]!.id,
    payload: {
      delegation_id: rows[0]!.id,
      delegator_user_id: input.delegatorUserId,
      delegate_user_id: input.delegateUserId,
      entity_types: input.entityTypes,
      starts_at: input.startsAt.toISOString(),
      ends_at: input.endsAt.toISOString(),
    },
  });

  return rows[0]!;
}

/** Ends a delegation early. Decisions already made under it keep their recorded authority. */
export async function revokeDelegation(tx: TenantTx, delegationId: string): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE workflow.workflow_delegation
        SET status = 'revoked', revoked_at = now(), revoked_by = $3
      WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
    [tx.tenantId, delegationId, tx.actor.userId ?? null],
  );
  if (!rowCount) throw notFound('Delegation');

  await audit(tx, {
    entityType: 'workflow_delegation',
    entityId: delegationId,
    action: 'workflow.delegation_revoked',
    metadata: { revoked_by_user_id: tx.actor.userId },
  });

  await emitEvent(tx, 'WorkflowDelegationRevoked', {
    aggregateType: 'workflow_delegation',
    aggregateId: delegationId,
    payload: { delegation_id: delegationId, revoked_by_user_id: tx.actor.userId ?? null },
  });
}

export type DelegationRow = {
  id: string;
  delegator_user_id: string;
  delegate_user_id: string;
  entity_types: string[];
  starts_at: Date;
  ends_at: Date;
  status: string;
};

export async function listDelegations(tx: TenantTx): Promise<DelegationRow[]> {
  const { rows } = await tx.query<DelegationRow>(
    `SELECT id, delegator_user_id, delegate_user_id, entity_types, starts_at, ends_at, status
       FROM workflow.workflow_delegation
      WHERE tenant_id = $1
      ORDER BY starts_at DESC`,
    [tx.tenantId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Resubmission
// ---------------------------------------------------------------------------

/**
 * Starts a fresh attempt after a rejection.
 *
 * A new instance, not a reopened one (PRD s.16.5). The rejected instance keeps its status,
 * its tasks and its reasons exactly as they were decided — that record is what an employee
 * asking "why was this refused" is entitled to. The new attempt points back at it, is
 * numbered, and picks up whichever definition version is active *now*, because a
 * resubmission is a new request rather than a continuation of the old one.
 *
 * Approvals recorded against the previous attempt belong to that attempt's tasks and cannot
 * move this one: task ids differ, and `decide` matches a task to its own instance.
 */
export async function resubmitWorkflow(
  tx: TenantTx,
  rejectedInstanceId: string,
): Promise<StartResult & { attemptNo: number }> {
  const { rows } = await tx.query<{
    entity_type: WorkflowEntity;
    entity_id: string;
    subject_employee_id: string | null;
    status: string;
    attempt_no: number;
  }>(
    `SELECT entity_type, entity_id, subject_employee_id, status, attempt_no
       FROM workflow.workflow_instance
      WHERE tenant_id = $1 AND id = $2
      FOR UPDATE`,
    [tx.tenantId, rejectedInstanceId],
  );
  const previous = rows[0];
  if (!previous) throw notFound('Workflow instance');
  if (previous.status !== 'rejected') {
    throw conflict('workflow_not_rejected', 'Only a rejected request can be resubmitted');
  }
  if (!previous.subject_employee_id) {
    throw unprocessable('workflow_subject_missing', 'This request has no subject employee to resubmit for');
  }

  const started = await startWorkflow(
    tx,
    previous.entity_type,
    previous.entity_id,
    previous.subject_employee_id,
    { supersedesInstanceId: rejectedInstanceId, attemptNo: previous.attempt_no + 1 },
  );

  await audit(tx, {
    entityType: 'workflow_instance',
    entityId: started.instanceId ?? rejectedInstanceId,
    action: 'workflow.resubmitted',
    metadata: {
      supersedes_instance_id: rejectedInstanceId,
      attempt_no: previous.attempt_no + 1,
      entity_type: previous.entity_type,
    },
  });

  if (started.instanceId) {
    await emitEvent(tx, 'WorkflowResubmitted', {
      aggregateType: 'workflow_instance',
      aggregateId: started.instanceId,
      payload: {
        workflow_instance_id: started.instanceId,
        supersedes_instance_id: rejectedInstanceId,
        attempt_no: previous.attempt_no + 1,
        entity_type: previous.entity_type,
        entity_id: previous.entity_id,
      },
    });
  }

  return { ...started, attemptNo: previous.attempt_no + 1 };
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

/**
 * Widens authority over tasks that have passed their SLA.
 *
 * What escalation does *not* do is decide: the task stays pending and keeps its original
 * approver. The configured target simply becomes a second person who may act on it, which is
 * the only escalation the existing model can express without inventing an organizational
 * hierarchy the product has never defined.
 *
 * A target that does not resolve is not skipped quietly — the failure is recorded, so an
 * operator can see that an SLA passed and escalation could not happen, which is more useful
 * than a task that is merely late.
 */
export async function escalateOverdueTasks(tx: TenantTx, now = new Date()): Promise<number> {
  const { rows } = await tx.query<{
    id: string;
    workflow_instance_id: string;
    sequence_no: number;
    due_at: Date;
    subject_employee_id: string | null;
    definition: unknown;
  }>(
    // Joined on the instance's pinned definition *version*, not the newest one, so a
    // definition edited since the instance started cannot change where it escalates to.
    `SELECT t.id, t.workflow_instance_id, t.sequence_no, t.due_at,
            i.subject_employee_id, d.definition
       FROM workflow.approval_task t
       JOIN workflow.workflow_instance i ON i.id = t.workflow_instance_id
       JOIN workflow.workflow_definition d
         ON d.tenant_id = i.tenant_id AND d.entity_type = i.entity_type
        AND d.version = i.definition_version
      WHERE t.tenant_id = $1
        AND t.status = 'pending'
        AND t.due_at IS NOT NULL
        AND t.due_at < $2
        AND t.escalated_at IS NULL
        AND i.status = 'in_progress'
      ORDER BY t.due_at
      LIMIT 200`,
    [tx.tenantId, now],
  );

  let escalated = 0;
  for (const task of rows) {
    const parsed = definitionSchema.safeParse(task.definition);
    if (!parsed.success) continue;
    const step = parsed.data.steps.find((s) => s.sequence === task.sequence_no);
    if (!step?.escalate_to) continue;

    const target = task.subject_employee_id
      ? await resolveTarget(tx, step.escalate_to, task.subject_employee_id)
      : null;

    if (!target?.employeeId) {
      await audit(tx, {
        entityType: 'workflow_instance',
        entityId: task.workflow_instance_id,
        action: 'workflow.escalation_failed',
        metadata: {
          task_id: task.id,
          sequence: task.sequence_no,
          due_at: task.due_at.toISOString(),
          reason: 'escalation target did not resolve in this tenant',
          configured_target: step.escalate_to.approver,
        },
      });
      await emitEvent(tx, 'WorkflowEscalationFailed', {
        aggregateType: 'workflow_instance',
        aggregateId: task.workflow_instance_id,
        payload: {
          workflow_instance_id: task.workflow_instance_id,
          task_id: task.id,
          sequence: task.sequence_no,
          due_at: task.due_at.toISOString(),
          reason: 'escalation_target_unresolved',
        },
      });
      continue;
    }

    await tx.query(
      `UPDATE workflow.approval_task
          SET escalated_at = now(), escalated_to_employee_id = $3, escalation_reason = $4
        WHERE tenant_id = $1 AND id = $2 AND status = 'pending' AND escalated_at IS NULL`,
      [tx.tenantId, task.id, target.employeeId, 'sla_breached'],
    );

    await audit(tx, {
      entityType: 'workflow_instance',
      entityId: task.workflow_instance_id,
      action: 'workflow.escalated',
      metadata: {
        task_id: task.id,
        sequence: task.sequence_no,
        due_at: task.due_at.toISOString(),
        escalated_to_employee_id: target.employeeId,
        reason: 'sla_breached',
      },
    });

    await emitEvent(tx, 'WorkflowEscalated', {
      aggregateType: 'workflow_instance',
      aggregateId: task.workflow_instance_id,
      payload: {
        workflow_instance_id: task.workflow_instance_id,
        task_id: task.id,
        sequence: task.sequence_no,
        due_at: task.due_at.toISOString(),
        escalated_to_employee_id: target.employeeId,
        reason: 'sla_breached',
      },
    });
    escalated += 1;
  }
  return escalated;
}
