import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closePools, getAppPool, probeRlsEnforcement, withTenant, SYSTEM_ACTOR } from '../../src/infra/db/pool.ts';
import { createEmployee, createTestTenant, dropTestTenant, skipWithoutDb, type TestTenant } from './helpers.ts';

/**
 * Tenant isolation is the invariant this system cannot get wrong (PRD s.29,
 * invariants.md#multi-tenancy). These tests exercise the database boundary directly
 * rather than trusting that application code always adds the right predicate.
 */
describe('tenant isolation', skipWithoutDb, () => {
  let alpha: TestTenant;
  let beta: TestTenant;
  let alphaEmployeeId: string;
  let betaEmployeeId: string;

  before(async () => {
    alpha = await createTestTenant('alpha');
    beta = await createTestTenant('beta');
    alphaEmployeeId = await createEmployee(alpha, { code: 'ALPHA001' });
    betaEmployeeId = await createEmployee(beta, { code: 'BETA001' });
  });

  after(async () => {
    await dropTestTenant(alpha.tenantId);
    await dropTestTenant(beta.tenantId);
    await closePools();
  });

  it('proves the API connection is actually subject to RLS', async () => {
    const probe = await probeRlsEnforcement();
    assert.equal(
      probe.enforced,
      true,
      `RLS is not enforced: ${probe.enforced === false ? probe.reason : ''}`,
    );
  });

  it('shows a tenant only its own employees', async () => {
    const alphaCodes = await alpha.as(async (tx) => {
      const { rows } = await tx.query<{ employee_code: string }>('SELECT employee_code FROM core.employee');
      return rows.map((r) => r.employee_code);
    });
    assert.deepEqual(alphaCodes, ['ALPHA001']);
  });

  it('hides another tenant row even when queried by its exact primary key', async () => {
    const found = await alpha.as(async (tx) => {
      const { rowCount } = await tx.query('SELECT 1 FROM core.employee WHERE id = $1', [betaEmployeeId]);
      return rowCount;
    });
    assert.equal(found, 0, 'tenant alpha could read a row belonging to tenant beta');
  });

  it('returns nothing when a query forgets its tenant predicate entirely', async () => {
    // This is the exact developer mistake RLS exists to survive: a query with no
    // WHERE tenant_id at all still cannot see across the boundary.
    const rows = await beta.as(async (tx) => {
      const result = await tx.query<{ count: string }>('SELECT count(*) AS count FROM core.employee');
      return Number(result.rows[0]!.count);
    });
    assert.equal(rows, 1);
  });

  it('refuses to write a row belonging to another tenant', async () => {
    await assert.rejects(
      alpha.as(async (tx) => {
        await tx.query(
          `INSERT INTO core.department (tenant_id, name) VALUES ($1, 'Smuggled')`,
          [beta.tenantId],
        );
      }),
      /row-level security/i,
      'RLS WITH CHECK did not block a cross-tenant insert',
    );
  });

  it('cannot update another tenant row', async () => {
    const updated = await alpha.as(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE core.employee SET first_name = 'Hijacked' WHERE id = $1`,
        [betaEmployeeId],
      );
      return rowCount;
    });
    assert.equal(updated, 0);

    const stillIntact = await beta.as(async (tx) => {
      const { rows } = await tx.query<{ first_name: string }>(
        'SELECT first_name FROM core.employee WHERE id = $1',
        [betaEmployeeId],
      );
      return rows[0]!.first_name;
    });
    assert.equal(stillIntact, 'Test');
  });

  it('cannot delete another tenant row', async () => {
    const deleted = await alpha.as(async (tx) => {
      const { rowCount } = await tx.query('DELETE FROM core.employee WHERE id = $1', [betaEmployeeId]);
      return rowCount;
    });
    assert.equal(deleted, 0);
  });

  it('fails closed when no tenant context is set', async () => {
    // Simulates a code path that reached the database without going through withTenant.
    const client = await getAppPool().connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ count: string }>('SELECT count(*) AS count FROM core.employee');
      assert.equal(Number(rows[0]!.count), 0, 'rows were visible without tenant context');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('refuses to open a tenant transaction with a non-uuid tenant id', async () => {
    await assert.rejects(
      withTenant("' OR '1'='1", SYSTEM_ACTOR, async (tx) => tx.query('SELECT 1')),
      /Tenant context is not a valid UUID/,
    );
  });

  it('does not leak tenant context between transactions on a pooled connection', async () => {
    // The scenario SET LOCAL exists to prevent: consecutive transactions on the same
    // pooled connection must not inherit the previous tenant's context.
    for (let i = 0; i < 12; i += 1) {
      const tenant = i % 2 === 0 ? alpha : beta;
      const expected = i % 2 === 0 ? 'ALPHA001' : 'BETA001';
      const codes = await tenant.as(async (tx) => {
        const { rows } = await tx.query<{ employee_code: string }>('SELECT employee_code FROM core.employee');
        return rows.map((r) => r.employee_code);
      });
      assert.deepEqual(codes, [expected], `iteration ${i} saw the wrong tenant's data`);
    }
  });

  it('keeps each tenant reading only its own tenant configuration row', async () => {
    const visible = await alpha.as(async (tx) => {
      const { rows } = await tx.query<{ id: string }>('SELECT id FROM identity.tenant');
      return rows.map((r) => r.id);
    });
    assert.deepEqual(visible, [alpha.tenantId]);
  });

  it('isolates the audit trail', async () => {
    const alphaAudit = await alpha.as(async (tx) => {
      const { rows } = await tx.query<{ entity_id: string }>(
        `SELECT entity_id FROM audit.audit_log WHERE entity_type = 'employee'`,
      );
      return rows.map((r) => r.entity_id);
    });
    assert.ok(alphaAudit.includes(alphaEmployeeId));
    assert.ok(!alphaAudit.includes(betaEmployeeId), 'audit trail leaked across tenants');
  });

  it('isolates the event outbox', async () => {
    const alphaEvents = await alpha.as(async (tx) => {
      const { rows } = await tx.query<{ aggregate_id: string }>(
        `SELECT aggregate_id FROM integration.event_outbox WHERE event_type = 'EmployeeCreated'`,
      );
      return rows.map((r) => r.aggregate_id);
    });
    assert.ok(alphaEvents.includes(alphaEmployeeId));
    assert.ok(!alphaEvents.includes(betaEmployeeId), 'outbox leaked across tenants');
  });
});
