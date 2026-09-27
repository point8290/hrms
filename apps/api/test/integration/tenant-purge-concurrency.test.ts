import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { closePools, getAppPool, getPlatformPool } from '../../src/infra/db/pool.ts';
import { createEmployee, createTestTenant, dropTestTenant, skipWithoutDb, type TestTenant } from './helpers.ts';

/**
 * Concurrency of `identity.purge_tenant` (ADR-008).
 *
 * A purge is one `DELETE FROM identity.tenant`, and everything else is the foreign-key
 * cascade unwinding through seventy-one tables that reference it. Nothing about that is
 * obviously safe to run twice at once, and the integration suite did once see teardown fail
 * with a deadlock (40P01) — so `dropTestTenant` serialises every purge in the suite behind
 * one transaction-scoped advisory lock.
 *
 * That lock is a property of the *test harness*, not of the function. These tests establish
 * what the function itself does, because the two must not be confused: copying the harness
 * lock into the database would serialise every tenant's erasure behind every other tenant's,
 * and nothing here asks for that.
 *
 * The concurrency tests below hold that same key **exclusively, on a connection of their
 * own**, for the duration of the test. No other file's teardown can purge while they run;
 * their own purges take no advisory lock at all, so they stay genuinely concurrent with
 * each other, which is the whole point.
 *
 * That is not caution. A first version took no lock anywhere, on the grounds that
 * serialisation was the thing under test and borrowing the harness's lock would assume the
 * answer. Run against a loaded database it reproduced the very 40P01 the harness lock
 * exists for — inside this file, on a purge of a tenant no other test had heard of. Two
 * purges of *different* tenants can deadlock: the cascade walks seventy-one tables in an
 * order its own data dictates, and two walks can meet head-on.
 *
 * A second version had both purge connections take the key in shared mode. That is worse
 * than it looks. Postgres queues advisory lock requests fairly, so an exclusive waiter
 * arriving between the two acquisitions parks the second one behind itself — behind a
 * waiter that is in turn waiting for the first connection, which is idle in a transaction
 * waiting for this test to move. No cycle Postgres can see, and nothing to break it. A
 * separate gate has no such window: it is taken once, before anything else, and the purges
 * themselves never queue for anything.
 *
 * Everything below uses explicit transaction control rather than sleeps: a purge is held
 * open on one connection while a second is observed against it, so the interleaving is
 * constructed rather than hoped for.
 */

/** The key `dropTestTenant` takes for every purge in the suite. */
const SUITE_PURGE_KEY = 'hrms:test:purge_tenant';

/**
 * Takes the suite purge key so that no other file can purge until `close()`.
 *
 * Session-scoped rather than transaction-scoped, because it has to outlive the several
 * transactions each test opens and closes inside it — and on a connection of its own, so
 * that the connections doing the purging never queue for an advisory lock at all.
 */
async function openPurgeGate(): Promise<{ close(): Promise<void> }> {
  const gate = await platform().connect();
  await gate.query('SELECT pg_advisory_lock(hashtext($1))', [SUITE_PURGE_KEY]);
  return {
    async close() {
      try {
        await gate.query('SELECT pg_advisory_unlock(hashtext($1))', [SUITE_PURGE_KEY]);
        gate.release();
      } catch {
        // Returning a connection that still holds a session lock would block every later
        // teardown in the suite for as long as the pool keeps it. Discard it instead.
        gate.release(true);
      }
    },
  };
}

/**
 * Ends whatever state these connections are in and returns them to the pool.
 *
 * `ROLLBACK` is a no-op on a connection that already committed and the only safe thing on
 * one whose transaction failed. An earlier version simply released inside a `finally`: when
 * a purge deadlocked, the connection went back to the pool mid-transaction and the next
 * test to borrow it failed with "current transaction is aborted" — one failure becoming
 * three, with the real cause two tests up the log.
 */
