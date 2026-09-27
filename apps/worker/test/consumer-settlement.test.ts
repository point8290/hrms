import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { QUEUES } from '@hrms/events';
import { setQueue, type Queue, type QueueMessage } from '@hrms/api/src/infra/queue.ts';
import { HANDLERS } from '../src/handlers.ts';
import { MAX_RECEIVES, runConsumer } from '../src/consumer.ts';

/**
 * How the platform consumer settles a message.
 *
 * Every message leaves the loop by exactly one of four routes — deleted, released,
 * dead-lettered, or deliberately left alone — and the route it takes has to follow from
 * what actually happened, not from where the exception was thrown. Two things were wrong,
 * and both came from settling inside the same `try` as the work:
 *
 *   * a handler that **succeeded** and whose delete then failed fell into the failure
 *     branch, and at the retry limit that dead-lettered it. Work that was done, in the
 *     dead letter queue, under the alarm that watches it.
 *   * any settle call that threw escaped the message loop, escaped `while (!aborted)`, and
 *     exited the process — taking the publisher, the scheduler and notification delivery
 *     with it, because all four roles share one worker.
 *
 * No database: the queue comes through the `setQueue` seam and the handler is stubbed, so
 * these are deterministic and run everywhere.
 */

/** A real event type, so `parseEnvelope` accepts the envelope. */
const EVENT_TYPE = 'EmployeeCreated';

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    event_id: randomUUID(),
    event_type: EVENT_TYPE,
    schema_version: 1,
    tenant_id: randomUUID(),
    aggregate_type: 'employee',
    aggregate_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    producer: 'hrms-api',
    payload: {},
    ...overrides,
  };
}

type Row = {
  handle: string;
  body: Record<string, unknown>;
  receiveCount: number;
  deleted: boolean;
  released: boolean;
  deadLettered: boolean;
  reason?: string;
};

/**
 * A queue with SQS's semantics and injectable failures.
 *
 * `receive` hands out each row once and then aborts the consumer, so a test is one pass
 * over the loop with no timing involved.
 */
class FakeQueue implements Queue {
  rows: Row[] = [];
  failOn: Partial<Record<'delete' | 'release' | 'deadLetter', boolean>> = {};
  calls: string[] = [];
  private served = false;

  // An explicit field, not a parameter property: `--experimental-strip-types` does not
  // support those.
  private readonly controller: AbortController;

  constructor(controller: AbortController) {
    this.controller = controller;
  }

  add(body: Record<string, unknown>, receiveCount = 1): Row {
    const row: Row = {
      handle: String(this.rows.length),
      body,
      receiveCount,
      deleted: false,
      released: false,
      deadLettered: false,
    };
    this.rows.push(row);
    return row;
  }

  async send(): Promise<void> {}

  async receive(): Promise<QueueMessage[]> {
    if (this.served) {
      this.controller.abort();
      return [];
    }
    this.served = true;
    return this.rows.map((r) => ({
      receiptHandle: r.handle,
      body: r.body,
      receiveCount: r.receiveCount,
    }));
  }

  private row(handle: string): Row {
    return this.rows.find((r) => r.handle === handle)!;
  }

  async delete(_q: string, handle: string): Promise<void> {
    this.calls.push(`delete:${handle}`);
    if (this.failOn.delete) throw new Error('broker unreachable on delete');
    this.row(handle).deleted = true;
  }

  async release(_q: string, handle: string): Promise<void> {
    this.calls.push(`release:${handle}`);
    if (this.failOn.release) throw new Error('broker unreachable on release');
    this.row(handle).released = true;
  }

  async deadLetter(_q: string, handle: string, reason: string): Promise<void> {
    this.calls.push(`deadLetter:${handle}`);
    if (this.failOn.deadLetter) throw new Error('broker unreachable on dead-letter');
    const row = this.row(handle);
    row.deadLettered = true;
    row.reason = reason;
  }
}

type Run = { queue: FakeQueue; logs: string[]; errors: string[] };

/** Drives one pass of the consumer with `handler` standing in for the real one. */
async function run(
  build: (q: FakeQueue) => void,
  handler: () => Promise<void>,
): Promise<Run> {
  const controller = new AbortController();
  const queue = new FakeQueue(controller);
  build(queue);

  const original = HANDLERS[EVENT_TYPE];
  HANDLERS[EVENT_TYPE] = handler as (typeof HANDLERS)[string];
  setQueue(queue);

  const logs: string[] = [];
  const errors: string[] = [];
  try {
    await runConsumer({
      signal: controller.signal,
      log: (msg) => logs.push(msg),
      logError: (msg) => errors.push(msg),
    });
  } finally {
    if (original) HANDLERS[EVENT_TYPE] = original;
    else delete HANDLERS[EVENT_TYPE];
    setQueue(undefined);
  }
  return { queue, logs, errors };
}

