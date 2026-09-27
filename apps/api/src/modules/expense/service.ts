import type { TenantTx } from '../../infra/db/pool.ts';
import { audit } from '../../infra/audit.ts';
import { emitEvent } from '../../infra/events/outbox.ts';
import { conflict, notFound, unprocessable } from '../../infra/errors.ts';
import * as workflow from '../workflow/service.ts';

/**
 * Expense claims, advances and reimbursement.
 *
 * Business shape follows mature HR behaviour:
 * a claim is a header with typed lines; finance may sanction less than was claimed, per
 * line, with a reason; an outstanding advance is settled against the claim before anything
 * is reimbursed.
 *
 * Money moves only at the end, and only once: the claim is immutable after `paid`,
 * enforced by a database trigger.
 */

type ClaimRow = {
  id: string;
  employee_id: string;
  claim_number: string;
  status: string;
  workflow_instance_id: string | null;
  total_claimed_amount: string;
  total_sanctioned_amount: string;
  advance_adjusted_amount: string;
  reimbursable_amount: string;
};

async function loadClaim(tx: TenantTx, claimId: string, forUpdate = false): Promise<ClaimRow> {
  const { rows } = await tx.query<ClaimRow>(
    `SELECT id, employee_id, claim_number, status, workflow_instance_id,
            total_claimed_amount, total_sanctioned_amount, advance_adjusted_amount, reimbursable_amount
       FROM expense.expense_claim
      WHERE tenant_id = $1 AND id = $2
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [tx.tenantId, claimId],
  );
  const row = rows[0];
  if (!row) throw notFound('Expense claim');
  return row;
}

/** Sequential per tenant and year, so a claim number is meaningful to finance. */
async function nextClaimNumber(tx: TenantTx, claimDate: string): Promise<string> {
  const year = claimDate.slice(0, 4);
  const { rows } = await tx.query<{ next: number }>(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(claim_number, '^EXP-\\d{4}-', ''), '')::bigint), 0) + 1 AS next
       FROM expense.expense_claim
      WHERE tenant_id = $1 AND claim_number LIKE $2`,
    [tx.tenantId, `EXP-${year}-%`],
  );
  return `EXP-${year}-${String(rows[0]?.next ?? 1).padStart(5, '0')}`;
}

export type ExpenseLineInput = {
  expenseTypeId: string;
  expenseDate: string;
  description: string;
  claimedAmount: number;
  taxAmount?: number;
  receiptDocumentId?: string;
};

export type CreateClaimInput = {
  employeeId: string;
  claimDate: string;
  title: string;
  businessPurpose?: string;
  lines: ExpenseLineInput[];
};

/**
 * Creates a draft claim.
 *
 * Policy is validated at creation rather than at approval, so an employee learns about a
 * missing receipt or a breached daily limit while they are still filling the form.
 */
