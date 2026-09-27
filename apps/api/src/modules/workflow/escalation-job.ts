import type { TenantTx } from '../../infra/db/pool.ts';
import type { ClaimedJob, ScheduleRequest, TenantClock } from '../../infra/scheduler/jobs.ts';
import type { JobDefinition, JobOutcome } from '../../infra/scheduler/registry.ts';
import { escalateOverdueTasks } from './service.ts';

/**
 * Sweeps approval tasks whose SLA has passed.
 *
 * On the existing scheduler rather than a timer of its own: claiming, attempt counting,
 * backoff, stale recovery and the audit trail are already solved there, and a second timing
 * mechanism would have to re-solve all of them (ADR-011).
 *
 * What the sweep does is narrow on purpose. It does not approve, reject or reassign anything
 * — it records that a task passed its SLA and adds the step's configured escalation target as
 * a second person who may act on it. An overdue approval still needs a human decision; what
 * changes is that someone else is now allowed to make it.
 *
 * Tenants with no SLA configured anywhere pay for one indexed lookup that returns nothing.
 */

export const WORKFLOW_ESCALATION_JOB = 'workflow.escalate_overdue';

export const workflowEscalationJob: JobDefinition = {
  jobType: WORKFLOW_ESCALATION_JOB,

  async plan(_tx: TenantTx, clock: TenantClock): Promise<ScheduleRequest[]> {
    // One sweep per tenant per local day, matching the payroll recovery sweep. An SLA is
    // measured in hours and the breach has already happened; finding it within the day is
    // what the escalation is for, and a per-tick sweep would be noise.
    return [{ jobType: WORKFLOW_ESCALATION_JOB, executionDate: clock.local_date }];
  },

  async execute(tx: TenantTx, _job: ClaimedJob): Promise<JobOutcome> {
    const escalated = await escalateOverdueTasks(tx);
    return { mode: 'completed', result: { escalated } };
  },
};
