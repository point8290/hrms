import type { TenantTx } from '../../infra/db/pool.ts';
import { audit } from '../../infra/audit.ts';
import { decryptField } from '../../infra/crypto.ts';
import { conflict, notFound, unprocessable } from '../../infra/errors.ts';

/**
 * Payment batches and bank export.
 *
 * Runs only against a finalized payroll run: paying from figures that can still change is
 * the failure this whole design exists to prevent (ADR-005).
 *
 * Bank details are snapshotted onto each line. A bank account changed after the file went
 * to the bank must not silently redirect a payment already in flight, and a returned
 * payment has to be explainable against the details that were actually used.
 */

export type BatchResult = {
  id: string;
  batchNumber: string;
  employeeCount: number;
  totalAmount: number;
  excluded: Array<{ employee_code: string; reason: string }>;
};

/**
 * Builds a payment batch from a finalized run.
 *
 * Employees without usable bank details are excluded and reported, never silently dropped:
 * payroll is final and they are owed money, so the gap has to be visible and fixable.
 */
export async function createBatch(
  tx: TenantTx,
  input: { payrollRunId: string; valueDate: string; format?: 'neft' | 'csv' },
): Promise<BatchResult> {
  const run = await tx.query<{ status: string; period_end: string }>(
    `SELECT r.status, to_char(p.period_end, 'YYYY-MM-DD') AS period_end
       FROM payroll.payroll_run r
       JOIN payroll.payroll_period p ON p.id = r.payroll_period_id
      WHERE r.tenant_id = $1 AND r.id = $2
      FOR UPDATE OF r`,
    [tx.tenantId, input.payrollRunId],
  );
  const runRow = run.rows[0];
  if (!runRow) throw notFound('Payroll run');
  if (!['finalized', 'payment_pending'].includes(runRow.status)) {
    throw unprocessable(
      'run_not_finalized',
      `A payroll run that is ${runRow.status.replace(/_/g, ' ')} cannot be paid. Finalize it first.`,
    );
  }

  const existing = await tx.query<{ id: string; batch_number: string }>(
    `SELECT id, batch_number FROM payroll.payment_batch
      WHERE tenant_id = $1 AND payroll_run_id = $2 AND status <> 'failed'`,
    [tx.tenantId, input.payrollRunId],
  );
  if (existing.rows[0]) {
    throw conflict(
      'batch_exists',
      `Payment batch ${existing.rows[0].batch_number} already covers this run`,
    );
  }

  // Bank details resolved as at period end, so a mid-month account change does not apply
  // retroactively to a period that was paid on the old account.
  const { rows: slips } = await tx.query<{
    slip_id: string;
    employee_id: string;
    employee_code: string;
    net_amount: string;
    account_holder: string | null;
    account_number_encrypted: string | null;
    account_number_last4: string | null;
    ifsc: string | null;
  }>(
    `SELECT s.id AS slip_id, s.employee_id, e.employee_code, s.net_amount,
            b.account_holder, b.account_number_encrypted, b.account_number_last4, b.ifsc
       FROM payroll.salary_slip s
       JOIN core.employee e ON e.id = s.employee_id
       LEFT JOIN LATERAL (
         SELECT account_holder, account_number_encrypted, account_number_last4, ifsc
           FROM core.bank_account
          WHERE tenant_id = s.tenant_id AND employee_id = s.employee_id
            AND is_primary AND effective_from <= $3::date
            AND (effective_to IS NULL OR effective_to >= $3::date)
          ORDER BY effective_from DESC
          LIMIT 1
       ) b ON true
      WHERE s.tenant_id = $1 AND s.payroll_run_id = $2 AND s.status = 'finalized'
      ORDER BY e.employee_code`,
    [tx.tenantId, input.payrollRunId, runRow.period_end],
  );

  if (slips.length === 0) {
    throw unprocessable('no_finalized_slips', 'This run has no finalized payslips to pay');
  }

  const batchNumber = await nextBatchNumber(tx, input.valueDate);
  const excluded: Array<{ employee_code: string; reason: string }> = [];
  const payable = slips.filter((slip) => {
    if (Number(slip.net_amount) <= 0) {
      // A zero or negative net is not an error - full-month LOP produces one - but it is
      // not a payment either.
      excluded.push({ employee_code: slip.employee_code, reason: 'net pay is zero or negative' });
      return false;
    }
    if (!slip.account_number_encrypted || !slip.ifsc) {
      excluded.push({ employee_code: slip.employee_code, reason: 'no bank account on record for this period' });
      return false;
    }
    return true;
  });

  const total = payable.reduce((sum, s) => sum + Number(s.net_amount), 0);

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO payroll.payment_batch
       (tenant_id, payroll_run_id, batch_number, format, value_date, employee_count,
        total_amount, excluded, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     RETURNING id`,
    [
      tx.tenantId, input.payrollRunId, batchNumber, input.format ?? 'neft', input.valueDate,
      payable.length, total, JSON.stringify(excluded), tx.actor.userId,
    ],
  );
  const batchId = rows[0]!.id;

  for (const slip of payable) {
    await tx.query(
      `INSERT INTO payroll.payment_line
         (tenant_id, payment_batch_id, employee_id, salary_slip_id, account_holder_snapshot,
          account_number_last4, ifsc_snapshot, amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        tx.tenantId, batchId, slip.employee_id, slip.slip_id,
        slip.account_holder, slip.account_number_last4, slip.ifsc, slip.net_amount,
      ],
    );
  }

  await tx.query(
    `UPDATE payroll.payroll_run SET status = 'payment_pending' WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, input.payrollRunId],
  );

  await audit(tx, {
    entityType: 'payment_batch',
    entityId: batchId,
    action: 'payroll.payment.batch_created',
    after: {
      batch_number: batchNumber,
      employee_count: payable.length,
      total_amount: total,
      excluded,
    },
    metadata: excluded.length > 0 ? { requires_operator_attention: true } : undefined,
  });

  return { id: batchId, batchNumber, employeeCount: payable.length, totalAmount: total, excluded };
}

/**
 * Renders the bank file.
 *
 * Account numbers are decrypted here and held only for as long as it takes to build the
 * file. They are never written back to the batch, and never logged — the batch keeps only
 * the last four digits.
 */
export async function renderBatchFile(tx: TenantTx, batchId: string): Promise<{ filename: string; content: string }> {
  const batch = await tx.query<{
    batch_number: string;
    format: string;
    value_date: string;
    payroll_run_id: string;
    status: string;
  }>(
    `SELECT batch_number, format, to_char(value_date, 'YYYY-MM-DD') AS value_date,
            payroll_run_id, status
       FROM payroll.payment_batch WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, batchId],
  );
  const batchRow = batch.rows[0];
  if (!batchRow) throw notFound('Payment batch');

  const period = await tx.query<{ period_end: string }>(
    `SELECT to_char(p.period_end, 'YYYY-MM-DD') AS period_end
       FROM payroll.payroll_run r JOIN payroll.payroll_period p ON p.id = r.payroll_period_id
      WHERE r.tenant_id = $1 AND r.id = $2`,
    [tx.tenantId, batchRow.payroll_run_id],
  );

  const { rows: lines } = await tx.query<{
    employee_code: string;
    account_holder_snapshot: string;
    ifsc_snapshot: string;
    amount: string;
    employee_id: string;
  }>(
    `SELECT e.employee_code, l.account_holder_snapshot, l.ifsc_snapshot, l.amount, l.employee_id
       FROM payroll.payment_line l
       JOIN core.employee e ON e.id = l.employee_id
      WHERE l.tenant_id = $1 AND l.payment_batch_id = $2
      ORDER BY e.employee_code`,
    [tx.tenantId, batchId],
  );

  const rows: string[] = [
    'employee_code,beneficiary_name,account_number,ifsc,amount,value_date,reference',
  ];

  for (const line of lines) {
    const account = await tx.query<{ account_number_encrypted: string }>(
      `SELECT account_number_encrypted FROM core.bank_account
        WHERE tenant_id = $1 AND employee_id = $2 AND is_primary
          AND effective_from <= $3::date
          AND (effective_to IS NULL OR effective_to >= $3::date)
        ORDER BY effective_from DESC LIMIT 1`,
      [tx.tenantId, line.employee_id, period.rows[0]!.period_end],
    );
    const encrypted = account.rows[0]?.account_number_encrypted;
    if (!encrypted) continue;

    rows.push(
      [
        line.employee_code,
        csv(line.account_holder_snapshot),
        decryptField(encrypted),
        line.ifsc_snapshot,
        Number(line.amount).toFixed(2),
        batchRow.value_date,
        batchRow.batch_number,
      ].join(','),
    );
  }

  await audit(tx, {
    entityType: 'payment_batch',
    entityId: batchId,
    action: 'payroll.payment.file_generated',
    after: { batch_number: batchRow.batch_number, lines: rows.length - 1 },
    metadata: { contains_bank_details: true },
  });

  await tx.query(
    `UPDATE payroll.payment_batch SET status = 'exported' WHERE tenant_id = $1 AND id = $2
       AND status = 'generated'`,
    [tx.tenantId, batchId],
  );

  return {
    filename: `${batchRow.batch_number}.csv`,
    content: rows.join('\n'),
  };
}

