import type { EventEnvelope } from '@hrms/events';
import { dedupeKey, notificationDefinition, type NotificationKey } from '@hrms/events';
import { withTenant, SYSTEM_ACTOR, type TenantTx } from '@hrms/api/src/infra/db/pool.ts';
import { claimEvent, emitEvent } from '@hrms/api/src/infra/events/outbox.ts';
import { storage, sha256 } from '@hrms/api/src/infra/storage.ts';
import { renderPayslipPdf } from './payslip.ts';
import { onReportRequested } from './reports.ts';

export const CONSUMER_NAME = 'platform-worker';

export type Handler = (envelope: EventEnvelope) => Promise<void>;

/**
 * Runs a handler under tenant context with the idempotency guard already applied.
 *
 * Every consumer needs the same three things — tenant context from the envelope, a
 * processed-event claim, and both committed with the work — so it lives here once rather
 * than being re-implemented (and eventually mis-implemented) per handler.
 */
async function once(envelope: EventEnvelope, fn: (tx: TenantTx) => Promise<void>): Promise<void> {
  await withTenant(
    envelope.tenant_id,
    { ...SYSTEM_ACTOR, label: CONSUMER_NAME, correlationId: envelope.correlation_id },
    async (tx) => {
      const claimed = await claimEvent(tx, envelope.tenant_id, envelope.event_id, CONSUMER_NAME);
      if (!claimed) return; // already handled; ACK and move on
      await fn(tx);
    },
  );
}

/**
 * Queues one catalogue notification, on every channel it is configured for.
 *
 * Four things happen here, in this order, and the order is the point.
 *
 * **The recipient is resolved inside the event's tenant.** Every lookup is tenant-scoped and
 * RLS applies underneath, so a payload naming an employee elsewhere resolves to nobody.
 *
 * **A preference can suppress, but only an explicit one, and only where the PRD allows it.**
 * Mandatory categories skip the check entirely (s.18.4). For the rest, the absence of a
 * preference row means send: an opt-out nobody expressed cannot silence anything.
 *
 * **One row per channel**, because that is what the dedupe identity in s.18.6 requires and
 * because an employee may want the in-app copy without the email.
 *
 * **The dedupe key is event + employee + channel + type** (s.18.6). Carrying the source
 * event id is what makes a redelivered message land on the row the first delivery created;
 * carrying the employee id is what keeps one event's several recipients apart. `ON CONFLICT DO NOTHING` then makes the second delivery a
 * no-op rather than a second message — which is what at-least-once delivery demands, without
 * anyone relying on SQS not repeating itself.
 *
 * In-app notifications are complete when written: there is nothing to deliver, so they are
 * `sent` immediately and the dispatcher never sees them.
 */
