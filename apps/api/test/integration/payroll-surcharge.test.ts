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
 * Surcharge rule resolution and freezing — the part Node owns.
 *
 * The arithmetic lives in the Python suite. What matters here is that the *right* rule
 * reaches the engine and then stops moving:
 *
 *   * bands resolve from the income-tax rule for the run's period, so a tax year with
 *     different bands gets different bands
 *   * a tenant override outranks the platform default and reaches no other tenant
 *   * the whole rule config — bands included — is frozen in the snapshot, so a rule
 *     published tomorrow cannot re-price a run calculated today
 *   * the engine is never given a path to the rule table
 */

async function surchargeFixture(prefix: string, baseAmount = '200000') {
  const tenant = await createTestTenant(prefix);
  const employeeId = await createEmployee(tenant, { code: 'SC0001', joiningDate: '2025-01-01' });

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
       VALUES ($1, $2, $3, 60000000, $4, '2025-01-01')`,
      [tenant.tenantId, employeeId, structure.rows[0]!.id, baseAmount],
    );
    await tx.query(
      `INSERT INTO core.tax_profile
         (tenant_id, employee_id, tax_regime, pf_applicable, esi_applicable, effective_from)
       VALUES ($1, $2, 'old', false, false, '2025-01-01')`,
      [tenant.tenantId, employeeId],
    );
  });

  return { tenant, employeeId };
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

async function frozenIncomeTax(tenant: TestTenant, runId: string) {
  return tenant.as(async (tx) => {
    const { rows } = await tx.query<{ statutory_json: any }>(
      `SELECT statutory_json FROM payroll.payroll_input_snapshot
        WHERE payroll_run_id = $1 ORDER BY snapshot_version DESC LIMIT 1`,
      [runId],
    );
    return rows[0]!.statutory_json.income_tax;
  });
}

async function abandon(tenant: TestTenant, runId: string) {
  await tenant.as((tx) => payroll.markFailed(tx, runId, 'test cleanup'));
  await tenant.as((tx) => payroll.cancel(tx, runId, 'test cleanup'));
}

/** A tenant-scoped income-tax rule, which outranks the platform default. */
async function overrideRule(
  tenant: TestTenant,
  version: number,
  effectiveFrom: string,
  bands: Array<{ threshold: number; rate: number }>,
) {
  await tenant.as((tx) =>
    tx.query(
      `INSERT INTO payroll.statutory_rule
         (tenant_id, country_code, rule_type, version, effective_from, rule_config)
       VALUES ($1, 'IN', 'income_tax', $2, $3::date, $4::jsonb)`,
      [
        tenant.tenantId,
        version,
        effectiveFrom,
        JSON.stringify({
          regimes: {
            old: {
              slabs: [{ upto: 250000, rate: 0 }, { upto: null, rate: 0.3 }],
              standard_deduction: 50000,
              rebate_limit: 500000,
              rebate_max: 12500,
              cess_rate: 0.04,
              surcharge: {
                applicable: true,
                bands: bands.map((b) => ({ ...b, marginal_relief: true })),
              },
            },
          },
        }),
      ],
    ),
  );
}

// ---------------------------------------------------------------------------

describe('surcharge rule resolution', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof surchargeFixture>>;

  before(async () => {
    f = await surchargeFixture('surcharge');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('ships platform surcharge bands for both regimes', async () => {
    const rules = await f.tenant.as((tx) => loadStatutoryRules(tx, '2026-06-30', []));
    const config = (rules.income_tax as any).config;

    for (const regime of ['old', 'new']) {
      const surcharge = config.regimes[regime].surcharge;
      assert.equal(surcharge.applicable, true, regime);
      assert.ok(surcharge.bands.length > 0, regime);
      assert.equal(Number(surcharge.bands[0].threshold), 5000000, regime);
    }
    // The new regime caps at 25%: section 115BAC has no 37% band.
    const oldRates = config.regimes.old.surcharge.bands.map((b: any) => Number(b.rate));
    const newRates = config.regimes.new.surcharge.bands.map((b: any) => Number(b.rate));
    assert.deepEqual(oldRates, [0.1, 0.15, 0.25, 0.37]);
    assert.deepEqual(newRates, [0.1, 0.15, 0.25]);
  });

  it('resolves the pre-surcharge version for an earlier tax year', async () => {
    // Version 1 governs FY 2025-26 and declares no surcharge; version 2 takes over from
    // 2026-04-01. A run in the earlier year must keep resolving the rule it always did.
    const earlier = await f.tenant.as((tx) => loadStatutoryRules(tx, '2025-09-30', []));
    const later = await f.tenant.as((tx) => loadStatutoryRules(tx, '2026-09-30', []));

    assert.equal((earlier.income_tax as any).version, 1);
    assert.equal((earlier.income_tax as any).config.regimes.old.surcharge, undefined);
    assert.equal((later.income_tax as any).version, 2);
    assert.ok((later.income_tax as any).config.regimes.old.surcharge);
  });

  it('carries the rule identity, version and source', async () => {
    const rules = await f.tenant.as((tx) => loadStatutoryRules(tx, '2026-06-30', []));
    const rule = rules.income_tax as any;

    // A version number is only unique within a scope, so the id is what makes a two-year-old
    // payslip traceable to the exact row that produced it.
    assert.match(rule.rule_id, /^[0-9a-f-]{36}$/);
    assert.equal(rule.version, 2);
    assert.equal(rule.source, 'platform');
  });

  it('lets a tenant override the platform bands', async () => {
    await overrideRule(f.tenant, 10, '2026-04-01', [{ threshold: 3000000, rate: 0.05 }]);

    const rules = await f.tenant.as((tx) => loadStatutoryRules(tx, '2026-06-30', []));
    const rule = rules.income_tax as any;

    assert.equal(rule.source, 'tenant');
    assert.equal(rule.version, 10);
    assert.equal(Number(rule.config.regimes.old.surcharge.bands[0].threshold), 3000000);
  });
});

// ---------------------------------------------------------------------------

describe('surcharge rule freezing', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof surchargeFixture>>;

  before(async () => {
    f = await surchargeFixture('surcharge-freeze');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('freezes the bands into the snapshot with the rule identity', async () => {
    const run = await makeRun(f.tenant, 'Jun 2026', '2026-06-01', '2026-06-30');
    const rule = await frozenIncomeTax(f.tenant, run.id);

    assert.equal(rule.version, 2);
    assert.equal(rule.source, 'platform');
    assert.match(rule.rule_id, /^[0-9a-f-]{36}$/);
    const bands = rule.config.regimes.old.surcharge.bands;
    assert.equal(bands.length, 4);
    assert.equal(Number(bands[0].threshold), 5000000);
    await abandon(f.tenant, run.id);
  });

  it('a rule published afterwards does not move a run already calculated', async () => {
    const run = await makeRun(f.tenant, 'Jul 2026', '2026-07-01', '2026-07-31');
    const before = await frozenIncomeTax(f.tenant, run.id);
    assert.equal(Number(before.config.regimes.old.surcharge.bands[0].threshold), 5000000);

    // A tenant override with wildly different bands, published behind the run's back.
    await overrideRule(f.tenant, 20, '2026-04-01', [{ threshold: 1, rate: 0.9 }]);

    const after = await frozenIncomeTax(f.tenant, run.id);
    assert.equal(after.version, 2, 'still the platform version the run froze');
    assert.equal(Number(after.config.regimes.old.surcharge.bands[0].threshold), 5000000);
    await abandon(f.tenant, run.id);

    // A new run sees the override: frozen is not the same as stale.
    const next = await makeRun(f.tenant, 'Aug 2026', '2026-08-01', '2026-08-31');
    const fresh = await frozenIncomeTax(f.tenant, next.id);
    assert.equal(fresh.version, 20);
    assert.equal(fresh.source, 'tenant');
    assert.equal(Number(fresh.config.regimes.old.surcharge.bands[0].threshold), 1);
    await abandon(f.tenant, next.id);
  });

  it('a recalculation rebuilds from the live rule, as it always has', async () => {
    const run = await makeRun(f.tenant, 'Sep 2026', '2026-09-01', '2026-09-30');
    assert.equal((await frozenIncomeTax(f.tenant, run.id)).version, 20);

    await f.tenant.as((tx) => payroll.recalculate(tx, run.id));

    const after = await frozenIncomeTax(f.tenant, run.id);
    // A recalculation appends a new snapshot version and re-resolves; the earlier version
    // remains on record to explain the previous attempt.
    assert.equal(after.version, 20);
    await abandon(f.tenant, run.id);
  });
});

// ---------------------------------------------------------------------------

describe('surcharge rule isolation', skipWithoutDb, () => {
  let a: Awaited<ReturnType<typeof surchargeFixture>>;
  let b: Awaited<ReturnType<typeof surchargeFixture>>;

  before(async () => {
    a = await surchargeFixture('surcharge-iso-a');
    b = await surchargeFixture('surcharge-iso-b');
    await overrideRule(a.tenant, 30, '2026-04-01', [{ threshold: 111, rate: 0.11 }]);
  });

  after(async () => {
    await dropTestTenant(a.tenant.tenantId);
    await dropTestTenant(b.tenant.tenantId);
    await closePools();
  });

  it('one tenant cannot read another surcharge rule', async () => {
    const mine = await b.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM payroll.statutory_rule
          WHERE rule_type = 'income_tax' AND tenant_id IS NOT NULL`,
      );
      return Number(rows[0]!.count);
    });
    // Tenant A's override exists, and tenant B sees no tenant-owned rule at all.
    assert.equal(mine, 0);
  });

  it('a tenant override does not reach another tenant resolution', async () => {
    const rulesB = await b.tenant.as((tx) => loadStatutoryRules(tx, '2026-06-30', []));
    const ruleB = rulesB.income_tax as any;
    assert.equal(ruleB.source, 'platform');
    assert.equal(Number(ruleB.config.regimes.old.surcharge.bands[0].threshold), 5000000);

    const rulesA = await a.tenant.as((tx) => loadStatutoryRules(tx, '2026-06-30', []));
    assert.equal((rulesA.income_tax as any).source, 'tenant');
    assert.equal(Number((rulesA.income_tax as any).config.regimes.old.surcharge.bands[0].threshold), 111);
  });

  it('a tenant override does not reach another tenant snapshot', async () => {
    const run = await makeRun(b.tenant, 'Jun 2026', '2026-06-01', '2026-06-30');
    const rule = await frozenIncomeTax(b.tenant, run.id);
    assert.equal(rule.source, 'platform');
    assert.equal(Number(rule.config.regimes.old.surcharge.bands[0].threshold), 5000000);
    await abandon(b.tenant, run.id);
  });

  it('one tenant cannot plant a rule under another tenant id', async () => {
    await assert.rejects(
      a.tenant.as((tx) =>
        tx.query(
          `INSERT INTO payroll.statutory_rule
             (tenant_id, country_code, rule_type, version, effective_from, rule_config)
           VALUES ($1, 'IN', 'income_tax', 99, '2026-04-01', '{}'::jsonb)`,
          [b.tenant.tenantId],
        ),
      ),
      (err: { code?: string }) => err.code === '42501',
    );
  });

  it('one tenant cannot plant a platform-wide rule', async () => {
    await assert.rejects(
      a.tenant.as((tx) =>
        tx.query(
          `INSERT INTO payroll.statutory_rule
             (tenant_id, country_code, rule_type, version, effective_from, rule_config)
           VALUES (NULL, 'IN', 'income_tax', 98, '2026-04-01', '{}'::jsonb)`,
        ),
      ),
      (err: { code?: string }) => err.code === '42501',
    );
  });
});
