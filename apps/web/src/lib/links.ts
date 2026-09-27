/**
 * The one place that turns a business object into a route.
 *
 * Notifications, "My Work" items and approval tasks all need to send somebody to the thing
 * they are about. Without a single resolver that logic gets copied into every component that
 * renders a list, and the copies drift — which is how a notification ends up linking to a
 * page that was renamed six months ago.
 *
 * The rule here is that **a destination is only offered when the route actually exists**.
 * PRD s.18.7 asks for deep links; it does not define destinations for entity types whose UI
 * has not been built. Inventing a URL for those would produce a link that 404s, which is
 * worse for the user than a notification that is plainly not clickable. So `resolve` returns
 * null for anything unmapped, callers render it as plain text, and the gap stays visible in
 * `UNROUTED` below rather than hidden inside a component.
 */

/** Entity types the product can currently navigate to. */
const ROUTES: Record<string, (id: string) => string> = {
  leave_application: () => '/leave',
  expense_claim: (id) => `/expenses/${id}`,
  attendance_correction: () => '/attendance',
  employee: (id) => `/employees/${id}`,
  payroll_run: (id) => `/payroll/${id}`,
  salary_slip: () => '/payslips',
  onboarding_plan: () => '/my-work',
  onboarding_task: () => '/my-work',
  approval_task: () => '/approvals',
  report_run: () => '/reports',
  tax_declaration: () => '/tax',
};

/**
 * Entity types that exist in the backend but have no screen yet.
 *
 * Listed explicitly so the absence is a documented product gap rather than a silent `null`,
 * and so a reader can tell "not built yet" apart from "typo in the entity type".
 */
export const UNROUTED = [
  // Delegation has a screen, but nothing addresses a single delegation by id.
  'workflow_delegation',
  'payment_batch',
  'document',
] as const;

/** A route for this entity, or null when the product has nowhere to send the user yet. */
export function resolve(entityType: string | null | undefined, entityId: string | null | undefined): string | null {
  if (!entityType) return null;
  const route = ROUTES[entityType];
  if (!route) return null;
  return route(entityId ?? '');
}

/**
 * Where a notification should lead.
 *
 * The notification's own payload carries the entity it is about, because the notification
 * table records what happened rather than where to look. Template codes map to the entity
 * type their payload contains — this is a presentation concern, so it lives here and not in
 * the notification catalogue, which is shared with the worker and must stay about delivery.
 */
const NOTIFICATION_ENTITY: Record<string, { type: string; key: string }> = {
  'leave.awaiting_approval': { type: 'approval_task', key: 'leave_application_id' },
  'leave.approved': { type: 'leave_application', key: 'leave_application_id' },
  'leave.rejected': { type: 'leave_application', key: 'leave_application_id' },
  'leave.cancelled': { type: 'leave_application', key: 'leave_application_id' },
  'expense.awaiting_approval': { type: 'approval_task', key: 'expense_claim_id' },
  'expense.approved': { type: 'expense_claim', key: 'expense_claim_id' },
  'expense.rejected': { type: 'expense_claim', key: 'expense_claim_id' },
  'expense.paid': { type: 'expense_claim', key: 'expense_claim_id' },
  'attendance.correction_decided': { type: 'attendance_correction', key: 'correction_id' },
  'payroll.payslip_available': { type: 'salary_slip', key: 'salary_slip_id' },
  'onboarding.task_assigned': { type: 'onboarding_plan', key: 'onboarding_plan_id' },
  'onboarding.completed': { type: 'onboarding_plan', key: 'onboarding_plan_id' },
  'employee.welcome': { type: 'employee', key: 'employee_id' },
};

export function notificationLink(notification: {
  template_code: string;
  payload?: Record<string, unknown> | null;
}): string | null {
  const mapping = NOTIFICATION_ENTITY[notification.template_code];
  if (!mapping) return null;
  const id = notification.payload?.[mapping.key];
  return resolve(mapping.type, typeof id === 'string' ? id : null);
}
