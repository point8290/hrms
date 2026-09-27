import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accepted, authenticate, inTenant, parseBody, parseParams, parseQuery } from '../../http/context.ts';
import { hasPermission, requirePermission } from '../../http/auth.ts';
import { audit } from '../../infra/audit.ts';
import { storage } from '../../infra/storage.ts';
import { unprocessable } from '../../infra/errors.ts';
import { REPORT_TYPES, allReportDefinitions, reportDefinition } from './definitions.ts';
import { getReportRun, listReportRuns, requestReport } from './service.ts';

/**
 * Reporting endpoints (PRD s.22).
 *
 * Authorization is the part worth reading. There is no blanket "reporting" permission: the
 * permission is resolved from the *requested report type*, and it is the one that already
 * guards that data — `employee.read` for headcount, `payroll.read` for payroll cost. So
 * reaching `POST /api/reports` grants nothing on its own, and a user who can run a headcount
 * report cannot obtain salary by changing one field of the request body (PRD s.7).
 *
 * The same check gates reading the run and downloading the export, because the artifact *is*
 * the report: letting someone who lost `payroll.read` keep downloading last month's payroll
 * cost export would make the permission a formality.
 */

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });

const parametersSchema = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
  departmentId: uuid.optional(),
  locationId: uuid.optional(),
});

export async function reportingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The catalogue, narrowed to what this caller may actually run.
   *
   * Listing a report they cannot run would be a list of things to ask an administrator for;
   * listing every report regardless would disclose which sensitive reports exist. This shows
   * what they can do.
   */
  app.get('/api/reports/types', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (_tx, principal) => ({
      types: allReportDefinitions()
        .filter((d) => hasPermission(principal, d.permission))
        .map((d) => ({
          type: d.type,
          permission: d.permission,
          sensitive: d.sensitive,
          grain: d.grain,
          columns: d.columns,
        })),
    })),
  );

  app.post('/api/reports', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      const body = parseBody(
        request,
        z.object({ reportType: z.enum(REPORT_TYPES), parameters: parametersSchema }),
      );

      // Resolved from the report type, before anything is recorded or queued.
      requirePermission(principal, reportDefinition(body.reportType).permission);

      const run = await requestReport(tx, {
        reportType: body.reportType,
        parameters: body.parameters,
      });
      // Accepted, not done: generation happens on the worker (PRD s.22, s.25).
      return accepted(reply, run);
    }),
  );

  app.get('/api/reports', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const query = parseQuery(request, z.object({ limit: z.coerce.number().int().positive().optional() }));
      const runs = await listReportRuns(tx, query.limit ?? 50);
      // A run is only visible to someone who could have requested it. Otherwise the list
      // discloses that payroll cost reports are being run, and over which periods.
      return {
        runs: runs.filter((r) => hasPermission(principal, reportDefinition(r.report_type).permission)),
      };
    }),
  );

  app.get('/api/reports/:id', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const { id } = parseParams(request, idParam);
      const run = await getReportRun(tx, id);
      requirePermission(principal, reportDefinition(run.report_type).permission);
      return run;
    }),
  );

  /**
   * A presigned link to the export.
   *
   * Short-lived and issued per request, through the same storage seam every other document
   * download uses — nothing here builds a URL itself. The document row is read inside the
   * tenant transaction, so RLS decides whether it is reachable at all and another tenant's
   * report is indistinguishable from one that does not exist.
   */
  app.get('/api/reports/:id/download-url', { preHandler: [authenticate] }, async (request) => {
    const found = await inTenant(request, async (tx, principal) => {
      const { id } = parseParams(request, idParam);
      const run = await getReportRun(tx, id);
      requirePermission(principal, reportDefinition(run.report_type).permission);

      if (run.status !== 'completed' || !run.document_id) return { run, document: null };

      const { rows } = await tx.query<{ s3_key: string; filename: string }>(
        `SELECT s3_key, filename FROM documents.document
          WHERE tenant_id = $1 AND id = $2 AND status = 'available'`,
        [tx.tenantId, run.document_id],
      );
      return { run, document: rows[0] ?? null };
    });

    if (!found.document) {
      throw unprocessable('report_not_ready', `Report is ${found.run.status}; no export is available`);
    }

    const link = await storage().presignDownload(found.document.s3_key, found.document.filename);

    // Downloading an export of sensitive data is itself an access worth recording (PRD s.18,
    // s.27). Written after the link is issued, in its own transaction: a link that was handed
    // out must be recorded even though the read that produced it has committed.
    await inTenant(request, (tx) =>
      audit(tx, {
        entityType: 'report_run',
        entityId: found.run.id,
        action: 'report.downloaded',
        metadata: { report_type: found.run.report_type, document_id: found.run.document_id },
      }),
    );

    return { url: link.url, expiresInSeconds: link.expiresInSeconds, filename: found.document.filename };
  });
}
