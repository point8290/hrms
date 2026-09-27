import { z } from 'zod';

export * from './notifications.ts';

/**
 * The event contract shared by the API, the Node worker and (mirrored in Python) the
 * calculation engines.
 *
 * tenant_id is required on every envelope. A background worker has no HTTP request and
 * no JWT, so the envelope is its only source of tenant context (ADR-004). An event
 * without it cannot be processed safely and must be dead-lettered.
 */
export const EVENT_TYPES = [
  'EmployeeCreated',
  'EmployeeUpdated',
  'EmployeeTransferred',
  'EmployeeSeparated',
  'CheckinRecorded',
  'AttendanceCalculated',
  'AttendanceCorrectionApproved',
  'AttendanceCloseRequested',
  'AttendanceClosed',
  'LeaveApplied',
  'LeaveApproved',
  'LeaveRejected',
  'LeaveCancelled',
  'OnboardingPlanCreated',
  'OnboardingCompleted',
  'ExpenseClaimSubmitted',
  'ExpenseClaimApproved',
  'ExpenseClaimRejected',
  'ExpensePaid',
  'PayrollRunCreated',
  'PayrollCalculated',
  'PayrollFinalized',
  'SalarySlipGenerated',
  'DocumentUploaded',
  // Asks the worker to generate and export a report (PRD s.22). Routed to the platform
  // queue by default: the generator is Node, next to the storage and document code it needs.
  'ReportRequested',

  /**
   * Workflow (PRD s.16, s.23). Emitted, not yet consumed — the contract exists so that
   * notifications can be built against it rather than against the approval engine's tables.
   *
   * Two aggregates, deliberately. The decision and lifecycle events are about the
   * **workflow instance**; the delegation events are about the **delegation** itself, which
   * outlives any one request.
   *
   * `WorkflowApproved` and `WorkflowRejected` describe the *approval* reaching an outcome.
   * They are not a replacement for the domain's own events: a leave approval also emits
   * `LeaveApproved`, which is about the leave. A consumer that wants to tell an employee
   * their leave was approved should listen to one of them, not both — the workflow event is
   * the right choice for entity types that have no domain event of their own
   * (employee_change, payroll_run, separation).
   */
  'WorkflowApproved',
  'WorkflowRejected',
  'WorkflowResubmitted',
  'WorkflowFallbackActivated',
  'WorkflowEscalated',
  /** An SLA passed and the configured target could not be resolved. Nobody gained authority. */
  'WorkflowEscalationFailed',
  'WorkflowDelegated',
  'WorkflowDelegationRevoked',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const QUEUES = {
  workforce: 'workforce-jobs',
  payroll: 'payroll-jobs',
  platform: 'platform-jobs',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Which queue carries each event. Unlisted events go to the platform queue. */
export const EVENT_ROUTING: Partial<Record<EventType, QueueName>> = {
  CheckinRecorded: QUEUES.workforce,
  AttendanceCorrectionApproved: QUEUES.workforce,
  AttendanceCloseRequested: QUEUES.workforce,
  PayrollRunCreated: QUEUES.payroll,
};

export function queueForEvent(eventType: EventType): QueueName {
  return EVENT_ROUTING[eventType] ?? QUEUES.platform;
}

export const eventEnvelopeSchema = z.object({
  event_id: z.string().uuid(),
  event_type: z.enum(EVENT_TYPES),
  schema_version: z.number().int().positive(),
  tenant_id: z.string().uuid(),
  aggregate_type: z.string().min(1),
  aggregate_id: z.string().uuid(),
  occurred_at: z.string().datetime({ offset: true }),
  producer: z.string().min(1),
  correlation_id: z.string().optional(),
  /**
   * W3C trace context of whatever caused this event. Optional because an event produced
   * before tracing existed, or by a producer that is not traced, must still be processable
   * — a missing trace is a gap in observability, never a reason to drop work.
   */
  traceparent: z.string().regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/).optional(),
  payload: z.record(z.unknown()).default({}),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export function parseEnvelope(raw: unknown): EventEnvelope {
  return eventEnvelopeSchema.parse(raw);
}

/** Payload shapes we rely on across process boundaries. Kept minimal on purpose: the
 *  consumer re-reads the database for anything authoritative rather than trusting a
 *  payload that may be stale by the time it is delivered. */
export const payloadSchemas = {
  CheckinRecorded: z.object({
    checkin_id: z.string().uuid(),
    employee_id: z.string().uuid(),
    checkin_at: z.string(),
    attendance_date_hint: z.string().optional(),
  }),
  AttendanceCalculated: z.object({
    employee_id: z.string().uuid(),
    attendance_date: z.string(),
    calculation_version: z.string(),
  }),
  AttendanceCloseRequested: z.object({
    close_run_id: z.string().uuid(),
    business_date: z.string(),
    attempt: z.number().int().positive(),
  }),
  AttendanceClosed: z.object({
    close_run_id: z.string().uuid(),
    business_date: z.string(),
    employee_count: z.number().int().nonnegative(),
  }),
  LeaveApproved: z.object({
    leave_application_id: z.string().uuid(),
    employee_id: z.string().uuid(),
    leave_type_id: z.string().uuid(),
    start_date: z.string(),
    end_date: z.string(),
    quantity: z.string(),
  }),
  PayrollRunCreated: z.object({
    payroll_run_id: z.string().uuid(),
    payroll_period_id: z.string().uuid(),
    employee_count: z.number().int().nonnegative(),
  }),
  PayrollCalculated: z.object({
    payroll_run_id: z.string().uuid(),
    calculation_version: z.string(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  PayrollFinalized: z.object({
    payroll_run_id: z.string().uuid(),
  }),
  OnboardingPlanCreated: z.object({
    onboarding_plan_id: z.string().uuid(),
    employee_id: z.string().uuid(),
    task_count: z.number().int().nonnegative(),
  }),
  OnboardingCompleted: z.object({
    onboarding_plan_id: z.string().uuid(),
    employee_id: z.string().uuid(),
  }),
  ExpenseClaimSubmitted: z.object({
    expense_claim_id: z.string().uuid(),
    employee_id: z.string().uuid(),
    claim_number: z.string(),
    total_claimed: z.string(),
  }),
  ExpenseClaimApproved: z.object({
    expense_claim_id: z.string().uuid(),
    employee_id: z.string().uuid(),
    sanctioned_amount: z.string(),
    reimbursable_amount: z.string(),
  }),
  ExpensePaid: z.object({
    expense_claim_id: z.string().uuid(),
    employee_id: z.string().uuid(),
    amount: z.string(),
  }),
  /**
   * Emitted per slip AFTER finalization (ADR-009), not when the engine writes a draft.
   * It means: an immutable salary slip artifact exists and may be turned into a document.
   */
  SalarySlipGenerated: z.object({
    salary_slip_id: z.string().uuid(),
    payroll_run_id: z.string().uuid(),
    employee_id: z.string().uuid(),
    slip_number: z.string(),
  }),
} as const;