export async function createClaim(
  tx: TenantTx,
  input: CreateClaimInput,
): Promise<{ id: string; claimNumber: string; totalClaimed: number }> {
  if (input.lines.length === 0) {
    throw unprocessable('empty_claim', 'A claim must have at least one line');
  }

  const employee = await tx.query<{ employment_status: string }>(
    'SELECT employment_status FROM core.employee WHERE tenant_id = $1 AND id = $2',
    [tx.tenantId, input.employeeId],
  );
  if (!employee.rows[0]) throw notFound('Employee');

  const typeIds = [...new Set(input.lines.map((l) => l.expenseTypeId))];
  const types = await tx.query<{
    id: string;
    code: string;
    name: string;
    receipt_required: boolean;
    limit_amount: string | null;
    daily_limit_amount: string | null;
    requires_business_purpose: boolean;
    status: string;
  }>(
    `SELECT id, code, name, receipt_required, limit_amount, daily_limit_amount,
            requires_business_purpose, status
       FROM expense.expense_type
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tx.tenantId, typeIds],
  );

  const byId = new Map(types.rows.map((t) => [t.id, t]));
  for (const id of typeIds) {
    const type = byId.get(id);
    if (!type) throw notFound('Expense type');
    if (type.status !== 'active') {
      throw unprocessable('expense_type_inactive', `Expense type ${type.code} is not active`);
    }
  }

  for (const line of input.lines) {
    const type = byId.get(line.expenseTypeId)!;

    if (type.receipt_required && !line.receiptDocumentId) {
      throw unprocessable('receipt_required', `${type.name} requires a receipt`, {
        expense_date: line.expenseDate,
        expense_type: type.code,
      });
    }
    if (type.requires_business_purpose && !input.businessPurpose) {
      throw unprocessable('business_purpose_required', `${type.name} requires a business purpose`);
    }
    if (type.limit_amount !== null && line.claimedAmount > Number(type.limit_amount)) {
      throw unprocessable('exceeds_type_limit', `${type.name} is limited to ${type.limit_amount} per item`, {
        claimed: line.claimedAmount,
        limit: Number(type.limit_amount),
      });
    }
  }

  // Daily limits span claims, so the check has to look at what the employee has already
  // submitted for that date, not only at the lines in this request.
  for (const type of types.rows) {
    if (type.daily_limit_amount === null) continue;
    const dates = [...new Set(input.lines.filter((l) => l.expenseTypeId === type.id).map((l) => l.expenseDate))];

    for (const date of dates) {
      const inThisClaim = input.lines
        .filter((l) => l.expenseTypeId === type.id && l.expenseDate === date)
        .reduce((sum, l) => sum + l.claimedAmount, 0);

      const { rows } = await tx.query<{ existing: string }>(
        `SELECT COALESCE(SUM(el.claimed_amount), 0)::text AS existing
           FROM expense.expense_line el
           JOIN expense.expense_claim ec ON ec.id = el.expense_claim_id
          WHERE el.tenant_id = $1 AND el.expense_type_id = $2 AND el.expense_date = $3::date
            AND ec.employee_id = $4 AND ec.status NOT IN ('rejected', 'cancelled')`,
        [tx.tenantId, type.id, date, input.employeeId],
      );

      const total = Number(rows[0]!.existing) + inThisClaim;
      if (total > Number(type.daily_limit_amount)) {
        throw unprocessable(
          'exceeds_daily_limit',
          `${type.name} is limited to ${type.daily_limit_amount} per day`,
          { date, already_claimed: Number(rows[0]!.existing), this_claim: inThisClaim, limit: Number(type.daily_limit_amount) },
        );
      }
    }
  }

  const claimNumber = await nextClaimNumber(tx, input.claimDate);
  const totalClaimed = round2(input.lines.reduce((sum, l) => sum + l.claimedAmount, 0));

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO expense.expense_claim
       (tenant_id, employee_id, claim_number, claim_date, title, business_purpose,
        total_claimed_amount, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      tx.tenantId, input.employeeId, claimNumber, input.claimDate, input.title,
      input.businessPurpose ?? null, totalClaimed, tx.actor.userId,
    ],
  );
  const claimId = rows[0]!.id;

  for (const line of input.lines) {
    await tx.query(
      `INSERT INTO expense.expense_line
         (tenant_id, expense_claim_id, expense_type_id, expense_date, description,
          claimed_amount, tax_amount, receipt_document_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        tx.tenantId, claimId, line.expenseTypeId, line.expenseDate, line.description,
        line.claimedAmount, line.taxAmount ?? 0, line.receiptDocumentId ?? null,
      ],
    );
  }

  await audit(tx, {
    entityType: 'expense_claim',
    entityId: claimId,
    action: 'expense.claim.created',
    after: { claim_number: claimNumber, employee_id: input.employeeId, total: totalClaimed, lines: input.lines.length },
  });

  return { id: claimId, claimNumber, totalClaimed };
}

/**
 * Submits a draft claim for approval.
 *
 * Outstanding advances are settled here, before approval, because the amount the approver
 * sees should be what the company will actually pay out.
 */
