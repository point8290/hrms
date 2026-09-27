import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closePools, getAppPool, withPlatform } from '../../src/infra/db/pool.ts';
import {
  claimEvent,
  claimForPublish,
  emitEvent,
  markPublishFailed,
  markPublished,
  toEnvelope,
  type OutboxRow,
} from '../../src/infra/events/outbox.ts';
import { continueTrace, outgoingTraceparent } from '../../src/infra/telemetry.ts';
import { createEmployee, createTestTenant, dropTestTenant, skipWithoutDb, type TestTenant } from './helpers.ts';

/**
 * Event infrastructure: the outbox publisher and consumer idempotency.
 *
 * These exercise the failure branches, because the success path is already covered by the
 * MVP journey. What matters here is what happens when the broker is down and when an event
 * is delivered twice.
 */

/**
 * The publisher's batch size, mirrored from `apps/worker/src/publisher.ts`.
 *
 * Not imported: the api and worker workspaces have separate `rootDir`s, so a cross-workspace
 * import does not typecheck. Only the isolation tests below depend on it, and they depend on
 * it being *a* realistic batch size rather than on it being exactly this number.
 */
const PUBLISHER_BATCH_SIZE = 50;

/**
 * Claims this tenant's outbox rows, and no other tenant's.
 *
 * This is the production `claimForPublish`, unmodified — same CTE, same `FOR UPDATE SKIP
 * LOCKED`, same lease write. The only difference is the connection it runs on: the worker
 * runs it as `hrms_platform`, which holds BYPASSRLS, and a test runs it inside tenant
 * context as `hrms_app`, which does not. The statement carries no tenant predicate either
 * way; under RLS the `tenant_isolation` policy supplies one.
 *
 * That is the point. The boundary is the database, not a convention a future test can
 * forget: a tenant-scoped test cannot claim, lease, publish or assert against another
 * tenant's row even by mistake, while still exercising the real claim semantics.
 *
 * The suite runs test *files* concurrently (`node --test`), so a global claim here is not
 * a theoretical hazard. `claimForPublish` takes the oldest N unpublished rows across every
 * tenant and leases them: another file's backlog can fill the batch before this file's row
 * is reached, and the lease collides with whatever that file is doing. Both races have
 * been observed.
 */
async function claimOwn(
  tenant: TestTenant,
  limit = PUBLISHER_BATCH_SIZE * 4,
  leaseSeconds = 0,
): Promise<OutboxRow[]> {
  return tenant.as((tx) => claimForPublish(tx, limit, leaseSeconds));
}

/** One outbox row, read inside its own tenant. */
async function outboxRow(tenant: TestTenant, eventId: string): Promise<OutboxRow> {
  return tenant.as(async (tx) => {
    const { rows } = await tx.query<OutboxRow>(
      `SELECT id, event_id, event_type, schema_version, tenant_id, aggregate_type,
              aggregate_id, payload, correlation_id, producer, occurred_at, traceparent
         FROM integration.event_outbox WHERE tenant_id = $1 AND event_id = $2`,
      [tenant.tenantId, eventId],
    );
    const row = rows[0];
    if (!row) throw new Error(`no outbox row for event ${eventId}`);
    return row;
  });
}

