import type { TenantTx } from '../../infra/db/pool.ts';
import { audit } from '../../infra/audit.ts';
import { emitEvent } from '../../infra/events/outbox.ts';
import { badRequest, notFound } from '../../infra/errors.ts';
import { reportDefinition, type ReportParameters, type ReportType } from './definitions.ts';

/**
 * Requesting a report, and asking how it went.
 *
 * The API never generates anything. It validates, records the request and returns its
 * identity; the work happens on the worker (PRD s.22 "asynchronous", s.25 "expose state
 * through a job or aggregate record rather than blocking HTTP requests"). That is the same
 * split payroll already uses — a run is created here and calculated elsewhere — so the client
 * contract is one it has already met.
 */

export type ReportRun = {
  id: string;
  report_type: ReportType;
  status: 'pending' | 'running' | 'completed' | 'failed';
  parameters: ReportParameters;
  row_count: number | null;
  document_id: string | null;
  failure_reason: string | null;
  requested_by_label: string;
  requested_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
};

/**
 * Checks the date range before anything is queued.
 *
 * A reversed range is rejected because it is a mistake that would otherwise produce an empty
 * report and look like an answer. That is validation, not policy.
 *
 * There is deliberately **no maximum range**. An earlier version capped requests at 400 days,
 * which was an implementation assumption rather than a requirement: nothing in the PRD bounds
 * a report period, and no other date-filtered endpoint in this application bounds one either
 * — `GET /api/attendance` takes an unbounded `from`/`to` and limits the *result* instead.
 *
 * Measurement said the same thing. A report's row count is governed by the cardinality of
 * what it groups by, not by how long the range is: a ten-year attendance report over 18,265
 * rows returns five rows in 23ms, and headcount and compensation are point-in-time, so their
 * output does not vary with the range at all. Only payroll cost grows with it, by one row per
 * payroll period per department — roughly 2,400 rows for a decade.
 *
 * What a pathological request actually threatens is the size of the export, and that already
 * has a bound expressed where it belongs: `MAX_ROWS` in the generator, which fails the run
 * with a reason naming the limit. A resource safeguard on the result, rather than a business
 * rule refusing three years of attendance that nobody asked to forbid.
 */
function validateRange(params: ReportParameters): void {
  const from = Date.parse(params.dateFrom);
  const to = Date.parse(params.dateTo);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw badRequest('invalid_date_range', 'dateFrom and dateTo must be YYYY-MM-DD dates');
  }
  if (to < from) {
    throw badRequest('invalid_date_range', 'dateTo cannot be before dateFrom');
  }
}

/**
 * Records the request and announces it.
 *
 * The row and the event commit together (ADR-004), so a report can never be requested without
 * something eventually running it, and can never be run without a row saying who asked.
 *
 * The audit entry is written here rather than on completion because the auditable act is a
 * person asking for the data — PRD s.27 audits sensitive operations, and running a payroll
 * cost export is one whether or not the generation later succeeds.
 */
export async function requestReport(
  tx: TenantTx,
  input: { reportType: ReportType; parameters: ReportParameters },
): Promise<ReportRun> {
  const definition = reportDefinition(input.reportType);
  if (!definition) throw badRequest('unknown_report_type', `No such report: ${input.reportType}`);
  validateRange(input.parameters);

  const { rows } = await tx.query<ReportRun>(
    `INSERT INTO analytics.report_run
       (tenant_id, report_type, parameters, requested_by_user_id, requested_by_label, correlation_id)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)
     RETURNING id, report_type, status, parameters, row_count, document_id, failure_reason,
               requested_by_label, requested_at, started_at, completed_at`,
    [
      tx.tenantId,
      input.reportType,
      JSON.stringify(input.parameters),
      tx.actor.userId ?? null,
      tx.actor.label ?? 'unknown',
      tx.actor.correlationId ?? tx.actor.requestId ?? null,
    ],
  );
  const run = rows[0]!;

  await audit(tx, {
    entityType: 'report_run',
    entityId: run.id,
    action: 'report.requested',
    after: { report_type: input.reportType, parameters: input.parameters },
    metadata: { sensitive_report: definition.sensitive },
  });

  await emitEvent(tx, 'ReportRequested', {
    aggregateType: 'report_run',
    aggregateId: run.id,
    payload: { report_run_id: run.id, report_type: input.reportType },
  });

  return run;
}

export async function getReportRun(tx: TenantTx, id: string): Promise<ReportRun> {
  const { rows } = await tx.query<ReportRun>(
    `SELECT id, report_type, status, parameters, row_count, document_id, failure_reason,
            requested_by_label, requested_at, started_at, completed_at
       FROM analytics.report_run
      WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, id],
  );
  const run = rows[0];
  if (!run) throw notFound('Report run');
  return run;
}

export async function listReportRuns(tx: TenantTx, limit = 50): Promise<ReportRun[]> {
  const { rows } = await tx.query<ReportRun>(
    `SELECT id, report_type, status, parameters, row_count, document_id, failure_reason,
            requested_by_label, requested_at, started_at, completed_at
       FROM analytics.report_run
      WHERE tenant_id = $1
      ORDER BY requested_at DESC
      LIMIT $2`,
    [tx.tenantId, Math.min(limit, 200)],
  );
  return rows;
}
