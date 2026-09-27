import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/infra/db/pool.ts';
import * as payroll from '../../src/modules/payroll/service.ts';
import { loadStatutoryRules } from '../../src/modules/payroll/snapshot.ts';
import {
  createEmployee,
  createTestTenant,
  dropTestTenant,
  skipWithoutDb,
  type TestTenant,
} from './helpers.ts';

/**
 * Professional tax jurisdiction — the part Node owns.
 *
 * The slab arithmetic is in the Python suite. What is proved here is that the *right state*
 * reaches the engine and then stops moving:
 *
 *   * an explicit `tax_profile.pt_state_code` outranks the work location's state, and the
 *     snapshot records which of the two was used
 *   * both resolve **as at the payroll period's end**, so an employee who transfers keeps
 *     their old jurisdiction on old periods — including when one is recalculated
 *   * a state with no configured rule is recorded as unsupported, never as a silent zero
 *   * one tenant's PT rules and overrides reach no other tenant
 */

async function ptFixture(prefix: string, options: { locationState?: string | null } = {}) {
  const tenant = await createTestTenant(prefix);

  await tenant.as((tx) =>
    tx.query('UPDATE core.location SET state_code = $2 WHERE tenant_id = $1', [
      tenant.tenantId,
      options.locationState === undefined ? 'KA' : options.locationState,
    ]),
  );

  const employeeId = await createEmployee(tenant, { code: 'PT0001', joiningDate: '2025-01-01' });

  await tenant.as(async (tx) => {
    const basic = await tx.query<{ id: string }>(
      `INSERT INTO compensation.salary_component
         (tenant_id, code, name, component_type, calculation_type, taxable, semantic_role)
       VALUES ($1, 'BASIC', 'Basic', 'earning', 'percentage', true, 'basic') RETURNING id`,
      [tenant.tenantId],
    );
    const structure = await tx.query<{ id: string }>(
      `INSERT INTO compensation.salary_structure (tenant_id, name, version, effective_from)
       VALUES ($1, 'Standard', 1, '2025-01-01') RETURNING id`,
      [tenant.tenantId],
    );
    await tx.query(
      `INSERT INTO compensation.salary_structure_component
         (tenant_id, salary_structure_id, salary_component_id, sequence_no, percentage, percentage_of_code)
       VALUES ($1, $2, $3, 1, 100, 'BASE')`,
      [tenant.tenantId, structure.rows[0]!.id, basic.rows[0]!.id],
    );
    await tx.query(
      `INSERT INTO compensation.salary_assignment
         (tenant_id, employee_id, salary_structure_id, annual_ctc, base_amount, effective_from)
       VALUES ($1, $2, $3, 600000, 50000, '2025-01-01')`,
      [tenant.tenantId, employeeId, structure.rows[0]!.id],
    );
  });

  return { tenant, employeeId };
}

/** An effective-dated PT-state assertion on the tax profile. */
async function assertState(
  tenant: TestTenant,
  employeeId: string,
  state: string | null,
  from: string,
  to?: string,
) {
  await tenant.as((tx) =>
    tx.query(
      `INSERT INTO core.tax_profile
         (tenant_id, employee_id, tax_regime, pf_applicable, esi_applicable,
          pt_state_code, effective_from, effective_to)
       VALUES ($1, $2, 'old', false, false, $3, $4::date, $5::date)`,
      [tenant.tenantId, employeeId, state, from, to ?? null],
    ),
  );
}

async function closeAttendance(tenant: TestTenant, from: string, to: string) {
  await tenant.as((tx) =>
    tx.query(
      `INSERT INTO integration.scheduled_job
         (tenant_id, job_type, execution_date, status, completed_at, payload)
       SELECT $1, 'attendance.close', d::date, 'completed', now(), '{"timezone":"Asia/Kolkata"}'::jsonb
         FROM generate_series($2::date, $3::date, INTERVAL '1 day') AS d
       ON CONFLICT (tenant_id, job_type, execution_date, job_key) DO NOTHING`,
      [tenant.tenantId, from, to],
    ),
  );
}

async function makeRun(tenant: TestTenant, name: string, start: string, end: string) {
  await closeAttendance(tenant, start, end);
  const period = await tenant.as((tx) =>
    payroll.createPeriod(tx, {
      companyId: tenant.companyId,
      name,
      periodStart: start,
      periodEnd: end,
      payDate: end,
    }),
  );
  return tenant.as((tx) => payroll.createRun(tx, { payrollPeriodId: period.id }));
}

