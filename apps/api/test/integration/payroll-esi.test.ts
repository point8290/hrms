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
 * ESI rule resolution and freezing — the part Node owns.
 *
 * The contribution arithmetic and the eligibility test are in the Python suite. What is
 * proved here is the PRD's two cross-cutting statutory requirements, neither of which had
 * ESI coverage:
 *
 *   * rules are "effective-dated and versioned rather than scattered as hard-coded logic" —
 *     so both rates and the ceiling come from a resolvable rule whose identity travels with
 *     the run
 *   * "rule changes without changing historical payroll results" — so a rule published after
 *     a run was snapshotted cannot re-price it, and cannot retrospectively move an employee
 *     in or out of the scheme
 *
 * ESI has no jurisdiction dimension: the rule is national (`state_code` is null), so unlike
 * professional tax there is nothing here about where the employee works.
 */

const PLATFORM_ESI = {
  employee_rate: 0.0075,
  employer_rate: 0.0325,
  gross_wage_ceiling: 21000,
};

async function esiFixture(prefix: string, baseAmount = '20000') {
  const tenant = await createTestTenant(prefix);
  const employeeId = await createEmployee(tenant, { code: 'ESI001', joiningDate: '2025-01-01' });

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
       VALUES ($1, $2, $3, 240000, $4, '2025-01-01')`,
      [tenant.tenantId, employeeId, structure.rows[0]!.id, baseAmount],
    );
    await tx.query(
      `INSERT INTO core.tax_profile
         (tenant_id, employee_id, tax_regime, pf_applicable, esi_applicable, effective_from)
       VALUES ($1, $2, 'new', false, true, '2025-01-01')`,
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

async function frozenEsi(tenant: TestTenant, runId: string) {
  return tenant.as(async (tx) => {
    const { rows } = await tx.query<{ statutory_json: any; tax_json: any }>(
      `SELECT statutory_json, tax_json FROM payroll.payroll_input_snapshot
        WHERE payroll_run_id = $1 ORDER BY snapshot_version DESC LIMIT 1`,
      [runId],
    );
    return { rule: rows[0]!.statutory_json.esi, tax: rows[0]!.tax_json,
             required: rows[0]!.statutory_json.required };
  });
}

async function abandon(tenant: TestTenant, runId: string) {
  await tenant.as((tx) => payroll.markFailed(tx, runId, 'test cleanup'));
  await tenant.as((tx) => payroll.cancel(tx, runId, 'test cleanup'));
}

async function overrideEsi(
  tenant: TestTenant,
  version: number,
  effectiveFrom: string,
  config: Record<string, unknown>,
) {
  await tenant.as((tx) =>
    tx.query(
      `INSERT INTO payroll.statutory_rule
         (tenant_id, country_code, rule_type, version, effective_from, rule_config)
       VALUES ($1, 'IN', 'esi', $2, $3::date, $4::jsonb)`,
      [tenant.tenantId, version, effectiveFrom, JSON.stringify(config)],
    ),
  );
}

// ---------------------------------------------------------------------------

describe('ESI rule resolution', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof esiFixture>>;

  before(async () => {
    f = await esiFixture('esi-rules');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('ships a platform rule carrying every statutory figure', async () => {
    const rule = (await f.tenant.as((tx) => loadStatutoryRules(tx, '2026-06-30', []))).esi as any;

    // All three are data. If any were absent the engine now refuses rather than assuming,
    // and the ceiling is the one that decides coverage at all.
    for (const key of ['employee_rate', 'employer_rate', 'gross_wage_ceiling']) {
      assert.ok(key in rule.config, `the platform ESI rule must configure ${key}`);
    }
    assert.equal(Number(rule.config.gross_wage_ceiling), 21000);
    assert.equal(Number(rule.config.employee_rate), 0.0075);
    assert.equal(Number(rule.config.employer_rate), 0.0325);
  });

  it('is a national rule with no jurisdiction dimension', async () => {
    // Unlike professional tax, ESI is not state-scoped in the supported model.
    const stateScoped = await f.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM payroll.statutory_rule
          WHERE rule_type = 'esi' AND state_code IS NOT NULL`,
      );
      return Number(rows[0]!.count);
    });
    assert.equal(stateScoped, 0);
  });

  it('carries the rule identity, version and source', async () => {
    const rule = (await f.tenant.as((tx) => loadStatutoryRules(tx, '2026-06-30', []))).esi as any;
    assert.match(rule.rule_id, /^[0-9a-f-]{36}$/);
    assert.equal(rule.version, 1);
    assert.equal(rule.source, 'platform');
  });

  it('lets a tenant override the platform rule', async () => {
    await overrideEsi(f.tenant, 10, '2026-04-01', { ...PLATFORM_ESI, gross_wage_ceiling: 30000 });

    const rule = (await f.tenant.as((tx) => loadStatutoryRules(tx, '2026-06-30', []))).esi as any;
    assert.equal(rule.source, 'tenant');
    assert.equal(rule.version, 10);
    assert.equal(Number(rule.config.gross_wage_ceiling), 30000);
  });

  it('resolves by effective date, so an earlier period keeps the earlier rule', async () => {
    const earlier = await f.tenant.as((tx) => loadStatutoryRules(tx, '2026-03-31', []));
    const later = await f.tenant.as((tx) => loadStatutoryRules(tx, '2026-06-30', []));

    assert.equal((earlier.esi as any).source, 'platform');
    assert.equal(Number((earlier.esi as any).config.gross_wage_ceiling), 21000);
    assert.equal((later.esi as any).source, 'tenant');
  });
});

