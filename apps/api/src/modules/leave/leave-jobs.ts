import type { TenantTx } from '../../infra/db/pool.ts';
import type { ClaimedJob, ScheduleRequest, TenantClock } from '../../infra/scheduler/jobs.ts';
import type { JobDefinition, JobOutcome } from '../../infra/scheduler/registry.ts';
import { financialYearOf } from '../tenant/financial-year.ts';
import { runAccrual, runCarryForward } from './period-jobs.ts';

/**
 * Leave accrual and carry-forward, as scheduled jobs.
 *
 * Both were reachable only from an API call, which meant a tenant whose administrator
 * forgot to press the button on the first of the financial year quietly did not accrue
 * anyone's leave — and carry-forward that never runs takes days away from employees who
 * earned them. Scheduling them is the point of generalising the job framework.
 *
 * Two deliberate restrictions:
 *
 *   * Only `annual` policy rules are scheduled. Monthly and quarterly accrual frequencies
 *     are modelled on the rule but `runAccrual` grants the full annual allocation, so
 *     automating them would grant twelve years of leave in a year. They stay manual until
 *     the period arithmetic for them exists (see remaining gaps in the RKL).
 *
 *   * Nothing is scheduled for a financial year that began before the tenant existed. A
 *     tenant onboarded mid-year has already had its opening balances loaded by whoever set
 *     it up; running an accrual for that year on deploy day would grant a second one.
 */

export const LEAVE_ACCRUAL_JOB = 'leave.accrual';
export const LEAVE_CARRY_FORWARD_JOB = 'leave.carry_forward';

export const leaveAccrualJob: JobDefinition = {
  jobType: LEAVE_ACCRUAL_JOB,

  async plan(tx: TenantTx, clock: TenantClock): Promise<ScheduleRequest[]> {
    const fy = financialYearOf(clock.local_date, clock.fy_start_month);
    if (fy.start < clock.created_date) return [];

    // One job per leave type, so a type whose accrual fails does not block the others and
    // so the job key is meaningful when someone asks what ran.
    const { rows } = await tx.query<{ leave_type_id: string }>(
      `SELECT DISTINCT r.leave_type_id
         FROM leave_mgmt.leave_policy_rule r
         JOIN leave_mgmt.leave_policy p
           ON p.tenant_id = r.tenant_id AND p.id = r.leave_policy_id
        WHERE r.tenant_id = $1
          AND r.accrual_frequency = 'annual'
          AND p.effective_from <= $2::date
          AND (p.effective_to IS NULL OR p.effective_to >= $3::date)`,
      [tx.tenantId, fy.end, fy.start],
    );

    return rows.map((row) => ({
      jobType: LEAVE_ACCRUAL_JOB,
      executionDate: fy.start,
      jobKey: row.leave_type_id,
      payload: { period_start: fy.start, period_end: fy.end, leave_type_id: row.leave_type_id },
    }));
  },

  async execute(tx: TenantTx, job: ClaimedJob): Promise<JobOutcome> {
    const result = await runAccrual(tx, {
      periodStart: String(job.payload.period_start),
      periodEnd: String(job.payload.period_end),
      leaveTypeId: job.job_key,
    });
    return {
      mode: 'completed',
      result: {
        leave_period_job_id: result.jobId,
        employees_processed: result.employeesProcessed,
        units_moved: result.unitsMoved,
        already_run: result.alreadyRun,
      },
    };
  },
};

export const leaveCarryForwardJob: JobDefinition = {
  jobType: LEAVE_CARRY_FORWARD_JOB,

  async plan(_tx: TenantTx, clock: TenantClock): Promise<ScheduleRequest[]> {
    const fy = financialYearOf(clock.local_date, clock.fy_start_month);
    // The previous year must have been spent under our management, or there is no ledger
    // to carry anything forward from.
    const previous = financialYearOf(addDays(fy.start, -1), clock.fy_start_month);
    if (previous.start < clock.created_date) return [];

    return [
      {
        jobType: LEAVE_CARRY_FORWARD_JOB,
        executionDate: fy.start,
        payload: {
          from_period_start: previous.start,
          from_period_end: previous.end,
          to_period_start: fy.start,
          to_period_end: fy.end,
        },
      },
    ];
  },

  async execute(tx: TenantTx, job: ClaimedJob): Promise<JobOutcome> {
    const result = await runCarryForward(tx, {
      fromPeriodStart: String(job.payload.from_period_start),
      fromPeriodEnd: String(job.payload.from_period_end),
      toPeriodStart: String(job.payload.to_period_start),
      toPeriodEnd: String(job.payload.to_period_end),
    });
    return {
      mode: 'completed',
      result: {
        leave_period_job_id: result.jobId,
        employees_processed: result.employeesProcessed,
        units_moved: result.unitsMoved,
        already_run: result.alreadyRun,
      },
    };
  },
};

function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
