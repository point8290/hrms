import type { TenantTx } from './db/pool.ts';

/**
 * Operations the PRD requires to be auditable. Listing them explicitly means a reviewer
 * can see at a glance which actions must never happen silently.
 */
export const SENSITIVE_ACTIONS = new Set([
  'employee.bank_account.created',
  'employee.bank_account.updated',
  'employee.tax_profile.updated',
  // Rent decides the HRA exemption, which decides how much tax is withheld from someone's
  // pay for the rest of the year. Same standing as an opening balance.
  'tax.rent.declared',
  'tax.rent.amended',
  'tax.rent.proof_reviewed',
  // A chapter VI-A declaration and the eligibility assessed against it both change
  // how much tax is withheld for the rest of the year.
  'tax.exemption.declared',
  'tax.exemption.amended',
  // Accepting or refusing proof is what turns a declaration into a deduction.
  'tax.exemption.proof_reviewed',
  'employee.separated',
  'compensation.assigned',
  'compensation.revised',
  'attendance.correction.approved',
  'attendance.recalculated',
  'leave.ledger.adjusted',
  'payroll.run.approved',
  'payroll.run.finalized',
  'payroll.run.incomplete_attendance_override',
  // A run failed by the system rather than by a person. Someone has to decide whether to
  // retry, and if it keeps stalling, why.
  'payroll.run.recovered',
  // A scheduled job nobody will retry is a silent correctness gap, not an ops detail:
  // an attendance day that never closes costs employees LOP accuracy.
  'scheduled_job.abandoned',
  'role.permissions.changed',
  // Anything that changes *who may approve*. A delegation, a fallback and an escalation all
  // let someone act who could not act a moment earlier, which is the same kind of change as
  // editing a role's permissions — and the same kind of thing an auditor asks about when a
  // request was approved by someone unexpected. The routine decisions themselves
  // (workflow.approved / workflow.rejected) are not listed: they are recorded on every
  // request, and the ones that are genuinely sensitive already have their own entries above.
  'workflow.delegated',
  'workflow.delegation_revoked',
  'workflow.fallback_activated',
  'workflow.escalated',
  'workflow.escalation_failed',
  // Anything that changes what stands between a password and payroll.
  'auth.mfa.enrolled',
  'auth.mfa.disabled',
  'auth.mfa.recovery_code_used',
  'auth.mfa_enrolment_required',
  'auth.refresh_token_reuse_detected',
]);

export type AuditInput = {
  entityType: string;
  entityId?: string | null;
  action: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
};

/**
 * Appends an audit record inside the caller's transaction.
 *
 * Same transaction on purpose: if the business change rolls back, the audit entry must
 * roll back with it, and a committed change can never be missing its trail.
 */
export async function audit(tx: TenantTx, input: AuditInput): Promise<void> {
  await tx.query(
    `INSERT INTO audit.audit_log
       (tenant_id, actor_user_id, actor_employee_id, actor_label, entity_type, entity_id,
        action, is_sensitive, before_state, after_state, metadata, request_id, correlation_id, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14::inet)`,
    [
      tx.tenantId,
      tx.actor.userId,
      tx.actor.employeeId,
      tx.actor.label,
      input.entityType,
      input.entityId ?? null,
      input.action,
      SENSITIVE_ACTIONS.has(input.action),
      input.before === undefined ? null : JSON.stringify(redact(input.before)),
      input.after === undefined ? null : JSON.stringify(redact(input.after)),
      input.metadata ? JSON.stringify(input.metadata) : null,
      tx.actor.requestId ?? null,
      tx.actor.correlationId ?? null,
      tx.actor.ip ?? null,
    ],
  );
}

const REDACTED_KEYS = new Set([
  'password',
  'password_hash',
  'token',
  'token_hash',
  'account_number',
  'account_number_encrypted',
  'mfa_secret',
]);

/**
 * The audit trail records that a secret changed, never the secret itself. Without this a
 * "who changed the bank details" trail would itself become a store of bank details.
 */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.has(key) ? '[redacted]' : redact(val);
    }
    return out;
  }
  return value;
}