describe('outbox publisher', skipWithoutDb, () => {
  let tenant: TestTenant;
  let employeeId: string;

  before(async () => {
    tenant = await createTestTenant('outbox');
    employeeId = await createEmployee(tenant, { code: 'OUT001' });
  });

  after(async () => {
    await dropTestTenant(tenant.tenantId);
    await closePools();
  });

  /**
   * The trace has to survive the crossing into Python.
   *
   * The engines are a separate process in a separate language, so the only thing joining a
   * payroll calculation to the request that asked for it is this field on the envelope. It
   * was already being written to the outbox row; what was never checked is that it comes
   * back out on the envelope the consumer actually reads, spelled the way Python reads it
   * (`hrms_engine.consumer` looks for `body["traceparent"]`).
   */
  it('carries the emitting request trace onto the envelope a worker receives', async () => {
    const parentTrace = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

    const eventId = await continueTrace(parentTrace, async () =>
      tenant.as((tx) =>
        emitEvent(tx, 'EmployeeCreated', {
          aggregateType: 'employee',
          aggregateId: employeeId,
          payload: { employee_id: employeeId },
        }),
      ),
    );

    const row = await outboxRow(tenant, eventId);

    const envelope = toEnvelope(row) as { traceparent?: string };
    assert.ok(envelope.traceparent, 'the envelope must carry the trace, not just the row');
    // Same trace as the request that caused it. The span may differ — the emitter is a step
    // inside that trace — but a worker joining on a different trace id joins nothing.
    assert.match(envelope.traceparent!, /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-[0-9a-f]{2}$/);
  });

  it('omits the trace rather than inventing one when there is no request', async () => {
    // Emitting outside any trace — a scheduled job, a migration backfill. A fabricated root
    // trace would look like a request that never happened.
    assert.equal(outgoingTraceparent(), undefined);

    const eventId = await tenant.as((tx) =>
      emitEvent(tx, 'EmployeeCreated', {
        aggregateType: 'employee',
        aggregateId: employeeId,
        payload: { employee_id: employeeId },
      }),
    );

    const row = await outboxRow(tenant, eventId);
    assert.equal(row.traceparent, null);
    assert.equal(Object.hasOwn(toEnvelope(row), 'traceparent'), false);
  });

  it('claims only unpublished events', async () => {
    const claimed = await claimOwn(tenant);
    assert.ok(claimed.length > 0, 'creating an employee should have produced an outbox event');
    assert.ok(claimed.some((r) => r.event_type === 'EmployeeCreated'));
    assert.ok(
      claimed.every((r) => r.tenant_id === tenant.tenantId),
      'a tenant-scoped claim must return this tenant and nothing else',
    );
  });

  it('marks published events so they are not sent twice', async () => {
    const before = await claimOwn(tenant);
    assert.ok(before.length > 0, 'there should be something to publish');

    await tenant.as((tx) => markPublished(tx, before.map((r) => r.id)));

    // Not `filter(...).length === 0` but the whole claim: within this tenant nothing at all
    // remains claimable, which is the assertion the filtered version could only approximate.
    const after = await claimOwn(tenant);
    assert.equal(after.length, 0, 'a published event must not be claimed again');
  });

  it('backs off a failed publish instead of spinning on it', async () => {
    const eventId = await tenant.as(async (tx) => {
      const { emitEvent } = await import('../../src/infra/events/outbox.ts');
      return emitEvent(tx, 'EmployeeUpdated', {
        aggregateType: 'employee',
        aggregateId: employeeId,
        payload: { employee_id: employeeId },
      });
    });

    const claimed = await claimOwn(tenant);
    const row = claimed.find((r) => r.event_id === eventId);
    assert.ok(row, 'the event just emitted must be claimable within its own tenant');

    await tenant.as((tx) => markPublishFailed(tx, row!.id, 'broker unavailable'));

    const state = await tenant.as(async (tx) => {
      const { rows } = await tx.query<{ retry_count: number; last_error: string; future: boolean }>(
        `SELECT retry_count, last_error, available_at > now() AS future
           FROM integration.event_outbox WHERE event_id = $1`,
        [eventId],
      );
      return rows[0]!;
    });

    assert.equal(state.retry_count, 1);
    assert.match(state.last_error, /broker unavailable/);
    assert.equal(state.future, true, 'a failed publish must be deferred, not retried immediately');
  });

  it('leaves an unpublished event claimable after a publisher crash', async () => {
    // markPublished was never called for the failed event, so the next publisher picks it
    // up once the backoff expires. Nothing is lost by the crash.
    await tenant.as((tx) =>
      tx.query(
        `UPDATE integration.event_outbox SET available_at = now() - INTERVAL '1 minute'
          WHERE tenant_id = $1 AND published_at IS NULL`,
        [tenant.tenantId],
      ),
    );

    const claimed = await claimOwn(tenant);
    assert.ok(claimed.length > 0, 'an unpublished event must become claimable again');
    assert.ok(claimed.every((r) => r.tenant_id === tenant.tenantId));
  });
});

/**
 * Tenant isolation in the outbox.
 *
 * Two separate properties, and conflating them is what went wrong before:
 *
 *   * the **publisher** is cross-tenant on purpose — one process drains every tenant's
 *     outbox, as the platform role, and that is the design (ADR-004)
 *   * a **test** is not a publisher, and must never claim, lease, publish or assert
 *     against a tenant it did not create
 *
 * The suite runs files concurrently, so a test that reached for the global claim was
 * reaching into whatever another file was doing at that moment. It failed both ways: its
 * own event could sit past the batch boundary behind another tenant's backlog, and its
 * lease landed on rows belonging to tenants it had never heard of.
 *
 * These tests pin both properties, and they do it read-only wherever asserting the hazard
 * would otherwise mean committing it.
 */
