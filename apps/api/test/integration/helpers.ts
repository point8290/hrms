import { randomUUID } from 'node:crypto';
import { withPlatform, withTenant, SYSTEM_ACTOR, type TenantTx } from '../../src/infra/db/pool.ts';

/**
 * Integration-test helpers.
 *
 * These talk to a real Postgres because the properties under test — RLS, exclusion
 * constraints, append-only triggers, the finalized-payslip guard — live in the database.
 * Mocking them out would test the mock.
 */

export const hasDatabase = Boolean(process.env.DATABASE_URL);

export const skipWithoutDb = {
  skip: hasDatabase ? false : 'DATABASE_URL is not set (run: docker compose up -d postgres && npm run db:migrate)',
};

export type TestTenant = {
  tenantId: string;
  companyId: string;
  locationId: string;
  holidayListId: string;
  as: <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
};

const actor = { ...SYSTEM_ACTOR, label: 'integration-test' };

/** Creates an isolated tenant with the minimum org scaffolding a test needs. */
export async function createTestTenant(prefix = 'test'): Promise<TestTenant> {
  const slug = `${prefix}-${randomUUID().slice(0, 8)}`;

  const tenantId = await withPlatform('tenant-provisioning', async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO identity.tenant (name, slug, timezone) VALUES ($1, $2, 'Asia/Kolkata') RETURNING id`,
      [`Test ${slug}`, slug],
    );
    return rows[0]!.id;
  });

  const scaffolding = await withTenant(tenantId, actor, async (tx) => {
    const company = await tx.query<{ id: string }>(
      `INSERT INTO core.company (tenant_id, name, legal_name) VALUES ($1, 'Acme', 'Acme Private Limited') RETURNING id`,
      [tenantId],
    );
    const location = await tx.query<{ id: string }>(
      `INSERT INTO core.location (tenant_id, name, timezone, state_code)
       VALUES ($1, 'Bengaluru', 'Asia/Kolkata', 'KA') RETURNING id`,
      [tenantId],
    );
    const holidayList = await tx.query<{ id: string }>(
      `INSERT INTO workforce.holiday_list (tenant_id, name, year, is_default, weekly_offs)
       VALUES ($1, 'India 2026', 2026, true, ARRAY[0]::smallint[]) RETURNING id`,
      [tenantId],
    );
    return {
      companyId: company.rows[0]!.id,
      locationId: location.rows[0]!.id,
      holidayListId: holidayList.rows[0]!.id,
    };
  });

  return {
    tenantId,
    ...scaffolding,
    as: (fn) => withTenant(tenantId, actor, fn),
  };
}

export async function createEmployee(
  tenant: TestTenant,
  overrides: { code?: string; joiningDate?: string; managerId?: string } = {},
): Promise<string> {
  return tenant.as(async (tx) => {
    const { createEmployee: create } = await import('../../src/modules/core-hr/service.ts');
    const result = await create(tx, {
      employeeCode: overrides.code ?? `EMP${randomUUID().slice(0, 6).toUpperCase()}`,
      companyId: tenant.companyId,
      locationId: tenant.locationId,
      firstName: 'Test',
      lastName: 'Employee',
      workEmail: `${randomUUID().slice(0, 8)}@example.com`,
      joiningDate: overrides.joiningDate ?? '2026-01-01',
      employmentStatus: 'active',
      ...(overrides.managerId ? { managerEmployeeId: overrides.managerId } : {}),
    });
    return result.id;
  });
}

export async function createLeaveType(
  tenant: TestTenant,
  overrides: Partial<{
    code: string;
    name: string;
    requiresApproval: boolean;
    includeHolidays: boolean;
    allowNegative: boolean;
    isLop: boolean;
  }> = {},
): Promise<string> {
  return tenant.as(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO leave_mgmt.leave_type
         (tenant_id, name, code, requires_approval, include_holidays, allow_negative_balance, is_lop)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        tenant.tenantId,
        overrides.name ?? 'Earned Leave',
        overrides.code ?? `EL${randomUUID().slice(0, 4).toUpperCase()}`,
        overrides.requiresApproval ?? false,
        overrides.includeHolidays ?? false,
        overrides.allowNegative ?? false,
        overrides.isLop ?? false,
      ],
    );
    return rows[0]!.id;
  });
}

/**
 * Removes the tenant and everything cascading from it.
 *
 * Goes through identity.purge_tenant because audit records, the leave ledger, check-ins
 * and the outbox are append-only: a plain DELETE is refused, by design. Using the real
 * purge path here also keeps that path exercised.
 */
export async function dropTestTenant(tenantId: string): Promise<void> {
  await withPlatform('maintenance', async (tx) => {
    // Serialise purges across the whole suite.
    //
    // `purge_tenant` deletes the tenant row and lets the cascade unwind through seventy-odd
    // tables. Two purges running at once take those tables' locks in whatever order their
    // own data happens to dictate, and Postgres occasionally catches them in a deadlock
    // (40P01) — which surfaced as a teardown hook failing in maybe one run in eight, in a
    // different file each time.
    //
    // The advisory lock is transaction-scoped, so it is released with this transaction even
    // if the purge throws. It is a test-harness fix: production purges one tenant at a time
    // behind an authorisation step, and making them mutually exclusive there is a separate
    // question from making this suite deterministic.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['hrms:test:purge_tenant']);
    await tx.query('SELECT identity.purge_tenant($1, $2)', [tenantId, 'integration test teardown']);
  });
}

export async function countRows(tenant: TestTenant, table: string): Promise<number> {
  return tenant.as(async (tx) => {
    const { rows } = await tx.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
    return Number(rows[0]!.count);
  });
}
