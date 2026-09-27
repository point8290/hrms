import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, inTenant, parseBody, parseParams, parseQuery } from '../../http/context.ts';
import { audit } from '../../infra/audit.ts';
import { forbidden, notFound } from '../../infra/errors.ts';
import { configurableCategories, NOTIFICATIONS, type NotificationDefinition } from '@hrms/events';

/**
 * Notification endpoints (PRD s.30).
 *
 * Authorization here is ownership, not a permission. A notification is addressed to one
 * person, so the only question is whether the caller is that person — `recipient_user_id`
 * against the authenticated user, inside tenant context, with RLS underneath. There is
 * deliberately no `notification.admin`: the PRD does not define one, and a permission that
 * let somebody read other people's notifications would be a way to read the contents of
 * their leave, expense and payroll messages without holding any of those permissions.
 *
 * Only the in-app channel is exposed. An email is delivered to a mailbox this system does
 * not own, and listing sent emails back would be a second, unauthenticated copy of them.
 */

const idParam = z.object({ id: z.string().uuid() });

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  /** The caller's own in-app inbox (PRD s.18.1, s.30). */
  app.get('/api/notifications', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const query = parseQuery(
        request,
        z.object({
          unreadOnly: z.coerce.boolean().default(false),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      );

      const { rows } = await tx.query(
        `SELECT id, category, template_code, subject, payload, created_at, read_at
           FROM notification.notification
          WHERE tenant_id = $1
            AND recipient_user_id = $2
            AND channel = 'in_app'
            AND status = 'sent'
            AND (NOT $3::boolean OR read_at IS NULL)
          ORDER BY created_at DESC
          LIMIT $4`,
        [tx.tenantId, principal.userId, query.unreadOnly, query.limit],
      );

      const unread = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM notification.notification
          WHERE tenant_id = $1 AND recipient_user_id = $2
            AND channel = 'in_app' AND status = 'sent' AND read_at IS NULL`,
        [tx.tenantId, principal.userId],
      );

      return { notifications: rows, unread: unread.rows[0]!.n };
    }),
  );

  /**
   * Marks one notification read (PRD s.18.3, SENT -> READ).
   *
   * Idempotent, and the first read wins: `read_at IS NULL` in the predicate means a second
   * call leaves the original timestamp alone rather than moving it to now.
   */
  app.post('/api/notifications/:id/read', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const { id } = parseParams(request, idParam);

      // Ownership is checked by the predicate, so another user's notification and one that
      // does not exist give the same answer and an id cannot be probed.
      const { rows } = await tx.query<{ read_at: Date }>(
        `UPDATE notification.notification
            SET read_at = COALESCE(read_at, now())
          WHERE tenant_id = $1 AND id = $2 AND recipient_user_id = $3
            AND channel = 'in_app' AND status = 'sent'
          RETURNING read_at`,
        [tx.tenantId, id, principal.userId],
      );
      if (!rows[0]) throw notFound('Notification');
      return { id, read_at: rows[0].read_at };
    }),
  );

  /**
   * What this person may configure, and what they have chosen (PRD s.20).
   *
   * Mandatory categories are not listed as togglable at all. Offering a switch that the
   * server would ignore is worse than not offering one.
   */
  app.get('/api/notification-preferences', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const { rows } = await tx.query<{ category: string; channel: string; enabled: boolean }>(
        `SELECT category, channel, enabled FROM notification.notification_preference
          WHERE tenant_id = $1 AND user_id = $2`,
        [tx.tenantId, principal.userId],
      );

      const chosen = new Map(rows.map((r) => [`${r.category}:${r.channel}`, r.enabled]));
      const preferences = configurableCategories().flatMap((category) =>
        (['email', 'in_app'] as const).map((channel) => ({
          category,
          channel,
          // No row means enabled: a preference nobody expressed never suppresses anything.
          enabled: chosen.get(`${category}:${channel}`) ?? true,
        })),
      );

      const mandatory = [
        ...new Set(
          (Object.values(NOTIFICATIONS) as NotificationDefinition[])
            .filter((d) => d.mandatory)
            .map((d) => d.category),
        ),
      ].sort();

      return { preferences, mandatory_categories: mandatory };
    }),
  );

  /**
   * Sets this person's own preferences (PRD s.20).
   *
   * A mandatory category is refused rather than silently ignored — an employee who switches
   * something off and is still emailed should be told why, not left to conclude the setting
   * is broken. PRD s.20 also requires preference changes to be audited.
   */
  app.put('/api/notification-preferences', { preHandler: [authenticate] }, async (request) =>
    inTenant(request, async (tx, principal) => {
      const body = parseBody(
        request,
        z.object({
          preferences: z.array(z.object({
            category: z.string().min(1).max(40),
            channel: z.enum(['email', 'in_app']),
            enabled: z.boolean(),
          })).min(1).max(40),
        }),
      );

      if (!principal.userId) throw forbidden('Only a signed-in user has notification preferences');

      const configurable = new Set(configurableCategories());
      for (const preference of body.preferences) {
        if (!configurable.has(preference.category as never)) {
          throw forbidden(
            `"${preference.category}" cannot be switched off: it is either mandatory (PRD s.18.4) ` +
            'or not a notification category.',
          );
        }
      }

      for (const preference of body.preferences) {
        await tx.query(
          `INSERT INTO notification.notification_preference
             (tenant_id, user_id, category, channel, enabled)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, user_id, category, channel)
           DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
          [tx.tenantId, principal.userId, preference.category, preference.channel, preference.enabled],
        );
      }

      await audit(tx, {
        entityType: 'notification_preference',
        entityId: principal.userId,
        action: 'notification.preferences.changed',
        after: { preferences: body.preferences },
      });

      return { updated: body.preferences.length };
    }),
  );
}
