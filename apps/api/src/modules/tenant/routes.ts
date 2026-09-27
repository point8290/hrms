import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, created, inTenant, parseBody, parseParams, parseQuery } from '../../http/context.ts';
import { requirePermission } from '../../http/auth.ts';
import { audit } from '../../infra/audit.ts';
import { conflict, isPgError, notFound, PG_UNIQUE_VIOLATION } from '../../infra/errors.ts';
import { getAppPool, type TenantTx } from '../../infra/db/pool.ts';

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });

/**
 * Organization structure: companies, locations, branches, departments, designations and
 * the holiday calendar. Plain reference data, but tenant-scoped and audited like
 * everything else — a department rename changes reporting lines.
 */
export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tenant', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'tenant.read', 'org.read');
      const { rows } = await tx.query(
        `SELECT id, name, slug, timezone, locale, currency, country_code, fy_start_month, status
           FROM identity.tenant WHERE id = $1`,
        [tx.tenantId],
      );
      if (!rows[0]) throw notFound('Tenant');
      return rows[0];
    }),
  );


  // -------------------------------------------------------------------- branding

  /**
   * Branding for the sign-in screen, before anyone has authenticated.
   *
   * Unauthenticated by necessity: a person looking at a login form has no session, so there
   * is no tenant context to set and RLS has nothing to match on.
   *
   * It still runs on the ordinary RLS-bound application connection, *not* the BYPASSRLS
   * platform role — serving a user request from the platform pool is exactly what this
   * codebase keeps narrow. The one controlled hole is `identity.public_branding`, a
   * SECURITY DEFINER function that returns presentational columns for active tenants only and
   * answers identically for a missing tenant and an unbranded one, so it cannot be used to
   * enumerate workspaces. Rate-limited like the login route it sits beside.
   */
  app.get(
    '/api/branding',
    { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } },
    async (request) => {
      const query = parseQuery(request, z.object({ slug: z.string().min(1).max(80) }));
      const { rows } = await getAppPool().query(
        'SELECT * FROM identity.public_branding($1)',
        [query.slug],
      );
      // A tenant that does not exist and one with no branding row are the same answer.
      return rows[0] ?? { slug: query.slug, display_name: null };
    },
  );

  /** The signed-in tenant's own branding. Any member may read it: it is what they already see. */
  app.get('/api/tenant/branding', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx) => {
      const { rows } = await tx.query(
        `SELECT t.slug,
                COALESCE(b.display_name, t.name) AS display_name,
                b.logo_url, b.favicon_url, b.primary_color, b.secondary_color,
                COALESCE(b.density, 'comfortable') AS density,
                COALESCE(b.radius, 'medium') AS radius,
                b.login_tagline, b.email_footer
           FROM identity.tenant t
           LEFT JOIN identity.tenant_branding b ON b.tenant_id = t.id
          WHERE t.id = $1`,
        [tx.tenantId],
      );
      if (!rows[0]) throw notFound('Tenant');
      return rows[0];
    }),
  );

  /**
   * Sets this tenant's branding.
   *
   * `tenant.manage` rather than `org.manage`: branding is the company's outward identity, and
   * the same person who renames a department should not necessarily be able to replace the
   * logo every employee sees. Colours are validated by the database CHECK as well as here, so
   * no path can store a value the stylesheet cannot consume.
   *
   * Nothing here accepts markup or CSS. A tenant chooses from bounded options; it does not
   * ship code into other people's browsers.
   */
  app.put('/api/tenant/branding', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'tenant.manage');

      const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour such as #1f5eff');
      // Only http(s) and same-origin paths. A `javascript:` or `data:` URL in an <img src>
      // is a script-execution surface, so the shape is constrained at the edge.
      const assetUrl = z
        .string()
        .max(500)
        .refine((v) => /^https:\/\//.test(v) || v.startsWith('/'),
          'Use an https:// URL or a path beginning with /');

      const body = parseBody(
        request,
        z.object({
          displayName: z.string().min(1).max(160).nullish(),
          logoUrl: assetUrl.nullish(),
          faviconUrl: assetUrl.nullish(),
          primaryColor: hex.nullish(),
          secondaryColor: hex.nullish(),
          density: z.enum(['comfortable', 'compact']).optional(),
          radius: z.enum(['sharp', 'medium', 'round']).optional(),
          loginTagline: z.string().max(160).nullish(),
          emailFooter: z.string().max(400).nullish(),
        }),
      );

      const { rows } = await tx.query(
        `INSERT INTO identity.tenant_branding
           (tenant_id, display_name, logo_url, favicon_url, primary_color, secondary_color,
            density, radius, login_tagline, email_footer)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'comfortable'),COALESCE($8,'medium'),$9,$10)
         ON CONFLICT (tenant_id) DO UPDATE SET
           display_name    = EXCLUDED.display_name,
           logo_url        = EXCLUDED.logo_url,
           favicon_url     = EXCLUDED.favicon_url,
           primary_color   = EXCLUDED.primary_color,
           secondary_color = EXCLUDED.secondary_color,
           density         = EXCLUDED.density,
           radius          = EXCLUDED.radius,
           login_tagline   = EXCLUDED.login_tagline,
           email_footer    = EXCLUDED.email_footer,
           updated_at      = now()
         RETURNING display_name, logo_url, favicon_url, primary_color, secondary_color,
                   density, radius, login_tagline, email_footer`,
        [
          tx.tenantId, body.displayName ?? null, body.logoUrl ?? null, body.faviconUrl ?? null,
          body.primaryColor ?? null, body.secondaryColor ?? null,
          body.density ?? null, body.radius ?? null,
          body.loginTagline ?? null, body.emailFooter ?? null,
        ],
      );

      await audit(tx, {
        entityType: 'tenant_branding',
        entityId: tx.tenantId,
        action: 'tenant.branding.changed',
        after: rows[0] as Record<string, unknown>,
      });

      return rows[0];
    }),
  );

  registerCollection(app, {
    path: 'companies',
    table: 'core.company',
    columns: 'id, name, legal_name, tax_identifier, pf_number, esi_number, status',
    orderBy: 'name',
    create: z.object({
      name: z.string().min(1).max(160),
      legalName: z.string().min(1).max(200),
      taxIdentifier: z.string().max(32).optional(),
      pfNumber: z.string().max(32).optional(),
      esiNumber: z.string().max(32).optional(),
    }),
    insert: (tx, body) => [
      `INSERT INTO core.company (tenant_id, name, legal_name, tax_identifier, pf_number, esi_number)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tx.tenantId, body.name, body.legalName, body.taxIdentifier ?? null, body.pfNumber ?? null, body.esiNumber ?? null],
    ],
  });

  registerCollection(app, {
    path: 'locations',
    table: 'core.location',
    columns: 'id, name, timezone, address, state_code, metro_classification',
    orderBy: 'name',
    create: z.object({
      name: z.string().min(1).max(160),
      timezone: z.string().min(1).max(64).default('Asia/Kolkata'),
      address: z.string().max(500).optional(),
      stateCode: z.string().max(4).optional(),
      /**
       * Whether HRA exemption here is measured at 50% of basic or 40%.
       *
       * Stated rather than derived: the Act names Delhi, Mumbai, Kolkata and Chennai, and no
       * address parser can be trusted to decide that. Defaults to non_metro because
       * over-deducting is something the employee reclaims when they file, while
       * under-deducting is the employer's liability under section 192.
       */
      metroClassification: z.enum(['metro', 'non_metro']).default('non_metro'),
    }),
    insert: (tx, body) => [
      `INSERT INTO core.location (tenant_id, name, timezone, address, state_code, metro_classification)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tx.tenantId, body.name, body.timezone, body.address ?? null, body.stateCode ?? null,
       body.metroClassification],
    ],
  });

  registerCollection(app, {
    path: 'departments',
    table: 'core.department',
    columns: 'id, name, code, parent_id',
    orderBy: 'name',
    create: z.object({
      name: z.string().min(1).max(160),
      code: z.string().max(32).optional(),
      parentId: uuid.optional(),
    }),
    insert: (tx, body) => [
      'INSERT INTO core.department (tenant_id, name, code, parent_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [tx.tenantId, body.name, body.code ?? null, body.parentId ?? null],
    ],
  });

  registerCollection(app, {
    path: 'designations',
    table: 'core.designation',
    columns: 'id, name, grade',
    orderBy: 'name',
    create: z.object({ name: z.string().min(1).max(160), grade: z.string().max(32).optional() }),
    insert: (tx, body) => [
      'INSERT INTO core.designation (tenant_id, name, grade) VALUES ($1, $2, $3) RETURNING id',
      [tx.tenantId, body.name, body.grade ?? null],
    ],
  });

  registerCollection(app, {
    path: 'branches',
    table: 'core.branch',
    columns: 'id, name, company_id, location_id',
    orderBy: 'name',
    create: z.object({
      name: z.string().min(1).max(160),
      companyId: uuid,
      locationId: uuid.optional(),
    }),
    insert: (tx, body) => [
      'INSERT INTO core.branch (tenant_id, name, company_id, location_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [tx.tenantId, body.name, body.companyId, body.locationId ?? null],
    ],
  });

  // ---------------------------------------------------------------- holidays

  app.post('/api/holiday-lists', { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'org.manage');
      const body = parseBody(
        request,
        z.object({
          name: z.string().min(1).max(120),
          year: z.number().int().min(2000).max(2100),
          locationId: uuid.optional(),
          isDefault: z.boolean().default(false),
          // 0 = Sunday. A six-day week is common in India, so this is configuration.
          weeklyOffs: z.array(z.number().int().min(0).max(6)).default([0]),
          holidays: z
            .array(
              z.object({
                date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                name: z.string().min(1).max(120),
                isOptional: z.boolean().default(false),
              }),
            )
            .default([]),
        }),
      );

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO workforce.holiday_list (tenant_id, name, year, location_id, is_default, weekly_offs)
         VALUES ($1, $2, $3, $4, $5, $6::smallint[])
         RETURNING id`,
        [tx.tenantId, body.name, body.year, body.locationId ?? null, body.isDefault, body.weeklyOffs],
      );
      const listId = rows[0]!.id;

      for (const holiday of body.holidays) {
        await tx.query(
          `INSERT INTO workforce.holiday (tenant_id, holiday_list_id, holiday_date, name, is_optional)
           VALUES ($1, $2, $3::date, $4, $5)
           ON CONFLICT (holiday_list_id, holiday_date) DO NOTHING`,
          [tx.tenantId, listId, holiday.date, holiday.name, holiday.isOptional],
        );
      }

      if (body.isDefault) {
        await tx.query(
          'UPDATE workforce.holiday_list SET is_default = false WHERE tenant_id = $1 AND id <> $2 AND year = $3',
          [tx.tenantId, listId, body.year],
        );
      }

      await audit(tx, {
        entityType: 'holiday_list',
        entityId: listId,
        action: 'holiday_list.created',
        after: { name: body.name, year: body.year, holidays: body.holidays.length, weekly_offs: body.weeklyOffs },
      });

      return created(reply, { id: listId, holidays: body.holidays.length });
    }),
  );

  app.get('/api/holiday-lists', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'org.read');
      const query = parseQuery(request, z.object({ year: z.coerce.number().int().optional() }));
      const { rows } = await tx.query(
        `SELECT hl.id, hl.name, hl.year, hl.is_default, hl.weekly_offs, hl.location_id,
                COUNT(h.id)::int AS holiday_count
           FROM workforce.holiday_list hl
           LEFT JOIN workforce.holiday h ON h.holiday_list_id = hl.id
          WHERE hl.tenant_id = $1 AND ($2::int IS NULL OR hl.year = $2)
          GROUP BY hl.id
          ORDER BY hl.year DESC, hl.name`,
        [tx.tenantId, query.year ?? null],
      );
      return { holiday_lists: rows };
    }),
  );

  app.get('/api/holiday-lists/:id/holidays', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'org.read');
      const params = parseParams(request, idParam);
      const { rows } = await tx.query(
        `SELECT to_char(holiday_date, 'YYYY-MM-DD') AS date, name, is_optional
           FROM workforce.holiday
          WHERE tenant_id = $1 AND holiday_list_id = $2
          ORDER BY holiday_date`,
        [tx.tenantId, params.id],
      );
      return { holidays: rows };
    }),
  );
}

type CollectionSpec = {
  path: string;
  table: string;
  columns: string;
  orderBy: string;
  create: z.ZodObject<z.ZodRawShape>;
  insert: (tx: TenantTx, body: any) => [string, unknown[]];
};

/**
 * Organization reference data shares one shape: list everything in the tenant, create one.
 * Registering them from a spec avoids five near-identical handlers without hiding the
 * behaviour behind a generic CRUD layer that would also expose the business tables.
 */
function registerCollection(app: FastifyInstance, spec: CollectionSpec): void {
  app.get(`/api/${spec.path}`, { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'org.read');
      const { rows } = await tx.query(
        `SELECT ${spec.columns} FROM ${spec.table} WHERE tenant_id = $1 ORDER BY ${spec.orderBy}`,
        [tx.tenantId],
      );
      return { [spec.path]: rows };
    }),
  );

  app.post(`/api/${spec.path}`, { preHandler: [authenticate] }, async (request, reply) =>
    inTenant(request, async (tx, principal) => {
      requirePermission(principal, 'org.manage');
      const body = parseBody(request, spec.create);
      const [sql, values] = spec.insert(tx, body);
      try {
        const { rows } = await tx.query<{ id: string }>(sql, values);
        await audit(tx, {
          entityType: spec.table,
          entityId: rows[0]!.id,
          action: `${spec.path}.created`,
          after: body as Record<string, unknown>,
        });
        return created(reply, { id: rows[0]!.id });
      } catch (err) {
        if (isPgError(err, PG_UNIQUE_VIOLATION)) {
          throw conflict('duplicate_name', `A record with that name already exists in ${spec.path}`);
        }
        throw err;
      }
    }),
  );
}
