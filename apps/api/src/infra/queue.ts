import type { QueueName } from '@hrms/events';
import { config } from '../config.ts';
import { withPlatform } from './db/pool.ts';

export type QueueMessage = {
  receiptHandle: string;
  body: Record<string, unknown>;
  receiveCount: number;
};

export type Queue = {
  send(queue: QueueName, body: Record<string, unknown>): Promise<void>;
  receive(queue: QueueName, max: number, visibilitySeconds: number): Promise<QueueMessage[]>;
  delete(queue: QueueName, receiptHandle: string): Promise<void>;
  /** Returns the message to the queue early instead of waiting out the visibility timeout. */
  release(queue: QueueName, receiptHandle: string, delaySeconds: number): Promise<void>;
  /**
   * Takes a message out of circulation permanently, with a reason.
   *
   * A consumer that gives up must say so somewhere durable. Silently deleting a message it
   * could not process loses the evidence that an event was never handled, and leaving it to
   * be redelivered for ever turns one poison message into a permanently degraded consumer.
   */
  deadLetter(queue: QueueName, receiptHandle: string, reason: string): Promise<void>;
};

/**
 * SQS refuses a message body over 256 KiB. Every envelope this system produces carries
 * identifiers rather than data — a payslip event names a slip, it does not contain one —
 * so the limit should be unreachable. Checking it means a change that starts embedding
 * employee or payroll data in a message fails here, loudly and locally, instead of in
 * production against the real broker.
 */
const MAX_MESSAGE_BYTES = 256 * 1024;

function encodeBody(queue: QueueName, body: Record<string, unknown>): string {
  const text = JSON.stringify(body);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new Error(
      `message for "${queue}" is ${bytes} bytes, over the ${MAX_MESSAGE_BYTES} byte limit; ` +
        'events must carry identifiers, not payload data',
    );
  }
  return text;
}

/**
 * Postgres-backed queue for local development and integration tests.
 *
 * It reproduces the three SQS properties that actually shape the code: at-least-once
 * delivery, a visibility timeout, and a dead-letter destination after a bounded number of
 * receives. That means consumers are exercised against the same duplicate-delivery
 * semantics locally as in AWS, so idempotency bugs surface early rather than in production.
 */
const localQueue: Queue = {
  async send(queue, body) {
    const text = encodeBody(queue, body);
    await withPlatform('maintenance', (tx) =>
      tx.query('INSERT INTO integration.local_queue_message (queue_name, body) VALUES ($1, $2::jsonb)', [
        queue,
        text,
      ]),
    );
  },

  async receive(queue, max, visibilitySeconds) {
    return withPlatform('maintenance', async (tx) => {
      const { rows } = await tx.query<{ id: number; body: Record<string, unknown>; receive_count: number }>(
        // CTE rather than `WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`: with a
        // locking subquery the planner may evaluate it more than once, which would hand
        // back more messages than the caller asked for — and SQS caps a receive at ten,
        // so the local driver must not be looser than the thing it models.
        `WITH due AS (
            SELECT id FROM integration.local_queue_message
             WHERE queue_name = $1
               AND deleted_at IS NULL
               AND dead_lettered_at IS NULL
               AND visible_at <= now()
             ORDER BY id
             LIMIT $2
             FOR UPDATE SKIP LOCKED
         )
         UPDATE integration.local_queue_message m
            SET visible_at = now() + ($3 || ' seconds')::interval,
                receive_count = m.receive_count + 1
           FROM due
          WHERE m.id = due.id
          RETURNING m.id, m.body, m.receive_count`,
        [queue, max, String(visibilitySeconds)],
      );
      return rows.map((r) => ({
        receiptHandle: String(r.id),
        body: r.body,
        receiveCount: r.receive_count,
      }));
    });
  },

  async delete(_queue, receiptHandle) {
    await withPlatform('maintenance', (tx) =>
      tx.query('UPDATE integration.local_queue_message SET deleted_at = now() WHERE id = $1', [
        Number(receiptHandle),
      ]),
    );
  },

  async release(_queue, receiptHandle, delaySeconds) {
    await withPlatform('maintenance', (tx) =>
      tx.query(
        `UPDATE integration.local_queue_message
            SET visible_at = now() + ($2 || ' seconds')::interval
          WHERE id = $1`,
        [Number(receiptHandle), String(delaySeconds)],
      ),
    );
  },

  async deadLetter(_queue, receiptHandle, reason) {
    await withPlatform('maintenance', (tx) =>
      tx.query(
        `UPDATE integration.local_queue_message
            SET dead_lettered_at = now(), dead_letter_reason = $2
          WHERE id = $1`,
        [Number(receiptHandle), reason.slice(0, 1000)],
      ),
    );
  },
};

