import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/infra/db/pool.ts';
import * as expense from '../../src/modules/expense/service.ts';
import { createEmployee, createTestTenant, dropTestTenant, skipWithoutDb, type TestTenant } from './helpers.ts';

/**
 * Expense claims, advances and reimbursement.
 *
 * The money paths matter most: an advance must not be reimbursed twice, finance must be
 * able to sanction less than was claimed, and a paid claim must be immutable.
 */
describe('expense claims', skipWithoutDb, () => {
  let tenant: TestTenant;
  let employeeId: string;
  let travelTypeId: string;
  let mealTypeId: string;

  before(async () => {
    tenant = await createTestTenant('expense');
    employeeId = await createEmployee(tenant, { code: 'EXP001' });

    await tenant.as(async (tx) => {
      const travel = await tx.query<{ id: string }>(
        `INSERT INTO expense.expense_type (tenant_id, code, name, receipt_required)
         VALUES ($1, 'TRAVEL', 'Travel', true) RETURNING id`,
        [tenant.tenantId],
      );
      travelTypeId = travel.rows[0]!.id;

      const meal = await tx.query<{ id: string }>(
        `INSERT INTO expense.expense_type (tenant_id, code, name, receipt_required, daily_limit_amount)
         VALUES ($1, 'MEAL', 'Meals', false, 1000) RETURNING id`,
        [tenant.tenantId],
      );
      mealTypeId = meal.rows[0]!.id;
    });
  });

  after(async () => {
    await dropTestTenant(tenant.tenantId);
    await closePools();
  });

  async function document(): Promise<string> {
    return tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO documents.document
           (tenant_id, employee_id, document_type, filename, content_type, size_bytes,
            s3_bucket, s3_key, status)
         VALUES ($1, $2, 'expense_receipt', 'receipt.pdf', 'application/pdf', 1024,
                 'test', 'receipts/' || gen_random_uuid(), 'available')
         RETURNING id`,
        [tenant.tenantId, employeeId],
      );
      return rows[0]!.id;
    });
  }

  it('requires a receipt when the expense type demands one', async () => {
    await assert.rejects(
      tenant.as((tx) =>
        expense.createClaim(tx, {
          employeeId,
          claimDate: '2026-07-01',
          title: 'Client visit',
          lines: [
            { expenseTypeId: travelTypeId, expenseDate: '2026-07-01', description: 'Taxi', claimedAmount: 500 },
          ],
        }),
      ),
      /requires a receipt/,
    );
  });

  it('enforces a daily limit across the whole claim', async () => {
    await assert.rejects(
      tenant.as((tx) =>
        expense.createClaim(tx, {
          employeeId,
          claimDate: '2026-07-02',
          title: 'Meals',
          lines: [
            { expenseTypeId: mealTypeId, expenseDate: '2026-07-02', description: 'Lunch', claimedAmount: 600 },
            { expenseTypeId: mealTypeId, expenseDate: '2026-07-02', description: 'Dinner', claimedAmount: 700 },
          ],
        }),
      ),
      /limited to 1000.00 per day/,
    );
  });

  it('enforces a daily limit across separate claims for the same date', async () => {
    await tenant.as((tx) =>
      expense.createClaim(tx, {
        employeeId,
        claimDate: '2026-07-03',
        title: 'Lunch',
        lines: [
          { expenseTypeId: mealTypeId, expenseDate: '2026-07-03', description: 'Lunch', claimedAmount: 800 },
        ],
      }),
    );

    // A second claim for the same day must see what the first already used.
    await assert.rejects(
      tenant.as((tx) =>
        expense.createClaim(tx, {
          employeeId,
          claimDate: '2026-07-03',
          title: 'Dinner',
          lines: [
            { expenseTypeId: mealTypeId, expenseDate: '2026-07-03', description: 'Dinner', claimedAmount: 400 },
          ],
        }),
      ),
      /limited to 1000.00 per day/,
    );
  });

  it('creates a claim with a sequential number', async () => {
    const receipt = await document();
    const claim = await tenant.as((tx) =>
      expense.createClaim(tx, {
        employeeId,
        claimDate: '2026-07-05',
        title: 'Client visit',
        lines: [
          { expenseTypeId: travelTypeId, expenseDate: '2026-07-05', description: 'Flight', claimedAmount: 12000, receiptDocumentId: receipt },
          { expenseTypeId: mealTypeId, expenseDate: '2026-07-05', description: 'Dinner', claimedAmount: 900 },
        ],
      }),
    );

    assert.match(claim.claimNumber, /^EXP-2026-\d{5}$/);
    assert.equal(claim.totalClaimed, 12900);
  });

  it('settles an outstanding advance when the claim is submitted', async () => {
    const advance = await tenant.as((tx) =>
      expense.requestAdvance(tx, { employeeId, purpose: 'Trip float', amount: 10000 }),
    );
    await tenant.as((tx) => expense.decideAdvance(tx, advance.id, 'approved', 10000));
    await tenant.as((tx) => expense.payAdvance(tx, advance.id, 10000));

    const receipt = await document();
    const claim = await tenant.as((tx) =>
      expense.createClaim(tx, {
        employeeId,
        claimDate: '2026-07-10',
        title: 'Trip expenses',
        lines: [
          { expenseTypeId: travelTypeId, expenseDate: '2026-07-10', description: 'Hotel', claimedAmount: 15000, receiptDocumentId: receipt },
        ],
      }),
    );

    const submitted = await tenant.as((tx) => expense.submitClaim(tx, claim.id));

    // The employee already holds 10,000 of company money, so only the balance is owed.
    assert.equal(submitted.reimbursable, 5000);

    const outstanding = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ outstanding: string; status: string }>(
        `SELECT (paid_amount - claimed_amount - returned_amount)::text AS outstanding, status
           FROM expense.employee_advance WHERE id = $1`,
        [advance.id],
      );
      return rows[0]!;
    });
    assert.equal(Number(outstanding.outstanding), 0);
    assert.equal(outstanding.status, 'settled', 'a fully consumed advance is settled');
  });

  it('lets finance sanction less than was claimed, with a reason', async () => {
    const claimId = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM expense.expense_claim WHERE status = 'finance_review' ORDER BY created_at DESC LIMIT 1`,
      );
      return rows[0]!.id;
    });

    const lines = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'SELECT id FROM expense.expense_line WHERE expense_claim_id = $1',
        [claimId],
      );
      return rows;
    });

    const result = await tenant.as((tx) =>
      expense.sanction(tx, claimId, {
        lines: [{ lineId: lines[0]!.id, sanctionedAmount: 12000, note: 'Hotel rate above policy' }],
        decisionNote: 'Partially sanctioned',
      }),
    );

    assert.equal(result.sanctioned, 12000);
    // The advance still applies, but only up to what is now payable.
    assert.equal(result.reimbursable, 2000);
  });

  it('refuses to reduce a line without explaining why', async () => {
    const receipt = await document();
    const claim = await tenant.as((tx) =>
      expense.createClaim(tx, {
        employeeId,
        claimDate: '2026-07-15',
        title: 'Supplies',
        lines: [
          { expenseTypeId: travelTypeId, expenseDate: '2026-07-15', description: 'Rail', claimedAmount: 2000, receiptDocumentId: receipt },
        ],
      }),
    );
    await tenant.as((tx) => expense.submitClaim(tx, claim.id));

    const lineId = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'SELECT id FROM expense.expense_line WHERE expense_claim_id = $1',
        [claim.id],
      );
      return rows[0]!.id;
    });

    await assert.rejects(
      tenant.as((tx) =>
        expense.sanction(tx, claim.id, { lines: [{ lineId, sanctionedAmount: 1500 }] }),
      ),
      /requires a note/,
      'an employee is owed a reason for not being paid in full',
    );
  });

  it('refuses to sanction above the amount claimed', async () => {
    const { claimId, lineId } = await tenant.as(async (tx) => {
      const claim = await tx.query<{ id: string }>(
        `SELECT id FROM expense.expense_claim WHERE status = 'finance_review' ORDER BY created_at DESC LIMIT 1`,
      );
      const line = await tx.query<{ id: string }>(
        'SELECT id FROM expense.expense_line WHERE expense_claim_id = $1',
        [claim.rows[0]!.id],
      );
      return { claimId: claim.rows[0]!.id, lineId: line.rows[0]!.id };
    });

    await assert.rejects(
      tenant.as((tx) =>
        expense.sanction(tx, claimId, { lines: [{ lineId, sanctionedAmount: 99999 }] }),
      ),
      /cannot be sanctioned above/,
    );
  });

  it('makes a paid claim immutable', async () => {
    const claimId = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM expense.expense_claim WHERE status = 'approved' ORDER BY created_at LIMIT 1`,
      );
      return rows[0]!.id;
    });

    await tenant.as((tx) => expense.markPaid(tx, claimId, 'NEFT-20260720-001'));

    await assert.rejects(
      tenant.as((tx) =>
        tx.query('UPDATE expense.expense_claim SET total_sanctioned_amount = 1 WHERE id = $1', [claimId]),
      ),
      /immutable/,
    );
  });

  it('refuses to cancel a paid claim', async () => {
    const claimId = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM expense.expense_claim WHERE status = 'paid' LIMIT 1`,
      );
      return rows[0]!.id;
    });

    await assert.rejects(
      tenant.as((tx) => expense.cancelClaim(tx, claimId, 'changed my mind')),
      /paid claim cannot be cancelled/,
    );
  });

  it('returns settled advance money when a claim is cancelled', async () => {
    const advance = await tenant.as((tx) =>
      expense.requestAdvance(tx, { employeeId, purpose: 'Second float', amount: 5000 }),
    );
    await tenant.as((tx) => expense.decideAdvance(tx, advance.id, 'approved', 5000));
    await tenant.as((tx) => expense.payAdvance(tx, advance.id, 5000));

    const receipt = await document();
    const claim = await tenant.as((tx) =>
      expense.createClaim(tx, {
        employeeId,
        claimDate: '2026-08-01',
        title: 'Cancelled trip',
        lines: [
          { expenseTypeId: travelTypeId, expenseDate: '2026-08-01', description: 'Booking', claimedAmount: 4000, receiptDocumentId: receipt },
        ],
      }),
    );
    await tenant.as((tx) => expense.submitClaim(tx, claim.id));

    const during = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ outstanding: string }>(
        `SELECT (paid_amount - claimed_amount - returned_amount)::text AS outstanding
           FROM expense.employee_advance WHERE id = $1`,
        [advance.id],
      );
      return Number(rows[0]!.outstanding);
    });
    assert.equal(during, 1000, '4000 of the 5000 advance is consumed by the claim');

    await tenant.as((tx) => expense.cancelClaim(tx, claim.id, 'Trip cancelled'));

    const afterCancel = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ outstanding: string; status: string }>(
        `SELECT (paid_amount - claimed_amount - returned_amount)::text AS outstanding, status
           FROM expense.employee_advance WHERE id = $1`,
        [advance.id],
      );
      return rows[0]!;
    });
    assert.equal(Number(afterCancel.outstanding), 5000, 'the advance is fully outstanding again');
    assert.equal(afterCancel.status, 'paid');
  });

  it('keeps the settlement history after a reversal', async () => {
    const settlements = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ amount: string }>(
        `SELECT s.amount FROM expense.advance_settlement s
           JOIN expense.expense_claim c ON c.id = s.expense_claim_id
          WHERE c.title = 'Cancelled trip' ORDER BY s.created_at`,
      );
      return rows.map((r) => Number(r.amount));
    });

    // The original settlement and its compensating reversal both survive: the advance
    // balance is always explainable from the history, not just from the current number.
    assert.deepEqual(settlements, [4000, -4000]);
  });

  it('refuses to modify a settlement record', async () => {
    await assert.rejects(
      tenant.as((tx) => tx.query('UPDATE expense.advance_settlement SET amount = 0')),
      /append-only/,
    );
  });

  it('refuses to pay an advance above the approved amount', async () => {
    const advance = await tenant.as((tx) =>
      expense.requestAdvance(tx, { employeeId, purpose: 'Third float', amount: 3000 }),
    );
    await tenant.as((tx) => expense.decideAdvance(tx, advance.id, 'approved', 2000));

    await assert.rejects(
      tenant.as((tx) => expense.payAdvance(tx, advance.id, 3000)),
      /cannot exceed the approved amount/,
    );
  });

  it('isolates claims between tenants', async () => {
    const other = await createTestTenant('expense-other');
    try {
      const visible = await other.as(async (tx) => {
        const { rows } = await tx.query<{ count: string }>(
          'SELECT count(*) AS count FROM expense.expense_claim',
        );
        return Number(rows[0]!.count);
      });
      assert.equal(visible, 0, 'another tenant must not see these claims');
    } finally {
      await dropTestTenant(other.tenantId);
    }
  });
});