export async function submitClaim(tx: TenantTx, claimId: string): Promise<{ status: string; reimbursable: number }> {
  const claim = await loadClaim(tx, claimId, true);
  if (claim.status !== 'draft') {
    throw conflict('already_submitted', `This claim is already ${claim.status.replace(/_/g, ' ')}`);
  }

  const adjusted = await settleAdvances(tx, claimId, claim.employee_id, Number(claim.total_claimed_amount));
  const reimbursable = round2(Number(claim.total_claimed_amount) - adjusted);

  const started = await workflow.startWorkflow(tx, 'expense_claim', claimId, claim.employee_id);
  // No configured workflow means nobody has to approve; go straight to finance, which is
  // where the money decision is made regardless.
  const status = started.status === 'approved' ? 'finance_review' : 'manager_review';

  await tx.query(
    `UPDATE expense.expense_claim
        SET status = $3, submitted_at = now(), workflow_instance_id = $4,
            advance_adjusted_amount = $5, reimbursable_amount = $6
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, claimId, status, started.instanceId, adjusted, reimbursable],
  );

  await audit(tx, {
    entityType: 'expense_claim',
    entityId: claimId,
    action: 'expense.claim.submitted',
    after: { status, advance_adjusted: adjusted, reimbursable },
  });

  await emitEvent(tx, 'ExpenseClaimSubmitted', {
    aggregateType: 'expense_claim',
    aggregateId: claimId,
    payload: {
      expense_claim_id: claimId,
      employee_id: claim.employee_id,
      claim_number: claim.claim_number,
      total_claimed: claim.total_claimed_amount,
    },
  });

  return { status, reimbursable };
}

/**
 * Applies outstanding advances to a claim, oldest first.
 *
 * An employee holding company money must not also be reimbursed for it. Settling oldest
 * first clears the longest-outstanding liability, which is what finance expects.
 */
async function settleAdvances(
  tx: TenantTx,
  claimId: string,
  employeeId: string,
  claimTotal: number,
): Promise<number> {
  const { rows } = await tx.query<{ id: string; outstanding: string }>(
    `SELECT id, (paid_amount - claimed_amount - returned_amount)::text AS outstanding
       FROM expense.employee_advance
      WHERE tenant_id = $1 AND employee_id = $2 AND status = 'paid'
        AND paid_amount - claimed_amount - returned_amount > 0
      ORDER BY created_at
      FOR UPDATE`,
    [tx.tenantId, employeeId],
  );

  let remaining = claimTotal;
  let adjusted = 0;

  for (const advance of rows) {
    if (remaining <= 0) break;
    const applied = Math.min(remaining, Number(advance.outstanding));
    if (applied <= 0) continue;

    await tx.query(
      `INSERT INTO expense.advance_settlement
         (tenant_id, expense_claim_id, employee_advance_id, amount, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [tx.tenantId, claimId, advance.id, applied, tx.actor.userId],
    );
    await tx.query(
      `UPDATE expense.employee_advance
          SET claimed_amount = claimed_amount + $3,
              status = CASE
                WHEN paid_amount - (claimed_amount + $3) - returned_amount <= 0 THEN 'settled'
                ELSE status
              END
        WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, advance.id, applied],
    );

    adjusted = round2(adjusted + applied);
    remaining = round2(remaining - applied);
  }

  return adjusted;
}

/** Records a manager decision arriving from the workflow engine. */
export async function applyWorkflowOutcome(
  tx: TenantTx,
  claimId: string,
  outcome: workflow.WorkflowOutcome,
  note: string | undefined,
): Promise<void> {
  if (outcome === 'in_progress') return;

  const claim = await loadClaim(tx, claimId, true);
  if (!['submitted', 'manager_review'].includes(claim.status)) return;

  // Manager approval moves the claim to finance; it does not approve the payment.
  const status = outcome === 'approved' ? 'finance_review' : 'rejected';

  await tx.query(
    `UPDATE expense.expense_claim
        SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, claimId, status, tx.actor.userId, note ?? null],
  );

  await audit(tx, {
    entityType: 'expense_claim',
    entityId: claimId,
    action: `expense.claim.manager_${outcome}`,
    before: { status: claim.status },
    after: { status, note: note ?? null },
  });

  if (status === 'rejected') {
    await reverseSettlements(tx, claimId, 'claim rejected');
    await emitEvent(tx, 'ExpenseClaimRejected', {
      aggregateType: 'expense_claim',
      aggregateId: claimId,
      payload: { expense_claim_id: claimId, employee_id: claim.employee_id },
    });
  }
}

export type SanctionInput = {
  lines: Array<{ lineId: string; sanctionedAmount: number; note?: string }>;
  decisionNote?: string;
};

/**
 * Finance sanctions the claim, line by line.
 *
 * Sanctioning less than claimed is normal and must be explained, so a reduced line without
 * a note is rejected — the employee is owed a reason for not being paid in full.
 */
