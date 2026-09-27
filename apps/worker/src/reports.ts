import { SYSTEM_ACTOR, withTenant } from '@hrms/api/src/infra/db/pool.ts';
import { claimEvent } from '@hrms/api/src/infra/events/outbox.ts';
import { sha256, storage } from '@hrms/api/src/infra/storage.ts';
import { audit } from '@hrms/api/src/infra/audit.ts';
import {
  reportDefinition,
  type ReportParameters,
  type ReportType,
} from '@hrms/api/src/modules/reporting/definitions.ts';

/**
 * Report generation.
 *
 * Three phases separated by commits, the same shape as payslip generation next door, and for
 * the same reason: the S3 upload happens with **no transaction open**. Running the export
 * inside the query's transaction would hold a read transaction across a network call to the
 * object store — the pattern the outbox publisher and the notification worker were both
 * explicitly changed to stop doing.
 *
 *   1. query   — run the report inside tenant context, commit
 *   2. upload  — write the CSV to S3, outside any transaction
 *   3. record  — claim the event, write the document row and settle the run, together
 *
 * Tenant context comes from the envelope and nothing else (ADR-002): a worker has no request
 * and no JWT, and `withTenant` refuses anything that is not a uuid, so a report can only ever
 * be generated inside the tenant that asked for it. Every statement additionally carries its
 * own `tenant_id` predicate, and RLS is underneath both.
 *
 * Re-delivery is safe. The event claim and the document row commit together, so "this event
 * was handled" and "the export exists" cannot disagree; and the run is re-read under `FOR
 * UPDATE` before settling, so a second delivery that raced the first finds the report already
 * finished and leaves it alone rather than producing a second artifact.
 */

const CONSUMER_NAME = 'platform-worker';

/** Cap on rows in one export. Past this the report is the wrong question, not a bigger file. */
const MAX_ROWS = 100_000;

type Envelope = {
  event_id: string;
  tenant_id: string;
  aggregate_id: string;
  correlation_id?: string;
  payload?: Record<string, unknown>;
};

