import type { TenantTx } from '../../infra/db/pool.ts';
import { audit } from '../../infra/audit.ts';
import { emitEvent } from '../../infra/events/outbox.ts';
import { conflict, notFound, unprocessable } from '../../infra/errors.ts';

/**
 * Onboarding task orchestration.
 *
 * Follows mature HR behaviour: a reusable template of
 * activities instantiated per joiner, each with an owner, a due date relative to the
 * joining date, and a mandatory flag that gates completion of the plan.
 *
 * Owners are resolved once, when the plan is created, and then stored. Resolving them
 * lazily would mean a task silently changing hands when someone's manager changes, which
 * makes "who was supposed to do this" unanswerable after the fact.
 */

export type TemplateTaskInput = {
  sequenceNo: number;
  title: string;
  description?: string;
  category?: 'general' | 'document' | 'it_asset' | 'training' | 'bank_details' | 'tax_declaration' | 'introduction';
  ownerKind?: 'employee' | 'reporting_manager' | 'hr' | 'role';
  ownerRoleName?: string;
  dueOffsetDays?: number;
  isMandatory?: boolean;
  requiresDocumentType?: string;
};

export async function createTemplate(
  tx: TenantTx,
  input: {
    name: string;
    departmentId?: string;
    designationId?: string;
    employmentType?: string;
    tasks: TemplateTaskInput[];
  },
): Promise<{ id: string; taskCount: number }> {
  if (input.tasks.length === 0) {
    throw unprocessable('empty_template', 'An onboarding template needs at least one task');
  }

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO recruitment.onboarding_template
       (tenant_id, name, department_id, designation_id, employment_type)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [tx.tenantId, input.name, input.departmentId ?? null, input.designationId ?? null, input.employmentType ?? null],
  );
  const templateId = rows[0]!.id;

  for (const task of input.tasks) {
    let roleId: string | null = null;
    if (task.ownerKind === 'role') {
      if (!task.ownerRoleName) {
        throw unprocessable('role_required', `Task "${task.title}" is owned by a role but names none`);
      }
      const role = await tx.query<{ id: string }>(
        'SELECT id FROM identity.role WHERE tenant_id = $1 AND name = $2',
        [tx.tenantId, task.ownerRoleName],
      );
      if (!role.rows[0]) throw notFound(`Role ${task.ownerRoleName}`);
      roleId = role.rows[0].id;
    }

    await tx.query(
      `INSERT INTO recruitment.onboarding_template_task
         (tenant_id, template_id, sequence_no, title, description, category, owner_kind,
          owner_role_id, due_offset_days, is_mandatory, requires_document_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        tx.tenantId, templateId, task.sequenceNo, task.title, task.description ?? null,
        task.category ?? 'general', task.ownerKind ?? 'hr', roleId,
        task.dueOffsetDays ?? 0, task.isMandatory ?? true, task.requiresDocumentType ?? null,
      ],
    );
  }

  await audit(tx, {
    entityType: 'onboarding_template',
    entityId: templateId,
    action: 'onboarding.template.created',
    after: { name: input.name, tasks: input.tasks.length },
  });

  return { id: templateId, taskCount: input.tasks.length };
}

/**
 * Chooses the template for a joiner.
 *
 * Most specific wins: a template naming both the department and the designation beats one
 * naming only the department, which beats a general one. Without that ordering, adding a
 * specialised template would silently do nothing.
 */
async function resolveTemplate(
  tx: TenantTx,
  employee: { department_id: string | null; designation_id: string | null; employment_type: string },
): Promise<{ id: string; name: string } | null> {
  const { rows } = await tx.query<{ id: string; name: string }>(
    `SELECT id, name
       FROM recruitment.onboarding_template
      WHERE tenant_id = $1 AND status = 'active'
        AND (department_id IS NULL OR department_id = $2)
        AND (designation_id IS NULL OR designation_id = $3)
        AND (employment_type IS NULL OR employment_type = $4)
      ORDER BY (department_id IS NOT NULL)::int + (designation_id IS NOT NULL)::int
               + (employment_type IS NOT NULL)::int DESC,
               created_at DESC
      LIMIT 1`,
    [tx.tenantId, employee.department_id, employee.designation_id, employee.employment_type],
  );
  return rows[0] ?? null;
}

export type CreatePlanResult = {
  id: string;
  templateName: string;
  taskCount: number;
  unresolvedOwners: string[];
};

/**
 * Instantiates an onboarding plan for a new joiner.
 *
 * Due dates are computed from the joining date, so a task can legitimately fall before it
 * (asset ordering, offer paperwork). Owners that cannot be resolved fall back to the plan
 * creator rather than being left blank — an unowned task is one nobody chases.
 */
export async function createPlan(
  tx: TenantTx,
  input: { employeeId: string; templateId?: string },
): Promise<CreatePlanResult> {
  const { rows: employeeRows } = await tx.query<{
    department_id: string | null;
    designation_id: string | null;
    employment_type: string;
    manager_employee_id: string | null;
    joining_date: string;
    employment_status: string;
  }>(
    `SELECT department_id, designation_id, employment_type, manager_employee_id,
            to_char(joining_date, 'YYYY-MM-DD') AS joining_date, employment_status
       FROM core.employee WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, input.employeeId],
  );
  const employee = employeeRows[0];
  if (!employee) throw notFound('Employee');
  if (employee.employment_status === 'separated') {
    throw unprocessable('employee_separated', 'A separated employee cannot be onboarded');
  }

  const template = input.templateId
    ? (
        await tx.query<{ id: string; name: string }>(
          'SELECT id, name FROM recruitment.onboarding_template WHERE tenant_id = $1 AND id = $2',
          [tx.tenantId, input.templateId],
        )
      ).rows[0] ?? null
    : await resolveTemplate(tx, employee);

  if (!template) {
    throw unprocessable(
      'no_onboarding_template',
      'No onboarding template matches this employee. Create one, or pass a template explicitly.',
    );
  }

  let planId: string;
  try {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO recruitment.onboarding_plan
         (tenant_id, employee_id, template_id, template_name, joining_date, created_by)
       VALUES ($1, $2, $3, $4, $5::date, $6)
       RETURNING id`,
      [tx.tenantId, input.employeeId, template.id, template.name, employee.joining_date, tx.actor.userId],
    );
    planId = rows[0]!.id;
  } catch {
    throw conflict('plan_exists', 'This employee already has an onboarding plan');
  }

  const { rows: templateTasks } = await tx.query<{
    sequence_no: number;
    title: string;
    description: string | null;
    category: string;
    owner_kind: string;
    owner_role_id: string | null;
    due_offset_days: number;
    is_mandatory: boolean;
    requires_document_type: string | null;
  }>(
    `SELECT sequence_no, title, description, category, owner_kind, owner_role_id,
            due_offset_days, is_mandatory, requires_document_type
       FROM recruitment.onboarding_template_task
      WHERE tenant_id = $1 AND template_id = $2
      ORDER BY sequence_no`,
    [tx.tenantId, template.id],
  );

  // HR-owned tasks go to whoever holds the HR Admin role; resolved once, here.
  const hrRole = await tx.query<{ id: string }>(
    `SELECT id FROM identity.role WHERE tenant_id = $1 AND name = 'HR Admin'`,
    [tx.tenantId],
  );

  const unresolvedOwners: string[] = [];

  for (const task of templateTasks) {
    let ownerEmployeeId: string | null = null;
    let ownerRoleId: string | null = null;

    switch (task.owner_kind) {
      case 'employee':
        ownerEmployeeId = input.employeeId;
        break;
      case 'reporting_manager':
        ownerEmployeeId = employee.manager_employee_id;
        if (!ownerEmployeeId) unresolvedOwners.push(task.title);
        break;
      case 'role':
        ownerRoleId = task.owner_role_id;
        break;
      case 'hr':
      default:
        ownerRoleId = hrRole.rows[0]?.id ?? null;
        if (!ownerRoleId) unresolvedOwners.push(task.title);
        break;
    }

    await tx.query(
      `INSERT INTO recruitment.onboarding_task
         (tenant_id, plan_id, sequence_no, title, description, category, owner_employee_id,
          owner_role_id, due_date, is_mandatory, requires_document_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, ($9::date + make_interval(days => $10))::date, $11,$12)`,
      [
        tx.tenantId, planId, task.sequence_no, task.title, task.description, task.category,
        ownerEmployeeId, ownerRoleId, employee.joining_date, task.due_offset_days,
        task.is_mandatory, task.requires_document_type,
      ],
    );
  }

  await audit(tx, {
    entityType: 'onboarding_plan',
    entityId: planId,
    action: 'onboarding.plan.created',
    after: {
      employee_id: input.employeeId,
      template: template.name,
      tasks: templateTasks.length,
      unresolved_owners: unresolvedOwners,
    },
  });

  await emitEvent(tx, 'OnboardingPlanCreated', {
    aggregateType: 'onboarding_plan',
    aggregateId: planId,
    payload: {
      onboarding_plan_id: planId,
      employee_id: input.employeeId,
      task_count: templateTasks.length,
    },
  });

  return { id: planId, templateName: template.name, taskCount: templateTasks.length, unresolvedOwners };
}

/**
 * Completes a task.
 *
 * A task that requires a document cannot be completed without one. That is the whole point
 * of the flag: "collect the signed contract" is not done because someone ticked a box.
 */
export async function completeTask(
  tx: TenantTx,
  taskId: string,
  input: { note?: string; documentId?: string },
): Promise<{ planCompleted: boolean }> {
  const { rows } = await tx.query<{
    plan_id: string;
    title: string;
    status: string;
    requires_document_type: string | null;
  }>(
    `SELECT plan_id, title, status, requires_document_type
       FROM recruitment.onboarding_task
      WHERE tenant_id = $1 AND id = $2
      FOR UPDATE`,
    [tx.tenantId, taskId],
  );
  const task = rows[0];
  if (!task) throw notFound('Onboarding task');
  if (task.status === 'completed') return { planCompleted: false };

  if (task.requires_document_type) {
    if (!input.documentId) {
      throw unprocessable(
        'document_required',
        `"${task.title}" is complete only when a ${task.requires_document_type} document is attached`,
      );
    }
    const document = await tx.query<{ document_type: string; status: string }>(
      'SELECT document_type, status FROM documents.document WHERE tenant_id = $1 AND id = $2',
      [tx.tenantId, input.documentId],
    );
    const doc = document.rows[0];
    if (!doc) throw notFound('Document');
    if (doc.status !== 'available') {
      throw unprocessable('document_not_available', 'That document has not finished uploading');
    }
    if (doc.document_type !== task.requires_document_type) {
      throw unprocessable(
        'wrong_document_type',
        `This task needs a ${task.requires_document_type} document, not ${doc.document_type}`,
      );
    }
  }

  await tx.query(
    `UPDATE recruitment.onboarding_task
        SET status = 'completed', completed_by = $3, completed_at = now(),
            completion_note = $4, document_id = $5
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, taskId, tx.actor.userId, input.note ?? null, input.documentId ?? null],
  );

  return { planCompleted: await settlePlanIfDone(tx, task.plan_id) };
}