export async function sanction(
  tx: TenantTx,
  claimId: string,
  input: SanctionInput,
): Promise<{ sanctioned: number; reimbursable: number }> {
  const claim = await loadClaim(tx, claimId, true);
  if (claim.status !== 'finance_review') {
    throw conflict('not_in_finance_review', `This claim is ${claim.status.replace(/_/g, ' ')}, not awaiting finance`);
  }

  const { rows: lines } = await tx.query<{ id: string; claimed_amount: string }>(
    'SELECT id, claimed_amount FROM expense.expense_line WHERE tenant_id = $1 AND expense_claim_id = $2',
    [tx.tenantId, claimId],
  );
  const claimedById = new Map(lines.map((l) => [l.id, Number(l.claimed_amount)]));

  if (input.lines.length !== lines.length) {
    throw unprocessable('incomplete_sanction', 'Every line must be sanctioned, including those reduced to zero');
  }

  for (const decision of input.lines) {
    const claimed = claimedById.get(decision.lineId);
    if (claimed === undefined) throw notFound('Expense line');
    if (decision.sanctionedAmount > claimed) {
      throw unprocessable('sanction_above_claim', 'A line cannot be sanctioned above the amount claimed');
    }
    if (decision.sanctionedAmount < claimed && !decision.note) {
      throw unprocessable('reduction_needs_note', 'Reducing a line requires a note explaining why');
    }

    await tx.query(
      `UPDATE expense.expense_line
          SET sanctioned_amount = $3, sanction_note = $4
        WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, decision.lineId, decision.sanctionedAmount, decision.note ?? null],
    );
  }

  const sanctioned = round2(input.lines.reduce((sum, l) => sum + l.sanctionedAmount, 0));
  // Advances were settled against the claimed total; if finance sanctioned less, the
  // settlement cannot exceed what is now payable.
  const adjusted = Math.min(Number(claim.advance_adjusted_amount), sanctioned);
  const reimbursable = round2(sanctioned - adjusted);

  await tx.query(
    `UPDATE expense.expense_claim
        SET status = 'approved', total_sanctioned_amount = $3,
            advance_adjusted_amount = $4, reimbursable_amount = $5,
            decided_by = $6, decided_at = now(), decision_note = $7
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, claimId, sanctioned, adjusted, reimbursable, tx.actor.userId, input.decisionNote ?? null],
  );

  await audit(tx, {
    entityType: 'expense_claim',
    entityId: claimId,
    action: 'expense.claim.sanctioned',
    before: { claimed: claim.total_claimed_amount },
    after: { sanctioned, advance_adjusted: adjusted, reimbursable, note: input.decisionNote ?? null },
  });

  await emitEvent(tx, 'ExpenseClaimApproved', {
    aggregateType: 'expense_claim',
    aggregateId: claimId,
    payload: {
      expense_claim_id: claimId,
      employee_id: claim.employee_id,
      sanctioned_amount: String(sanctioned),
      reimbursable_amount: String(reimbursable),
    },
  });

  return { sanctioned, reimbursable };
}

/** Records payment. The claim becomes immutable at this point, enforced by trigger. */
export async function markPaid(
  tx: TenantTx,
  claimId: string,
  paymentReference: string,
): Promise<void> {
  const claim = await loadClaim(tx, claimId, true);
  if (claim.status !== 'approved' && claim.status !== 'payment_pending') {
    throw conflict('not_payable', `A claim that is ${claim.status.replace(/_/g, ' ')} cannot be paid`);
  }

  await tx.query(
    `UPDATE expense.expense_claim
        SET status = 'paid', paid_at = now(), payment_reference = $3
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, claimId, paymentReference],
  );

  await audit(tx, {
    entityType: 'expense_claim',
    entityId: claimId,
    action: 'expense.claim.paid',
    after: {
      claim_number: claim.claim_number,
      amount: claim.reimbursable_amount,
      payment_reference: paymentReference,
    },
  });

  await emitEvent(tx, 'ExpensePaid', {
    aggregateType: 'expense_claim',
    aggregateId: claimId,
    payload: {
      expense_claim_id: claimId,
      employee_id: claim.employee_id,
      amount: claim.reimbursable_amount,
    },
  });
}

/** Cancels a claim and returns any advance it had settled. */
export async function cancelClaim(tx: TenantTx, claimId: string, reason: string): Promise<void> {
  const claim = await loadClaim(tx, claimId, true);
  if (claim.status === 'paid') {
    throw conflict('already_paid', 'A paid claim cannot be cancelled; raise an adjustment instead');
  }
  if (claim.status === 'cancelled') return;

  await reverseSettlements(tx, claimId, reason);
  await workflow.cancelWorkflow(tx, claim.workflow_instance_id);

  await tx.query(
    `UPDATE expense.expense_claim
        SET status = 'cancelled', decision_note = $3
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, claimId, reason],
  );

  await audit(tx, {
    entityType: 'expense_claim',
    entityId: claimId,
    action: 'expense.claim.cancelled',
    before: { status: claim.status },
    after: { status: 'cancelled', reason },
  });
}

/**
 * Returns advance money a cancelled or rejected claim had settled.
 *
 * A compensating settlement row rather than an edit, so the advance balance always has a
 * complete, explainable history.
 */
