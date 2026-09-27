import { withPlatform } from '../../infra/db/pool.ts';

/**
 * Queues an authentication email.
 *
 * Authentication mail is a special case: password reset happens before any tenant is
 * chosen, so the notification cannot be written through a tenant transaction the way every
 * other notification is. It goes in through the platform connection, attributed to a tenant
 * the user actually belongs to so the existing dispatcher picks it up.
 *
 * The token is placed in the payload and never logged or returned to the caller. The API
 * response is deliberately identical whether or not an account matched.
 */

export type AuthEmailInput = {
  userId: string;
  email: string;
  template: 'auth.password_reset' | 'auth.verify_email';
  token: string;
  tenantId?: string;
};

export async function queueAuthEmail(input: AuthEmailInput): Promise<void> {
  await withPlatform('tenant-provisioning', async (tx) => {
    const { rows } = await tx.query<{ email: string; full_name: string; tenant_id: string | null }>(
      `SELECT u.email, u.full_name,
              COALESCE($2::uuid, (
                -- Any active membership will do: the mail is about the person, not a
                -- workspace, and the dispatcher only needs a tenant to scope the row.
                SELECT m.tenant_id FROM identity.tenant_membership m
                 WHERE m.user_id = u.id AND m.status = 'active'
                 ORDER BY m.joined_at
                 LIMIT 1
              )) AS tenant_id
         FROM identity.app_user u
        WHERE u.id = $1`,
      [input.userId, input.tenantId ?? null],
    );

    const user = rows[0];
    if (!user?.tenant_id) {
      // A user with no active membership has nowhere to sign in to, so there is nothing
      // useful to send. Silently doing nothing keeps the endpoint uninformative.
      return;
    }

    await tx.query(
      `INSERT INTO notification.notification
         (tenant_id, recipient_user_id, recipient_email, channel, template_code, subject,
          payload, dedupe_key)
       VALUES ($1, $2, $3, 'email', $4, $5, $6::jsonb, $7)
       ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [
        user.tenant_id,
        input.userId,
        input.email || user.email,
        input.template,
        input.template === 'auth.password_reset' ? 'Reset your password' : 'Verify your email address',
        JSON.stringify({ first_name: user.full_name.split(' ')[0], token: input.token }),
        // Keyed on the token so a retry of the same request does not send twice, while a
        // genuinely new request (new token) always does.
        `${input.template}:${input.token.slice(0, 16)}`,
      ],
    );
  });
}