async function ptContext(tenant: TestTenant, runId: string) {
  return tenant.as(async (tx) => {
    const { rows } = await tx.query<{ tax_json: any; statutory_json: any }>(
      `SELECT tax_json, statutory_json FROM payroll.payroll_input_snapshot
        WHERE payroll_run_id = $1 ORDER BY snapshot_version DESC LIMIT 1`,
      [runId],
    );
    return { pt: rows[0]!.tax_json.professional_tax, statutory: rows[0]!.statutory_json };
  });
}

async function abandon(tenant: TestTenant, runId: string) {
  await tenant.as((tx) => payroll.markFailed(tx, runId, 'test cleanup'));
  await tenant.as((tx) => payroll.cancel(tx, runId, 'test cleanup'));
}

/** A tenant-scoped PT rule, which outranks the platform default for that state. */
async function overridePt(
  tenant: TestTenant,
  state: string,
  version: number,
  effectiveFrom: string,
  amount: number,
) {
  await tenant.as((tx) =>
    tx.query(
      `INSERT INTO payroll.statutory_rule
         (tenant_id, country_code, state_code, rule_type, version, effective_from, rule_config)
       VALUES ($1, 'IN', $2, 'professional_tax', $3, $4::date, $5::jsonb)`,
      [
        tenant.tenantId, state, version, effectiveFrom,
        JSON.stringify({
          applicable: true,
          state_name: `${state} override`,
          wage_basis: 'gross_earnings',
          frequency: 'monthly',
          slabs: [{ upto: null, amount, label: 'all earnings' }],
        }),
      ],
    ),
  );
}

// ---------------------------------------------------------------------------