function sqsUrl(queue: QueueName): string {
  const cfg = config();
  const url = {
    'workforce-jobs': cfg.SQS_WORKFORCE_QUEUE_URL,
    'payroll-jobs': cfg.SQS_PAYROLL_QUEUE_URL,
    'platform-jobs': cfg.SQS_PLATFORM_QUEUE_URL,
  }[queue];
  if (!url) throw new Error(`No SQS queue URL configured for "${queue}"`);
  return url;
}

/**
 * Real SQS. The AWS SDK is imported lazily so local development and CI never need the
 * dependency installed or credentials present.
 */
function createSqsQueue(): Queue {
  let clientPromise: Promise<any> | undefined;
  let modPromise: Promise<any> | undefined;

  function sdk(): Promise<any> {
    modPromise ??= import('@aws-sdk/client-sqs' as string);
    return modPromise;
  }

  async function client() {
    clientPromise ??= (async () => {
      const mod = await sdk();
      // No credentials here on purpose: the SDK's default provider chain resolves the task
      // role. Passing keys through configuration is what turns a leaked env dump into a
      // production compromise.
      return new mod.SQSClient({ region: config().AWS_REGION });
    })();
    return clientPromise;
  }

  return {
    async send(queue, body) {
      const [sqs, mod] = await Promise.all([client(), sdk()]);
      await sqs.send(
        new mod.SendMessageCommand({ QueueUrl: sqsUrl(queue), MessageBody: encodeBody(queue, body) }),
      );
    },

    async receive(queue, max, visibilitySeconds) {
      const [sqs, mod] = await Promise.all([client(), sdk()]);
      const res = await sqs.send(
        new mod.ReceiveMessageCommand({
          QueueUrl: sqsUrl(queue),
          MaxNumberOfMessages: Math.min(max, 10),
          VisibilityTimeout: visibilitySeconds,
          // Long polling: one held request instead of a poll every second, which is both
          // cheaper and lower latency than the alternative.
          WaitTimeSeconds: 20,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
      );
      return (res.Messages ?? []).map((m: any) => ({
        receiptHandle: m.ReceiptHandle,
        body: JSON.parse(m.Body ?? '{}'),
        receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? 1),
      }));
    },

    async delete(queue, receiptHandle) {
      const [sqs, mod] = await Promise.all([client(), sdk()]);
      await sqs.send(new mod.DeleteMessageCommand({ QueueUrl: sqsUrl(queue), ReceiptHandle: receiptHandle }));
    },

    async release(queue, receiptHandle, delaySeconds) {
      const [sqs, mod] = await Promise.all([client(), sdk()]);
      await sqs.send(
        new mod.ChangeMessageVisibilityCommand({
          QueueUrl: sqsUrl(queue),
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: Math.min(Math.max(delaySeconds, 0), 43_200),
        }),
      );
    },

    /**
     * On SQS the redrive policy owns dead-lettering: once a message has been received
     * `maxReceiveCount` times without being deleted, SQS moves it to the DLQ itself.
     * Deleting it here would destroy the very message the DLQ exists to preserve, so this
     * makes it visible again immediately and lets the broker make the move.
     */
    async deadLetter(queue, receiptHandle) {
      const [sqs, mod] = await Promise.all([client(), sdk()]);
      await sqs.send(
        new mod.ChangeMessageVisibilityCommand({
          QueueUrl: sqsUrl(queue),
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    },
  };
}

let instance: Queue | undefined;

export function queue(): Queue {
  instance ??= config().QUEUE_DRIVER === 'sqs' ? createSqsQueue() : localQueue;
  return instance;
}

/** Test seam. */
export function setQueue(q: Queue | undefined): void {
  instance = q;
}