async function finish(...clients: pg.PoolClient[]): Promise<void> {
  for (const client of clients) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/** The purge runs as the platform role; `hrms_app` is not granted EXECUTE on it (ADR-008). */
function platform(): pg.Pool {
  return getPlatformPool();
}

/**
 * Waits until `pid` is waiting on a lock.
 *
 * A condition, not a delay: it returns the moment Postgres reports the backend blocked, and
 * the budget only bounds how long it is willing to be wrong for. Five seconds is far past
 * the point where a purge that was going to serialise has done so.
 */
async function waitUntilBlockedOnLock(observer: pg.PoolClient, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await observer.query<{ wait_event_type: string | null; state: string | null }>(
      'SELECT wait_event_type, state FROM pg_stat_activity WHERE pid = $1',
      [pid],
    );
    if (rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`backend ${pid} never blocked on a lock; the second purge did not serialise`);
}

async function purgeLogEntries(tenantId: string): Promise<Array<{ reason: string }>> {
  const { rows } = await platform().query<{ reason: string }>(
    'SELECT reason FROM identity.tenant_purge_log WHERE tenant_id = $1 ORDER BY id',
    [tenantId],
  );
  return rows;
}

/** A tenant with enough rows across enough tables that the cascade is not a formality. */
async function populatedTenant(prefix: string): Promise<TestTenant> {
  const tenant = await createTestTenant(prefix);
  for (let i = 0; i < 5; i += 1) {
    await createEmployee(tenant, { code: `PURGE${i}` });
  }
  return tenant;
}

describe('concurrent tenant purge', skipWithoutDb, () => {
  let sameTenant: TestTenant;
  let alpha: TestTenant;
  let beta: TestTenant;

  before(async () => {
    sameTenant = await populatedTenant('purge-same');
    alpha = await populatedTenant('purge-alpha');
    beta = await populatedTenant('purge-beta');
  });

  after(async () => {
    // Every tenant this file creates is purged by the tests themselves, so there is no
    // teardown to do beyond releasing the pools.
    await closePools();
  });

  it('serialises two purges of the same tenant instead of deadlocking', async () => {
    const gate = await openPurgeGate();
    const first = await platform().connect();
    const second = await platform().connect();
    const observer = await platform().connect();

    try {
      const { rows } = await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const secondPid = rows[0]!.pid;

      // The first purge runs but does not commit, so it still holds the row lock on
      // `identity.tenant` and every lock the cascade took on the way down.
      await first.query('BEGIN');
      await first.query('SELECT identity.purge_tenant($1, $2)', [sameTenant.tenantId, 'first, held open']);

      // The second starts against the same tenant. Not awaited: the point is what it does
      // while the first is still open.
      await second.query('BEGIN');
      const secondPurge = second.query('SELECT identity.purge_tenant($1, $2)', [
        sameTenant.tenantId,
        'second, concurrent',
      ]);

      // This is the property the whole file exists for. `DELETE FROM identity.tenant` takes
      // a row lock the first transaction already holds, so the second waits for it — one
      // transaction blocked on another, which is not a deadlock and never becomes one,
      // because there is nothing the first is waiting on in return.
      await waitUntilBlockedOnLock(observer, secondPid);

      await first.query('COMMIT');

      // Released, and it completes rather than erroring: under READ COMMITTED the DELETE
      // re-evaluates against the committed state, finds the row gone, and removes nothing.
      await secondPurge;
      await second.query('COMMIT');
    } finally {
      await finish(second, first, observer);
      await gate.close();
    }

    const survived = await platform().query('SELECT 1 FROM identity.tenant WHERE id = $1', [
      sameTenant.tenantId,
    ]);
    assert.equal(survived.rowCount, 0, 'the tenant must be gone once both purges have finished');

    const employees = await platform().query('SELECT 1 FROM core.employee WHERE tenant_id = $1', [
      sameTenant.tenantId,
    ]);
    assert.equal(employees.rowCount, 0, 'the cascade must have completed, not half-completed');

    // Both attempts are recorded. The log is evidence of who asked for an erasure and why
    // (ADR-008), so two authorisations are two rows — the second having erased nothing does
    // not make it something that did not happen.
    const log = await purgeLogEntries(sameTenant.tenantId);
    assert.deepEqual(
      log.map((r) => r.reason),
      ['first, held open', 'second, concurrent'],
    );
  });

  it('does not serialise purges of different tenants behind one another', async () => {
    const gate = await openPurgeGate();
    const first = await platform().connect();
    const second = await platform().connect();

    try {
      // Alpha's purge is held open for the whole of beta's.
      await first.query('BEGIN');
      await first.query('SELECT identity.purge_tenant($1, $2)', [alpha.tenantId, 'alpha, held open']);

      await second.query('BEGIN');
      // Neither of these connections holds an advisory lock — the gate is held elsewhere —
      // so nothing but the function's own behaviour lets this through. If `purge_tenant`
      // carried a lock of its own, this statement would block until alpha committed and the
      // test would hang. Erasing one customer must not wait on erasing an unrelated one.
      await second.query('SELECT identity.purge_tenant($1, $2)', [beta.tenantId, 'beta, concurrent']);
      await second.query('COMMIT');

      await first.query('COMMIT');
    } finally {
      await finish(second, first);
      await gate.close();
    }

    const left = await platform().query('SELECT id FROM identity.tenant WHERE id = ANY($1::uuid[])', [
      [alpha.tenantId, beta.tenantId],
    ]);
    assert.equal(left.rowCount, 0, 'both tenants must be gone');
  });

  it('refuses a second purge once the tenant is actually gone', async () => {
    // The idempotency this function offers, stated exactly: a purge racing another purge
    // succeeds having deleted nothing, but a purge of a tenant that is already gone is an
    // error rather than a silent no-op. Existing behaviour, pinned so a retry loop written
    // later cannot assume the friendlier of the two.
    await assert.rejects(
      platform().query('SELECT identity.purge_tenant($1, $2)', [alpha.tenantId, 'again']),
      /does not exist/,
    );
  });

  it('proceeds past an outbox row the publisher has leased but not committed', async () => {
    // The one production component that can genuinely be inside a tenant's rows while it is
    // being erased. The publisher claims across every tenant as the platform role, so a
    // purge and a publisher batch can overlap on `integration.event_outbox` — and the
    // publisher's three-phase design leaves exactly this window open on every batch.
    const victim = await populatedTenant('purge-outbox');

    const gate = await openPurgeGate();
    const publisher = await getAppPool().connect();
    const purger = await platform().connect();
    const observer = await platform().connect();

    try {
      // Phase 1 of a publish, held open: rows claimed and leased, transaction not committed.
      await publisher.query('BEGIN');
      await publisher.query("SELECT set_config('app.tenant_id', $1, true)", [victim.tenantId]);
      const leased = await publisher.query(
        `WITH due AS (
            SELECT id FROM integration.event_outbox
             WHERE published_at IS NULL AND available_at <= now()
             ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED
         )
         UPDATE integration.event_outbox o
            SET available_at = now() + make_interval(secs => 60)
           FROM due WHERE o.id = due.id
         RETURNING o.id`,
      );
      assert.ok((leased.rowCount ?? 0) > 0, 'creating employees should have left events to lease');

      const { rows } = await purger.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');

      await purger.query('BEGIN');
      const purge = purger.query('SELECT identity.purge_tenant($1, $2)', [
        victim.tenantId,
        'racing the publisher',
      ]);

      // The cascade reaches `event_outbox` and waits on the lease. Waiting, not deadlocking:
      // the publisher holds outbox rows and wants nothing the purge has, so the wait is
      // one-directional and resolves the moment the batch commits.
      await waitUntilBlockedOnLock(observer, rows[0]!.pid);

      await publisher.query('COMMIT');
      await purge;
      await purger.query('COMMIT');
    } finally {
      await finish(purger, publisher, observer);
      await gate.close();
    }

    const leftover = await platform().query(
      'SELECT 1 FROM integration.event_outbox WHERE tenant_id = $1',
      [victim.tenantId],
    );
    assert.equal(leftover.rowCount, 0, 'an erasure must remove the events too, leased or not');
  });

  it('still refuses a purge with no reason', async () => {
    const doomed = await createTestTenant('purge-noreason');
    await assert.rejects(
      platform().query('SELECT identity.purge_tenant($1, $2)', [doomed.tenantId, '']),
      /reason is required/,
    );

    const survived = await platform().query('SELECT 1 FROM identity.tenant WHERE id = $1', [
      doomed.tenantId,
    ]);
    assert.equal(survived.rowCount, 1, 'a refused purge must not have erased anything');

    // Ordinary teardown, through the harness helper and its exclusive lock: this one is a
    // real cascade with no reason to run concurrently with anything.
    await dropTestTenant(doomed.tenantId);
  });
});
