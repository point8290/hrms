import { QUEUES, parseEnvelope } from '@hrms/events';
import { queue } from '@hrms/api/src/infra/queue.ts';
import { continueTrace, currentTrace, withSpan } from '@hrms/api/src/infra/telemetry.ts';
import { CONSUMER_NAME, HANDLERS } from './handlers.ts';

/**
 * Consumes the platform queue.
 *
 * Failure policy, in one place because every branch of it is a decision about a real
 * message that will otherwise sit in the queue for ever:
 *
 *   * malformed envelope  — dead-lettered. A retry can never fix it, and without a
 *                           tenant_id it cannot be handled safely at all.
 *   * unknown event type  — ACKed. Another consumer owns it, or nobody does; either way
 *                           blocking this queue on it helps no one.
 *   * handler error       — released with capped exponential backoff, then dead-lettered
 *                           once the attempts are spent, so a poison message stops
 *                           consuming a receive slot on every poll.
 *   * settle failure      — logged, message left alone. A broker that cannot be reached
 *                           is not a verdict on the message, and it must not end the
 *                           process either: all four worker roles share one.
 *
 * Acknowledging a processed event is settled separately from the handler, because the two
 * failures mean different things: the handler failing is a verdict on the message, the
 * delete failing is a verdict on the broker.
 */

/** Matches the redrive policy in infrastructure. Keep the two in step. */
export const MAX_RECEIVES = 5;

const VISIBILITY_SECONDS = 120;

/** SQS refuses a visibility timeout beyond 12 hours; a retry delay must stay under it. */
const MAX_VISIBILITY_SECONDS = 43_200;

export type ConsumerOptions = {
  signal: AbortSignal;
  log: (msg: string, meta?: Record<string, unknown>) => void;
  logError: (msg: string, meta?: Record<string, unknown>) => void;
};

/**
 * Runs one queue settle operation without letting a broker failure end the consumer.
 *
 * Every settle below — delete, release, dead-letter — is a network call that can fail on
 * its own, and each was previously awaited bare inside the message loop. That loop sits
 * inside `while (!signal.aborted)` with nothing around it, so a single failed call rejected
 * `runConsumer`, rejected the `Promise.all` in `main.ts`, and exited the process. One
 * unreachable broker took down the publisher, the scheduler and notification delivery with
 * it, because all four roles share a process.
 *
 * Returning false instead leaves the message exactly as it is: still invisible until its
 * visibility timeout expires, then redelivered. Delayed, never lost, and never recorded as
 * settled when it was not.
 */
async function settle(
  what: string,
  op: () => Promise<void>,
  logError: ConsumerOptions['logError'],
  context: Record<string, unknown>,
): Promise<boolean> {
  try {
    await op();
    return true;
  } catch (err) {
    logError(`could not ${what}; the message will be redelivered`, { ...context, err: String(err) });
    return false;
  }
}

export async function runConsumer(options: ConsumerOptions): Promise<void> {
  const q = queue();
  let pollFailures = 0;

  while (!options.signal.aborted) {
    let messages;
    try {
      messages = await q.receive(QUEUES.platform, 10, VISIBILITY_SECONDS);
      pollFailures = 0;
    } catch (err) {
      // Back off on a broker outage instead of hammering it — and instead of filling the
      // log with one line per second for the duration.
      pollFailures += 1;
      options.logError('failed to poll platform queue', { err: String(err), consecutive: pollFailures });
      await sleep(Math.min(1000 * 2 ** pollFailures, 30_000), options.signal);
      continue;
    }

    if (messages.length === 0) {
      await sleep(1000, options.signal);
      continue;
    }

    for (const message of messages) {
      if (options.signal.aborted) break;

      let envelope;
      try {
        envelope = parseEnvelope(message.body);
      } catch (err) {
        options.logError('dead-lettering malformed envelope', { err: String(err) });
        await settle(
          'dead-letter a malformed envelope',
          () => q.deadLetter(QUEUES.platform, message.receiptHandle, 'malformed envelope'),
          options.logError,
          {},
        );
        continue;
      }

      const handler = HANDLERS[envelope.event_type];
      if (!handler) {
        await settle(
          'delete an unhandled event',
          () => q.delete(QUEUES.platform, message.receiptHandle),
          options.logError,
          { event_type: envelope.event_type, event_id: envelope.event_id },
        );
        continue;
      }

      try {
        // The trace the producer was in, resumed here. This is the join between the
        // synchronous and asynchronous halves: the span below belongs to the HTTP request
        // that ultimately caused this work, however many queue hops ago that was.
        await continueTrace(envelope.traceparent, () =>
          withSpan(
            `consume ${envelope.event_type}`,
            {
              'messaging.system': 'sqs',
              'messaging.operation': 'process',
              'messaging.destination': QUEUES.platform,
              'event.type': envelope.event_type,
              'event.id': envelope.event_id,
              'tenant.id': envelope.tenant_id,
              consumer: CONSUMER_NAME,
              component: 'worker',
            },
            async () => handler(envelope),
          ),
        );
      } catch (err) {
        options.logError('handler failed', {
          event_type: envelope.event_type,
          event_id: envelope.event_id,
          tenant_id: envelope.tenant_id,
          receive_count: message.receiveCount,
          err: String(err),
        });

        if (message.receiveCount < MAX_RECEIVES) {
          const delay = Math.min(2 ** message.receiveCount, MAX_VISIBILITY_SECONDS);
          await settle(
            'release a failed event for retry',
            () => q.release(QUEUES.platform, message.receiptHandle, delay),
            options.logError,
            { event_id: envelope.event_id, event_type: envelope.event_type },
          );
        } else {
          const dead = await settle(
            'dead-letter an exhausted event',
            () => q.deadLetter(
              QUEUES.platform,
              message.receiptHandle,
              `handler failed ${message.receiveCount} times: ${err instanceof Error ? err.message : String(err)}`,
            ),
            options.logError,
            { event_id: envelope.event_id, event_type: envelope.event_type },
          );
          // Only claimed once it actually happened. Logging the dead-letter unconditionally
          // would tell an operator the event is in the DLQ when it is still on the queue.
          if (dead) {
            options.logError('event dead-lettered', {
              event_id: envelope.event_id,
              event_type: envelope.event_type,
              tenant_id: envelope.tenant_id,
              consumer: CONSUMER_NAME,
              action: 'inspect the dead letter queue; the event has not been processed',
            });
          }
        }
        continue;
      }

      // The work is committed; only the acknowledgement is left. Deliberately outside the
      // try above, because a delete that fails is not a handler failure. Inside it, a
      // successful handler whose delete failed fell into the catch — and at
      // `receiveCount >= MAX_RECEIVES` that dead-lettered it, putting work that had
      // *succeeded* into the DLQ and raising the CloudWatch alarm that watches it.
      //
      // Redelivery instead is safe and always was: every handler claims through
      // `processed_event` in the same transaction as its work, so the next delivery finds
      // the event already handled, does nothing, and deletes cleanly. The business work is
      // not repeated — only the acknowledgement is retried.
      const acknowledged = await settle(
        'acknowledge a processed event',
        () => q.delete(QUEUES.platform, message.receiptHandle),
        options.logError,
        { event_id: envelope.event_id, event_type: envelope.event_type },
      );
      if (acknowledged) {
        options.log('event processed', {
          event_type: envelope.event_type,
          event_id: envelope.event_id,
          tenant_id: envelope.tenant_id,
          correlation_id: envelope.correlation_id,
          trace_id: currentTrace()?.traceId,
        });
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
