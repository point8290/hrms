import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, created, inTenant, parseBody, parseParams, parseQuery } from '../../http/context.ts';
import { requirePermission, resolveTargetEmployee } from '../../http/auth.ts';
import { audit } from '../../infra/audit.ts';
import { config } from '../../config.ts';
import { emitEvent } from '../../infra/events/outbox.ts';
import { forbidden, notFound, unprocessable } from '../../infra/errors.ts';
import { storage, verifyLocalSignature } from '../../infra/storage.ts';

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });

const DOCUMENT_TYPES = [
  'identity', 'address', 'education', 'offer_letter', 'contract', 'bank', 'tax',
  'certificate', 'payslip', 'expense_receipt', 'experience_letter', 'other',
] as const;

/** Document types that always require explicit authorization beyond ownership. */
const SENSITIVE_TYPES = new Set(['bank', 'tax', 'contract', 'offer_letter']);

const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Issues a presigned upload URL.
   *
   * The API never receives the binary: it authorizes, records metadata as `pending` and
   * hands back a short-lived, single-object URL. Nothing is readable until the client
   * confirms the upload, so an abandoned upload leaves no visible document.
   */
  app.post('/api/documents/upload-url', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      const body = parseBody(
        request,
        z.object({
          employeeId: uuid.optional(),
          documentType: z.enum(DOCUMENT_TYPES),
          filename: z.string().min(1).max(200),
          contentType: z.string().min(3).max(120),
          sizeBytes: z.number().int().min(1).max(25 * 1024 * 1024),
        }),
      );

      if (!ALLOWED_CONTENT_TYPES.has(body.contentType)) {
        throw unprocessable('unsupported_content_type', `${body.contentType} is not an accepted document type`);
      }

      const target = resolveTargetEmployee(principal, body.employeeId, {
        self: 'document.read.self',
        others: 'document.manage',
      });
      // Uploading a sensitive type for yourself is still an HR action.
      if (SENSITIVE_TYPES.has(body.documentType)) {
        requirePermission(principal, 'document.manage');
      }

      const store = storage();
      const key = store.buildKey(tx.tenantId, body.documentType, body.filename);
      const presigned = await store.presignUpload(key, body.contentType);

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO documents.document
           (tenant_id, employee_id, document_type, filename, content_type, size_bytes,
            s3_bucket, s3_key, is_sensitive, status, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)
         RETURNING id`,
        [
          tx.tenantId, target.employeeId, body.documentType, body.filename, body.contentType,
          body.sizeBytes, presigned.bucket, key, SENSITIVE_TYPES.has(body.documentType), tx.actor.userId,
        ],
      );

      return created(reply, {
        document_id: rows[0]!.id,
        upload: {
          url: presigned.url,
          method: presigned.method,
          headers: presigned.headers,
          expires_in: presigned.expiresInSeconds,
        },
      });
    }),
  );

  app.post('/api/documents/:id/confirm', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const params = parseParams(request, idParam);
      const body = parseBody(request, z.object({ checksumSha256: z.string().length(64).optional() }));

      const { rows } = await tx.query<{ employee_id: string | null; status: string; document_type: string }>(
        'SELECT employee_id, status, document_type FROM documents.document WHERE tenant_id = $1 AND id = $2',
        [tx.tenantId, params.id],
      );
      const document = rows[0];
      if (!document) throw notFound('Document');
      if (document.status !== 'pending') {
        return { id: params.id, status: document.status };
      }

      await tx.query(
        `UPDATE documents.document SET status = 'available', checksum_sha256 = COALESCE($3, checksum_sha256)
          WHERE tenant_id = $1 AND id = $2`,
        [tx.tenantId, params.id, body.checksumSha256 ?? null],
      );

      await audit(tx, {
        entityType: 'document',
        entityId: params.id,
        action: 'document.uploaded',
        after: { employee_id: document.employee_id, document_type: document.document_type },
      });

      await emitEvent(tx, 'DocumentUploaded', {
        aggregateType: 'document',
        aggregateId: params.id,
        payload: { document_id: params.id, employee_id: document.employee_id },
      });

      return { id: params.id, status: 'available' };
    }),
  );

  app.get('/api/documents', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const query = parseQuery(
        request,
        z.object({ employeeId: uuid.optional(), documentType: z.enum(DOCUMENT_TYPES).optional() }),
      );
      const target = resolveTargetEmployee(principal, query.employeeId, {
        self: 'document.read.self',
        others: 'document.read',
      });
      const { rows } = await tx.query(
        `SELECT id, document_type, filename, content_type, size_bytes, version, is_sensitive,
                status, created_at
           FROM documents.document
          WHERE tenant_id = $1 AND employee_id = $2 AND status = 'available'
            AND ($3::text IS NULL OR document_type = $3)
          ORDER BY created_at DESC`,
        [tx.tenantId, target.employeeId, query.documentType ?? null],
      );
      return { documents: rows };
    }),
  );

  /**
   * Issues a short-lived download URL after checking authorization.
   *
   * Access is decided here, every time — the URL is the grant, so a sensitive document
   * requires the elevated permission even for its owner.
   */
  app.get('/api/documents/:id/download-url', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const params = parseParams(request, idParam);
      const { rows } = await tx.query<{
        employee_id: string | null;
        s3_key: string;
        filename: string;
        is_sensitive: boolean;
        status: string;
      }>(
        `SELECT employee_id, s3_key, filename, is_sensitive, status
           FROM documents.document WHERE tenant_id = $1 AND id = $2`,
        [tx.tenantId, params.id],
      );
      const document = rows[0];
      if (!document) throw notFound('Document');
      if (document.status !== 'available') {
        throw notFound('Document');
      }

      const isOwner = document.employee_id !== null && document.employee_id === principal.employeeId;
      if (document.is_sensitive) {
        requirePermission(principal, 'document.read');
      } else if (!isOwner) {
        requirePermission(principal, 'document.read');
      } else if (!principal.permissions.has('document.read.self') && !principal.permissions.has('document.read')) {
        throw forbidden('You do not have access to this document');
      }

      const presigned = await storage().presignDownload(document.s3_key, document.filename);

      await audit(tx, {
        entityType: 'document',
        entityId: params.id,
        action: 'document.download_url_issued',
        metadata: { sensitive: document.is_sensitive },
      });

      return { url: presigned.url, expires_in: presigned.expiresInSeconds, filename: document.filename };
    }),
  );

  /**
   * Local-driver object endpoint. Exists only so development mirrors the S3 flow; with
   * STORAGE_DRIVER=s3 these URLs are never issued and this route refuses everything.
   */
  app.route({
    method: ['GET', 'PUT'],
    url: '/internal/files/*',
    handler: async (request, reply) => {
      if (config().STORAGE_DRIVER !== 'local') {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
      }
      const key = decodeURIComponent((request.params as Record<string, string>)['*'] ?? '');
      const query = request.query as { expires?: string; sig?: string; filename?: string };
      if (!query.sig || !verifyLocalSignature(key, Number(query.expires), query.sig)) {
        return reply.code(403).send({ error: { code: 'invalid_signature', message: 'Link expired or invalid' } });
      }

      const store = storage();
      if (request.method === 'PUT') {
        const body = request.body as Buffer;
        await store.putObject(key, Buffer.isBuffer(body) ? body : Buffer.from(String(body)), 'application/octet-stream');
        return reply.code(200).send({ ok: true });
      }

      try {
        const data = await store.getObject(key);
        return reply
          .header('content-disposition', `attachment; filename="${query.filename ?? 'download'}"`)
          .header('content-type', 'application/octet-stream')
          .send(data);
      } catch {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Object not found' } });
      }
    },
  });
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/audit', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'audit.read');
      const query = parseQuery(
        request,
        z.object({
          entityType: z.string().max(64).optional(),
          entityId: uuid.optional(),
          action: z.string().max(64).optional(),
          sensitiveOnly: z.coerce.boolean().default(false),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      );
      const { rows } = await tx.query(
        `SELECT id, actor_label, actor_user_id, entity_type, entity_id, action, is_sensitive,
                before_state, after_state, metadata, correlation_id, created_at
           FROM audit.audit_log
          WHERE tenant_id = $1
            AND ($2::text IS NULL OR entity_type = $2)
            AND ($3::uuid IS NULL OR entity_id = $3)
            AND ($4::text IS NULL OR action = $4)
            AND (NOT $5::boolean OR is_sensitive)
          ORDER BY created_at DESC
          LIMIT $6 OFFSET $7`,
        [
          tx.tenantId, query.entityType ?? null, query.entityId ?? null, query.action ?? null,
          query.sensitiveOnly, query.limit, query.offset,
        ],
      );
      return { entries: rows, limit: query.limit, offset: query.offset };
    }),
  );
}
