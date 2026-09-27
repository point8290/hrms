import { attendanceCloseJob } from '../../modules/workforce/close-schedule.ts';
import { leaveAccrualJob, leaveCarryForwardJob } from '../../modules/leave/leave-jobs.ts';
import { payrollRecoveryJob } from '../../modules/payroll/run-recovery.ts';
import { workflowEscalationJob } from '../../modules/workflow/escalation-job.ts';
import { clearJobRegistry, registerJob } from './registry.ts';

/**
 * The scheduled jobs this deployment runs.
 *
 * Registration is explicit rather than a side effect of importing a module: a job that is
 * scheduled only because something happened to import a file is a job nobody can find, and
 * one that silently stops being scheduled when an import is tidied away.
 */
export function registerAllJobs(): void {
  clearJobRegistry();
  registerJob(attendanceCloseJob);
  registerJob(leaveAccrualJob);
  registerJob(leaveCarryForwardJob);
  registerJob(payrollRecoveryJob);
  registerJob(workflowEscalationJob);
}

export * from './jobs.ts';
export * from './registry.ts';