describe('PT jurisdiction resolution', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof ptFixture>>;

  before(async () => {
    f = await ptFixture('pt-jurisdiction');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('falls back to the work location state when nothing is asserted', async () => {
    const run = await makeRun(f.tenant, 'Jun 2026', '2026-06-01', '2026-06-30');
    const { pt } = await ptContext(f.tenant, run.id);

    assert.equal(pt.state_code, 'KA');
    assert.equal(pt.state_source, 'work_location');
    assert.equal(pt.rule_resolved, true);
    // A location is a location fact, not a tax assertion (ADR-014), so PT is not mandatory.
    assert.equal(pt.required, false);
    await abandon(f.tenant, run.id);
  });

  it('an explicit tax-profile state outranks the work location', async () => {
    await assertState(f.tenant, f.employeeId, 'MH', '2025-01-01');

    const run = await makeRun(f.tenant, 'Jul 2026', '2026-07-01', '2026-07-31');
    const { pt } = await ptContext(f.tenant, run.id);

    assert.equal(pt.state_code, 'MH', 'the assertion wins over the KA location');
    assert.equal(pt.state_source, 'tax_profile');
    // An explicit assertion is an assertion of liability, so PT becomes mandatory.
    assert.equal(pt.required, true);
    await abandon(f.tenant, run.id);
  });

  it('freezes the rule identity, version and effective date', async () => {
    const run = await makeRun(f.tenant, 'Aug 2026', '2026-08-01', '2026-08-31');
    const { pt, statutory } = await ptContext(f.tenant, run.id);

    assert.equal(pt.rule_key, 'professional_tax:MH');
    assert.equal(pt.rule_effective_from, '2026-04-01');

    const rule = statutory['professional_tax:MH'];
    assert.match(rule.rule_id, /^[0-9a-f-]{36}$/);
    assert.equal(rule.version, 2);
    assert.equal(rule.source, 'platform');
    // The whole schedule travels with it, special month and ceiling included.
    assert.equal(rule.config.annual_cap, 2500);
    assert.equal(rule.config.slabs[2].special_months['2'], 300);
    await abandon(f.tenant, run.id);
  });

  it('records the period month, so a special instalment needs no month in Python', async () => {
    const run = await makeRun(f.tenant, 'Feb 2027', '2027-02-01', '2027-02-28');
    const { pt } = await ptContext(f.tenant, run.id);
    assert.equal(pt.period_month, 2);
    await abandon(f.tenant, run.id);
  });
});

// ---------------------------------------------------------------------------

describe('PT unsupported and missing jurisdictions', skipWithoutDb, () => {
  it('records an unsupported state rather than silently deducting nothing', async () => {
    const f = await ptFixture('pt-unsupported', { locationState: 'TN' });
    try {
      const run = await makeRun(f.tenant, 'Jun 2026', '2026-06-01', '2026-06-30');
      const { pt } = await ptContext(f.tenant, run.id);

      assert.equal(pt.state_code, 'TN');
      assert.equal(pt.rule_resolved, false);
      assert.equal(pt.required, false);
      assert.match(pt.reason, /not supported by this deployment/);
      await abandon(f.tenant, run.id);
    } finally {
      await dropTestTenant(f.tenant.tenantId);
    }
  });

  it('records an employee with no state at all', async () => {
    const f = await ptFixture('pt-nostate', { locationState: null });
    try {
      const run = await makeRun(f.tenant, 'Jun 2026', '2026-06-01', '2026-06-30');
      const { pt } = await ptContext(f.tenant, run.id);

      assert.equal(pt.state_code, null);
      assert.equal(pt.state_source, 'none');
      assert.match(pt.reason, /no professional tax state/);
      await abandon(f.tenant, run.id);
    } finally {
      await dropTestTenant(f.tenant.tenantId);
    }
  });

  it('marks it required when the tenant opts every employee in', async () => {
    const f = await ptFixture('pt-required', { locationState: 'TN' });
    try {
      await f.tenant.as((tx) =>
        tx.query(
          `INSERT INTO payroll.tenant_payroll_policy (tenant_id, require_professional_tax)
           VALUES ($1, true)
           ON CONFLICT (tenant_id) DO UPDATE SET require_professional_tax = true`,
          [f.tenant.tenantId],
        ),
      );

      const run = await makeRun(f.tenant, 'Jun 2026', '2026-06-01', '2026-06-30');
      const { pt } = await ptContext(f.tenant, run.id);

      // Carried to the engine, which fails this one employee rather than the run.
      assert.equal(pt.required, true);
      assert.equal(pt.rule_resolved, false);
      await abandon(f.tenant, run.id);
    } finally {
      await dropTestTenant(f.tenant.tenantId);
    }
  });

  it('does not require it for a tenant that has not opted in', async () => {
    const f = await ptFixture('pt-optional', { locationState: 'TN' });
    try {
      const run = await makeRun(f.tenant, 'Jun 2026', '2026-06-01', '2026-06-30');
      assert.equal((await ptContext(f.tenant, run.id)).pt.required, false);
      await abandon(f.tenant, run.id);
    } finally {
      await dropTestTenant(f.tenant.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------

describe('PT historical jurisdiction and state transfer', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof ptFixture>>;

  before(async () => {
    f = await ptFixture('pt-transfer');
    // Karnataka until the end of September, Maharashtra from October. The tax profile is
    // effective-dated, so the transfer is a new row rather than an overwrite.
    await assertState(f.tenant, f.employeeId, 'KA', '2025-01-01', '2026-09-30');
    await assertState(f.tenant, f.employeeId, 'MH', '2026-10-01');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('a period before the transfer resolves the old state', async () => {
    const run = await makeRun(f.tenant, 'Sep 2026', '2026-09-01', '2026-09-30');
    const { pt } = await ptContext(f.tenant, run.id);
    assert.equal(pt.state_code, 'KA');
    assert.equal(pt.rule_key, 'professional_tax:KA');
    await abandon(f.tenant, run.id);
  });

  it('a period after the transfer resolves the new state', async () => {
    const run = await makeRun(f.tenant, 'Nov 2026', '2026-11-01', '2026-11-30');
    const { pt } = await ptContext(f.tenant, run.id);
    assert.equal(pt.state_code, 'MH');
    assert.equal(pt.rule_key, 'professional_tax:MH');
    await abandon(f.tenant, run.id);
  });

  it('recalculating a pre-transfer period still uses the pre-transfer state', async () => {
    // The case that would break if resolution used today's location: an August run
    // recalculated after the October transfer must still be Karnataka.
    const run = await makeRun(f.tenant, 'Aug 2026', '2026-08-01', '2026-08-31');
    assert.equal((await ptContext(f.tenant, run.id)).pt.state_code, 'KA');

    await f.tenant.as((tx) => payroll.recalculate(tx, run.id));

    const after = await ptContext(f.tenant, run.id);
    assert.equal(after.pt.state_code, 'KA', 'history is not re-jurisdicted by a later move');
    assert.equal(after.pt.rule_key, 'professional_tax:KA');
    await abandon(f.tenant, run.id);
  });

  it('the transfer does not overwrite the historical assertion', async () => {
    const rows = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ pt_state_code: string; effective_from: string }>(
        `SELECT pt_state_code, to_char(effective_from, 'YYYY-MM-DD') AS effective_from
           FROM core.tax_profile WHERE tenant_id = $1 AND employee_id = $2
          ORDER BY effective_from`,
        [f.tenant.tenantId, f.employeeId],
      );
      return rows;
    });
    // Both rows survive. A transfer is a new effective-dated assertion, not an edit.
    assert.deepEqual(rows.map((r) => r.pt_state_code), ['KA', 'MH']);
  });
});

// ---------------------------------------------------------------------------

describe('PT rule freezing and overrides', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof ptFixture>>;

  before(async () => {
    f = await ptFixture('pt-freeze');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('resolves the pre-2026 version for an earlier tax year', async () => {
    const earlier = await f.tenant.as((tx) => loadStatutoryRules(tx, '2025-09-30', ['KA']));
    const later = await f.tenant.as((tx) => loadStatutoryRules(tx, '2026-09-30', ['KA']));

    assert.equal((earlier['professional_tax:KA'] as any).version, 1);
    assert.equal((later['professional_tax:KA'] as any).version, 2);
    // Version 2 is the first to carry the explicit structure.
    assert.equal((later['professional_tax:KA'] as any).config.wage_basis, 'gross_earnings');
  });

  it('a rule published afterwards does not move a run already snapshotted', async () => {
    const run = await makeRun(f.tenant, 'Jun 2026', '2026-06-01', '2026-06-30');
    const before = await ptContext(f.tenant, run.id);
    assert.equal(before.statutory['professional_tax:KA'].config.slabs[1].amount, 200);

    await overridePt(f.tenant, 'KA', 50, '2026-04-01', 999);

    const after = await ptContext(f.tenant, run.id);
    assert.equal(after.statutory['professional_tax:KA'].version, 2, 'still the frozen version');
    assert.equal(after.statutory['professional_tax:KA'].config.slabs[1].amount, 200);
    await abandon(f.tenant, run.id);

    // A new run sees the override: frozen is not the same as stale.
    const next = await makeRun(f.tenant, 'Jul 2026', '2026-07-01', '2026-07-31');
    const fresh = await ptContext(f.tenant, next.id);
    assert.equal(fresh.statutory['professional_tax:KA'].version, 50);
    assert.equal(fresh.statutory['professional_tax:KA'].source, 'tenant');
    assert.equal(fresh.statutory['professional_tax:KA'].config.slabs[0].amount, 999);
    await abandon(f.tenant, next.id);
  });
});

// ---------------------------------------------------------------------------

describe('PT tenant isolation', skipWithoutDb, () => {
  let a: Awaited<ReturnType<typeof ptFixture>>;
  let b: Awaited<ReturnType<typeof ptFixture>>;

  before(async () => {
    a = await ptFixture('pt-iso-a');
    b = await ptFixture('pt-iso-b');
    await overridePt(a.tenant, 'KA', 60, '2026-04-01', 777);
  });

  after(async () => {
    await dropTestTenant(a.tenant.tenantId);
    await dropTestTenant(b.tenant.tenantId);
    await closePools();
  });

  it('one tenant cannot read another PT override', async () => {
    const visible = await b.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM payroll.statutory_rule
          WHERE rule_type = 'professional_tax' AND tenant_id IS NOT NULL`,
      );
      return Number(rows[0]!.count);
    });
    assert.equal(visible, 0);
  });

  it('one tenant override does not change another tenant resolution', async () => {
    const rulesB = await b.tenant.as((tx) => loadStatutoryRules(tx, '2026-06-30', ['KA']));
    assert.equal((rulesB['professional_tax:KA'] as any).source, 'platform');
    assert.equal((rulesB['professional_tax:KA'] as any).config.slabs[1].amount, 200);

    const rulesA = await a.tenant.as((tx) => loadStatutoryRules(tx, '2026-06-30', ['KA']));
    assert.equal((rulesA['professional_tax:KA'] as any).source, 'tenant');
    assert.equal((rulesA['professional_tax:KA'] as any).config.slabs[0].amount, 777);
  });

  it('one tenant override does not reach another tenant snapshot', async () => {
    const run = await makeRun(b.tenant, 'Jun 2026', '2026-06-01', '2026-06-30');
    const { statutory } = await ptContext(b.tenant, run.id);
    assert.equal(statutory['professional_tax:KA'].source, 'platform');
    await abandon(b.tenant, run.id);
  });

  it('one tenant cannot plant a PT rule under another tenant id', async () => {
    await assert.rejects(
      a.tenant.as((tx) =>
        tx.query(
          `INSERT INTO payroll.statutory_rule
             (tenant_id, country_code, state_code, rule_type, version, effective_from, rule_config)
           VALUES ($1, 'IN', 'KA', 'professional_tax', 91, '2026-04-01', '{}'::jsonb)`,
          [b.tenant.tenantId],
        ),
      ),
      (err: { code?: string }) => err.code === '42501',
    );
  });

  it('one tenant cannot plant a platform-wide PT rule', async () => {
    await assert.rejects(
      a.tenant.as((tx) =>
        tx.query(
          `INSERT INTO payroll.statutory_rule
             (tenant_id, country_code, state_code, rule_type, version, effective_from, rule_config)
           VALUES (NULL, 'IN', 'KA', 'professional_tax', 92, '2026-04-01', '{}'::jsonb)`,
        ),
      ),
      (err: { code?: string }) => err.code === '42501',
    );
  });
});
