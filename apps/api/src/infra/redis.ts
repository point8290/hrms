import { config } from '../config.ts';

/**
 * Redis connection for rate limiting and short-lived coordination.
 *
 * Redis is cache and coordination only. It is never a source of truth (invariants.md
 * #architecture), so every consumer here must keep working when it is unavailable.
 */

export type RedisLike = {
  status: string;
  quit(): Promise<unknown>;
  /** Drops the socket without waiting for the server. ioredis provides it; a stub may not. */
  disconnect?(): void;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
};

let client: RedisLike | null | undefined;
let unavailableLogged = false;

function log(level: 'info' | 'warn' | 'error', msg: string, meta: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, component: 'redis', msg, ...meta });
  if (level === 'error') console.error(line);
  else console.log(line);
}

/**
 * Returns a Redis client, or null when Redis is not configured or cannot be loaded.
 *
 * `null` is a supported outcome, not an error: the rate limiter falls back to per-process
 * memory rather than refusing traffic, because losing Redis must degrade the limit's
 * accuracy, never the API's availability.
 */
export async function getRedis(): Promise<RedisLike | null> {
  if (client !== undefined) return client;

  const cfg = config();
  if (!cfg.REDIS_URL) {
    client = null;
    return client;
  }

  try {
    const mod: any = await import('ioredis' as string);
    const Redis = mod.default ?? mod;

    client = new Redis(cfg.REDIS_URL, {
      // The rate limiter must not hold a request open waiting for Redis. A short timeout
      // and a bounded retry mean a Redis outage costs milliseconds, not the request.
      connectTimeout: 1_000,
      commandTimeout: 500,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
      retryStrategy: (attempt: number) => Math.min(attempt * 200, 5_000),
    }) as RedisLike;

    client.on('error', (err: unknown) => {
      // ioredis emits on every reconnect attempt; log the first, then stay quiet so a
      // sustained outage does not drown the log.
      if (!unavailableLogged) {
        unavailableLogged = true;
        log('error', 'redis unavailable; rate limiting degrades to per-process', { err: String(err) });
      }
    });
    client.on('ready', () => {
      if (unavailableLogged) log('info', 'redis recovered');
      unavailableLogged = false;
    });

    return client;
  } catch (err) {
    log('warn', 'ioredis not installed; rate limiting will be per-process', { err: String(err) });
    client = null;
    return client;
  }
}

export async function closeRedis(): Promise<void> {
  const current = client;
  client = undefined;
  unavailableLogged = false;
  if (!current) return;

  try {
    await current.quit();
  } catch {
    /* already gone */
  }

  // QUIT is a request-response: it waits for the server, and a client that is mid-reconnect
  // never gets an answer, so the socket outlives the process's last piece of work. Shutdown
  // must not hang on a dependency that is explicitly allowed to be unavailable.
  try {
    current.disconnect?.();
  } catch {
    /* already closed */
  }
}

/** Test seam. */
export function setRedis(instance: RedisLike | null | undefined): void {
  client = instance;
}
