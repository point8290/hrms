import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, created, inTenant, parseBody, parseParams, parseQuery } from '../../http/context.ts';
import { requirePermission, resolveTargetEmployee } from '../../http/auth.ts';
import { audit } from '../../infra/audit.ts';
import { conflict, isPgError, notFound, PG_UNIQUE_VIOLATION } from '../../infra/errors.ts';
import { assertCanViewEmployee } from '../core-hr/routes.ts';
import * as expense from './service.ts';

const uuid = z.string().uuid();
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const idParam = z.object({ id: uuid });

export async function expenseRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- types

  app.post('/api/expense-types', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'expense.manage');
      const body = parseBody(
        request,
        z.object({
          code: z.string().min(1).max(32),
          name: z.string().min(1).max(120),
          receiptRequired: z.boolean().default(true),
          limitAmount: z.number().positive().optional(),
          dailyLimitAmount: z.number().positive().optional(),
          requiresBusinessPurpose: z.boolean().default(false),
        }),
      );

      try {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO expense.expense_type
             (tenant_id, code, name, receipt_required, limit_amount, daily_limit_amount, requires_business_purpose)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [
            tx.tenantId, body.code, body.name, body.receiptRequired,
            body.limitAmount ?? null, body.dailyLimitAmount ?? null, body.requiresBusinessPurpose,
          ],
        );
        await audit(tx, {
          entityType: 'expense_type',
          entityId: rows[0]!.id,
          action: 'expense_type.created',
          after: body as Record<string, unknown>,
        });
        return created(reply, { id: rows[0]!.id });
      } catch (err) {
        if (isPgError(err, PG_UNIQUE_VIOLATION)) {
          throw conflict('expense_type_code_taken', `Expense type ${body.code} already exists`);
        }
        throw err;
      }
    }),
  );

  app.get('/api/expense-types', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'expense.read.self', 'expense.read', 'expense.manage');
      const { rows } = await tx.query(
        `SELECT id, code, name, receipt_required, limit_amount, daily_limit_amount,
                requires_business_purpose, status
           FROM expense.expense_type WHERE tenant_id = $1 AND status = 'active' ORDER BY name`,
        [tx.tenantId],
      );
      return { expense_types: rows };
    }),
  );

  // ---------------------------------------------------------------- claims

  app.post('/api/expense-claims', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      const body = parseBody(
        request,
        z.object({
          employeeId: uuid.optional(),
          claimDate: dateString,
          title: z.string().min(1).max(160),
          businessPurpose: z.string().max(500).optional(),
          lines: z
            .array(
              z.object({
                expenseTypeId: uuid,
                expenseDate: dateString,
                description: z.string().min(1).max(300),
                claimedAmount: z.number().positive(),
                taxAmount: z.number().min(0).optional(),
                receiptDocumentId: uuid.optional(),
              }),
            )
            .min(1)
            .max(50),
        }),
      );

      // Claiming for someone else is an HR/finance action, not self-service.
      const target = resolveTargetEmployee(principal, body.employeeId, {
        self: 'expense.submit',
        others: 'expense.manage',
      });

      const result = await expense.createClaim(tx, { ...body, employeeId: target.employeeId });
      return created(reply, {
        id: result.id,
        claim_number: result.claimNumber,
        total_claimed: result.totalClaimed,
      });
    }),
  );

  app.post('/api/expense-claims/:id/submit', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const params = parseParams(request, idParam);
      const { rows } = await tx.query<{ employee_id: string }>(
        'SELECT employee_id FROM expense.expense_claim WHERE tenant_id = $1 AND id = $2',
        [tx.tenantId, params.id],
      );
      if (!rows[0]) throw notFound('Expense claim');

      resolveTargetEmployee(principal, rows[0].employee_id, {
        self: 'expense.submit',
        others: 'expense.manage',
      });

      const result = await expense.submitClaim(tx, params.id);
      return { id: params.id, status: result.status, reimbursable_amount: result.reimbursable };
    }),
  );

  app.get('/api/expense-claims', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const query = parseQuery(
        request,
        z.object({
          employeeId: uuid.optional(),
          status: z.string().max(32).optional(),
          /**
           * `finance` lists every claim awaiting finance, across employees.
           *
           * The default shape of this route resolves exactly one employee — the caller, or
           * whoever they name — which is right for self-service and for a manager reading one
           * report's claims. Finance needs the opposite question answered: whoever raised it,
           * if it is waiting on them. That is a different question rather than a different
           * resource, so it is a scope on this route and not a second expense domain.
           *
           * Gated on `expense.finance` specifically. `expense.approve` is deliberately not
           * enough: a manager who approves their own team's claims must not thereby be able
           * to read every claim in the company.
           */
          scope: z.enum(['self', 'finance']).default('self'),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      );

      if (query.scope === 'finance') {
        requirePermission(principal, 'expense.finance');
        const { rows } = await tx.query(
          `SELECT c.id, c.employee_id, c.claim_number,
                  to_char(c.claim_date, 'YYYY-MM-DD') AS claim_date,
                  c.title, c.status, c.total_claimed_amount, c.total_sanctioned_amount,
                  c.advance_adjusted_amount, c.reimbursable_amount, c.currency,
                  c.submitted_at, c.paid_at, c.payment_reference,
                  e.first_name || ' ' || e.last_name AS employee_name,
                  e.employee_code
             FROM expense.expense_claim c
             JOIN core.employee e ON e.id = c.employee_id AND e.tenant_id = c.tenant_id
            WHERE c.tenant_id = $1
              AND ($2::text IS NULL OR c.status = $2)
              -- Everything finance still has a decision or a payment to make on.
              AND c.status IN ('finance_review', 'approved', 'payment_pending')
            ORDER BY c.submitted_at NULLS LAST, c.claim_date DESC
            LIMIT $3`,
          [tx.tenantId, query.status ?? null, query.limit],
        );
        return { claims: rows };
      }

      const target = resolveTargetEmployee(principal, query.employeeId, {
        self: 'expense.read.self',
        others: 'expense.read',
      });
      if (target.scope === 'others') {
        await assertCanViewEmployee(tx, principal, target.employeeId);
      }

      const { rows } = await tx.query(
        `SELECT id, claim_number, to_char(claim_date, 'YYYY-MM-DD') AS claim_date, title, status,
                total_claimed_amount, total_sanctioned_amount, advance_adjusted_amount,
                reimbursable_amount, currency, submitted_at, paid_at, payment_reference
           FROM expense.expense_claim
          WHERE tenant_id = $1 AND employee_id = $2
            AND ($3::text IS NULL OR status = $3)
          ORDER BY claim_date DESC
          LIMIT $4`,
        [tx.tenantId, target.employeeId, query.status ?? null, query.limit],
      );
      return { claims: rows };
    }),
  );

  app.get('/api/expense-claims/:id', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const params = parseParams(request, idParam);
      const header = await tx.query<{ employee_id: string }>(
        `SELECT id, employee_id, claim_number, to_char(claim_date, 'YYYY-MM-DD') AS claim_date,
                title, business_purpose, status, total_claimed_amount, total_sanctioned_amount,
                advance_adjusted_amount, reimbursable_amount, currency, submitted_at,
                decided_at, decision_note, paid_at, payment_reference
           FROM expense.expense_claim WHERE tenant_id = $1 AND id = $2`,
        [tx.tenantId, params.id],
      );
      const claim = header.rows[0];
      if (!claim) throw notFound('Expense claim');

      resolveTargetEmployee(principal, claim.employee_id, {
        self: 'expense.read.self',
        others: 'expense.read',
      });

      const lines = await tx.query(
        `SELECT el.id, et.code AS expense_type, et.name AS expense_type_name,
                to_char(el.expense_date, 'YYYY-MM-DD') AS expense_date, el.description,
                el.claimed_amount, el.sanctioned_amount, el.sanction_note, el.tax_amount,
                el.receipt_document_id
           FROM expense.expense_line el
           JOIN expense.expense_type et ON et.id = el.expense_type_id
          WHERE el.tenant_id = $1 AND el.expense_claim_id = $2
          ORDER BY el.expense_date`,
        [tx.tenantId, params.id],
      );

      const settlements = await tx.query(
        `SELECT employee_advance_id, SUM(amount) AS amount
           FROM expense.advance_settlement
          WHERE tenant_id = $1 AND expense_claim_id = $2
          GROUP BY employee_advance_id
         HAVING SUM(amount) <> 0`,
        [tx.tenantId, params.id],
      );

      return { ...claim, lines: lines.rows, advance_settlements: settlements.rows };
    }),
  );

  /**
   * Finance sanctions the claim line by line.
   *
   * Separate permission from manager approval: deciding how much the company pays is a
   * finance decision, and it is marked sensitive because it moves money.
   */
  app.post('/api/expense-claims/:id/sanction', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'expense.finance');
      const params = parseParams(request, idParam);
      const body = parseBody(
        request,
        z.object({
          lines: z
            .array(
              z.object({
                lineId: uuid,
                sanctionedAmount: z.number().min(0),
                note: z.string().max(300).optional(),
              }),
            )
            .min(1),
          decisionNote: z.string().max(500).optional(),
        }),
      );
      const result = await expense.sanction(tx, params.id, body);
      return {
        id: params.id,
        status: 'approved',
        sanctioned_amount: result.sanctioned,
        reimbursable_amount: result.reimbursable,
      };
    }),
  );

  app.post('/api/expense-claims/:id/pay', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'expense.finance');
      const params = parseParams(request, idParam);
      const body = parseBody(
        request,
        z.object({ paymentReference: z.string().min(1).max(120) }),
      );
      await expense.markPaid(tx, params.id, body.paymentReference);
      return { id: params.id, status: 'paid' };
    }),
  );

  app.post('/api/expense-claims/:id/cancel', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const params = parseParams(request, idParam);
      const body = parseBody(request, z.object({ reason: z.string().min(3).max(300) }));

      const { rows } = await tx.query<{ employee_id: string }>(
        'SELECT employee_id FROM expense.expense_claim WHERE tenant_id = $1 AND id = $2',
        [tx.tenantId, params.id],
      );
      if (!rows[0]) throw notFound('Expense claim');

      resolveTargetEmployee(principal, rows[0].employee_id, {
        self: 'expense.submit',
        others: 'expense.manage',
      });

      await expense.cancelClaim(tx, params.id, body.reason);
      return { id: params.id, status: 'cancelled' };
    }),
  );

  // ---------------------------------------------------------------- advances

  app.post('/api/expense-advances', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      const body = parseBody(
        request,
        z.object({
          employeeId: uuid.optional(),
          purpose: z.string().min(3).max(300),
          amount: z.number().positive(),
          neededBy: dateString.optional(),
        }),
      );
      const target = resolveTargetEmployee(principal, body.employeeId, {
        self: 'expense.submit',
        others: 'expense.manage',
      });
      const result = await expense.requestAdvance(tx, { ...body, employeeId: target.employeeId });
      return created(reply, { id: result.id, status: result.status });
    }),
  );

  app.get('/api/expense-advances', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const query = parseQuery(request, z.object({ employeeId: uuid.optional() }));
      const target = resolveTargetEmployee(principal, query.employeeId, {
        self: 'expense.read.self',
        others: 'expense.read',
      });

      const { rows } = await tx.query(
        `SELECT id, purpose, requested_amount, approved_amount, paid_amount, claimed_amount,
                returned_amount,
                (paid_amount - claimed_amount - returned_amount) AS outstanding_amount,
                status, to_char(needed_by, 'YYYY-MM-DD') AS needed_by, created_at
           FROM expense.employee_advance
          WHERE tenant_id = $1 AND employee_id = $2
          ORDER BY created_at DESC`,
        [tx.tenantId, target.employeeId],
      );
      return { advances: rows };
    }),
  );

  app.post('/api/expense-advances/:id/decision', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'expense.approve', 'expense.manage');
      const params = parseParams(request, idParam);
      const body = parseBody(
        request,
        z.object({
          decision: z.enum(['approved', 'rejected']),
          approvedAmount: z.number().positive().optional(),
        }),
      );
      await expense.decideAdvance(tx, params.id, body.decision, body.approvedAmount);
      return { id: params.id, status: body.decision };
    }),
  );

  app.post('/api/expense-advances/:id/pay', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'expense.finance');
      const params = parseParams(request, idParam);
      const body = parseBody(request, z.object({ amount: z.number().positive() }));
      await expense.payAdvance(tx, params.id, body.amount);
      return { id: params.id, status: 'paid' };
    }),
  );
}
