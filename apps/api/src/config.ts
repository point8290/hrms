import { z } from 'zod';

/**
 * Configuration is validated once at boot. A missing or malformed value stops the
 * process rather than surfacing as a confusing runtime failure later.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  API_PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1),
  PLATFORM_DATABASE_URL: z.string().min(1).optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_PREVIOUS_SECRET: z.string().min(32).optional(),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),

  FIELD_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'FIELD_ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),

  QUEUE_DRIVER: z.enum(['local', 'sqs']).default('local'),
  AWS_REGION: z.string().default('ap-south-1'),
  SQS_WORKFORCE_QUEUE_URL: z.string().optional(),
  SQS_PAYROLL_QUEUE_URL: z.string().optional(),
  SQS_PLATFORM_QUEUE_URL: z.string().optional(),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  S3_BUCKET: z.string().default('hrms-local'),
  S3_PRESIGN_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  LOCAL_STORAGE_DIR: z.string().default('.storage'),

  MAILER_DRIVER: z.enum(['console', 'ses']).default('console'),
  SES_FROM_ADDRESS: z.string().default('no-reply@example.com'),

  WORKFORCE_ENGINE_URL: z.string().default('http://localhost:8001'),
  PAYROLL_ENGINE_URL: z.string().default('http://localhost:8002'),

  REDIS_URL: z.string().optional(),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),

  /**
   * How many workspaces may be created from one address per hour.
   *
   * Five is the production figure and the default: signup is unauthenticated and provisions a
   * tenant, so it is the one route where a loose limit is a way to fill the database from the
   * outside. Development and demo environments legitimately create many tenants in a sitting,
   * and waiting out a production limiter is not a security control — it is just a slow way to
   * rehearse. So this is configurable, and the production guard below refuses any value above
   * the production figure. Raising it changes nothing about who may call the route or what
   * provisioning does.
   */
  SIGNUP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  SIGNUP_RATE_LIMIT_WINDOW: z.string().default('1 hour'),

  SERVICE_NAME: z.string().default('hrms-api'),
  /**
   * Whether finished spans are written to stdout as structured logs.
   *
   * On by default: a trace that exists only in an APM nobody has bought yet is no trace,
   * and a span line with a trace id ships with logs that are already collected.
   */
  TELEMETRY_LOG_SPANS: z.coerce.boolean().default(true),

  /**
   * Skips the startup proof that the database connection is subject to RLS.
   * Only for environments where the probe cannot run (e.g. a read replica smoke test).
   * Never set this in production.
   */
  ALLOW_UNVERIFIED_RLS: z.coerce.boolean().default(false),
});

/** The signup allowance production is held to, whatever the environment asks for. */
const PRODUCTION_SIGNUP_RATE_LIMIT = 5;

export type Config = z.infer<typeof schema> & { isProduction: boolean };

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  const value = parsed.data;

  if (value.NODE_ENV === 'production') {
    if (value.ALLOW_UNVERIFIED_RLS) {
      throw new Error('ALLOW_UNVERIFIED_RLS must not be enabled in production');
    }
    if (value.JWT_SECRET.startsWith('change-me')) {
      throw new Error('JWT_SECRET still holds the example value');
    }
    if (/^0+$/.test(value.FIELD_ENCRYPTION_KEY)) {
      throw new Error('FIELD_ENCRYPTION_KEY still holds the example value');
    }
    if (value.QUEUE_DRIVER === 'local') {
      throw new Error('QUEUE_DRIVER=local is a development transport; use sqs in production');
    }
    if (value.STORAGE_DRIVER === 'local') {
      throw new Error('STORAGE_DRIVER=local is a development transport; use s3 in production');
    }
    if (!value.REDIS_URL) {
      // Without Redis the rate limiter is per-process, so the effective limit silently
      // multiplies by the instance count. That is a production misconfiguration.
      throw new Error('REDIS_URL is required in production for distributed rate limiting');
    }
    if (value.SIGNUP_RATE_LIMIT_MAX > PRODUCTION_SIGNUP_RATE_LIMIT) {
      // The knob exists so a laptop can create ten demo tenants, not so production can be
      // talked into accepting a thousand. An environment that tries refuses to boot rather
      // than starting with the protection quietly relaxed.
      throw new Error(
        `SIGNUP_RATE_LIMIT_MAX must not exceed ${PRODUCTION_SIGNUP_RATE_LIMIT} in production`,
      );
    }
    if (value.SIGNUP_RATE_LIMIT_WINDOW !== '1 hour') {
      throw new Error("SIGNUP_RATE_LIMIT_WINDOW must remain '1 hour' in production");
    }
  }

  return { ...value, isProduction: value.NODE_ENV === 'production' };
}

export function config(): Config {
  cached ??= loadConfig();
  return cached;
}
