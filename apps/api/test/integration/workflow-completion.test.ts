import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closePools, getAppPool, withPlatform, withTenant, SYSTEM_ACTOR, type TenantTx } from '../../src/infra/db/pool.ts';
import * as workflow from '../../src/modules/workflow/service.ts';
import { escalateOverdueTasks } from '../../src/modules/workflow/service.ts';
import { createEmployee, createTestTenant, dropTestTenant, skipWithoutDb, type TestTenant } from './helpers.ts';

/**
 * Workflow completion (PRD s.16, s.17).
 *
 * Everything the engine already did — ordered steps, one decision per step, a version pinned
 * at instantiation — is assumed working and covered elsewhere. What is established here is
 * the behaviour added on top, and in particular the three things that decide whether an
 * approval can be trusted: nobody approves their own request, a group completes only when
 * its declared policy is actually satisfied, and two people deciding at the same instant
 * produce one outcome rather than two.
 */

const uuid = () => randomUUID();

/**
 * Polls a condition to a generous bound.
 *
 * Used instead of sleeping: these tests construct an interleaving and then wait for the
 * database to report that it has happened, so a slow machine makes them slower rather than
 * wrong.
 */
async function waitFor(condition: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A tenant transaction acting as a specific user, which is what maker-checker turns on. */
function asUser<T>(tenant: TestTenant, userId: string | null, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withTenant(tenant.tenantId, { ...SYSTEM_ACTOR, label: 'workflow-test', userId }, fn);
}

/** What a backend is doing, read from a connection of its own so it is never self-observing. */
async function backendState(pid: number): Promise<string | null> {
  if (!pid) return null;
  const { rows } = await getAppPool().query<{ state: string | null }>(
    'SELECT state FROM pg_stat_activity WHERE pid = $1', [pid]);
  return rows[0]?.state ?? null;
}

async function backendWaitEvent(pid: number): Promise<string | null> {
  if (!pid) return null;
  const { rows } = await getAppPool().query<{ wait_event_type: string | null }>(
    'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
  return rows[0]?.wait_event_type ?? null;
}

describe('workflow completion', skipWithoutDb, () => {
  let tenant: TestTenant;
  let other: TestTenant;
  /** Employees, each linked to a user so "who acted" is a real identity. */
  let requester: { employeeId: string; userId: string };
  let managerA: { employeeId: string; userId: string };
  let managerB: { employeeId: string; userId: string };
  let managerC: { employeeId: string; userId: string };
  let stranger: { employeeId: string; userId: string };

  async function makeActor(t: TestTenant, code: string): Promise<{ employeeId: string; userId: string }> {
    const email = `${code.toLowerCase()}-${uuid().slice(0, 8)}@example.com`;
    const userId = await withPlatform('tenant-provisioning', async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO identity.app_user (email, full_name, status, password_hash)
         VALUES ($1, $2, 'active', 'x') RETURNING id`,
        [email, code],
      );
      return rows[0]!.id;
    });
    await withPlatform('tenant-provisioning', (tx) =>
      tx.query(
        `INSERT INTO identity.tenant_membership (tenant_id, user_id, status) VALUES ($1, $2, 'active')`,
        [t.tenantId, userId],
      ).then(() => undefined),
    );
    const employeeId = await createEmployee(t, { code });
    await t.as((tx) =>
      tx.query('UPDATE core.employee SET user_id = $3 WHERE tenant_id = $1 AND id = $2', [
        tx.tenantId, employeeId, userId,
      ]).then(() => undefined),
    );
    return { employeeId, userId };
  }

  /** Installs a definition and starts an instance for a throwaway entity. */
  async function startWith(
    steps: workflow.WorkflowStep[],
    opts: { subject?: string; initiator?: string | null } = {},
  ): Promise<{ instanceId: string; entityId: string }> {
    await tenant.as((tx) =>
      workflow.upsertDefinition(tx, {
        name: 'Test', entityType: 'employee_change', steps,
      }).then(() => undefined),
    );
    const entityId = uuid();
    const started = await asUser(tenant, opts.initiator === undefined ? requester.userId : opts.initiator, (tx) =>
      workflow.startWorkflow(tx, 'employee_change', entityId, opts.subject ?? requester.employeeId),
    );
    assert.ok(started.instanceId, 'the definition should have produced an instance');
    return { instanceId: started.instanceId!, entityId };
  }

  async function tasksOf(instanceId: string) {
    return tenant.as(async (tx) => {
      const { rows } = await tx.query<{
        id: string; sequence_no: number; status: string; approver_employee_id: string | null;
        group_mode: string; group_quorum: number | null; decision_note: string | null;
        decided_by: string | null; decided_on_behalf_of_user_id: string | null;
        is_fallback: boolean; fallback_reason: string | null; escalated_to_employee_id: string | null;
      }>(
        `SELECT id, sequence_no, status, approver_employee_id, group_mode, group_quorum,
                decision_note, decided_by, decided_on_behalf_of_user_id,
                is_fallback, fallback_reason, escalated_to_employee_id
           FROM workflow.approval_task
          WHERE tenant_id = $1 AND workflow_instance_id = $2
          ORDER BY sequence_no, approver_employee_id`,
        [tx.tenantId, instanceId],
      );
      return rows;
    });
  }

  /** Outbox rows for one aggregate, read inside the tenant (RLS applies). */
  async function eventsOf(t: TestTenant, aggregateId: string) {
    return t.as(async (tx) => {
      const { rows } = await tx.query<{
        event_type: string; tenant_id: string; aggregate_type: string; aggregate_id: string;
        schema_version: number; producer: string; payload: Record<string, unknown>;
      }>(
        `SELECT event_type, tenant_id, aggregate_type, aggregate_id, schema_version, producer, payload
           FROM integration.event_outbox
          WHERE tenant_id = $1 AND aggregate_id = $2
          ORDER BY id`,
        [tx.tenantId, aggregateId],
      );
      return rows;
    });
  }

  async function instanceOf(instanceId: string) {
    return tenant.as(async (tx) => {
      const { rows } = await tx.query<{
        status: string; current_sequence: number; attempt_no: number;
        supersedes_instance_id: string | null; initiated_by_user_id: string | null;
        definition_version: number;
      }>(
        `SELECT status, current_sequence, attempt_no, supersedes_instance_id,
                initiated_by_user_id, definition_version
           FROM workflow.workflow_instance WHERE tenant_id = $1 AND id = $2`,
        [tx.tenantId, instanceId],
      );
      return rows[0]!;
    });
  }

  const employeeStep = (sequence: number, employeeId: string, extra: Record<string, unknown> = {}) =>
    ({ sequence, approver: 'employee', employee_id: employeeId, skip_if_unresolved: false, ...extra }) as workflow.WorkflowStep;

  before(async () => {
    tenant = await createTestTenant('wf');
    other = await createTestTenant('wf-other');
    requester = await makeActor(tenant, 'WFREQ');
    managerA = await makeActor(tenant, 'WFMGRA');
    managerB = await makeActor(tenant, 'WFMGRB');
    managerC = await makeActor(tenant, 'WFMGRC');
    stranger = await makeActor(tenant, 'WFSTR');
  });

  after(async () => {
    await dropTestTenant(tenant.tenantId);
    await dropTestTenant(other.tenantId);
    await closePools();
  });

  beforeEach(async () => {
    // Definitions accumulate versions; instances are per-entity, so nothing needs resetting
    // except delegations, which would otherwise leak authority between tests.
    //
    // Only the unused ones: a delegation that authorised a decision is referenced by that
    // task and must survive, because "whose authority was this approved under" has to stay
    // answerable. The foreign key enforces that, and this respects it rather than working
    // around it.
    // Revoked, not deleted: a delegation that authorised a decision is referenced by that
    // task and must survive, because "whose authority was this approved under" has to stay
    // answerable. Revoking neutralises the authority without destroying the record — which
    // is also exactly what revocation means in production.
    await tenant.as((tx) =>
      tx.query(
        `UPDATE workflow.workflow_delegation
            SET status = 'revoked', revoked_at = now()
          WHERE tenant_id = $1 AND status = 'active'`,
        [tx.tenantId],
      ).then(() => undefined),
    );
  });

  // -------------------------------------------------------------- definition validation

  describe('definition validation', () => {
    const bad = async (steps: workflow.WorkflowStep[], pattern: RegExp) =>
      assert.rejects(
        tenant.as((tx) => workflow.upsertDefinition(tx, { name: 'Bad', entityType: 'employee_change', steps })),
        pattern,
      );

    it('refuses quorum mode with no quorum', async () => {
      await bad(
        [employeeStep(1, managerA.employeeId, { mode: 'quorum' }),
         employeeStep(1, managerB.employeeId, { mode: 'quorum' })],
        /does not declare a single quorum/,
      );
    });

    it('refuses a quorum of zero or less', async () => {
      await bad(
        [employeeStep(1, managerA.employeeId, { mode: 'quorum', quorum: 0 }),
         employeeStep(1, managerB.employeeId, { mode: 'quorum', quorum: 0 })],
        /quorum of 0/,
      );
    });

    it('refuses a quorum larger than the group, which could never complete', async () => {
      await bad(
        [employeeStep(1, managerA.employeeId, { mode: 'quorum', quorum: 3 }),
         employeeStep(1, managerB.employeeId, { mode: 'quorum', quorum: 3 })],
        /needs 3 approvals but has only 2/,
      );
    });

    it('refuses a quorum on an any or all group', async () => {
      await bad([employeeStep(1, managerA.employeeId, { mode: 'any', quorum: 1 })], /must not declare a quorum/);
    });

    it('refuses steps in one group that disagree about the mode', async () => {
      await bad(
        [employeeStep(1, managerA.employeeId, { mode: 'any' }),
         employeeStep(1, managerB.employeeId, { mode: 'all' })],
        /disagree about the completion mode/,
      );
    });

    it('refuses an escalation target with no SLA to breach', async () => {
      await bad(
        [employeeStep(1, managerA.employeeId, { escalate_to: { approver: 'employee', employee_id: managerB.employeeId } })],
        /no sla_hours/,
      );
    });

    it('refuses a fallback that names no target', async () => {
      await bad(
        [employeeStep(1, managerA.employeeId, { fallback: { approver: 'role' } })],
        /names no role/,
      );
    });

    it('accepts a plain sequential definition exactly as before', async () => {
      const result = await tenant.as((tx) =>
        workflow.upsertDefinition(tx, {
          name: 'Sequential',
          entityType: 'employee_change',
          steps: [employeeStep(1, managerA.employeeId), employeeStep(2, managerB.employeeId)],
        }),
      );
      assert.ok(result.version > 0);
    });
  });

  // -------------------------------------------------------------- parallel groups

  describe('parallel groups', () => {
    it('defaults to ALL, which is what shared sequences already did', async () => {
      const { instanceId } = await startWith([
        employeeStep(1, managerA.employeeId),
        employeeStep(1, managerB.employeeId),
      ]);
      const tasks = await tasksOf(instanceId);
      assert.equal(tasks.length, 2);
      assert.ok(tasks.every((t) => t.group_mode === 'all'), 'absent mode must persist as all');

      const first = tasks.find((t) => t.approver_employee_id === managerA.employeeId)!;
      await asUser(tenant, managerA.userId, (tx) =>
        workflow.decide(tx, first.id, 'approved', undefined, managerA.employeeId, []));
      assert.equal((await instanceOf(instanceId)).status, 'in_progress', 'one of two is not ALL');

      const second = (await tasksOf(instanceId)).find((t) => t.status === 'pending')!;
      await asUser(tenant, managerB.userId, (tx) =>
        workflow.decide(tx, second.id, 'approved', undefined, managerB.employeeId, []));
      assert.equal((await instanceOf(instanceId)).status, 'approved');
    });

    it('completes an ANY group on the first approval and ends the rest', async () => {
      const { instanceId } = await startWith([
        employeeStep(1, managerA.employeeId, { mode: 'any' }),
        employeeStep(1, managerB.employeeId, { mode: 'any' }),
      ]);
      const tasks = await tasksOf(instanceId);
      const first = tasks.find((t) => t.approver_employee_id === managerA.employeeId)!;

      await asUser(tenant, managerA.userId, (tx) =>
        workflow.decide(tx, first.id, 'approved', undefined, managerA.employeeId, []));

      assert.equal((await instanceOf(instanceId)).status, 'approved');
      const after = await tasksOf(instanceId);
      const other = after.find((t) => t.approver_employee_id === managerB.employeeId)!;
      assert.equal(other.status, 'cancelled', 'a decision that can no longer matter must not sit in an inbox');
    });

    it('completes a QUORUM group at the configured number, not before', async () => {
      const { instanceId } = await startWith([
        employeeStep(1, managerA.employeeId, { mode: 'quorum', quorum: 2 }),
        employeeStep(1, managerB.employeeId, { mode: 'quorum', quorum: 2 }),
        employeeStep(1, managerC.employeeId, { mode: 'quorum', quorum: 2 }),
      ]);
      const tasks = await tasksOf(instanceId);
      assert.ok(tasks.every((t) => t.group_quorum === 2));

      await asUser(tenant, managerA.userId, (tx) =>
        workflow.decide(tx, tasks.find((t) => t.approver_employee_id === managerA.employeeId)!.id,
          'approved', undefined, managerA.employeeId, []));
      assert.equal((await instanceOf(instanceId)).status, 'in_progress', 'one of two required is not a quorum');

      await asUser(tenant, managerB.userId, (tx) =>
        workflow.decide(tx, tasks.find((t) => t.approver_employee_id === managerB.employeeId)!.id,
          'approved', undefined, managerB.employeeId, []));
      assert.equal((await instanceOf(instanceId)).status, 'approved');

      const third = (await tasksOf(instanceId)).find((t) => t.approver_employee_id === managerC.employeeId)!;
      assert.equal(third.status, 'cancelled');
    });

    it('keeps a QUORUM group alive after a rejection that still leaves it reachable', async () => {
      const { instanceId } = await startWith([
        employeeStep(1, managerA.employeeId, { mode: 'quorum', quorum: 2 }),
        employeeStep(1, managerB.employeeId, { mode: 'quorum', quorum: 2 }),
        employeeStep(1, managerC.employeeId, { mode: 'quorum', quorum: 2 }),
      ]);
      const tasks = await tasksOf(instanceId);

      await asUser(tenant, managerA.userId, (tx) =>
        workflow.decide(tx, tasks.find((t) => t.approver_employee_id === managerA.employeeId)!.id,
          'rejected', 'not this one', managerA.employeeId, []));

      // Two approvers remain and two approvals are needed: still reachable, so the request
      // is not dead. Treating any rejection as fatal would make quorum meaningless.
      assert.equal((await instanceOf(instanceId)).status, 'in_progress');

      await asUser(tenant, managerB.userId, (tx) =>
        workflow.decide(tx, tasks.find((t) => t.approver_employee_id === managerB.employeeId)!.id,
          'approved', undefined, managerB.employeeId, []));
      await asUser(tenant, managerC.userId, (tx) =>
        workflow.decide(tx, tasks.find((t) => t.approver_employee_id === managerC.employeeId)!.id,
          'approved', undefined, managerC.employeeId, []));
      assert.equal((await instanceOf(instanceId)).status, 'approved');
    });

    it('rejects a QUORUM group once the number can no longer be reached', async () => {
      const { instanceId } = await startWith([
        employeeStep(1, managerA.employeeId, { mode: 'quorum', quorum: 2 }),
        employeeStep(1, managerB.employeeId, { mode: 'quorum', quorum: 2 }),
        employeeStep(1, managerC.employeeId, { mode: 'quorum', quorum: 2 }),
      ]);
      const tasks = await tasksOf(instanceId);

      await asUser(tenant, managerA.userId, (tx) =>
        workflow.decide(tx, tasks.find((t) => t.approver_employee_id === managerA.employeeId)!.id,
          'rejected', 'no', managerA.employeeId, []));
      await asUser(tenant, managerB.userId, (tx) =>
        workflow.decide(tx, tasks.find((t) => t.approver_employee_id === managerB.employeeId)!.id,
          'rejected', 'also no', managerB.employeeId, []));

      // One approver left, two approvals needed: unreachable.
      assert.equal((await instanceOf(instanceId)).status, 'rejected');
    });

    it('rejects an ALL group on the first rejection, as it always did', async () => {
      const { instanceId } = await startWith([
        employeeStep(1, managerA.employeeId),
        employeeStep(1, managerB.employeeId),
      ]);
      const tasks = await tasksOf(instanceId);
      await asUser(tenant, managerA.userId, (tx) =>
        workflow.decide(tx, tasks[0]!.id, 'rejected', 'no', tasks[0]!.approver_employee_id!, []));
      assert.equal((await instanceOf(instanceId)).status, 'rejected');
    });
  });

  // -------------------------------------------------------------- maker-checker

  describe('self-approval', () => {
    it('refuses the user who raised the request', async () => {
      // The requester is also the assigned approver, which is exactly the configuration
      // maker-checker exists to catch.
      const { instanceId } = await startWith([employeeStep(1, requester.employeeId)], {
        subject: managerA.employeeId, initiator: requester.userId,
      });
      const task = (await tasksOf(instanceId))[0]!;

      await assert.rejects(
        asUser(tenant, requester.userId, (tx) =>
          workflow.decide(tx, task.id, 'approved', undefined, requester.employeeId, [])),
        /cannot approve a request you raised/,
      );
    });

    it('is scoped to the requester, and does not extend to the subject', async () => {
      // The boundary of the rule the PRD actually states. s.17 bars "a requester" from
      // approving "their own request"; it says nothing about the person a request is *about*,
      // and the word subject appears in the PRD only in the phrase "email subject lines".
      //
      // So when HR raises a change about someone else and that someone is the approver, this
      // engine permits it. Pinned deliberately, in both directions: it stops the rule being
      // silently widened back to an invented one, and it makes the gap visible if the product
      // later decides the subject should be barred too.
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)], {
        subject: managerA.employeeId, initiator: requester.userId,
      });
      const task = (await tasksOf(instanceId))[0]!;

      const result = await asUser(tenant, managerA.userId, (tx) =>
        workflow.decide(tx, task.id, 'approved', undefined, managerA.employeeId, []));
      assert.equal(result.outcome, 'approved');
    });

    it('still refuses the requester even when they are also the subject', async () => {
      // The common shape — someone raising their own leave — is covered by the requester
      // rule alone, which is why narrowing to the PRD's wording loses nothing in practice.
      const { instanceId } = await startWith([employeeStep(1, requester.employeeId)], {
        subject: requester.employeeId, initiator: requester.userId,
      });
      const task = (await tasksOf(instanceId))[0]!;

      await assert.rejects(
        asUser(tenant, requester.userId, (tx) =>
          workflow.decide(tx, task.id, 'approved', undefined, requester.employeeId, [])),
        /cannot approve a request you raised/,
      );
    });

    it('allows a different authorized approver', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      const task = (await tasksOf(instanceId))[0]!;
      const result = await asUser(tenant, managerA.userId, (tx) =>
        workflow.decide(tx, task.id, 'approved', undefined, managerA.employeeId, []));
      assert.equal(result.outcome, 'approved');
    });

    it('is not bypassable by delegating to the requester', async () => {
      // The requester holds a delegation from the assigned approver. Delegation widens who
      // may act; it can never make the maker the checker (PRD s.16.6, s.17).
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      await tenant.as((tx) =>
        workflow.createDelegation(tx, {
          delegatorUserId: managerA.userId,
          delegateUserId: requester.userId,
          entityTypes: ['employee_change'],
          startsAt: new Date(Date.now() - 3_600_000),
          endsAt: new Date(Date.now() + 3_600_000),
        }).then(() => undefined),
      );
      const task = (await tasksOf(instanceId))[0]!;

      await assert.rejects(
        asUser(tenant, requester.userId, (tx) =>
          workflow.decide(tx, task.id, 'approved', undefined, requester.employeeId, [])),
        /cannot approve a request you raised/,
      );
    });
  });

  // -------------------------------------------------------------- rejection reason

  describe('rejection reason', () => {
    it('refuses a missing reason', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      const task = (await tasksOf(instanceId))[0]!;
      await assert.rejects(
        asUser(tenant, managerA.userId, (tx) =>
          workflow.decide(tx, task.id, 'rejected', undefined, managerA.employeeId, [])),
        /must include a reason/,
      );
    });

    it('refuses a whitespace-only reason', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      const task = (await tasksOf(instanceId))[0]!;
      await assert.rejects(
        asUser(tenant, managerA.userId, (tx) =>
          workflow.decide(tx, task.id, 'rejected', '   \t  ', managerA.employeeId, [])),
        /must include a reason/,
      );
    });

    it('stores a real reason with the actor and the time', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      const task = (await tasksOf(instanceId))[0]!;
      await asUser(tenant, managerA.userId, (tx) =>
        workflow.decide(tx, task.id, 'rejected', '  budget not approved  ', managerA.employeeId, []));

      const decided = (await tasksOf(instanceId))[0]!;
      assert.equal(decided.decision_note, 'budget not approved', 'the reason is trimmed, not padded');
      assert.equal(decided.decided_by, managerA.userId);
    });

    it('is enforced by the database, not only the service', async () => {
      await assert.rejects(
        tenant.as((tx) => tx.query(
          `UPDATE workflow.approval_task SET status = 'rejected', decision_note = '   '
            WHERE tenant_id = $1 AND status = 'pending'`, [tx.tenantId]).then(() => undefined)),
        /approval_task_rejection_reason/,
      );
    });
  });

  // -------------------------------------------------------------- delegation

  describe('delegation', () => {
    const window = () => ({
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: new Date(Date.now() + 3_600_000),
    });

    it('lets an active delegate act, and records both identities', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      await tenant.as((tx) =>
        workflow.createDelegation(tx, {
          delegatorUserId: managerA.userId, delegateUserId: managerB.userId,
          entityTypes: ['employee_change'], ...window(),
        }).then(() => undefined));

      const task = (await tasksOf(instanceId))[0]!;
      const result = await asUser(tenant, managerB.userId, (tx) =>
        workflow.decide(tx, task.id, 'approved', undefined, managerB.employeeId, []));
      assert.equal(result.outcome, 'approved');

      const decided = (await tasksOf(instanceId))[0]!;
      assert.equal(decided.decided_by, managerB.userId, 'the actor is who actually decided');
      assert.equal(decided.decided_on_behalf_of_user_id, managerA.userId, 'and whose authority they used');
    });

    it('refuses an expired delegation', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      await tenant.as((tx) =>
        workflow.createDelegation(tx, {
          delegatorUserId: managerA.userId, delegateUserId: managerB.userId,
          entityTypes: ['employee_change'],
          startsAt: new Date(Date.now() - 7_200_000),
          endsAt: new Date(Date.now() - 3_600_000),
        }).then(() => undefined));

      const task = (await tasksOf(instanceId))[0]!;
      await assert.rejects(
        asUser(tenant, managerB.userId, (tx) =>
          workflow.decide(tx, task.id, 'approved', undefined, managerB.employeeId, [])),
        /assigned to someone else/,
      );
    });

    it('refuses a delegation that has not started', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      await tenant.as((tx) =>
        workflow.createDelegation(tx, {
          delegatorUserId: managerA.userId, delegateUserId: managerB.userId,
          entityTypes: ['employee_change'],
          startsAt: new Date(Date.now() + 3_600_000),
          endsAt: new Date(Date.now() + 7_200_000),
        }).then(() => undefined));

      const task = (await tasksOf(instanceId))[0]!;
      await assert.rejects(
        asUser(tenant, managerB.userId, (tx) =>
          workflow.decide(tx, task.id, 'approved', undefined, managerB.employeeId, [])),
        /assigned to someone else/,
      );
    });

    it('refuses a revoked delegation', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      const delegation = await tenant.as((tx) =>
        workflow.createDelegation(tx, {
          delegatorUserId: managerA.userId, delegateUserId: managerB.userId,
          entityTypes: ['employee_change'], ...window(),
        }));
      await tenant.as((tx) => workflow.revokeDelegation(tx, delegation.id));

      const task = (await tasksOf(instanceId))[0]!;
      await assert.rejects(
        asUser(tenant, managerB.userId, (tx) =>
          workflow.decide(tx, task.id, 'approved', undefined, managerB.employeeId, [])),
        /assigned to someone else/,
      );
    });

    it('refuses a delegation scoped to a different workflow type', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      await tenant.as((tx) =>
        workflow.createDelegation(tx, {
          delegatorUserId: managerA.userId, delegateUserId: managerB.userId,
          entityTypes: ['leave_application'], ...window(),
        }).then(() => undefined));

      const task = (await tasksOf(instanceId))[0]!;
      await assert.rejects(
        asUser(tenant, managerB.userId, (tx) =>
          workflow.decide(tx, task.id, 'approved', undefined, managerB.employeeId, [])),
        /assigned to someone else/,
      );
    });

    it('grants nothing when the delegator had no authority over the task', async () => {
      // The delegator is not the approver. A delegation from someone with no say confers
      // no say — it is not a permission of its own.
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      await tenant.as((tx) =>
        workflow.createDelegation(tx, {
          delegatorUserId: stranger.userId, delegateUserId: managerB.userId,
          entityTypes: ['employee_change'], ...window(),
        }).then(() => undefined));

      const task = (await tasksOf(instanceId))[0]!;
      await assert.rejects(
        asUser(tenant, managerB.userId, (tx) =>
          workflow.decide(tx, task.id, 'approved', undefined, managerB.employeeId, [])),
        /assigned to someone else/,
      );
    });

    it('refuses self-delegation and a reversed window', async () => {
      await assert.rejects(
        tenant.as((tx) => workflow.createDelegation(tx, {
          delegatorUserId: managerA.userId, delegateUserId: managerA.userId,
          entityTypes: ['employee_change'], ...window(),
        })),
        /cannot delegate to themselves/,
      );
      await assert.rejects(
        tenant.as((tx) => workflow.createDelegation(tx, {
          delegatorUserId: managerA.userId, delegateUserId: managerB.userId,
          entityTypes: ['employee_change'],
          startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now()),
        })),
        /must end after it starts/,
      );
    });

    it('refuses a delegate who is not a member of this tenant', async () => {
      const outsider = await makeActor(other, 'WFOUT');
      await assert.rejects(
        tenant.as((tx) => workflow.createDelegation(tx, {
          delegatorUserId: managerA.userId, delegateUserId: outsider.userId,
          entityTypes: ['employee_change'], ...window(),
        })),
        /active members of this tenant/,
      );
    });
  });

  // -------------------------------------------------------------- fallback

  describe('fallback', () => {
    it('uses the configured fallback when the step approver does not resolve', async () => {
      // No manager assigned, so `reporting_manager` cannot resolve.
      const subject = await makeActor(tenant, 'WFNOMGR');
      const { instanceId } = await startWith(
        [{
          sequence: 1, approver: 'reporting_manager', skip_if_unresolved: false,
          fallback: { approver: 'employee', employee_id: managerC.employeeId },
        } as workflow.WorkflowStep],
        { subject: subject.employeeId },
      );

      const task = (await tasksOf(instanceId))[0]!;
      assert.equal(task.approver_employee_id, managerC.employeeId);
      assert.equal(task.is_fallback, true);
      assert.equal(task.fallback_reason, 'approver_unresolved');
    });

    it('audits the activation rather than substituting silently', async () => {
      const subject = await makeActor(tenant, 'WFNOMGR2');
      const { instanceId } = await startWith(
        [{
          sequence: 1, approver: 'reporting_manager', skip_if_unresolved: false,
          fallback: { approver: 'employee', employee_id: managerC.employeeId },
        } as workflow.WorkflowStep],
        { subject: subject.employeeId },
      );

      const entries = await tenant.as(async (tx) => {
        const { rows } = await tx.query<{ action: string; is_sensitive: boolean }>(
          `SELECT action, is_sensitive FROM audit.audit_log
            WHERE tenant_id = $1 AND entity_id = $2 AND action = 'workflow.fallback_activated'`,
          [tx.tenantId, instanceId]);
        return rows;
      });
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.is_sensitive, true, 'changing who may approve is a sensitive act');
    });

    it('blocks rather than inventing an approver when the fallback does not resolve either', async () => {
      const subject = await makeActor(tenant, 'WFNOMGR3');
      await tenant.as((tx) =>
        workflow.upsertDefinition(tx, {
          name: 'Bad fallback', entityType: 'employee_change',
          steps: [{
            sequence: 1, approver: 'reporting_manager', skip_if_unresolved: false,
            fallback: { approver: 'role', role_name: 'no-such-role-here' },
          } as workflow.WorkflowStep],
        }).then(() => undefined));

      await assert.rejects(
        asUser(tenant, requester.userId, (tx) =>
          workflow.startWorkflow(tx, 'employee_change', uuid(), subject.employeeId)),
        /fallback does not resolve/,
      );
    });
  });

  // -------------------------------------------------------------- SLA and escalation

  describe('SLA and escalation', () => {
    it('freezes due_at from the definition the instance started under', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId, { sla_hours: 4 })]);
      const before = await tenant.as(async (tx) => {
        const { rows } = await tx.query<{ due_at: Date }>(
          `SELECT due_at FROM workflow.approval_task WHERE tenant_id = $1 AND workflow_instance_id = $2`,
          [tx.tenantId, instanceId]);
        return rows[0]!.due_at;
      });
      assert.ok(before, 'an SLA step must have a due date');

      // A later edit lengthens the SLA. The running instance keeps its own deadline.
      await tenant.as((tx) =>
        workflow.upsertDefinition(tx, {
          name: 'Slower', entityType: 'employee_change',
          steps: [employeeStep(1, managerA.employeeId, { sla_hours: 400 })],
        }).then(() => undefined));

      const after = await tenant.as(async (tx) => {
        const { rows } = await tx.query<{ due_at: Date }>(
          `SELECT due_at FROM workflow.approval_task WHERE tenant_id = $1 AND workflow_instance_id = $2`,
          [tx.tenantId, instanceId]);
        return rows[0]!.due_at;
      });
      assert.equal(after.getTime(), before.getTime());
    });

    it('escalates an overdue task by widening who may act, without deciding it', async () => {
      const { instanceId } = await startWith([
        employeeStep(1, managerA.employeeId, {
          sla_hours: 1, escalate_to: { approver: 'employee', employee_id: managerC.employeeId },
        }),
      ]);
      await tenant.as((tx) =>
        tx.query(`UPDATE workflow.approval_task SET due_at = now() - INTERVAL '2 hours'
                   WHERE tenant_id = $1 AND workflow_instance_id = $2`,
          [tx.tenantId, instanceId]).then(() => undefined));

      const count = await tenant.as((tx) => escalateOverdueTasks(tx));
      assert.equal(count, 1);

      const task = (await tasksOf(instanceId))[0]!;
      assert.equal(task.status, 'pending', 'escalation must not decide anything');
      assert.equal(task.escalated_to_employee_id, managerC.employeeId);
      assert.equal((await instanceOf(instanceId)).status, 'in_progress');
    });

    it('lets the escalation target act, and leaves the original approver able to as well', async () => {
      const { instanceId } = await startWith([
        employeeStep(1, managerA.employeeId, {
          sla_hours: 1, escalate_to: { approver: 'employee', employee_id: managerC.employeeId },
        }),
      ]);
      await tenant.as((tx) =>
        tx.query(`UPDATE workflow.approval_task SET due_at = now() - INTERVAL '2 hours'
                   WHERE tenant_id = $1 AND workflow_instance_id = $2`,
          [tx.tenantId, instanceId]).then(() => undefined));
      await tenant.as((tx) => escalateOverdueTasks(tx));

      const task = (await tasksOf(instanceId))[0]!;
      const result = await asUser(tenant, managerC.userId, (tx) =>
        workflow.decide(tx, task.id, 'approved', undefined, managerC.employeeId, []));
      assert.equal(result.outcome, 'approved');
    });

    it('records a failure when the escalation target does not resolve', async () => {
      const { instanceId } = await startWith([
        employeeStep(1, managerA.employeeId, {
          sla_hours: 1, escalate_to: { approver: 'role', role_name: 'nobody-has-this-role' },
        }),
      ]);
      await tenant.as((tx) =>
        tx.query(`UPDATE workflow.approval_task SET due_at = now() - INTERVAL '2 hours'
                   WHERE tenant_id = $1 AND workflow_instance_id = $2`,
          [tx.tenantId, instanceId]).then(() => undefined));

      const count = await tenant.as((tx) => escalateOverdueTasks(tx));
      assert.equal(count, 0);

      const failures = await tenant.as(async (tx) => {
        const { rows } = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit.audit_log
            WHERE tenant_id = $1 AND entity_id = $2 AND action = 'workflow.escalation_failed'`,
          [tx.tenantId, instanceId]);
        return rows[0]!.n;
      });
      assert.equal(failures, 1, 'an SLA that passed with nowhere to escalate must be visible');
    });

    it('does not escalate a task twice', async () => {
      const { instanceId } = await startWith([
        employeeStep(1, managerA.employeeId, {
          sla_hours: 1, escalate_to: { approver: 'employee', employee_id: managerC.employeeId },
        }),
      ]);
      await tenant.as((tx) =>
        tx.query(`UPDATE workflow.approval_task SET due_at = now() - INTERVAL '2 hours'
                   WHERE tenant_id = $1 AND workflow_instance_id = $2`,
          [tx.tenantId, instanceId]).then(() => undefined));

      assert.equal(await tenant.as((tx) => escalateOverdueTasks(tx)), 1);
      assert.equal(await tenant.as((tx) => escalateOverdueTasks(tx)), 0, 'the sweep must be idempotent');
    });
  });

  // -------------------------------------------------------------- resubmission

  describe('resubmission', () => {
    it('creates a new attempt and leaves the rejection exactly as it was', async () => {
      const { instanceId, entityId } = await startWith([employeeStep(1, managerA.employeeId)]);
      const task = (await tasksOf(instanceId))[0]!;
      await asUser(tenant, managerA.userId, (tx) =>
        workflow.decide(tx, task.id, 'rejected', 'missing evidence', managerA.employeeId, []));

      const rejectedBefore = await instanceOf(instanceId);
      const rejectedTaskBefore = (await tasksOf(instanceId))[0]!;

      const retry = await asUser(tenant, requester.userId, (tx) =>
        workflow.resubmitWorkflow(tx, instanceId));

      assert.ok(retry.instanceId && retry.instanceId !== instanceId, 'a new attempt has a new identity');
      assert.equal(retry.attemptNo, 2);

      const fresh = await instanceOf(retry.instanceId!);
      assert.equal(fresh.supersedes_instance_id, instanceId);
      assert.equal(fresh.status, 'in_progress');

      const rejectedAfter = await instanceOf(instanceId);
      assert.deepEqual(
        { status: rejectedAfter.status, attempt: rejectedAfter.attempt_no },
        { status: rejectedBefore.status, attempt: rejectedBefore.attempt_no },
        'the rejected attempt is history and must not move',
      );
      const rejectedTaskAfter = (await tasksOf(instanceId))[0]!;
      assert.equal(rejectedTaskAfter.decision_note, rejectedTaskBefore.decision_note);
      assert.equal(rejectedTaskAfter.status, 'rejected');
      assert.equal(entityId.length, 36);
    });

    it('will not let a decision on the old attempt touch the new one', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      const oldTask = (await tasksOf(instanceId))[0]!;
      await asUser(tenant, managerA.userId, (tx) =>
        workflow.decide(tx, oldTask.id, 'rejected', 'no', managerA.employeeId, []));
      const retry = await asUser(tenant, requester.userId, (tx) => workflow.resubmitWorkflow(tx, instanceId));

      // The old task is settled; deciding it again is refused, and the new attempt is
      // untouched by the attempt.
      await assert.rejects(
        asUser(tenant, managerA.userId, (tx) =>
          workflow.decide(tx, oldTask.id, 'approved', undefined, managerA.employeeId, [])),
        /already been decided|already been actioned/,
      );
      assert.equal((await instanceOf(retry.instanceId!)).status, 'in_progress');
    });

    it('refuses to resubmit something that was not rejected', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      await assert.rejects(
        asUser(tenant, requester.userId, (tx) => workflow.resubmitWorkflow(tx, instanceId)),
        /Only a rejected request/,
      );
    });

    it('uses the definition version active now, not the rejected attempt\'s', async () => {
      await tenant.as((tx) =>
        workflow.upsertDefinition(tx, {
          name: 'V1', entityType: 'employee_change', steps: [employeeStep(1, managerA.employeeId)],
        }).then(() => undefined));
      const entityId = uuid();
      const first = await asUser(tenant, requester.userId, (tx) =>
        workflow.startWorkflow(tx, 'employee_change', entityId, requester.employeeId));
      const v1 = (await instanceOf(first.instanceId!)).definition_version;

      const task = (await tasksOf(first.instanceId!))[0]!;
      await asUser(tenant, managerA.userId, (tx) =>
        workflow.decide(tx, task.id, 'rejected', 'no', managerA.employeeId, []));

      await tenant.as((tx) =>
        workflow.upsertDefinition(tx, {
          name: 'V2', entityType: 'employee_change', steps: [employeeStep(1, managerB.employeeId)],
        }).then(() => undefined));

      const retry = await asUser(tenant, requester.userId, (tx) =>
        workflow.resubmitWorkflow(tx, first.instanceId!));
      const v2 = (await instanceOf(retry.instanceId!)).definition_version;

      assert.ok(v2 > v1, 'a resubmission is a new request and uses the current rules');
      assert.equal((await instanceOf(first.instanceId!)).definition_version, v1, 'the old attempt keeps its version');
      assert.equal((await tasksOf(retry.instanceId!))[0]!.approver_employee_id, managerB.employeeId);
    });
  });

  // -------------------------------------------------------------- version pinning

  describe('definition version pinning', () => {
    it('keeps a running instance on the version that created it', async () => {
      await tenant.as((tx) =>
        workflow.upsertDefinition(tx, {
          name: 'V1', entityType: 'employee_change', steps: [employeeStep(1, managerA.employeeId)],
        }).then(() => undefined));
      const running = await asUser(tenant, requester.userId, (tx) =>
        workflow.startWorkflow(tx, 'employee_change', uuid(), requester.employeeId));
      const pinned = (await instanceOf(running.instanceId!)).definition_version;

      await tenant.as((tx) =>
        workflow.upsertDefinition(tx, {
          name: 'V2', entityType: 'employee_change',
          steps: [employeeStep(1, managerB.employeeId), employeeStep(2, managerC.employeeId)],
        }).then(() => undefined));

      // The running instance still has one task, still assigned to A.
      const tasks = await tasksOf(running.instanceId!);
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]!.approver_employee_id, managerA.employeeId);
      assert.equal((await instanceOf(running.instanceId!)).definition_version, pinned);

      // A new instance gets the new rules.
      const fresh = await asUser(tenant, requester.userId, (tx) =>
        workflow.startWorkflow(tx, 'employee_change', uuid(), requester.employeeId));
      assert.equal((await tasksOf(fresh.instanceId!)).length, 2);
      assert.ok((await instanceOf(fresh.instanceId!)).definition_version > pinned);
    });
  });

  // -------------------------------------------------------------- concurrency

  describe('concurrency', () => {
    it('lets exactly one of two simultaneous decisions on one task win', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      const task = (await tasksOf(instanceId))[0]!;

      const results = await Promise.allSettled([
        asUser(tenant, managerA.userId, (tx) =>
          workflow.decide(tx, task.id, 'approved', undefined, managerA.employeeId, [])),
        asUser(tenant, managerA.userId, (tx) =>
          workflow.decide(tx, task.id, 'approved', undefined, managerA.employeeId, [])),
      ]);

      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'one winner');
      assert.equal(results.filter((r) => r.status === 'rejected').length, 1, 'one refusal');
      assert.equal((await tasksOf(instanceId))[0]!.status, 'approved');
    });

    it('refuses to decide a task that is already settled, while the instance runs on', async () => {
      // The duplicate-decision case that the instance-level check does not catch: in an ALL
      // group the instance is still in_progress after the first task is decided, so nothing
      // upstream refuses a second decision on that same task. Without the task-state guard
      // it would be silently accepted and counted again.
      const { instanceId } = await startWith([
        employeeStep(1, managerA.employeeId),
        employeeStep(1, managerB.employeeId),
      ]);
      const tasks = await tasksOf(instanceId);
      const taskA = tasks.find((t) => t.approver_employee_id === managerA.employeeId)!;

      await asUser(tenant, managerA.userId, (tx) =>
        workflow.decide(tx, taskA.id, 'approved', undefined, managerA.employeeId, []));
      assert.equal((await instanceOf(instanceId)).status, 'in_progress', 'the group is not finished yet');

      await assert.rejects(
        asUser(tenant, managerA.userId, (tx) =>
          workflow.decide(tx, taskA.id, 'rejected', 'changed my mind', managerA.employeeId, [])),
        /already been actioned/,
      );

      // And the first decision stands, unchanged.
      const after = (await tasksOf(instanceId)).find((t) => t.id === taskA.id)!;
      assert.equal(after.status, 'approved');
      assert.equal(after.decision_note, null);
    });

    it('settles an ANY group once when two approvals land together', async () => {
      const { instanceId } = await startWith([
        employeeStep(1, managerA.employeeId, { mode: 'any' }),
        employeeStep(1, managerB.employeeId, { mode: 'any' }),
      ]);
      const tasks = await tasksOf(instanceId);
      const a = tasks.find((t) => t.approver_employee_id === managerA.employeeId)!;
      const b = tasks.find((t) => t.approver_employee_id === managerB.employeeId)!;

      await Promise.allSettled([
        asUser(tenant, managerA.userId, (tx) =>
          workflow.decide(tx, a.id, 'approved', undefined, managerA.employeeId, [])),
        asUser(tenant, managerB.userId, (tx) =>
          workflow.decide(tx, b.id, 'approved', undefined, managerB.employeeId, [])),
      ]);

      const instance = await instanceOf(instanceId);
      assert.equal(instance.status, 'approved');
      const after = await tasksOf(instanceId);
      assert.equal(after.filter((t) => t.status === 'pending').length, 0, 'nothing may be left pending');
      assert.ok(after.some((t) => t.status === 'approved'));
    });

    it('reaches a single valid state when a quorum is decided concurrently', async () => {
      const { instanceId } = await startWith([
        employeeStep(1, managerA.employeeId, { mode: 'quorum', quorum: 2 }),
        employeeStep(1, managerB.employeeId, { mode: 'quorum', quorum: 2 }),
        employeeStep(1, managerC.employeeId, { mode: 'quorum', quorum: 2 }),
      ]);
      const tasks = await tasksOf(instanceId);

      // Paired by approver, not by array position: `tasksOf` orders by employee uuid, so
      // indexing would hand each manager somebody else's task and every decision would be
      // refused — which looks exactly like a concurrency failure and is not one.
      await Promise.allSettled(
        [managerA, managerB, managerC].map((m) => {
          const task = tasks.find((t) => t.approver_employee_id === m.employeeId)!;
          return asUser(tenant, m.userId, (tx) =>
            workflow.decide(tx, task.id, 'approved', undefined, m.employeeId, []));
        }),
      );

      const instance = await instanceOf(instanceId);
      const after = await tasksOf(instanceId);
      assert.equal(instance.status, 'approved');
      assert.ok(after.filter((t) => t.status === 'approved').length >= 2, 'the quorum was genuinely met');
      assert.equal(after.filter((t) => t.status === 'pending').length, 0);
    });

    it('serialises two deciders on one instance, deterministically', async () => {
      // The race that matters for a parallel group is two people deciding *different tasks
      // of the same instance* at the same moment. Under READ COMMITTED each transaction
      // would otherwise count the group seeing only its own approval: with a quorum of two
      // and two approvals landing together, neither sees two, neither settles the group,
      // and the instance ends with every task approved and its own status still
      // in_progress. `FOR UPDATE OF t, i` in `decide` is what prevents that.
      //
      // Constructed rather than hoped for: the first decision is held open until the second
      // is observed waiting on a lock.
      const { instanceId } = await startWith([
        employeeStep(1, managerA.employeeId, { mode: 'quorum', quorum: 2 }),
        employeeStep(1, managerB.employeeId, { mode: 'quorum', quorum: 2 }),
        employeeStep(1, managerC.employeeId, { mode: 'quorum', quorum: 2 }),
      ]);
      const tasks = await tasksOf(instanceId);
      const taskA = tasks.find((t) => t.approver_employee_id === managerA.employeeId)!;
      const taskB = tasks.find((t) => t.approver_employee_id === managerB.employeeId)!;

      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let firstPid = 0;
      let secondPid = 0;

      const first = asUser(tenant, managerA.userId, async (tx) => {
        const { rows } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        firstPid = rows[0]!.pid;
        await workflow.decide(tx, taskA.id, 'approved', undefined, managerA.employeeId, []);
        await held; // transaction stays open, still holding the instance row
      });

      // Wait for a condition rather than a duration: the first decider is parked on the
      // barrier, inside its transaction, once its backend reports idle in transaction. A
      // sleep here would be a race of its own under a loaded database.
      await waitFor(() => backendState(firstPid).then((st) => st === 'idle in transaction'),
        'the first decision to land and hold its transaction open');

      const second = asUser(tenant, managerB.userId, async (tx) => {
        const { rows } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        secondPid = rows[0]!.pid;
        return workflow.decide(tx, taskB.id, 'approved', undefined, managerB.employeeId, []);
      });

      // The property under test: the second decider waits for the first.
      await waitFor(
        async () => secondPid !== 0 && (await backendWaitEvent(secondPid)) === 'Lock',
        'the second decider to block on the first; without that the group is counted twice',
      );

      release();
      await first;
      await second;

      // Serialised, so the second saw the first's approval and the quorum settled once.
      assert.equal((await instanceOf(instanceId)).status, 'approved');
      const after = await tasksOf(instanceId);
      assert.equal(after.filter((t) => t.status === 'approved').length, 2);
      assert.equal(after.filter((t) => t.status === 'pending').length, 0);
    });

    it('produces one outcome when an approval and a rejection race', async () => {
      const { instanceId } = await startWith([
        employeeStep(1, managerA.employeeId),
        employeeStep(1, managerB.employeeId),
      ]);
      const tasks = await tasksOf(instanceId);
      const a = tasks.find((t) => t.approver_employee_id === managerA.employeeId)!;
      const b = tasks.find((t) => t.approver_employee_id === managerB.employeeId)!;

      await Promise.allSettled([
        asUser(tenant, managerA.userId, (tx) =>
          workflow.decide(tx, a.id, 'approved', undefined, managerA.employeeId, [])),
        asUser(tenant, managerB.userId, (tx) =>
          workflow.decide(tx, b.id, 'rejected', 'no', managerB.employeeId, [])),
      ]);

      // ALL mode: whichever order they land in, a rejection is decisive and the instance
      // must end rejected — never approved, and never still in progress.
      const instance = await instanceOf(instanceId);
      assert.equal(instance.status, 'rejected');
      assert.equal((await tasksOf(instanceId)).filter((t) => t.status === 'pending').length, 0);
    });
  });

  // -------------------------------------------------------------- domain events

  describe('domain events', () => {
    it('announces an approved instance once, whatever the group size', async () => {
      // Once per instance, not once per task: "the second of two approvers said yes" is the
      // group's own business, not something outside the engine can act on.
      const { instanceId, entityId } = await startWith([
        employeeStep(1, managerA.employeeId),
        employeeStep(1, managerB.employeeId),
      ]);
      const tasks = await tasksOf(instanceId);
      for (const m of [managerA, managerB]) {
        const task = tasks.find((t) => t.approver_employee_id === m.employeeId)!;
        await asUser(tenant, m.userId, (tx) =>
          workflow.decide(tx, task.id, 'approved', undefined, m.employeeId, []));
      }

      const events = await eventsOf(tenant, instanceId);
      const approved = events.filter((e) => e.event_type === 'WorkflowApproved');
      assert.equal(approved.length, 1);
      assert.equal(approved[0]!.aggregate_type, 'workflow_instance');
      assert.equal(approved[0]!.aggregate_id, instanceId);
      assert.equal(approved[0]!.tenant_id, tenant.tenantId);
      assert.equal(approved[0]!.payload.entity_id, entityId);
      assert.equal(approved[0]!.payload.entity_type, 'employee_change');
    });

    it('carries the established envelope fields', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      const task = (await tasksOf(instanceId))[0]!;
      await asUser(tenant, managerA.userId, (tx) =>
        workflow.decide(tx, task.id, 'approved', undefined, managerA.employeeId, []));

      const event = (await eventsOf(tenant, instanceId)).find((e) => e.event_type === 'WorkflowApproved')!;
      assert.equal(event.schema_version, 1);
      assert.equal(event.producer, 'hrms-api');
      assert.equal(event.tenant_id, tenant.tenantId);
    });

    it('announces a rejection', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      const task = (await tasksOf(instanceId))[0]!;
      await asUser(tenant, managerA.userId, (tx) =>
        workflow.decide(tx, task.id, 'rejected', 'no', managerA.employeeId, []));

      assert.deepEqual((await eventsOf(tenant, instanceId)).map((e) => e.event_type), ['WorkflowRejected']);
    });

    it('announces fallback and escalation against the instance', async () => {
      const subject = await makeActor(tenant, 'WFEVFB');
      const { instanceId } = await startWith(
        [{
          sequence: 1, approver: 'reporting_manager', skip_if_unresolved: false, sla_hours: 1,
          fallback: { approver: 'employee', employee_id: managerC.employeeId },
          escalate_to: { approver: 'employee', employee_id: managerB.employeeId },
        } as workflow.WorkflowStep],
        { subject: subject.employeeId },
      );
      assert.deepEqual(
        (await eventsOf(tenant, instanceId)).map((e) => e.event_type),
        ['WorkflowFallbackActivated'],
      );

      await tenant.as((tx) =>
        tx.query(`UPDATE workflow.approval_task SET due_at = now() - INTERVAL '2 hours'
                   WHERE tenant_id = $1 AND workflow_instance_id = $2`,
          [tx.tenantId, instanceId]).then(() => undefined));
      await tenant.as((tx) => escalateOverdueTasks(tx));

      const escalated = (await eventsOf(tenant, instanceId)).filter((e) => e.event_type === 'WorkflowEscalated');
      assert.equal(escalated.length, 1);
      assert.equal(escalated[0]!.payload.escalated_to_employee_id, managerB.employeeId);
    });

    it('announces an escalation that could not resolve, without granting anyone authority', async () => {
      const { instanceId } = await startWith([
        employeeStep(1, managerA.employeeId, {
          sla_hours: 1, escalate_to: { approver: 'role', role_name: 'no-such-role' },
        }),
      ]);
      await tenant.as((tx) =>
        tx.query(`UPDATE workflow.approval_task SET due_at = now() - INTERVAL '2 hours'
                   WHERE tenant_id = $1 AND workflow_instance_id = $2`,
          [tx.tenantId, instanceId]).then(() => undefined));
      await tenant.as((tx) => escalateOverdueTasks(tx));

      assert.deepEqual(
        (await eventsOf(tenant, instanceId)).map((e) => e.event_type), ['WorkflowEscalationFailed']);
      assert.equal((await tasksOf(instanceId))[0]!.escalated_to_employee_id, null);
    });

    it('announces delegation and revocation against the delegation, not the instance', async () => {
      const delegation = await tenant.as((tx) =>
        workflow.createDelegation(tx, {
          delegatorUserId: managerA.userId, delegateUserId: managerB.userId,
          entityTypes: ['employee_change'],
          startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 3_600_000),
        }));

      let events = await eventsOf(tenant, delegation.id);
      assert.deepEqual(events.map((e) => e.event_type), ['WorkflowDelegated']);
      assert.equal(events[0]!.aggregate_type, 'workflow_delegation');
      assert.equal(events[0]!.payload.delegator_user_id, managerA.userId);

      await tenant.as((tx) => workflow.revokeDelegation(tx, delegation.id));
      events = await eventsOf(tenant, delegation.id);
      assert.deepEqual(events.map((e) => e.event_type), ['WorkflowDelegated', 'WorkflowDelegationRevoked']);
    });

    it('announces a resubmission against the new attempt', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      const task = (await tasksOf(instanceId))[0]!;
      await asUser(tenant, managerA.userId, (tx) =>
        workflow.decide(tx, task.id, 'rejected', 'no', managerA.employeeId, []));
      const retry = await asUser(tenant, requester.userId, (tx) => workflow.resubmitWorkflow(tx, instanceId));

      const resubmitted = (await eventsOf(tenant, retry.instanceId!))
        .find((e) => e.event_type === 'WorkflowResubmitted')!;
      assert.ok(resubmitted);
      assert.equal(resubmitted.payload.supersedes_instance_id, instanceId);
      assert.equal(resubmitted.payload.attempt_no, 2);
      assert.deepEqual(
        (await eventsOf(tenant, instanceId)).map((e) => e.event_type), ['WorkflowRejected']);
    });

    it('emits nothing when the transaction that would have emitted it fails', async () => {
      // The outbox property: the row and the event commit together, so a business failure
      // cannot leave an announcement behind (ADR-004).
      const count = async () => tenant.as(async (tx) => {
        const { rows } = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM integration.event_outbox
            WHERE tenant_id = $1 AND event_type = 'WorkflowDelegated'`, [tx.tenantId]);
        return rows[0]!.n;
      });
      const before = await count();

      await assert.rejects(
        tenant.as(async (tx) => {
          await workflow.createDelegation(tx, {
            delegatorUserId: managerA.userId, delegateUserId: managerC.userId,
            entityTypes: ['employee_change'],
            startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 3_600_000),
          });
          throw new Error('business failure after the event was written');
        }),
        /business failure/,
      );

      assert.equal(await count(), before, 'a rolled-back transaction must leave no event');
    });

    it('does not emit twice when the same decision is repeated', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      const task = (await tasksOf(instanceId))[0]!;
      await asUser(tenant, managerA.userId, (tx) =>
        workflow.decide(tx, task.id, 'approved', undefined, managerA.employeeId, []));

      await assert.rejects(
        asUser(tenant, managerA.userId, (tx) =>
          workflow.decide(tx, task.id, 'approved', undefined, managerA.employeeId, [])),
        /already been decided|already been actioned/,
      );

      assert.equal(
        (await eventsOf(tenant, instanceId)).filter((e) => e.event_type === 'WorkflowApproved').length, 1);
    });

    it('emits no event when a cross-tenant decision is refused', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      const task = (await tasksOf(instanceId))[0]!;

      await assert.rejects(
        other.as((tx) => workflow.decide(tx, task.id, 'approved', undefined, null, [])),
        /not found|Approval task/i,
      );

      assert.deepEqual(await eventsOf(other, instanceId), [], 'no event under the other tenant');
      assert.deepEqual(await eventsOf(tenant, instanceId), [], 'and none under the real one either');
    });

    it('leaves the domain to announce its own entity', async () => {
      // A workflow event is about the approval; LeaveApproved and friends are about the
      // entity and are emitted by their own modules. Only the workflow event appears here,
      // so the engine never announces the same thing twice.
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      const task = (await tasksOf(instanceId))[0]!;
      await asUser(tenant, managerA.userId, (tx) =>
        workflow.decide(tx, task.id, 'approved', undefined, managerA.employeeId, []));

      assert.deepEqual((await eventsOf(tenant, instanceId)).map((e) => e.event_type), ['WorkflowApproved']);
    });
  });

  // -------------------------------------------------------------- tenant isolation

  describe('tenant isolation', () => {
    it('treats another tenant task as nonexistent, not forbidden', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      const task = (await tasksOf(instanceId))[0]!;

      await assert.rejects(
        other.as((tx) => workflow.decide(tx, task.id, 'approved', undefined, null, [])),
        (err: Error) => {
          assert.match(err.message, /not found|Approval task/i);
          assert.doesNotMatch(err.message, /assigned to someone else/);
          return true;
        },
      );
    });

    it('hides another tenant workflow instance from resubmission', async () => {
      const { instanceId } = await startWith([employeeStep(1, managerA.employeeId)]);
      await assert.rejects(
        other.as((tx) => workflow.resubmitWorkflow(tx, instanceId)),
        /not found|Workflow instance/i,
      );
    });

    it('does not list another tenant delegations', async () => {
      await tenant.as((tx) =>
        workflow.createDelegation(tx, {
          delegatorUserId: managerA.userId, delegateUserId: managerB.userId,
          entityTypes: ['employee_change'],
          startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 3_600_000),
        }).then(() => undefined));

      assert.ok((await tenant.as((tx) => workflow.listDelegations(tx))).length > 0);
      assert.deepEqual(await other.as((tx) => workflow.listDelegations(tx)), []);
    });

    it('fails closed on delegations with no tenant context', async () => {
      const client = await getAppPool().connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM workflow.workflow_delegation');
        assert.equal(rows[0]!.n, 0);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });

    it('will not escalate across a tenant boundary', async () => {
      const { instanceId } = await startWith([
        employeeStep(1, managerA.employeeId, {
          sla_hours: 1, escalate_to: { approver: 'employee', employee_id: managerC.employeeId },
        }),
      ]);
      await tenant.as((tx) =>
        tx.query(`UPDATE workflow.approval_task SET due_at = now() - INTERVAL '2 hours'
                   WHERE tenant_id = $1 AND workflow_instance_id = $2`,
          [tx.tenantId, instanceId]).then(() => undefined));

      assert.equal(await other.as((tx) => escalateOverdueTasks(tx)), 0, 'another tenant sweep must see nothing');
      assert.equal((await tasksOf(instanceId))[0]!.escalated_to_employee_id, null);
    });
  });
});
