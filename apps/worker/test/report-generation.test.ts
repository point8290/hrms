import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closePools, withPlatform, withTenant, SYSTEM_ACTOR, type TenantTx } from '@hrms/api/src/infra/db/pool.ts';
import { storage } from '@hrms/api/src/infra/storage.ts';
import { onReportRequested, toCsv } from '../src/reports.ts';

/**
 * Report generation on the worker (PRD s.22 "asynchronous", s.25 "expose state through a job
 * or aggregate record").
 *
 * What matters here is not the numbers — those are pinned in the API suite against exact
 * fixtures — but the lifecycle around them: that a run reaches a terminal state, that the
 * export is a real tenant-scoped document, that a redelivered event does not produce a second
 * artifact, and that a failure is recorded on the row the client is polling rather than
 * leaving it at `running` for ever.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const skip = { skip: hasDb ? false : 'DATABASE_URL is not set' };

const actor = { ...SYSTEM_ACTOR, label: 'report-test' };

async function tenantTx<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withTenant(tenantId, actor, fn);
}

describe('report generation', skip, () => {
  let tenantId: string;

  before(async () => {
    tenantId = await withPlatform('tenant-provisioning', async (tx) => {
      const slug = `rptgen-${randomUUID().slice(0, 8)}`;
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO identity.tenant (name, slug, timezone) VALUES ($1,$2,'Asia/Kolkata') RETURNING id`,
        [slug, slug]);
      return rows[0]!.id;
    });

    await tenantTx(tenantId, async (tx) => {
      const company = await tx.query<{ id: string }>(
        `INSERT INTO core.company (tenant_id, name, legal_name) VALUES ($1,'Acme','Acme Ltd') RETURNING id`,
        [tx.tenantId]);
      const location = await tx.query<{ id: string }>(
        `INSERT INTO core.location (tenant_id, name, timezone, state_code)
         VALUES ($1,'Bengaluru','Asia/Kolkata','KA') RETURNING id`, [tx.tenantId]);
      const dept = await tx.query<{ id: string }>(
        `INSERT INTO core.department (tenant_id, name) VALUES ($1,'Engineering') RETURNING id`,
        [tx.tenantId]);

      // Two employees, so headcount has something exact to report.
      for (const code of ['GEN1', 'GEN2']) {
        const employee = await tx.query<{ id: string }>(
          `INSERT INTO core.employee
             (tenant_id, company_id, location_id, department_id, employee_code, first_name,
              last_name, work_email, joining_date, employment_status)
           VALUES ($1,$2,$3,$4,$5,'A','B',$6,'2026-01-01','active') RETURNING id`,
          [tx.tenantId, company.rows[0]!.id, location.rows[0]!.id, dept.rows[0]!.id, code,
           `${code}-${randomUUID().slice(0, 6)}@example.com`]);
        await tx.query(
          `INSERT INTO core.employment_history
             (tenant_id, employee_id, company_id, department_id, location_id,
              employment_type, employment_status, change_reason, effective_from)
           VALUES ($1,$2,$3,$4,$5,'full_time','active','joining','2026-01-01'::date)`,
          [tx.tenantId, employee.rows[0]!.id, company.rows[0]!.id, dept.rows[0]!.id, location.rows[0]!.id]);
      }
    });
  });

  after(async () => {
    await withPlatform('maintenance', async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['hrms:test:purge_tenant']);
      await tx.query('SELECT identity.purge_tenant($1,$2)', [tenantId, 'report generation test teardown']);
    });
    await closePools();
  });

  /** Requests a run directly, and returns the row plus a synthetic envelope for it. */
  async function request(reportType: string, parameters: Record<string, unknown>) {
    const run = await tenantTx(tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO analytics.report_run
           (tenant_id, report_type, parameters, requested_by_label)
         VALUES ($1,$2,$3::jsonb,'report-test') RETURNING id`,
        [tx.tenantId, reportType, JSON.stringify(parameters)]);
      return rows[0]!;
    });
    return {
      runId: run.id,
      envelope: {
        event_id: randomUUID(),
        tenant_id: tenantId,
        aggregate_id: run.id,
        payload: { report_run_id: run.id, report_type: reportType },
      },
    };
  }

  async function readRun(runId: string) {
    return tenantTx(tenantId, async (tx) => {
      const { rows } = await tx.query<{
        status: string; row_count: number | null; document_id: string | null;
        failure_reason: string | null; started_at: Date | null; completed_at: Date | null;
      }>(
        `SELECT status, row_count, document_id, failure_reason, started_at, completed_at
           FROM analytics.report_run WHERE tenant_id = $1 AND id = $2`,
        [tx.tenantId, runId]);
      return rows[0]!;
    });
  }

  const RANGE = { dateFrom: '2026-06-01', dateTo: '2026-06-30' };

  it('takes a pending run all the way to completed, with an export', async () => {
    const { runId, envelope } = await request('headcount', RANGE);

    await onReportRequested(envelope);

    const run = await readRun(runId);
    assert.equal(run.status, 'completed');
    assert.equal(run.row_count, 1, 'one department, one status: one row');
    assert.ok(run.document_id, 'a completed report must have produced an export');
    assert.ok(run.started_at && run.completed_at, 'a terminal run must say when it ran');
  });

  it('stores the export as a tenant-scoped document that can be read back', async () => {
    const { runId, envelope } = await request('headcount', RANGE);
    await onReportRequested(envelope);
    const run = await readRun(runId);

    const document = await tenantTx(tenantId, async (tx) => {
      const { rows } = await tx.query<{
        document_type: string; content_type: string; s3_key: string; filename: string;
        employee_id: string | null; is_sensitive: boolean; status: string; size_bytes: number;
      }>(
        `SELECT document_type, content_type, s3_key, filename, employee_id, is_sensitive,
                status, size_bytes
           FROM documents.document WHERE tenant_id = $1 AND id = $2`,
        [tx.tenantId, run.document_id]);
      return rows[0]!;
    });

    assert.equal(document.document_type, 'report');
    assert.equal(document.content_type, 'text/csv');
    assert.equal(document.employee_id, null, 'a report belongs to the tenant, not to a person');
    assert.equal(document.status, 'available');
    assert.ok(document.size_bytes > 0);
    // The object key is tenant-prefixed by the same storage seam every other document uses,
    // which is what stops a misissued URL reaching another tenant's file.
    assert.ok(document.s3_key.includes(tenantId), 'the object key must be scoped to the tenant');

    const body = await storage().getObject(document.s3_key);
    const [header, ...rest] = body.toString('utf8').trim().split('\r\n');
    assert.equal(header, '"department","location","employment_status","headcount"');
    assert.equal(rest.length, 1);
    assert.match(rest[0]!, /"Engineering","Bengaluru","active","2"/);
  });

  it('marks a sensitive report sensitive on the document itself', async () => {
    const { runId, envelope } = await request('payroll_cost', RANGE);
    await onReportRequested(envelope);
    const run = await readRun(runId);

    const sensitive = await tenantTx(tenantId, async (tx) => {
      const { rows } = await tx.query<{ is_sensitive: boolean }>(
        `SELECT is_sensitive FROM documents.document WHERE tenant_id = $1 AND id = $2`,
        [tx.tenantId, run.document_id]);
      return rows[0]!.is_sensitive;
    });
    assert.equal(sensitive, true);
  });

  it('does not produce a second artifact when the event is redelivered', async () => {
    const { runId, envelope } = await request('headcount', RANGE);

    await onReportRequested(envelope);
    const first = await readRun(runId);

    // Same envelope, same event id: at-least-once delivery, which SQS promises and the
    // consumer must absorb.
    await onReportRequested(envelope);
    const second = await readRun(runId);

    assert.equal(second.document_id, first.document_id, 'a redelivery must not replace the export');
    assert.equal(second.completed_at?.getTime(), first.completed_at?.getTime());

    const documents = await tenantTx(tenantId, async (tx) => {
      const { rows } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM documents.document
          WHERE tenant_id = $1 AND document_type = 'report' AND id = $2`,
        [tx.tenantId, first.document_id]);
      return rows[0]!.n;
    });
    assert.equal(documents, 1);
  });

  it('leaves an already-finished run alone rather than regenerating it', async () => {
    const { runId, envelope } = await request('headcount', RANGE);
    await onReportRequested(envelope);

    // A different delivery of a *different* event for the same run — the shape a duplicate
    // request would take. The run is no longer pending, so nothing should happen.
    await onReportRequested({ ...envelope, event_id: randomUUID() });

    const run = await readRun(runId);
    assert.equal(run.status, 'completed');
    assert.equal(run.row_count, 1);
  });

  it('records a failure on the run instead of leaving it running for ever', async () => {
    const { runId, envelope } = await request('headcount', RANGE);

    // Break the upload, which is the one step that talks to something outside the database.
    const real = storage();
    const broken = { ...real, putObject: async () => { throw new Error('bucket unreachable'); } };
    const { setStorage } = await import('@hrms/api/src/infra/storage.ts');
    setStorage(broken as never);
    try {
      await onReportRequested(envelope);
    } finally {
      setStorage(undefined);
    }

    const run = await readRun(runId);
    assert.equal(run.status, 'failed');
    assert.match(run.failure_reason!, /bucket unreachable/);
    assert.ok(run.completed_at, 'a failed run is finished, and must say when');
    assert.equal(run.document_id, null);
  });

  it('recovers a run left running by a crashed worker, on redelivery', async () => {
    // The crash window: phase 1 commits `running`, then the process dies before the artifact
    // is recorded. SQS redelivers the same event, because it was never acknowledged.
    const { runId, envelope } = await request('headcount', RANGE);
    await tenantTx(tenantId, (tx) => tx.query(
      `UPDATE analytics.report_run SET status='running', started_at=now()
        WHERE tenant_id=$1 AND id=$2`, [tx.tenantId, runId]).then(() => undefined));

    await onReportRequested(envelope);

    const run = await readRun(runId);
    assert.equal(
      run.status, 'completed',
      'a redelivery must finish a run its predecessor abandoned, not leave it running for ever',
    );
    assert.ok(run.document_id);
  });

  it('refuses to run at all without tenant context', async () => {
    // A worker has no request and no JWT: the envelope is its only source of tenant
    // identity (ADR-002). A malformed one must fail closed rather than run a report in
    // whatever context the pooled connection happened to have.
    const { envelope } = await request('headcount', RANGE);

    await assert.rejects(
      onReportRequested({ ...envelope, tenant_id: 'not-a-uuid' }),
      /tenant context/i,
    );
    await assert.rejects(
      onReportRequested({ ...envelope, tenant_id: '' }),
      /tenant context/i,
    );
  });

  it('records the generation in the audit trail', async () => {
    const { runId, envelope } = await request('payroll_cost', RANGE);
    await onReportRequested(envelope);

    const entry = await tenantTx(tenantId, async (tx) => {
      const { rows } = await tx.query<{
        action: string; entity_type: string; entity_id: string;
        after_state: Record<string, unknown>; metadata: Record<string, unknown>;
      }>(
        `SELECT action, entity_type, entity_id, after_state, metadata
           FROM audit.audit_log
          WHERE tenant_id = $1 AND entity_id = $2 AND action = 'report.generated'`,
        [tx.tenantId, runId]);
      return rows[0];
    });

    assert.ok(entry, 'generating a sensitive export must leave a trail');
    assert.equal(entry!.entity_type, 'report_run');
    assert.equal(entry!.metadata.report_type, 'payroll_cost');
    assert.equal(entry!.metadata.sensitive_report, true);
    assert.ok('row_count' in entry!.after_state);
  });

  it('keeps terminal runs terminal, and terminal rows complete', async () => {
    const { runId, envelope } = await request('headcount', RANGE);
    await onReportRequested(envelope);

    const completed = await readRun(runId);
    assert.equal(completed.status, 'completed');
    assert.ok(completed.completed_at, 'completed implies completed_at');
    assert.ok(completed.row_count !== null, 'completed implies row_count');

    // A fresh event for a finished run does nothing: terminal is terminal, which is what
    // makes redelivery and a duplicate request both safe.
    await onReportRequested({ ...envelope, event_id: randomUUID() });
    const after = await readRun(runId);
    assert.equal(after.status, 'completed');
    assert.equal(after.document_id, completed.document_id);
  });

  it('refuses to record a completed run with nothing to show for it', async () => {
    // The database constraint behind the invariant above, so it holds even if the worker
    // stops being the only writer.
    await assert.rejects(
      tenantTx(tenantId, (tx) => tx.query(
        `INSERT INTO analytics.report_run
           (tenant_id, report_type, parameters, requested_by_label, status, completed_at)
         VALUES ($1,'headcount','{}'::jsonb,'test','completed', now())`,
        [tx.tenantId]).then(() => undefined)),
      /report_run_terminal_state/,
    );
    await assert.rejects(
      tenantTx(tenantId, (tx) => tx.query(
        `INSERT INTO analytics.report_run
           (tenant_id, report_type, parameters, requested_by_label, status, completed_at)
         VALUES ($1,'headcount','{}'::jsonb,'test','failed', now())`,
        [tx.tenantId]).then(() => undefined)),
      /report_run_terminal_state/,
    );
  });

  it('never writes a report into another tenant', async () => {
    const { runId, envelope } = await request('headcount', RANGE);
    await onReportRequested(envelope);
    const run = await readRun(runId);

    const elsewhere = await withPlatform('maintenance', async (tx) => {
      const { rows } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM documents.document
          WHERE id = $1 AND tenant_id <> $2`,
        [run.document_id, tenantId]);
      return rows[0]!.n;
    });
    assert.equal(elsewhere, 0);
  });
});

describe('report csv', () => {
  it('quotes every field, so a comma in a department name stays one column', () => {
    const csv = toCsv(['department', 'headcount'], [{ department: 'Sales, EMEA', headcount: 3 }]).toString();
    assert.match(csv, /"Sales, EMEA","3"/);
  });

  it('escapes embedded quotes rather than truncating the value', () => {
    const csv = toCsv(['name'], [{ name: 'the "big" team' }]).toString();
    assert.match(csv, /"the ""big"" team"/);
  });

  it('defuses a value a spreadsheet would treat as a formula', () => {
    // An export is a file someone opens in Excel. A department name is not a thing that
    // should execute when they do.
    const csv = toCsv(['name'], [{ name: '=cmd|calc' }]).toString();
    assert.match(csv, /"'=cmd\|calc"/);
  });

  it('keeps a value containing a newline inside one field', () => {
    const withNewline = ['line one', 'line two'].join(String.fromCharCode(10));
    const csv = toCsv(['note'], [{ note: withNewline }]).toString();

    // The value keeps its newline, and the record is still one field: an export whose rows
    // split on an embedded newline turns one row into two and silently changes the report.
    assert.ok(csv.includes('"' + withNewline + '"'));
    const records = csv.split('\r\n');
    assert.equal(records.length, 3, 'header, one data record, trailing terminator');
  });

  it('preserves unicode rather than mangling it', () => {
    const csv = toCsv(['name'], [{ name: 'Bengaluru — क्षेत्र 東京' }]).toString('utf8');
    assert.match(csv, /"Bengaluru — क्षेत्र 東京"/);
  });

  it('writes columns in the declared order, whatever order the row keys are in', () => {
    // Column order comes from the definition, not from JavaScript object key order, so two
    // runs of the same report always produce the same file.
    const csv = toCsv(['a', 'b', 'c'], [{ c: 3, a: 1, b: 2 }]).toString();
    const records = csv.split('\r\n');

    assert.equal(records[0], '"a","b","c"');
    assert.equal(records[1], '"1","2","3"');
  });

  it('writes an empty field rather than the word undefined', () => {
    const csv = toCsv(['a', 'b'], [{ a: 1 }]).toString();
    assert.match(csv, /"1",""/);
  });
});