describe('outbox tenant isolation', skipWithoutDb, () => {
  let alpha: TestTenant;
  let beta: TestTenant;
  let alphaEmployeeId: string;
  let betaEmployeeId: string;
  /** Beta's event, emitted after alpha's backlog, so its id is the highest of the two. */
  let betaEventId: string;

  before(async () => {
    alpha = await createTestTenant('outbox-iso-a');
    beta = await createTestTenant('outbox-iso-b');

    // Alpha gets a full publisher batch of its own, all of it older than anything beta has.
    alphaEmployeeId = await createEmployee(alpha, { code: 'ISOA01' });
    await alpha.as(async (tx) => {
      for (let i = 0; i < PUBLISHER_BATCH_SIZE; i += 1) {
        await emitEvent(tx, 'EmployeeUpdated', {
          aggregateType: 'employee',
          aggregateId: alphaEmployeeId,
          payload: { employee_id: alphaEmployeeId, seq: i },
        });
      }
    });

    betaEmployeeId = await createEmployee(beta, { code: 'ISOB01' });
    betaEventId = await beta.as((tx) =>
      emitEvent(tx, 'EmployeeUpdated', {
        aggregateType: 'employee',
        aggregateId: betaEmployeeId,
        payload: { employee_id: betaEmployeeId },
      }),
    );
  });

  after(async () => {
    await dropTestTenant(alpha.tenantId);
    await dropTestTenant(beta.tenantId);
    await closePools();
  });

  /** Alpha's leases, as a comparable snapshot. */
  async function alphaLeases(): Promise<string[]> {
    return withPlatform('outbox-publisher', async (tx) => {
      const { rows } = await tx.query<{ id: string; available_at: Date }>(
        `SELECT id, available_at FROM integration.event_outbox WHERE tenant_id = $1 ORDER BY id`,
        [alpha.tenantId],
      );
      return rows.map((r) => `${r.id}@${r.available_at.toISOString()}`);
    });
  }

  it('puts one tenant event past the batch boundary a global claim would stop at', async () => {
    // Read-only on purpose: this is the row set a global `claimForPublish(BATCH_SIZE)` would
    // have leased, without leasing it. Asserting the hazard must not commit the hazard.
    //
    // Restricted to these two tenants so the assertion does not depend on what the rest of
    // the suite happens to have in the outbox at this instant — other files only add rows
    // ahead of beta's, which would make the point more strongly, never less.
    const batch = await withPlatform('outbox-publisher', async (tx) => {
      const { rows } = await tx.query<{ event_id: string; tenant_id: string }>(
        `SELECT event_id, tenant_id
           FROM integration.event_outbox
          WHERE published_at IS NULL
            AND available_at <= now()
            AND tenant_id = ANY($1::uuid[])
          ORDER BY id
          LIMIT $2`,
        [[alpha.tenantId, beta.tenantId], PUBLISHER_BATCH_SIZE],
      );
      return rows;
    });

    assert.equal(batch.length, PUBLISHER_BATCH_SIZE, 'alpha alone should fill a publisher batch');
    assert.ok(
      batch.every((r) => r.tenant_id === alpha.tenantId),
      'the batch is entirely alpha: this is the backlog that hid beta',
    );
    assert.equal(
      batch.some((r) => r.event_id === betaEventId),
      false,
      'beta event sits past the batch boundary, so a global claim would never have reached it',
    );
  });

  it('reaches this tenant event anyway, because the claim is tenant-scoped', async () => {
    const claimed = await claimOwn(beta);

    assert.ok(
      claimed.some((r) => r.event_id === betaEventId),
      'a tenant-scoped claim must find this tenant event however large another backlog is',
    );
    assert.ok(
      claimed.every((r) => r.tenant_id === beta.tenantId),
      'and must return nothing belonging to anyone else',
    );
  });

  it('does not lease another tenant rows', async () => {
    const before = await alphaLeases();

    // A real lease, not a zero-second one. If the claim crossed the tenant boundary it
    // would push alpha an hour into the future, and the difference would be unmistakable.
    const claimed = await claimOwn(beta, PUBLISHER_BATCH_SIZE * 4, 3600);
    assert.ok(claimed.length > 0, 'beta needs something to lease for this to prove anything');
    assert.ok(claimed.every((r) => r.tenant_id === beta.tenantId));

    assert.deepEqual(
      await alphaLeases(),
      before,
      'a claim inside one tenant must not move another tenant lease by so much as a microsecond',
    );
  });

  it('keeps two tenants concurrent claims disjoint, with neither blocking the other', async () => {
    // Fresh rows on both sides: the previous test leased beta an hour forward.
    const [alphaEvent, betaEvent] = await Promise.all([
      alpha.as((tx) =>
        emitEvent(tx, 'EmployeeUpdated', { aggregateType: 'employee', aggregateId: alphaEmployeeId }),
      ),
      beta.as((tx) =>
        emitEvent(tx, 'EmployeeUpdated', { aggregateType: 'employee', aggregateId: betaEmployeeId }),
      ),
    ]);

    // Genuinely concurrent: two connections, two transactions, both claiming at once. They
    // take `FOR UPDATE SKIP LOCKED` over the same table, which is the interleaving that
    // matters — and neither can block the other, because RLS means their candidate sets
    // never intersect.
    const [claimedA, claimedB] = await Promise.all([
      claimOwn(alpha, PUBLISHER_BATCH_SIZE * 4, 60),
      claimOwn(beta, PUBLISHER_BATCH_SIZE * 4, 60),
    ]);

    assert.ok(claimedA.every((r) => r.tenant_id === alpha.tenantId));
    assert.ok(claimedB.every((r) => r.tenant_id === beta.tenantId));
    assert.ok(claimedA.some((r) => r.event_id === alphaEvent));
    assert.ok(claimedB.some((r) => r.event_id === betaEvent));
    assert.deepEqual(
      claimedA.filter((r) => claimedB.some((o) => o.id === r.id)),
      [],
      'two tenants claims must not overlap',
    );
  });

  it('leaves the production publisher cross-tenant, which is its design', async () => {
    // Nothing above is a statement about the worker. `claimForPublish` carries no tenant
    // predicate on purpose — one publisher drains every tenant's outbox — and it runs as
    // `hrms_platform`, which holds BYPASSRLS. The tenant-scoped claims above work by
    // running that same unmodified statement on a connection that does not.
    //
    // Pinned here so that "make the tests pass by filtering the publisher" has to argue
    // with a failing test first. Read-only: proving the publisher sees both tenants must
    // not lease either one.
    const seen = await withPlatform('outbox-publisher', async (tx) => {
      const { rows } = await tx.query<{ bypasses_rls: boolean; tenants: number }>(
        `SELECT (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls,
                (SELECT count(DISTINCT tenant_id)::int FROM integration.event_outbox
                  WHERE tenant_id = ANY($1::uuid[])) AS tenants`,
        [[alpha.tenantId, beta.tenantId]],
      );
      return rows[0]!;
    });

    assert.equal(seen.bypasses_rls, true, 'the publisher role must bypass RLS or it could not drain every tenant');
    assert.equal(seen.tenants, 2, 'with no tenant context set the publisher sees both tenants');
  });

  it('fails closed when tenant context is missing, which is what the scoped claim rests on', async () => {
    // RLS is the boundary `claimOwn` relies on, so it has to fail closed rather than open.
    // `withTenant` refuses anything that is not a uuid, so the app pool is taken directly:
    // it is the only place a genuinely absent context is reachable.
    const client = await getAppPool().connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM integration.event_outbox WHERE tenant_id = ANY($1::uuid[])`,
        [[alpha.tenantId, beta.tenantId]],
      );
      assert.equal(rows[0]!.n, 0, 'with no tenant context the app role must see no outbox rows at all');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('consumer idempotency', skipWithoutDb, () => {
  let tenant: TestTenant;

  before(async () => {
    tenant = await createTestTenant('idem');
  });

  after(async () => {
    await dropTestTenant(tenant.tenantId);
    await closePools();
  });

  it('lets the first delivery through and stops the second', async () => {
    const eventId = crypto.randomUUID();

    const first = await tenant.as((tx) => claimEvent(tx, tenant.tenantId, eventId, 'test-consumer'));
    const second = await tenant.as((tx) => claimEvent(tx, tenant.tenantId, eventId, 'test-consumer'));

    assert.equal(first, true);
    assert.equal(second, false, 'a redelivered event must not be processed twice');
  });

  it('scopes the claim to the consumer, so two consumers both see the event', async () => {
    const eventId = crypto.randomUUID();

    const a = await tenant.as((tx) => claimEvent(tx, tenant.tenantId, eventId, 'consumer-a'));
    const b = await tenant.as((tx) => claimEvent(tx, tenant.tenantId, eventId, 'consumer-b'));

    assert.equal(a, true);
    assert.equal(b, true, 'one consumer processing an event must not starve another');
  });

  it('rolls the claim back with the work when the handler fails', async () => {
    const eventId = crypto.randomUUID();

    await assert.rejects(
      tenant.as(async (tx) => {
        await claimEvent(tx, tenant.tenantId, eventId, 'failing-consumer');
        throw new Error('handler blew up');
      }),
      /handler blew up/,
    );

    // The claim must not survive a failed handler, or the retry would be skipped and the
    // work would never happen.
    const retry = await tenant.as((tx) => claimEvent(tx, tenant.tenantId, eventId, 'failing-consumer'));
    assert.equal(retry, true, 'a failed handler must leave the event claimable again');
  });
});