async function reverseSettlements(tx: TenantTx, claimId: string, reason: string): Promise<void> {
  const { rows } = await tx.query<{ employee_advance_id: string; amount: string }>(
    `SELECT employee_advance_id, SUM(amount)::text AS amount
       FROM expense.advance_settlement
      WHERE tenant_id = $1 AND expense_claim_id = $2
      GROUP BY employee_advance_id
     HAVING SUM(amount) <> 0`,
    [tx.tenantId, claimId],
  );

  for (const settlement of rows) {
    await tx.query(
      `INSERT INTO expense.advance_settlement
         (tenant_id, expense_claim_id, employee_advance_id, amount, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [tx.tenantId, claimId, settlement.employee_advance_id, -Number(settlement.amount), tx.actor.userId],
    );
    await tx.query(
      `UPDATE expense.employee_advance
          SET claimed_amount = claimed_amount - $3,
              status = CASE WHEN status = 'settled' THEN 'paid' ELSE status END
        WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, settlement.employee_advance_id, Number(settlement.amount)],
    );
  }

  if (rows.length > 0) {
    await tx.query(
      `UPDATE expense.expense_claim SET advance_adjusted_amount = 0, reimbursable_amount = total_claimed_amount
        WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, claimId],
    );
    await audit(tx, {
      entityType: 'expense_claim',
      entityId: claimId,
      action: 'expense.advance.settlement_reversed',
      after: { advances: rows.length, reason },
    });
  }
}

// ---------------------------------------------------------------- advances

export async function requestAdvance(
  tx: TenantTx,
  input: { employeeId: string; purpose: string; amount: number; neededBy?: string },
): Promise<{ id: string; status: string }> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO expense.employee_advance
       (tenant_id, employee_id, purpose, requested_amount, needed_by, status, created_by)
     VALUES ($1, $2, $3, $4, $5, 'pending_approval', $6)
     RETURNING id`,
    [tx.tenantId, input.employeeId, input.purpose, input.amount, input.neededBy ?? null, tx.actor.userId],
  );

  await audit(tx, {
    entityType: 'employee_advance',
    entityId: rows[0]!.id,
    action: 'expense.advance.requested',
    after: { employee_id: input.employeeId, amount: input.amount, purpose: input.purpose },
  });

  return { id: rows[0]!.id, status: 'pending_approval' };
}

export async function decideAdvance(
  tx: TenantTx,
  advanceId: string,
  decision: 'approved' | 'rejected',
  approvedAmount?: number,
): Promise<void> {
  const { rows } = await tx.query<{ status: string; requested_amount: string; employee_id: string }>(
    `SELECT status, requested_amount, employee_id FROM expense.employee_advance
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tx.tenantId, advanceId],
  );
  const advance = rows[0];
  if (!advance) throw notFound('Employee advance');
  if (advance.status !== 'pending_approval') {
    throw conflict('already_decided', `This advance is already ${advance.status.replace(/_/g, ' ')}`);
  }

  const amount = decision === 'approved' ? approvedAmount ?? Number(advance.requested_amount) : 0;
  if (decision === 'approved' && amount > Number(advance.requested_amount)) {
    throw unprocessable('above_requested', 'An advance cannot be approved above the amount requested');
  }

  await tx.query(
    `UPDATE expense.employee_advance
        SET status = $3, approved_amount = $4, decided_by = $5, decided_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, advanceId, decision, decision === 'approved' ? amount : null, tx.actor.userId],
  );

  await audit(tx, {
    entityType: 'employee_advance',
    entityId: advanceId,
    action: `expense.advance.${decision}`,
    after: { employee_id: advance.employee_id, approved_amount: amount },
  });
}

/** Records that an approved advance was actually paid out. Only then can it be settled. */
export async function payAdvance(tx: TenantTx, advanceId: string, amount: number): Promise<void> {
  const { rows } = await tx.query<{ status: string; approved_amount: string | null }>(
    `SELECT status, approved_amount FROM expense.employee_advance
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tx.tenantId, advanceId],
  );
  const advance = rows[0];
  if (!advance) throw notFound('Employee advance');
  if (advance.status !== 'approved') {
    throw conflict('not_approved', 'Only an approved advance can be paid');
  }
  if (amount > Number(advance.approved_amount ?? 0)) {
    throw unprocessable('above_approved', 'Payment cannot exceed the approved amount');
  }

  await tx.query(
    `UPDATE expense.employee_advance SET status = 'paid', paid_amount = $3
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, advanceId, amount],
  );

  await audit(tx, {
    entityType: 'employee_advance',
    entityId: advanceId,
    action: 'expense.advance.paid',
    after: { amount },
  });
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