async function queueNotification(
  tx: TenantTx,
  input: {
    employeeId?: string | null;
    notification: NotificationKey;
    /** The source event's id — the deduplication anchor (PRD s.18.6). */
    eventId: string;
    payload: Record<string, unknown>;
    /** Overrides the catalogue subject where the PRD's wording needs context. */
    subject?: string;
  },
): Promise<void> {
  const definition = notificationDefinition(input.notification);

  const recipient = input.employeeId
    ? await tx.query<{ user_id: string | null; work_email: string | null; first_name: string }>(
        'SELECT user_id, work_email, first_name FROM core.employee WHERE tenant_id = $1 AND id = $2',
        [tx.tenantId, input.employeeId],
      )
    : null;

  const row = recipient?.rows[0];
  if (!row?.work_email && !row?.user_id) return;

  // Only a user has preferences and an in-app inbox; someone with an address but no login
  // can still be emailed.
  const disabled = row.user_id && !definition.mandatory
    ? await disabledChannels(tx, row.user_id, definition.category)
    : new Set<string>();

  for (const channel of definition.channels) {
    if (disabled.has(channel)) continue;
    if (channel === 'email' && !row.work_email) continue;
    if (channel === 'in_app' && !row.user_id) continue;

    await tx.query(
      `INSERT INTO notification.notification
         (tenant_id, recipient_user_id, recipient_email, channel, category, template_code,
          subject, payload, dedupe_key, status, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9,
               CASE WHEN $4 = 'in_app' THEN 'sent' ELSE 'pending' END,
               CASE WHEN $4 = 'in_app' THEN now() ELSE NULL END)
       ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [
        tx.tenantId,
        row.user_id,
        channel === 'email' ? row.work_email : null,
        channel,
        definition.category,
        definition.template,
        input.subject ?? definition.subject,
        JSON.stringify({ ...input.payload, first_name: row.first_name }),
        dedupeKey({
          eventId: input.eventId,
          // The employee id, not the address. `recipient` in s.18.6 is the person, and the
          // key has to separate two people the same event notifies. A work email does not:
          // it has no unique index, so two employees can share one mailbox, and keying on it
          // made the second person's notification collide with the first's and vanish.
          recipient: input.employeeId!,
          channel,
          notificationType: input.notification,
        }),
      ],
    );
  }
}

/** Channels this user has explicitly switched off for a category. Nothing else suppresses. */
async function disabledChannels(
  tx: TenantTx,
  userId: string,
  category: string,
): Promise<Set<string>> {
  const { rows } = await tx.query<{ channel: string }>(
    `SELECT channel FROM notification.notification_preference
      WHERE tenant_id = $1 AND user_id = $2 AND category = $3 AND enabled = false`,
    [tx.tenantId, userId, category],
  );
  return new Set(rows.map((r) => r.channel));
}

// ---------------------------------------------------------------------------
// Expense (PRD s.19 "Expense")
//
// The claimant is told what happened to their claim; the approver is told when one needs
// them. That split mirrors leave exactly, which is the pattern the product already
// established rather than a new opinion about who should hear what.
// ---------------------------------------------------------------------------

const onExpenseSubmitted: Handler = (envelope) =>
  once(envelope, async (tx) => {
    const claimId = String(envelope.payload.expense_claim_id ?? envelope.aggregate_id);
    const { rows } = await tx.query<{
      manager_employee_id: string | null; employee_name: string; claim_number: string;
    }>(
      `SELECT e.manager_employee_id,
              e.first_name || ' ' || e.last_name AS employee_name,
              c.claim_number
         FROM expense.expense_claim c
         JOIN core.employee e ON e.id = c.employee_id AND e.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1 AND c.id = $2`,
      [tx.tenantId, claimId],
    );
    const row = rows[0];
    if (!row?.manager_employee_id) return;

    await queueNotification(tx, {
      employeeId: row.manager_employee_id,
      notification: 'expense.awaiting_approval',
      eventId: envelope.event_id,
      subject: `Expense claim from ${row.employee_name}`,
      payload: {
        expense_claim_id: claimId,
        claim_number: row.claim_number,
        employee_name: row.employee_name,
      },
    });
  });

const onExpenseOutcome = (
  notification: 'expense.approved' | 'expense.rejected' | 'expense.paid',
): Handler => (envelope) =>
  once(envelope, async (tx) => {
    const claimId = String(envelope.payload.expense_claim_id ?? envelope.aggregate_id);
    const employeeId = envelope.payload.employee_id ? String(envelope.payload.employee_id) : null;
    const { rows } = await tx.query<{ claim_number: string }>(
      `SELECT claim_number FROM expense.expense_claim WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, claimId],
    );

    // No amount in the payload: PRD s.18.8 keeps money out of notification previews, and the
    // claim itself is one authorised click away.
    await queueNotification(tx, {
      employeeId,
      notification,
      eventId: envelope.event_id,
      payload: { expense_claim_id: claimId, claim_number: rows[0]?.claim_number ?? null },
    });
  });

// ---------------------------------------------------------------------------
// Leave cancellation (PRD s.19 "leave_cancelled")
//
// To the approver, not the employee: whoever cancelled it already knows, and the person who
// had it in their queue is the one whose picture of the world just changed.
// ---------------------------------------------------------------------------

const onLeaveCancelled: Handler = (envelope) =>
  once(envelope, async (tx) => {
    const applicationId = String(envelope.payload.leave_application_id ?? envelope.aggregate_id);
    const { rows } = await tx.query<{ manager_employee_id: string | null; employee_name: string }>(
      `SELECT e.manager_employee_id, e.first_name || ' ' || e.last_name AS employee_name
         FROM leave_mgmt.leave_application la
         JOIN core.employee e ON e.id = la.employee_id AND e.tenant_id = la.tenant_id
        WHERE la.tenant_id = $1 AND la.id = $2`,
      [tx.tenantId, applicationId],
    );
    const row = rows[0];
    if (!row?.manager_employee_id) return;

    await queueNotification(tx, {
      employeeId: row.manager_employee_id,
      notification: 'leave.cancelled',
      eventId: envelope.event_id,
      subject: `${row.employee_name} cancelled a leave request`,
      payload: { leave_application_id: applicationId, employee_name: row.employee_name },
    });
  });

