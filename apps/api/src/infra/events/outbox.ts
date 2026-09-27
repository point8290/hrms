import { randomUUID } from 'node:crypto';
import type { EventType } from '@hrms/events';
import { queueForEvent } from '@hrms/events';
import type { Queryable, TenantTx } from '../db/pool.ts';
import { outgoingTraceparent } from '../telemetry.ts';

export type EmitOptions = {
  aggregateType: string;
  aggregateId: string;
  payload?: Record<string, unknown>;
  schemaVersion?: number;
  /** Delays visibility, e.g. so a snapshot is definitely readable before work starts. */
  availableAt?: Date;
  /**
   * Overrides the correlation id taken from the actor. Used by the scheduler, where the
   * unit worth correlating is the job attempt rather than the HTTP request that happens
   * not to exist.
   */
  correlationId?: string;
};

/**
 * Records an event inside the caller's transaction.
 *
 * The write and the event intent commit together (ADR-004). Nothing is sent to the
 * broker here — publishing is the outbox publisher's job, so a crash between COMMIT and
 * publish loses nothing.
 */
export async function emitEvent(
  tx: TenantTx,
  eventType: EventType,
  options: EmitOptions,
): Promise<string> {
  const eventId = randomUUID();
  await tx.query(
    `INSERT INTO integration.event_outbox
       (event_id, tenant_id, event_type, schema_version, aggregate_type, aggregate_id,
        payload, correlation_id, producer, available_at, traceparent)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'hrms-api', COALESCE($9, now()), $10)`,
    [
      eventId,
      tx.tenantId,
      eventType,
      options.schemaVersion ?? 1,
      options.aggregateType,
      options.aggregateId,
      JSON.stringify(options.payload ?? {}),
      options.correlationId ?? tx.actor.correlationId ?? tx.actor.requestId ?? null,
      options.availableAt ?? null,
      // Captured at emit time, not publish time: the trace that matters is the one that
      // caused the event, and by the time the publisher runs that request is long gone.
      outgoingTraceparent() ?? null,
    ],
  );
  return eventId;
}

export type OutboxRow = {
  id: number;
  event_id: string;
  tenant_id: string;
  event_type: EventType;
  schema_version: number;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  producer: string;
  occurred_at: Date;
  traceparent: string | null;
};

/**
 * Leases a batch of unpublished events to this publisher instance.
 *
 * The lease is a write to `available_at`, committed before anything is sent. That is what
 * lets the publisher send outside a transaction: the batch is invisible to other publishers
 * for `leaseSeconds` without a lock being held across the network call. FOR UPDATE SKIP
 * LOCKED still guards the claim itself, so concurrent publishers take disjoint batches
 * rather than blocking on each other.
 *
 * A publisher that dies after claiming leaves its batch unpublished until the lease expires,
 * at which point another publisher takes it. Delayed, never lost.
 */
export async function claimForPublish(
  tx: Queryable,
  limit: number,
  leaseSeconds: number,
): Promise<OutboxRow[]> {
  const { rows } = await tx.query<OutboxRow>(
    // CTE rather than `WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`: with a locking
    // subquery the planner may evaluate it more than once, so the `IN` form can lease more
    // rows than the batch size asked for.
    `WITH due AS (
        SELECT id FROM integration.event_outbox
         WHERE published_at IS NULL
           AND available_at <= now()
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
     )
     UPDATE integration.event_outbox o
        SET available_at = now() + make_interval(secs => $2)
       FROM due
      WHERE o.id = due.id
      RETURNING o.id, o.event_id, o.tenant_id, o.event_type, o.schema_version, o.aggregate_type,
                o.aggregate_id, o.payload, o.correlation_id, o.producer, o.occurred_at, o.traceparent`,
    [limit, leaseSeconds],
  );
  return rows;
}

export async function markPublished(tx: Queryable, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.query('UPDATE integration.event_outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [ids]);
}

export async function markPublishFailed(tx: Queryable, id: number, error: string): Promise<void> {
  await tx.query(
    `UPDATE integration.event_outbox
        SET retry_count = retry_count + 1,
            last_error = $2,
            -- exponential backoff, capped, so a poison event does not spin the publisher
            available_at = now() + (least(power(2, least(retry_count, 10)), 900) || ' seconds')::interval
      WHERE id = $1`,
    [id, error.slice(0, 1000)],
  );
}

export function toEnvelope(row: OutboxRow) {
  return {
    event_id: row.event_id,
    event_type: row.event_type,
    schema_version: row.schema_version,
    tenant_id: row.tenant_id,
    aggregate_type: row.aggregate_type,
    aggregate_id: row.aggregate_id,
    occurred_at: row.occurred_at.toISOString(),
    producer: row.producer,
    ...(row.correlation_id ? { correlation_id: row.correlation_id } : {}),
    ...(row.traceparent ? { traceparent: row.traceparent } : {}),
    payload: row.payload ?? {},
  };
}

export { queueForEvent };

/**
 * Idempotency guard for consumers. Returns false when this event was already handled
 * by this consumer, in which case the caller must ACK and do nothing else.
 *
 * Must be called inside the same transaction as the business write, so that "work done"
 * and "event recorded as processed" can never diverge.
 */
export async function claimEvent(
  tx: Queryable,
  tenantId: string,
  eventId: string,
  consumerName: string,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `INSERT INTO integration.processed_event (tenant_id, event_id, consumer_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id, consumer_name) DO NOTHING`,
    [tenantId, eventId, consumerName],
  );
  return (rowCount ?? 0) > 0;
}