/**
 * RFC 4180 quoting.
 *
 * Every value is quoted rather than only the ones that need it: a department called
 * `Sales, EMEA` or an audit action containing a newline must not become two columns, and
 * deciding per value is how that gets missed. A leading `=`, `+`, `-` or `@` is prefixed with
 * a quote, because spreadsheet software treats those as formulas — an exported report is a
 * file someone opens in Excel, and a department name is not a thing that should execute.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const text = String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function toCsv(columns: readonly string[], rows: Record<string, unknown>[]): Buffer {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(row[c])).join(','));
  }
  // Trailing newline: a file whose last line has no terminator is one some tools drop.
  return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
}

export async function onReportRequested(envelope: Envelope): Promise<void> {
  const runId = (envelope.payload?.report_run_id as string | undefined) ?? envelope.aggregate_id;
  const actor = { ...SYSTEM_ACTOR, label: CONSUMER_NAME, correlationId: envelope.correlation_id };

  // Phase 1 — claim the run and produce the rows.
  const produced = await withTenant(envelope.tenant_id, actor, async (tx) => {
    const { rows } = await tx.query<{
      status: string;
      report_type: ReportType;
      parameters: ReportParameters;
    }>(
      `SELECT status, report_type, parameters FROM analytics.report_run
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE`,
      [tx.tenantId, runId],
    );
    const run = rows[0];
    if (!run) return null;

    // Terminal is terminal: a completed or failed run is never regenerated, which is what
    // makes a duplicate delivery a no-op.
    //
    // `running` is *not* terminal and must be retried. Phase 1 commits `running` before the
    // query and the upload, so a worker that dies in between leaves the run there. The
    // message was never acknowledged, so SQS redelivers it — and refusing to pick it up
    // because it is already `running` would strand it in that state permanently, with the
    // client polling a row that will never change. The row is held `FOR UPDATE` here, so two
    // concurrent deliveries serialise; the second may repeat the work, and phase 3 re-reads
    // under lock so only one of them records a document.
    if (run.status === 'completed' || run.status === 'failed') return null;

    await tx.query(
      `UPDATE analytics.report_run
          SET status = 'running', started_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, runId],
    );

    const definition = reportDefinition(run.report_type);
    const data = await definition.run(tx, tx.tenantId, run.parameters);
    return { definition, data, parameters: run.parameters };
  });

  if (!produced) {
    // Nothing to do. Claim the event so a redelivery does not re-check for ever.
    await withTenant(envelope.tenant_id, actor, (tx) =>
      claimEvent(tx, envelope.tenant_id, envelope.event_id, CONSUMER_NAME).then(() => undefined),
    );
    return;
  }

  if (produced.data.length > MAX_ROWS) {
    await settleFailed(
      envelope,
      actor,
      runId,
      `The report produced ${produced.data.length} rows, over the ${MAX_ROWS} row export limit; narrow the date range or filters`,
    );
    return;
  }

  // Phase 2 — render and upload, outside any transaction.
  let key: string;
  let csv: Buffer;
  const filename = `${produced.definition.type}-${produced.parameters.dateFrom}-to-${produced.parameters.dateTo}.csv`;
  try {
    csv = toCsv(produced.definition.columns, produced.data);
    const store = storage();
    key = store.buildKey(envelope.tenant_id, 'report', filename);
    await store.putObject(key, csv, 'text/csv');
  } catch (err) {
    await settleFailed(envelope, actor, runId, err instanceof Error ? err.message : String(err));
    return;
  }

  // Phase 3 — record. The event claim, the document row and the run's status commit together.
  await withTenant(envelope.tenant_id, actor, async (tx) => {
    const claimed = await claimEvent(tx, envelope.tenant_id, envelope.event_id, CONSUMER_NAME);
    if (!claimed) return;

    // Re-read under lock: another delivery may have finished this run while we uploaded.
    // Two objects in S3 is waste; two document rows is a second report.
    const { rows } = await tx.query<{ status: string; document_id: string | null }>(
      `SELECT status, document_id FROM analytics.report_run
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tx.tenantId, runId],
    );
    const current = rows[0];
    if (!current || current.status !== 'running' || current.document_id) return;

    const document = await tx.query<{ id: string }>(
      `INSERT INTO documents.document
         (tenant_id, employee_id, document_type, filename, content_type, size_bytes,
          s3_bucket, s3_key, checksum_sha256, is_sensitive, status, uploaded_by)
       VALUES ($1, NULL, 'report', $2, 'text/csv', $3, $4, $5, $6, $7, 'available', NULL)
       RETURNING id`,
      [
        tx.tenantId, filename, csv.byteLength, storage().bucket, key, sha256(csv),
        produced.definition.sensitive,
      ],
    );

    await tx.query(
      `UPDATE analytics.report_run
          SET status = 'completed', completed_at = now(), updated_at = now(),
              row_count = $3, document_id = $4
        WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, runId, produced.data.length, document.rows[0]!.id],
    );

    await audit(tx, {
      entityType: 'report_run',
      entityId: runId,
      action: 'report.generated',
      after: { row_count: produced.data.length, document_id: document.rows[0]!.id },
      metadata: { report_type: produced.definition.type, sensitive_report: produced.definition.sensitive },
    });
  });
}

/**
 * Records a failed generation.
 *
 * Terminal on purpose. A report that cannot be produced should say so on the row the client
 * is polling, rather than being retried until the queue gives up and leaves the run sitting
 * at `running` for ever with nothing to explain it. The event is claimed in the same
 * transaction so the failure is recorded exactly once.
 */
async function settleFailed(
  envelope: Envelope,
  actor: Record<string, unknown>,
  runId: string,
  reason: string,
): Promise<void> {
  await withTenant(envelope.tenant_id, actor as never, async (tx) => {
    await claimEvent(tx, envelope.tenant_id, envelope.event_id, CONSUMER_NAME);
    await tx.query(
      `UPDATE analytics.report_run
          SET status = 'failed', completed_at = now(), updated_at = now(), failure_reason = $3
        WHERE tenant_id = $1 AND id = $2 AND status = 'running'`,
      [tx.tenantId, runId, reason.slice(0, 1000)],
    );
  });
}