/**
 * Records that the bank settled the batch.
 *
 * Lines the bank returned stay `returned` with the reason, and the run only reaches `paid`
 * when nothing is outstanding — a partially settled batch must not look complete.
 */
export async function recordSettlement(
  tx: TenantTx,
  batchId: string,
  input: { reference: string; returned?: Array<{ employeeCode: string; reason: string }> },
): Promise<{ settled: number; returned: number; runPaid: boolean }> {
  const batch = await tx.query<{ payroll_run_id: string; status: string }>(
    `SELECT payroll_run_id, status FROM payroll.payment_batch
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tx.tenantId, batchId],
  );
  const batchRow = batch.rows[0];
  if (!batchRow) throw notFound('Payment batch');
  if (batchRow.status === 'settled') {
    throw conflict('already_settled', 'This batch has already been settled');
  }

  const returnedCodes = input.returned ?? [];

  for (const entry of returnedCodes) {
    await tx.query(
      `UPDATE payroll.payment_line l
          SET status = 'returned', return_reason = $4
         FROM core.employee e
        WHERE e.id = l.employee_id AND l.tenant_id = $1
          AND l.payment_batch_id = $2 AND e.employee_code = $3`,
      [tx.tenantId, batchId, entry.employeeCode, entry.reason],
    );
  }

  const settled = await tx.query<{ count: string }>(
    `UPDATE payroll.payment_line
        SET status = 'settled'
      WHERE tenant_id = $1 AND payment_batch_id = $2 AND status <> 'returned'
      RETURNING 1`,
    [tx.tenantId, batchId],
  );

  await tx.query(
    `UPDATE payroll.payment_batch
        SET status = 'settled', settled_at = now(), settlement_reference = $3
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, batchId, input.reference],
  );

  // The run is paid only when every line landed. A returned payment means someone is still
  // owed money, and the run should keep saying so.
  const runPaid = returnedCodes.length === 0;
  if (runPaid) {
    await tx.query(
      `UPDATE payroll.payroll_run SET status = 'paid' WHERE tenant_id = $1 AND id = $2
         AND status = 'payment_pending'`,
      [tx.tenantId, batchRow.payroll_run_id],
    );
  }

  await audit(tx, {
    entityType: 'payment_batch',
    entityId: batchId,
    action: 'payroll.payment.settled',
    after: {
      reference: input.reference,
      settled: settled.rowCount ?? 0,
      returned: returnedCodes,
      run_marked_paid: runPaid,
    },
    metadata: returnedCodes.length > 0 ? { requires_operator_attention: true } : undefined,
  });

  return { settled: settled.rowCount ?? 0, returned: returnedCodes.length, runPaid };
}

async function nextBatchNumber(tx: TenantTx, valueDate: string): Promise<string> {
  const month = valueDate.slice(0, 7).replace('-', '');
  const { rows } = await tx.query<{ next: number }>(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(batch_number, '^PAY-\\d{6}-', ''), '')::bigint), 0) + 1 AS next
       FROM payroll.payment_batch WHERE tenant_id = $1 AND batch_number LIKE $2`,
    [tx.tenantId, `PAY-${month}-%`],
  );
  return `PAY-${month}-${String(rows[0]?.next ?? 1).padStart(3, '0')}`;
}

function csv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
