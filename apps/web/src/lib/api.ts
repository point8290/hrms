/**
 * API client.
 *
 * Holds the access token in memory and refreshes it transparently when it expires, so
 * a page does not fail mid-action just because a 15-minute token lapsed. The refresh
 * token is the only thing persisted, and it is rotated on every use by the server.
 */

const REFRESH_KEY = 'hrms.refresh';
const TENANT_KEY = 'hrms.tenant';

export type Session = {
  accessToken: string;
  tenant: { id: string; name: string; slug: string };
  user: { id: string; name: string; email: string; employeeId: string | null };
  permissions: Set<string>;
};

let session: Session | null = null;
let refreshInFlight: Promise<Session> | null = null;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function currentSession(): Session | null {
  return session;
}

export function can(permission: string): boolean {
  return session?.permissions.has(permission) ?? false;
}

export function canAny(...permissions: string[]): boolean {
  return permissions.some(can);
}

function adopt(payload: any): Session {
  session = {
    accessToken: payload.access_token,
    tenant: payload.tenant ?? session?.tenant ?? { id: '', name: '', slug: '' },
    user: payload.user ?? session?.user ?? { id: '', name: '', email: '', employeeId: null },
    permissions: new Set<string>(payload.permissions ?? []),
  };
  localStorage.setItem(REFRESH_KEY, payload.refresh_token);
  localStorage.setItem(TENANT_KEY, session.tenant.id);
  return session;
}

/**
 * What a sign-in attempt produced.
 *
 * A password is not always a session. Any role holding a sensitive permission — payroll,
 * compensation, bank, tax, audit — must complete a second factor (ADR-012), and the server
 * answers with a challenge instead of a token. That is most administrative roles, so the
 * challenge is a normal outcome of signing in rather than an error, and the caller has to
 * handle it.
 */
export type SignInOutcome =
  | { kind: 'session'; session: Session }
  | { kind: 'challenge'; stage: 'enroll' | 'verify'; challengeToken: string };

export async function login(slug: string, email: string, password: string): Promise<SignInOutcome> {
  const payload = await request('POST', '/api/auth/login', { slug, email, password }, false);
  if (payload?.mfa_required) {
    return {
      kind: 'challenge',
      stage: payload.stage === 'enroll' ? 'enroll' : 'verify',
      challengeToken: payload.challenge_token,
    };
  }
  return { kind: 'session', session: adopt(payload) };
}

/** Starts enrolment for a challenge. The secret and recovery codes are shown once. */
export async function beginEnrolment(challengeToken: string): Promise<{
  secret: string;
  otpauth_uri: string;
  recovery_codes: string[];
}> {
  return request('POST', '/api/auth/mfa/enroll', { challenge_token: challengeToken }, false);
}

/** Confirms a new authenticator and completes the sign-in in the same step. */
export async function confirmEnrolment(challengeToken: string, code: string): Promise<Session> {
  return adopt(
    await request('POST', '/api/auth/mfa/confirm', { challenge_token: challengeToken, code }, false),
  );
}

/** Completes a sign-in for an account that already has an authenticator. */
export async function verifySecondFactor(
  challengeToken: string,
  input: { code?: string; recoveryCode?: string },
): Promise<Session> {
  return adopt(
    await request(
      'POST',
      '/api/auth/mfa/verify',
      {
        challenge_token: challengeToken,
        ...(input.code ? { code: input.code } : {}),
        ...(input.recoveryCode ? { recovery_code: input.recoveryCode } : {}),
      },
      false,
    ),
  );
}

/**
 * Creates a workspace and its first administrator.
 *
 * Unauthenticated, and rate limited by the server to five an hour. It returns identifiers
 * rather than a session: the new owner signs in afterwards like anybody else, which is also
 * what puts them through authenticator enrolment.
 */
export async function signUp(input: {
  tenantName: string;
  slug: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
  timezone?: string;
  currency?: string;
  countryCode?: string;
}): Promise<{ tenant_id: string; user_id: string }> {
  return request('POST', '/api/tenants', input, false);
}

export function logout(): void {
  // Best effort: the server revokes refresh tokens, but the local session is cleared
  // regardless so a failed call cannot leave the browser looking signed in.
  void request('POST', '/api/auth/logout', undefined).catch(() => {});
  session = null;
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(TENANT_KEY);
}

/** Restores a session on page load from the stored refresh token. */
export async function restore(): Promise<Session | null> {
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  const tenantId = localStorage.getItem(TENANT_KEY);
  if (!refreshToken || !tenantId) return null;

  try {
    const session = await refresh();
    // The refresh response carries permissions but not the profile; fill it from /me.
    const me = await api<any>('GET', '/api/auth/me');
    session.tenant = { id: tenantId, name: me.tenant_name, slug: me.tenant_slug };
    session.user = {
      id: me.id,
      name: me.full_name,
      email: me.email,
      employeeId: me.employee_id ?? null,
    };
    return session;
  } catch {
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(TENANT_KEY);
    return null;
  }
}

function refresh(): Promise<Session> {
  // Concurrent 401s must not each spend the (single-use, rotating) refresh token.
  refreshInFlight ??= (async () => {
    try {
      const payload = await request(
        'POST',
        '/api/auth/refresh',
        {
          tenant_id: localStorage.getItem(TENANT_KEY),
          refresh_token: localStorage.getItem(REFRESH_KEY),
        },
        false,
      );
      return adopt(payload);
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  authenticated = true,
): Promise<any> {
  const response = await fetch(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(authenticated && session ? { authorization: `Bearer ${session.accessToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (response.status === 204) return null;

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? 'request_failed',
      error.message ?? response.statusText,
      error.details,
    );
  }
  return payload;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return (await request(method, path, body)) as T;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && localStorage.getItem(REFRESH_KEY)) {
      await refresh();
      return (await request(method, path, body)) as T;
    }
    throw err;
  }
}

export const get = <T,>(path: string) => api<T>('GET', path);
export const post = <T,>(path: string, body?: unknown) => api<T>('POST', path, body);
export const put = <T,>(path: string, body?: unknown) => api<T>('PUT', path, body);

export function formatMoney(amount: string | number, currency = 'INR'): string {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 })
    .format(Number.isFinite(value) ? value : 0);
}

/** Three letters for every month, which no locale actually gives us. See formatDate. */
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  // Formatted by hand rather than through Intl, because no English locale produces
  // "01 Sep 2026". en-IN, en-GB and en-AU all abbreviate September to "Sept" (current
  // CLDR), which is four characters where every other month is three and visibly
  // steps a date column out of line; en-US and en-CA give "Sep" but reorder to
  // "Sep 01, 2026". The product's date format is fixed, so fix it here.
  //
  // getUTC* throughout: the value was pinned to UTC midnight above, and reading it
  // back in local time is exactly how a pay date shifts by a day.
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${day} ${SHORT_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * A count of days.
 *
 * Leave and loss-of-pay are stored to two decimals because half days are real, but
 * "1.00 days" reads like a measurement rather than a day. Show the fraction only
 * when there is one.
 */
export function formatDays(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return String(value);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

export function formatMinutes(minutes: number): string {
  if (!minutes) return '—';
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