// ---------------------------------------------------------------------------
// Onboarding (PRD s.19 "Onboarding")
//
// Task owners are already resolved and stored when the plan is created, so this tells the
// people who actually hold the work rather than re-deriving who that might be.
// ---------------------------------------------------------------------------

const onOnboardingPlanCreated: Handler = (envelope) =>
  once(envelope, async (tx) => {
    const planId = String(envelope.payload.onboarding_plan_id ?? envelope.aggregate_id);
    const { rows } = await tx.query<{ owner_employee_id: string; task_count: number; joiner_name: string }>(
      `SELECT t.owner_employee_id,
              count(*)::int AS task_count,
              min(e.first_name || ' ' || e.last_name) AS joiner_name
         FROM recruitment.onboarding_task t
         JOIN recruitment.onboarding_plan p ON p.id = t.plan_id AND p.tenant_id = t.tenant_id
         JOIN core.employee e ON e.id = p.employee_id AND e.tenant_id = p.tenant_id
        WHERE t.tenant_id = $1 AND t.plan_id = $2 AND t.owner_employee_id IS NOT NULL
        GROUP BY t.owner_employee_id`,
      [tx.tenantId, planId],
    );

    for (const row of rows) {
      await queueNotification(tx, {
        employeeId: row.owner_employee_id,
        notification: 'onboarding.task_assigned',
        eventId: envelope.event_id,
        payload: {
          onboarding_plan_id: planId,
          task_count: row.task_count,
          joiner_name: row.joiner_name,
        },
      });
    }
  });

const onOnboardingCompleted: Handler = (envelope) =>
  once(envelope, async (tx) => {
    const planId = String(envelope.payload.onboarding_plan_id ?? envelope.aggregate_id);
    const employeeId = envelope.payload.employee_id ? String(envelope.payload.employee_id) : null;
    await queueNotification(tx, {
      employeeId,
      notification: 'onboarding.completed',
      eventId: envelope.event_id,
      payload: { onboarding_plan_id: planId },
    });
  });

// ---------------------------------------------------------------------------
// Attendance correction (PRD s.19 "attendance_correction", s.18.5 controllable)
// ---------------------------------------------------------------------------