const succeeds = async () => {};
const fails = async () => {
  throw new Error('handler blew up');
};

afterEach(() => setQueue(undefined));

describe('platform consumer settlement', () => {
  it('deletes a processed event and reports it processed', async () => {
    const { queue, logs } = await run((q) => q.add(envelope()), succeeds);

    assert.equal(queue.rows[0]!.deleted, true);
    assert.equal(queue.rows[0]!.deadLettered, false);
    assert.ok(logs.includes('event processed'));
  });

  it('does not dead-letter successful work when the acknowledgement fails', async () => {
    // The defect, at the retry limit where it bit: the handler succeeded, the delete failed,
    // and the failure branch dead-lettered work that was already done.
    const { queue, logs } = await run((q) => {
      q.failOn.delete = true;
      q.add(envelope(), MAX_RECEIVES);
    }, succeeds);

    assert.equal(queue.rows[0]!.deadLettered, false, 'successful work must never be dead-lettered');
    assert.equal(queue.rows[0]!.released, false, 'nor treated as a failed attempt');
    assert.deepEqual(queue.calls, ['delete:0'], 'the only settle attempted is the acknowledgement');
    assert.equal(
      logs.includes('event processed'), false,
      'and it must not claim to have processed what it could not acknowledge',
    );
  });

  it('leaves an unacknowledged event to be redelivered rather than losing it', async () => {
    const { queue, errors } = await run((q) => {
      q.failOn.delete = true;
      q.add(envelope(), 1);
    }, succeeds);

    assert.equal(queue.rows[0]!.deleted, false);
    assert.equal(queue.rows[0]!.deadLettered, false);
    assert.ok(
      errors.some((e) => e.includes('acknowledge')),
      'the operator has to be told the acknowledgement failed',
    );
  });

  it('releases a failed handler below the retry limit', async () => {
    const { queue } = await run((q) => q.add(envelope(), 1), fails);

    assert.equal(queue.rows[0]!.released, true);
    assert.equal(queue.rows[0]!.deadLettered, false);
  });

  it('dead-letters a failed handler at the retry limit, with the reason', async () => {
    const { queue } = await run((q) => q.add(envelope(), MAX_RECEIVES), fails);

    assert.equal(queue.rows[0]!.deadLettered, true);
    assert.match(queue.rows[0]!.reason!, /handler failed 5 times: handler blew up/);
  });

  it('survives a release that fails instead of exiting the worker', async () => {
    // Before, this rejected `runConsumer`, which rejected the `Promise.all` in main.ts and
    // exited the process — one unreachable broker stopping four unrelated roles.
    const { queue, errors } = await run((q) => {
      q.failOn.release = true;
      q.add(envelope(), 1);
    }, fails);

    assert.equal(queue.rows[0]!.released, false);
    assert.ok(errors.some((e) => e.includes('release')));
  });

  it('survives a dead-letter that fails, and does not claim the event was dead-lettered', async () => {
    const { queue, errors } = await run((q) => {
      q.failOn.deadLetter = true;
      q.add(envelope(), MAX_RECEIVES);
    }, fails);

    assert.equal(queue.rows[0]!.deadLettered, false);
    assert.ok(errors.some((e) => e.includes('dead-letter')));
    assert.equal(
      errors.includes('event dead-lettered'), false,
      'telling an operator to inspect the DLQ for an event that never reached it sends them nowhere',
    );
  });

  it('keeps processing the rest of the batch after one message cannot be settled', async () => {
    const results: string[] = [];
    const { queue } = await run((q) => {
      q.failOn.release = true;
      q.add(envelope(), 1);
      q.add(envelope(), 1);
    }, async () => {
      results.push('ran');
      if (results.length === 1) throw new Error('handler blew up');
    });

    assert.equal(results.length, 2, 'the second message must still be handled');
    assert.equal(queue.rows[1]!.deleted, true);
  });

  it('survives a dead-letter failure on a malformed envelope', async () => {
    const { queue, errors } = await run((q) => {
      q.failOn.deadLetter = true;
      q.add({ event_type: EVENT_TYPE }, 1); // no event_id, no tenant_id
    }, succeeds);

    assert.equal(queue.rows[0]!.deadLettered, false);
    assert.ok(errors.some((e) => e.includes('malformed')));
  });

  it('survives a delete failure on an event nobody handles', async () => {
    const { queue, errors } = await run((q) => {
      q.failOn.delete = true;
      // A real event type with no entry in HANDLERS, so it takes the unhandled branch.
      q.add(envelope({ event_type: 'AttendanceCalculated' }), 1);
    }, succeeds);

    assert.equal(queue.rows[0]!.deleted, false);
    assert.ok(errors.some((e) => e.includes('unhandled')));
  });
});