// ---------------------------------------------------------------------------

describe('ESI rule freezing', skipWithoutDb, () => {
  let f: Awaited<ReturnType<typeof esiFixture>>;

  before(async () => {
    f = await esiFixture('esi-freeze');
  });

  after(async () => {
    await dropTestTenant(f.tenant.tenantId);
    await closePools();
  });

  it('freezes the whole ESI configuration into the snapshot', async () => {
    const run = await makeRun(f.tenant, 'Jun 2026', '2026-06-01', '2026-06-30');
    const { rule, tax, required } = await frozenEsi(f.tenant, run.id);

    assert.equal(rule.version, 1);
    assert.equal(rule.source, 'platform');
    assert.match(rule.rule_id, /^[0-9a-f-]{36}$/);
    assert.equal(Number(rule.config.gross_wage_ceiling), 21000);
    // Applicability is an employee fact and travels on the tax side, as it always has.
    assert.equal(tax.esi_applicable, true);
    // And an employee who is covered cannot be paid without the rule.
    assert.ok(required.includes('esi'));
    await abandon(f.tenant, run.id);
  });

  it('a rule published afterwards does not re-price a run already snapshotted', async () => {
    const run = await makeRun(f.tenant, 'Jul 2026', '2026-07-01', '2026-07-31');
    assert.equal(Number((await frozenEsi(f.tenant, run.id)).rule.config.employee_rate), 0.0075);

    await overrideEsi(f.tenant, 20, '2026-04-01', { ...PLATFORM_ESI, employee_rate: 0.02 });

    const after = await frozenEsi(f.tenant, run.id);
    assert.equal(after.rule.version, 1, 'still the version the run froze');
    assert.equal(Number(after.rule.config.employee_rate), 0.0075);
    await abandon(f.tenant, run.id);

    // A new run sees the override: frozen is not the same as stale.
    const next = await makeRun(f.tenant, 'Aug 2026', '2026-08-01', '2026-08-31');
    const fresh = await frozenEsi(f.tenant, next.id);
    assert.equal(fresh.rule.version, 20);
    assert.equal(fresh.rule.source, 'tenant');
    assert.equal(Number(fresh.rule.config.employee_rate), 0.02);
    await abandon(f.tenant, next.id);
  });

  it('a ceiling change cannot retrospectively move an employee out of the scheme', async () => {
    // The ESI-specific version of the freezing requirement: the ceiling is the eligibility
    // test, so a later ceiling must not change who was covered in a period already run.
    const run = await makeRun(f.tenant, 'Sep 2026', '2026-09-01', '2026-09-30');
    const before = await frozenEsi(f.tenant, run.id);
    assert.equal(Number(before.rule.config.gross_wage_ceiling), 21000);

    await overrideEsi(f.tenant, 30, '2026-04-01', { ...PLATFORM_ESI, gross_wage_ceiling: 5000 });

    const after = await frozenEsi(f.tenant, run.id);
    assert.equal(Number(after.rule.config.gross_wage_ceiling), 21000,
      'the run keeps the ceiling that decided its coverage');
    await abandon(f.tenant, run.id);
  });

  it('records ESI applicability per employee as at the period', async () => {
    // esi_applicable lives on the effective-dated tax profile, so switching it off from
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
    const oct = await frozenEsi(f.tenant, october.id);
    assert.equal(oct.tax.esi_applicable, true);
    assert.ok(oct.required.includes('esi'));
    await abandon(f.tenant, october.id);

    const november = await makeRun(f.tenant, 'Nov 2026', '2026-11-01', '2026-11-30');
    const nov = await frozenEsi(f.tenant, november.id);
    assert.equal(nov.tax.esi_applicable, false);
    // Not covered means the rule is not required for them either.
    assert.equal(nov.required.includes('esi'), false);
    await abandon(f.tenant, november.id);
  });
});