const onAttendanceCorrectionApproved: Handler = (envelope) =>
  once(envelope, async (tx) => {
    const correctionId = String(envelope.payload.correction_id ?? envelope.aggregate_id);
    const { rows } = await tx.query<{ employee_id: string; attendance_date: string }>(
      `SELECT employee_id, to_char(attendance_date, 'YYYY-MM-DD') AS attendance_date
         FROM workforce.attendance_correction
        WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, correctionId],
    );
    const row = rows[0];
    if (!row) return;

    await queueNotification(tx, {
      employeeId: row.employee_id,
      notification: 'attendance.correction_decided',
      eventId: envelope.event_id,
      payload: { correction_id: correctionId, attendance_date: row.attendance_date },
    });
  });

const onEmployeeCreated: Handler = (envelope) =>
  once(envelope, async (tx) => {
    const employeeId = String(envelope.payload.employee_id ?? envelope.aggregate_id);
    await queueNotification(tx, {
      employeeId,
      notification: 'employee.welcome',
      eventId: envelope.event_id,
      payload: { employee_id: employeeId },
    });
  });

const onLeaveApplied: Handler = (envelope) =>
  once(envelope, async (tx) => {
    const applicationId = String(envelope.payload.leave_application_id ?? envelope.aggregate_id);
    const { rows } = await tx.query<{ manager_employee_id: string | null; employee_name: string }>(
      `SELECT e.manager_employee_id, e.first_name || ' ' || e.last_name AS employee_name
         FROM leave_mgmt.leave_application la
         JOIN core.employee e ON e.id = la.employee_id
        WHERE la.tenant_id = $1 AND la.id = $2`,
      [tx.tenantId, applicationId],
    );
    const row = rows[0];
    if (!row?.manager_employee_id) return;

    await queueNotification(tx, {
      employeeId: row.manager_employee_id,
      notification: 'leave.awaiting_approval',
      eventId: envelope.event_id,
      subject: `Leave request from ${row.employee_name}`,
      payload: {
        leave_application_id: applicationId,
        employee_name: row.employee_name,
        start_date: envelope.payload.start_date,
        end_date: envelope.payload.end_date,
      },
    });
  });

const onLeaveDecision = (decision: 'approved' | 'rejected'): Handler => (envelope) =>
  once(envelope, async (tx) => {
    const applicationId = String(envelope.payload.leave_application_id ?? envelope.aggregate_id);
    const employeeId = envelope.payload.employee_id ? String(envelope.payload.employee_id) : null;
    await queueNotification(tx, {
      employeeId,
      notification: decision === 'approved' ? 'leave.approved' : 'leave.rejected',
      eventId: envelope.event_id,
      payload: { leave_application_id: applicationId },
    });
  });

/**
 * Fans out a finalized run into one event per payslip (ADR-009).
 *
 * This handler deliberately does no rendering and no S3 work. It enumerates the finalized
 * slips and emits one `SalarySlipGenerated` each, so the transaction stays short and a
 * failure on one employee cannot roll back payslips already produced for the rest.
 */
const onPayrollFinalized: Handler = (envelope) =>
  once(envelope, async (tx) => {
    const runId = String(envelope.payload.payroll_run_id ?? envelope.aggregate_id);

    const { rows } = await tx.query<{ id: string; employee_id: string; slip_number: string }>(
      `SELECT id, employee_id, slip_number
         FROM payroll.salary_slip
        WHERE tenant_id = $1 AND payroll_run_id = $2
          AND status = 'finalized'
          AND document_id IS NULL`,
      [tx.tenantId, runId],
    );

    for (const slip of rows) {
      await emitEvent(tx, 'SalarySlipGenerated', {
        aggregateType: 'salary_slip',
        aggregateId: slip.id,
        payload: {
          salary_slip_id: slip.id,
          payroll_run_id: runId,
          employee_id: slip.employee_id,
          slip_number: slip.slip_number,
        },
      });
    }
  });

/**
 * Produces the payslip document for one finalized slip and notifies the employee.
 *
 * Only ever reached after finalization, so the figures it renders are immutable by database
 * trigger — a regenerated document can never disagree with what was paid.
 *
 * Three phases, because the S3 upload is a network call and must not happen inside a
 * database transaction. Holding a row lock across an object-store round trip turns an S3
 * slowdown into held locks and an exhausted connection pool, and at four thousand payslips
 * that is the difference between a slow payroll run and an unavailable API:
 *
 *   1. read and render — one short transaction, no network beyond the database
 *   2. upload          — no transaction open
 *   3. record          — claim the event and write the document row together
 *
 * The order is deliberate. A crash between 2 and 3 leaves an orphan object in S3, which is
 * recoverable and invisible to employees; the reverse — a document row pointing at an object
 * that does not exist — surfaces to an employee as a payslip that will not open.
 */
const onSalarySlipGenerated: Handler = async (envelope) => {
  const slipId = String(envelope.payload.salary_slip_id ?? envelope.aggregate_id);
  const actor = { ...SYSTEM_ACTOR, label: CONSUMER_NAME, correlationId: envelope.correlation_id };

  // Phase 1 — read and render.
  const rendered = await withTenant(envelope.tenant_id, actor, async (tx) => {
    const { rows } = await tx.query<{
      employee_id: string;
      slip_number: string;
      status: string;
      document_id: string | null;
    }>(
      `SELECT employee_id, slip_number, status, document_id
         FROM payroll.salary_slip
        WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, slipId],
    );

    const slip = rows[0];
    if (!slip) return null;
    if (slip.status !== 'finalized') {
      // A run cancelled between finalization and delivery. Producing a document now would
      // hand the employee a payslip for a run that no longer stands.
      return null;
    }
    if (slip.document_id) return null; // already produced on an earlier delivery

    return { slip, pdf: await renderPayslipPdf(tx, slipId) };
  });

  if (!rendered) {
    // Nothing to produce. Claim the event so a redelivery does not re-check for ever.
    await once(envelope, async () => {});
    return;
  }

  // Phase 2 — upload, outside any transaction.
  const store = storage();
  const key = store.buildKey(envelope.tenant_id, 'payslip', `${rendered.slip.slip_number}.pdf`);
  await store.putObject(key, rendered.pdf, 'application/pdf');

  // Phase 3 — record. The event claim and the document row commit together, so "this event
  // was handled" and "the payslip exists" can never disagree.
  await withTenant(envelope.tenant_id, actor, async (tx) => {
    const claimed = await claimEvent(tx, envelope.tenant_id, envelope.event_id, CONSUMER_NAME);
    if (!claimed) return;

    // Re-read under lock: another delivery may have produced the document while this one
    // was uploading. Two objects in S3 is waste; two document rows is a second payslip.
    const { rows } = await tx.query<{ document_id: string | null; status: string }>(
      `SELECT document_id, status FROM payroll.salary_slip
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE`,
      [tx.tenantId, slipId],
    );
    const current = rows[0];
    if (!current || current.status !== 'finalized' || current.document_id) return;

    const document = await tx.query<{ id: string }>(
      `INSERT INTO documents.document
         (tenant_id, employee_id, document_type, filename, content_type, size_bytes,
          s3_bucket, s3_key, checksum_sha256, is_sensitive, status, uploaded_by)
       VALUES ($1,$2,'payslip',$3,'application/pdf',$4,$5,$6,$7,true,'available',NULL)
       RETURNING id`,
      [
        tx.tenantId, rendered.slip.employee_id, `${rendered.slip.slip_number}.pdf`,
        rendered.pdf.byteLength, store.bucket, key, sha256(rendered.pdf),
      ],
    );

    await tx.query('UPDATE payroll.salary_slip SET document_id = $3 WHERE tenant_id = $1 AND id = $2', [
      tx.tenantId,
      slipId,
      document.rows[0]!.id,
    ]);

    await queueNotification(tx, {
      employeeId: rendered.slip.employee_id,
      notification: 'payroll.payslip_available',
      eventId: envelope.event_id,
      payload: { salary_slip_id: slipId, slip_number: rendered.slip.slip_number },
    });
  });
};

