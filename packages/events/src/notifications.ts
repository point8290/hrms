/**
 * The notification catalogue.
 *
 * One entry per notification this system sends, each declaring the category a preference is
 * expressed against, whether an employee may switch it off, and which channels carry it.
 * Shared between the worker (which sends) and the API (which shows an employee what they can
 * configure), so the two can never disagree about what is switchable.
 *
 * **Every classification below comes from the PRD, not from judgement about what seems
 * important.** PRD s.18.4 lists what "cannot be disabled"; s.18.5 lists what an employee
 * "may control". Anything named in neither list is `mandatory: true` — not because it is
 * especially important, but because a preference that was never defined cannot have been
 * granted, and the failure that matters here is the notification nobody received. An employee
 * cannot opt out of something the product never offered to let them opt out of.
 */

export type NotificationChannel = 'email' | 'in_app';

export type NotificationCategory =
  | 'payroll'
  | 'security'
  | 'leave'
  | 'expense'
  | 'attendance'
  | 'onboarding'
  | 'employee';

export type NotificationDefinition = {
  /** Template code, and the notification's identity for deduplication (PRD s.18.6). */
  template: string;
  category: NotificationCategory;
  /** True when PRD s.18.4 forbids disabling it, or when s.18.5 does not permit it. */
  mandatory: boolean;
  channels: readonly NotificationChannel[];
  /** Subject line. Never carries an amount — PRD s.18.8. */
  subject: string;
};

const BOTH: readonly NotificationChannel[] = ['email', 'in_app'];

export const NOTIFICATIONS = {
  // ---------------------------------------------------------------- mandatory (s.18.4)
  /** s.18.4 "payslip available". */
  'payroll.payslip_available': {
    template: 'payroll.payslip_available',
    category: 'payroll',
    mandatory: true,
    channels: BOTH,
    subject: 'Your payslip is available',
  },
  // s.18.4 also makes "payroll finalized" mandatory, and s.19 lists `payroll_finalized`.
  // It is deliberately absent here: the event exists and the classification exists, but
  // nothing in the PRD says *who receives it*. It is not employee-scoped like a payslip, and
  // choosing a recipient — the person who finalized it, everyone holding payroll.read,
  // finance — would be inventing a rule rather than implementing one. Reported as a gap.

  // -------------------------------------------- named in s.19 but in neither s.18.4 nor s.18.5
  /** s.19 "employee_created". Not listed as controllable, so it is not controllable. */
  'employee.welcome': {
    template: 'employee.welcome',
    category: 'employee',
    mandatory: true,
    channels: BOTH,
    subject: 'Welcome aboard',
  },
  /** s.19 "onboarding_completed". */
  'onboarding.completed': {
    template: 'onboarding.completed',
    category: 'onboarding',
    mandatory: true,
    channels: BOTH,
    subject: 'Your onboarding is complete',
  },

  // ------------------------------------------------------- preference-controlled (s.18.5)
  /**
   * The approver's copy, which s.18.4 makes mandatory as "workflow approval required".
   *
   * s.18.5's "leave approval" is the *employee's* side — the outcome of their own request,
   * which stays controllable below. The approver's side is the workflow task, and s.18.4
   * names it explicitly. Reading it the other way would let an approver switch off the only
   * signal that work is waiting on them, which stalls every request routed to them.
   */
  'leave.awaiting_approval': {
    template: 'leave.awaiting_approval',
    category: 'leave',
    mandatory: true,
    channels: BOTH,
    subject: 'A leave request needs your approval',
  },
  /** s.18.5 "leave approval" — the employee's copy. */
  'leave.approved': {
    template: 'leave.approved',
    category: 'leave',
    mandatory: false,
    channels: BOTH,
    subject: 'Your leave request was approved',
  },
  'leave.rejected': {
    template: 'leave.rejected',
    category: 'leave',
    mandatory: false,
    channels: BOTH,
    subject: 'Your leave request was not approved',
  },
  /** s.19 "leave_cancelled". Grouped with leave approval, which s.18.5 makes controllable. */
  'leave.cancelled': {
    template: 'leave.cancelled',
    category: 'leave',
    mandatory: false,
    channels: BOTH,
    subject: 'A leave request was cancelled',
  },

  /** s.19 expense_approval_required — "workflow approval required" under s.18.4, as above. */
  'expense.awaiting_approval': {
    template: 'expense.awaiting_approval',
    category: 'expense',
    mandatory: true,
    channels: BOTH,
    subject: 'An expense claim needs your approval',
  },
  'expense.approved': {
    template: 'expense.approved',
    category: 'expense',
    mandatory: false,
    channels: BOTH,
    subject: 'Your expense claim was approved',
  },
  'expense.rejected': {
    template: 'expense.rejected',
    category: 'expense',
    mandatory: false,
    channels: BOTH,
    subject: 'Your expense claim was not approved',
  },
  /** s.19 "expense_paid". */
  'expense.paid': {
    template: 'expense.paid',
    category: 'expense',
    mandatory: false,
    channels: BOTH,
    subject: 'Your expense claim has been reimbursed',
  },

  /** s.18.5 "attendance correction", s.19 "attendance_correction". */
  'attendance.correction_decided': {
    template: 'attendance.correction_decided',
    category: 'attendance',
    mandatory: false,
    channels: BOTH,
    subject: 'Your attendance correction was reviewed',
  },

  /**
   * s.18.5 "non-critical reminders". s.19 has no task-assigned event, so this one is
   * justified by s.18.5 alone — the reminder an owner gets that work is waiting on them.
   */
  'onboarding.task_assigned': {
    template: 'onboarding.task_assigned',
    category: 'onboarding',
    mandatory: false,
    channels: BOTH,
    subject: 'You have onboarding tasks',
  },
} as const satisfies Record<string, NotificationDefinition>;

export type NotificationKey = keyof typeof NOTIFICATIONS;

export function notificationDefinition(key: NotificationKey): NotificationDefinition {
  return NOTIFICATIONS[key];
}

/** Categories an employee may actually configure, so the API offers only real choices. */
export function configurableCategories(): NotificationCategory[] {
  const seen = new Set<NotificationCategory>();
  for (const definition of Object.values(NOTIFICATIONS) as NotificationDefinition[]) {
    if (!definition.mandatory) seen.add(definition.category);
  }
  return [...seen].sort();
}

/**
 * The deduplication identity from PRD s.18.6:
 * `tenant_id + event_id + recipient + channel + notification_type`.
 *
 * `tenant_id` is not in the string because the unique index is already scoped by it; putting
 * it in as well would only make the key longer. The other four are all here, and the event id
 * is what makes a redelivered message land on the same key rather than a second notification.
 */
export function dedupeKey(input: {
  eventId: string;
  recipient: string;
  channel: NotificationChannel;
  notificationType: string;
}): string {
  return [input.eventId, input.recipient, input.channel, input.notificationType].join(':');
}