// ---------------------------------------------------------------------------

describe('ESI rule isolation', skipWithoutDb, () => {
  let a: Awaited<ReturnType<typeof esiFixture>>;
  let b: Awaited<ReturnType<typeof esiFixture>>;

  before(async () => {
    a = await esiFixture('esi-iso-a');
    b = await esiFixture('esi-iso-b');
    await overrideEsi(a.tenant, 40, '2026-04-01', { ...PLATFORM_ESI, employee_rate: 0.05 });
  });

  after(async () => {
    await dropTestTenant(a.tenant.tenantId);
    await dropTestTenant(b.tenant.tenantId);
    await closePools();
  });

  it('one tenant cannot read another ESI override', async () => {
    const visible = await b.tenant.as(async (tx) => {
      const { rows } = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM payroll.statutory_rule
          WHERE rule_type = 'esi' AND tenant_id IS NOT NULL`,
      );
      return Number(rows[0]!.count);
    });
    assert.equal(visible, 0);
  });

  it('one tenant override does not change another tenant resolution', async () => {
    const rulesB = await b.tenant.as((tx) => loadStatutoryRules(tx, '2026-06-30', []));
    assert.equal((rulesB.esi as any).source, 'platform');
    assert.equal(Number((rulesB.esi as any).config.employee_rate), 0.0075);

    const rulesA = await a.tenant.as((tx) => loadStatutoryRules(tx, '2026-06-30', []));
    assert.equal((rulesA.esi as any).source, 'tenant');
    assert.equal(Number((rulesA.esi as any).config.employee_rate), 0.05);
  });

  it('one tenant override does not reach another tenant snapshot', async () => {
    const run = await makeRun(b.tenant, 'Jun 2026', '2026-06-01', '2026-06-30');
    assert.equal((await frozenEsi(b.tenant, run.id)).rule.source, 'platform');
    await abandon(b.tenant, run.id);
  });

  it('one tenant cannot plant an ESI rule under another tenant id', async () => {
    await assert.rejects(
      a.tenant.as((tx) =>
        tx.query(
          `INSERT INTO payroll.statutory_rule
             (tenant_id, country_code, rule_type, version, effective_from, rule_config)
           VALUES ($1, 'IN', 'esi', 71, '2026-04-01', '{}'::jsonb)`,
          [b.tenant.tenantId],
        ),
      ),
      (err: { code?: string }) => err.code === '42501',
    );
  });

  it('one tenant cannot plant a platform-wide ESI rule', async () => {
    await assert.rejects(
      a.tenant.as((tx) =>
        tx.query(
          `INSERT INTO payroll.statutory_rule
             (tenant_id, country_code, rule_type, version, effective_from, rule_config)
           VALUES (NULL, 'IN', 'esi', 72, '2026-04-01', '{}'::jsonb)`,
        ),
      ),
      (err: { code?: string }) => err.code === '42501',
    );
  });
});