const onEmployeeSeparated: Handler = (envelope) =>
  once(envelope, async (tx) => {
    const employeeId = String(envelope.payload.employee_id ?? envelope.aggregate_id);
    // Cancel future leave so a separated employee does not hold dates they cannot take.
    // Ledger reversals happen through the leave module's cancel path, not here.
    await tx.query(
      `UPDATE leave_mgmt.leave_application
          SET status = 'cancelled', cancelled_at = now(),
              decision_note = COALESCE(decision_note, 'Cancelled on separation')
        WHERE tenant_id = $1 AND employee_id = $2
          AND status IN ('submitted', 'pending_approval')
          AND start_date > CURRENT_DATE`,
      [tx.tenantId, employeeId],
    );
  });

export const HANDLERS: Record<string, Handler> = {
  EmployeeCreated: onEmployeeCreated,
  EmployeeSeparated: onEmployeeSeparated,
  LeaveApplied: onLeaveApplied,
  LeaveApproved: onLeaveDecision('approved'),
  LeaveRejected: onLeaveDecision('rejected'),
  PayrollFinalized: onPayrollFinalized,
  SalarySlipGenerated: onSalarySlipGenerated,
  ReportRequested: onReportRequested,

  // PRD s.19. Every one of these events already existed and already carried the business
  // fact; what was missing was anybody listening for it.
  ExpenseClaimSubmitted: onExpenseSubmitted,
  ExpenseClaimApproved: onExpenseOutcome('expense.approved'),
  ExpenseClaimRejected: onExpenseOutcome('expense.rejected'),
  ExpensePaid: onExpenseOutcome('expense.paid'),
  LeaveCancelled: onLeaveCancelled,
  OnboardingPlanCreated: onOnboardingPlanCreated,
  OnboardingCompleted: onOnboardingCompleted,
  AttendanceCorrectionApproved: onAttendanceCorrectionApproved,
};

// Notification delivery lives in ./notifications.ts: it must send outside a database
// transaction, so it cannot share the `once()` wrapper these handlers use.
export { dispatchNotifications, reclaimStuckNotifications, MAX_NOTIFICATION_ATTEMPTS } from './notifications.ts';
