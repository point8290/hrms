/**
 * One error type for everything the API deliberately rejects. Anything else that
 * escapes a handler is a bug and is reported as 500 without leaking internals.
 */
export class AppError extends Error {
  // Written as explicit fields rather than constructor parameter properties: Node runs
  // this TypeScript by stripping types, and parameter properties require transformation.
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);

export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'forbidden', message);

export const notFound = (resource: string) =>
  new AppError(404, 'not_found', `${resource} not found`);

export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

/** Business rule violation: the request was well-formed but the domain refuses it. */
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);

export const tooManyRequests = (message = 'Too many requests') =>
  new AppError(429, 'rate_limited', message);

/** Postgres error codes the API translates into meaningful client responses. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_EXCLUSION_VIOLATION = '23P01';
export const PG_CHECK_VIOLATION = '23514';
export const PG_RESTRICT_VIOLATION = '23001';

export function isPgError(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
}

export function pgConstraint(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null
    ? (err as { constraint?: string }).constraint
    : undefined;
}
