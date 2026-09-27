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
 * Provident fund rule resolution and freezing — the part Node owns.
 *
 * The contribution arithmetic is in the Python suite. What is proved here is the PRD's two
 * cross-cutting statutory requirements, neither of which had coverage for PF:
 *
 *   * rules are "effective-dated and versioned rather than scattered as hard-coded logic" —
 *     so the rates, the ceiling and the wage basis all come from a resolvable rule row, and
 *     the row's identity travels with the run
 *   * "rule changes without changing historical payroll results" — so a rule published after
 *     a run was snapshotted cannot re-price it
 *
 * and that a tenant's override of either reaches no other tenant.
 */

async function pfFixture(prefix: string, baseAmount = '40000') {
  const tenant = await createTestTenant(prefix);
  const employeeId = await createEmployee(tenant, { code: 'PF0001', joiningDate: '2025-01-01' });

  await tenant.as(async (tx) => {
    const basic = await tx.query<{ id: string }>(
      `INSERT INTO compensation.salary_component
         (tenant_id, code, name, component_type, calculation_type, taxable, semantic_role)
       VALUES ($1, 'BASIC', 'Basic', 'earning', 'percentage', true, 'basic') RETURNING id`,
      [tenant.tenantId],
    );
    const special = await tx.query<{ id: string }>(
      `INSERT INTO compensation.salary_component
         (tenant_id, code, name, component_type, calculation_type, taxable)
       VALUES ($1, 'SPECIAL', 'Special Allowance', 'earning', 'percentage', true) RETURNING id`,
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
       VALUES ($1, $2, $3, 1, 50, 'BASE'), ($1, $2, $4, 2, 50, 'BASE')`,
      [tenant.tenantId, structure.rows[0]!.id, basic.rows[0]!.id, special.rows[0]!.id],
    );
    await tx.query(
      `INSERT INTO compensation.salary_assignment
         (tenant_id, employee_id, salary_structure_id, annual_ctc, base_amount, effective_from)
       VALUES ($1, $2, $3, 480000, $4, '2025-01-01')`,
      [tenant.tenantId, employeeId, structure.rows[0]!.id, baseAmount],
    );
    await tx.query(
      `INSERT INTO core.tax_profile
         (tenant_id, employee_id, tax_regime, pf_applicable, esi_applicable, effective_from)
       VALUES ($1, $2, 'new', true, false, '2025-01-01')`,
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

async function frozenPf(tenant: TestTenant, runId: string) {
  return tenant.as(async (tx) => {
    const { rows } = await tx.query<{ statutory_json: any; tax_json: any }>(
      `SELECT statutory_json, tax_json FROM payroll.payroll_input_snapshot
        WHERE payroll_run_id = $1 ORDER BY snapshot_version DESC LIMIT 1`,
      [runId],
    );
    return { rule: rows[0]!.statutory_json.pf, tax: rows[0]!.tax_json };
  });
}

async function abandon(tenant: TestTenant, runId: string) {
  await tenant.as((tx) => payroll.markFailed(tx, runId, 'test cleanup'));
  await tenant.as((tx) => payroll.cancel(tx, runId, 'test cleanup'));
}

/** A tenant-scoped PF rule, which outranks the platform default. */
async function overridePf(
  tenant: TestTenant,
  version: number,
  effectiveFrom: string,
  config: Record<string, unknown>,
) {
  await tenant.as((tx) =>
    tx.query(
      `INSERT INTO payroll.statutory_rule
         (tenant_id, country_code, rule_type, version, effective_from, rule_config)
       VALUES ($1, 'IN', 'pf', $2, $3::date, $4::jsonb)`,
      [tenant.tenantId, version, effectiveFrom, JSON.stringify(config)],
    ),
  );
}

const PLATFORM_PF = {
  employee_rate: 0.12,
  employer_rate: 0.12,
  employer_pension_rate: 0.0833,
  wage_ceiling: 15000,
  apply_ceiling: true,
  basis_component_codes: ['BASIC', 'DA'],
};

// ---------------------------------------------------------------------------

describe('PF rule resolution', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof pfFixture>>;

  before(async () => {
    f = await pfFixture('pf-rules');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('ships a platform rule carrying every statutory figure', async () => {
    const rules = await f.tenant.as((tx) => loadStatutoryRules(tx, '2026-06-30', []));
    const config = (rules.pf as any).config;

    // Every figure the engine needs is data, not a literal in Python. If any of these were
    // absent the engine would now refuse rather than assume — which is the point.
    for (const key of ['employee_rate', 'employer_rate', 'employer_pension_rate',
                       'wage_ceiling', 'apply_ceiling', 'basis_component_codes']) {
      assert.ok(key in config, `the platform PF rule must configure ${key}`);
    }
    assert.deepEqual(config.basis_component_codes, ['BASIC', 'DA']);
    assert.equal(Number(config.wage_ceiling), 15000);
  });

  it('carries the rule identity, version and source', async () => {
    const rule = (await f.tenant.as((tx) => loadStatutoryRules(tx, '2026-06-30', []))).pf as any;
    assert.match(rule.rule_id, /^[0-9a-f-]{36}$/);
    assert.equal(rule.version, 1);
    assert.equal(rule.source, 'platform');
  });

  it('lets a tenant override the platform rule', async () => {
    await overridePf(f.tenant, 10, '2026-04-01', { ...PLATFORM_PF, employee_rate: 0.10 });

    const rule = (await f.tenant.as((tx) => loadStatutoryRules(tx, '2026-06-30', []))).pf as any;
    assert.equal(rule.source, 'tenant');
    assert.equal(rule.version, 10);
    assert.equal(Number(rule.config.employee_rate), 0.1);
  });

  it('resolves by effective date, so an earlier period keeps the earlier rule', async () => {
    // The override starts on 2026-04-01; a period before it still resolves the platform rule.
    const earlier = await f.tenant.as((tx) => loadStatutoryRules(tx, '2026-03-31', []));
    const later = await f.tenant.as((tx) => loadStatutoryRules(tx, '2026-06-30', []));

    assert.equal((earlier.pf as any).source, 'platform');
    assert.equal(Number((earlier.pf as any).config.employee_rate), 0.12);
    assert.equal((later.pf as any).source, 'tenant');
  });
});

// ---------------------------------------------------------------------------

describe('PF rule freezing', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof pfFixture>>;

  before(async () => {
    f = await pfFixture('pf-freeze');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('freezes the whole PF configuration into the snapshot', async () => {
    const run = await makeRun(f.tenant, 'Jun 2026', '2026-06-01', '2026-06-30');
    const { rule, tax } = await frozenPf(f.tenant, run.id);

    assert.equal(rule.version, 1);
    assert.equal(rule.source, 'platform');
    assert.match(rule.rule_id, /^[0-9a-f-]{36}$/);
    assert.equal(Number(rule.config.employee_rate), 0.12);
    assert.deepEqual(rule.config.basis_component_codes, ['BASIC', 'DA']);
    // Applicability is an employee fact and travels on the tax side, as it always has.
    assert.equal(tax.pf_applicable, true);
    await abandon(f.tenant, run.id);
  });

  it('a rule published afterwards does not re-price a run already snapshotted', async () => {
    // The PRD requirement this exists for: "rule changes without changing historical
    // payroll results".
    const run = await makeRun(f.tenant, 'Jul 2026', '2026-07-01', '2026-07-31');
    assert.equal(Number((await frozenPf(f.tenant, run.id)).rule.config.employee_rate), 0.12);

    await overridePf(f.tenant, 20, '2026-04-01', { ...PLATFORM_PF, employee_rate: 0.05 });

    const after = await frozenPf(f.tenant, run.id);
    assert.equal(after.rule.version, 1, 'still the version the run froze');
    assert.equal(Number(after.rule.config.employee_rate), 0.12);
    await abandon(f.tenant, run.id);

    // A new run sees the override: frozen is not the same as stale.
    const next = await makeRun(f.tenant, 'Aug 2026', '2026-08-01', '2026-08-31');
    const fresh = await frozenPf(f.tenant, next.id);
    assert.equal(fresh.rule.version, 20);
    assert.equal(fresh.rule.source, 'tenant');
    assert.equal(Number(fresh.rule.config.employee_rate), 0.05);
    await abandon(f.tenant, next.id);
  });

  it('freezes the compensation that applied to the period, not today', async () => {
    const run = await makeRun(f.tenant, 'Sep 2026', '2026-09-01', '2026-09-30');
    const before = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ compensation_json: any }>(
        `SELECT compensation_json FROM payroll.payroll_input_snapshot
          WHERE payroll_run_id = $1 ORDER BY snapshot_version DESC LIMIT 1`,
        [run.id],
      );
      return rows[0]!.compensation_json.base_amount;
    });
    assert.equal(before, '40000.00');

    // Raise the salary behind the run's back. The PF wage is derived from the frozen
    // components, so the snapshotted run is unaffected.
    await f.tenant.as((tx) =>
      tx.query(
        `UPDATE compensation.salary_assignment SET base_amount = 90000
          WHERE tenant_id = $1 AND employee_id = $2`,
        [f.tenant.tenantId, f.employeeId],
      ),
    );

    const stillFrozen = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ compensation_json: any }>(
        `SELECT compensation_json FROM payroll.payroll_input_snapshot
          WHERE payroll_run_id = $1 ORDER BY snapshot_version DESC LIMIT 1`,
        [run.id],
      );
      return rows[0]!.compensation_json.base_amount;
    });
    assert.equal(stillFrozen, '40000.00');
    await abandon(f.tenant, run.id);
  });

  it('records PF applicability per employee as at the period', async () => {
    // pf_applicable lives on the effective-dated tax profile, so switching it off from
    // November leaves October alone.
    await f.tenant.as((tx) =>
      tx.query(
        `UPDATE core.tax_profile SET effective_to = '2026-10-31'
          WHERE tenant_id = $1 AND employee_id = $2`,
        [f.tenant.tenantId, f.employeeId],
      ),
    );
    await f.tenant.as((tx) =>
      tx.query(
        `INSERT INTO core.tax_profile
           (tenant_id, employee_id, tax_regime, pf_applicable, esi_applicable, effective_from)
         VALUES ($1, $2, 'new', false, false, '2026-11-01')`,
        [f.tenant.tenantId, f.employeeId],
      ),
    );

    const october = await makeRun(f.tenant, 'Oct 2026', '2026-10-01', '2026-10-31');
    assert.equal((await frozenPf(f.tenant, october.id)).tax.pf_applicable, true);
    await abandon(f.tenant, october.id);

    const november = await makeRun(f.tenant, 'Nov 2026', '2026-11-01', '2026-11-30');
    assert.equal((await frozenPf(f.tenant, november.id)).tax.pf_applicable, false);
    await abandon(f.tenant, november.id);
  });
});

// ---------------------------------------------------------------------------

describe('PF rule isolation', skipWithoutDb, () => {
  let a: Awaited<ReturnType<typeof pfFixture>>;
  let b: Awaited<ReturnType<typeof pfFixture>>;

  before(async () => {
    a = await pfFixture('pf-iso-a');
    b = await pfFixture('pf-iso-b');
    await overridePf(a.tenant, 30, '2026-04-01', { ...PLATFORM_PF, employee_rate: 0.01 });
  });

  after(async () => {
    await dropTestTenant(a.tenant.tenantId);
    await dropTestTenant(b.tenant.tenantId);
    await closePools();
  });

  it('one tenant cannot read another PF override', async () => {
    const visible = await b.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM payroll.statutory_rule
          WHERE rule_type = 'pf' AND tenant_id IS NOT NULL`,
      );
      return Number(rows[0]!.count);
    });
    assert.equal(visible, 0);
  });

  it('one tenant override does not change another tenant resolution', async () => {
    const rulesB = await b.tenant.as((tx) => loadStatutoryRules(tx, '2026-06-30', []));
    assert.equal((rulesB.pf as any).source, 'platform');
    assert.equal(Number((rulesB.pf as any).config.employee_rate), 0.12);

    const rulesA = await a.tenant.as((tx) => loadStatutoryRules(tx, '2026-06-30', []));
    assert.equal((rulesA.pf as any).source, 'tenant');
    assert.equal(Number((rulesA.pf as any).config.employee_rate), 0.01);
  });

  it('one tenant override does not reach another tenant snapshot', async () => {
    const run = await makeRun(b.tenant, 'Jun 2026', '2026-06-01', '2026-06-30');
    assert.equal((await frozenPf(b.tenant, run.id)).rule.source, 'platform');
    await abandon(b.tenant, run.id);
  });

  it('one tenant cannot plant a PF rule under another tenant id', async () => {
    await assert.rejects(
      a.tenant.as((tx) =>
        tx.query(
          `INSERT INTO payroll.statutory_rule
             (tenant_id, country_code, rule_type, version, effective_from, rule_config)
           VALUES ($1, 'IN', 'pf', 81, '2026-04-01', '{}'::jsonb)`,
          [b.tenant.tenantId],
        ),
      ),
      (err: { code?: string }) => err.code === '42501',
    );
  });

  it('one tenant cannot plant a platform-wide PF rule', async () => {
    await assert.rejects(
      a.tenant.as((tx) =>
        tx.query(
          `INSERT INTO payroll.statutory_rule
             (tenant_id, country_code, rule_type, version, effective_from, rule_config)
           VALUES (NULL, 'IN', 'pf', 82, '2026-04-01', '{}'::jsonb)`,
        ),
      ),
      (err: { code?: string }) => err.code === '42501',
    );
  });
});