export async function skipTask(tx: TenantTx, taskId: string, reason: string): Promise<{ planCompleted: boolean }> {
  const { rows } = await tx.query<{ plan_id: string; is_mandatory: boolean; status: string; title: string }>(
    `SELECT plan_id, is_mandatory, status, title FROM recruitment.onboarding_task
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tx.tenantId, taskId],
  );
  const task = rows[0];
  if (!task) throw notFound('Onboarding task');
  if (task.is_mandatory) {
    throw unprocessable('mandatory_task', `"${task.title}" is mandatory and cannot be skipped`);
  }

  await tx.query(
    `UPDATE recruitment.onboarding_task
        SET status = 'skipped', completed_by = $3, completed_at = now(), completion_note = $4
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, taskId, tx.actor.userId, reason],
  );

  return { planCompleted: await settlePlanIfDone(tx, task.plan_id) };
}

/**
 * Closes the plan once no mandatory task is outstanding.
 *
 * Confirming the employee is left to the lifecycle module: onboarding finishing is a fact
 * about paperwork, and deciding someone has passed probation is a separate judgement.
 */
async function settlePlanIfDone(tx: TenantTx, planId: string): Promise<boolean> {
  const { rows } = await tx.query<{ outstanding: string }>(
    `SELECT count(*) AS outstanding
       FROM recruitment.onboarding_task
      WHERE tenant_id = $1 AND plan_id = $2
        AND is_mandatory AND status NOT IN ('completed', 'skipped')`,
    [tx.tenantId, planId],
  );
  if (Number(rows[0]!.outstanding) > 0) return false;

  const { rowCount } = await tx.query(
    `UPDATE recruitment.onboarding_plan
        SET status = 'completed', completed_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'in_progress'`,
    [tx.tenantId, planId],
  );
  if (!rowCount) return false;

  const plan = await tx.query<{ employee_id: string }>(
    'SELECT employee_id FROM recruitment.onboarding_plan WHERE tenant_id = $1 AND id = $2',
    [tx.tenantId, planId],
  );

  await audit(tx, {
    entityType: 'onboarding_plan',
    entityId: planId,
    action: 'onboarding.plan.completed',
    after: { employee_id: plan.rows[0]?.employee_id },
  });

  await emitEvent(tx, 'OnboardingCompleted', {
    aggregateType: 'onboarding_plan',
    aggregateId: planId,
    payload: { onboarding_plan_id: planId, employee_id: plan.rows[0]?.employee_id },
  });

  return true;
}

/** Tasks waiting on one person, by direct assignment or by role. */
export async function tasksFor(
  tx: TenantTx,
  employeeId: string,
  roleIds: readonly string[],
): Promise<unknown[]> {
  const { rows } = await tx.query(
    `SELECT t.id, t.title, t.description, t.category,
            to_char(t.due_date, 'YYYY-MM-DD') AS due_date,
            t.is_mandatory, t.requires_document_type, t.status,
            t.due_date < CURRENT_DATE AS overdue,
            e.employee_code AS joiner_code,
            e.first_name || ' ' || e.last_name AS joiner_name
       FROM recruitment.onboarding_task t
       JOIN recruitment.onboarding_plan p ON p.id = t.plan_id
       JOIN core.employee e ON e.id = p.employee_id
      WHERE t.tenant_id = $1
        AND t.status IN ('pending', 'in_progress')
        AND p.status = 'in_progress'
        AND (t.owner_employee_id = $2 OR t.owner_role_id = ANY($3::uuid[]))
      ORDER BY t.due_date, t.sequence_no`,
    [tx.tenantId, employeeId, roleIds],
  );
  return rows;
}
