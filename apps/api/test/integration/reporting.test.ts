import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closePools, getAppPool, withPlatform, type TenantTx } from '../../src/infra/db/pool.ts';
import {
  REPORT_TYPES,
  allReportDefinitions,
  reportDefinition,
} from '../../src/modules/reporting/definitions.ts';
import { getReportRun, listReportRuns, requestReport } from '../../src/modules/reporting/service.ts';
import { createEmployee, createTestTenant, dropTestTenant, skipWithoutDb, type TestTenant } from './helpers.ts';

/**
 * Reporting (PRD s.22).
 *
 * Three things are being established, and only the first is about numbers.
 *
 *   * every report returns exactly what the fixture contains, from the authoritative source
 *     for that domain rather than a second interpretation of it;
 *   * a report is gated on the permission that already protects its data, so the reporting
 *     endpoint cannot become a route around `payroll.read`;
 *   * a report reads its own tenant and nothing else, under RLS rather than by convention.
 *
 * Fixtures are exact. Every expected number below is one a reader can count off the setup.
 */

/**
 * Builds one real payroll run for a period and puts the given slips in it.
 *
 * One run, not one per slip: a period is unique per tenant and company, and a payroll run
 * belongs to a period. Going through the real chain — tax year, period, run, payroll
 * employee, input snapshot, slip — rather than inserting slips straight in means the report
 * is being read off the shape payroll actually produces.
 */
async function payrollRun(
  tx: TenantTx,
  input: {
    companyId: string;
    periodStart: string;
    periodEnd: string;
    slips: Array<{
      employeeId: string;
      slipNumber: string;
      gross: string;
      deduction: string;
      tax: string;
      net: string;
      employer: string;
      status?: 'draft' | 'finalized';
    }>;
  },
): Promise<void> {
  // One tax year per tenant is enough here; the label format is fixed by a check constraint
  // and the range by a GiST exclusion, so reuse rather than insert an overlapping year.
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM payroll.tax_year WHERE tenant_id = $1 LIMIT 1`, [tx.tenantId]);
  const taxYearId = existing.rows[0]?.id ?? (await tx.query<{ id: string }>(
    `INSERT INTO payroll.tax_year (tenant_id, label, start_date, end_date)
     VALUES ($1, '2026-27', '2026-04-01'::date, '2027-03-31'::date) RETURNING id`,
    [tx.tenantId])).rows[0]!.id;

  const period = await tx.query<{ id: string }>(
    `INSERT INTO payroll.payroll_period
       (tenant_id, company_id, name, period_start, period_end, pay_date, tax_year_id)
     VALUES ($1,$2,$3,$4::date,$5::date,$5::date,$6) RETURNING id`,
    [tx.tenantId, input.companyId, `P-${input.periodStart}`, input.periodStart, input.periodEnd, taxYearId],
  );
  const run = await tx.query<{ id: string }>(
    `INSERT INTO payroll.payroll_run
       (tenant_id, payroll_period_id, company_id, calculation_version, run_sequence)
     VALUES ($1,$2,$3,'test',1) RETURNING id`,
    [tx.tenantId, period.rows[0]!.id, input.companyId],
  );
  const runId = run.rows[0]!.id;

  for (const slip of input.slips) {
    const pe = await tx.query<{ id: string }>(
      `INSERT INTO payroll.payroll_employee (tenant_id, payroll_run_id, employee_id)
       VALUES ($1,$2,$3) RETURNING id`,
      [tx.tenantId, runId, slip.employeeId],
    );
    const snap = await tx.query<{ id: string }>(
      `INSERT INTO payroll.payroll_input_snapshot
         (tenant_id, payroll_run_id, employee_id, employee_json, attendance_json, leave_json,
          compensation_json, tax_json, statutory_json)
       VALUES ($1,$2,$3,'{}','{}','{}','{}','{}','{}') RETURNING id`,
      [tx.tenantId, runId, slip.employeeId],
    );
    await tx.query(
      `INSERT INTO payroll.salary_slip
         (tenant_id, payroll_run_id, payroll_employee_id, employee_id, slip_number,
          period_start, period_end, total_days, payable_days, calculation_version, snapshot_id,
          gross_amount, deduction_amount, tax_amount, net_amount, employer_contribution, status)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,30,30,'test',$8,$9,$10,$11,$12,$13,$14)`,
      [
        tx.tenantId, runId, pe.rows[0]!.id, slip.employeeId, slip.slipNumber,
        input.periodStart, input.periodEnd, snap.rows[0]!.id,
        slip.gross, slip.deduction, slip.tax, slip.net, slip.employer, slip.status ?? 'finalized',
      ],
    );
  }
}

const RANGE = { dateFrom: '2026-06-01', dateTo: '2026-06-30' };

describe('reporting', skipWithoutDb, () => {
  let tenant: TestTenant;
  let other: TestTenant;
  let engineering: string;
  let sales: string;
  let alice: string;
  let bob: string;
  let carol: string;

  before(async () => {
    tenant = await createTestTenant('report');
    other = await createTestTenant('report-other');

    const depts = await tenant.as(async (tx) => {
      const e = await tx.query<{ id: string }>(
        `INSERT INTO core.department (tenant_id, name) VALUES ($1,'Engineering') RETURNING id`,
        [tx.tenantId]);
      const s = await tx.query<{ id: string }>(
        `INSERT INTO core.department (tenant_id, name) VALUES ($1,'Sales') RETURNING id`,
        [tx.tenantId]);
      return { engineering: e.rows[0]!.id, sales: s.rows[0]!.id };
    });
    engineering = depts.engineering;
    sales = depts.sales;

    // Two in Engineering, one in Sales. Employment history is written by createEmployee, so
    // the department has to be set on both the employee and the history row it produced.
    alice = await createEmployee(tenant, { code: 'RPT001', joiningDate: '2026-01-01' });
    bob = await createEmployee(tenant, { code: 'RPT002', joiningDate: '2026-01-01' });
    carol = await createEmployee(tenant, { code: 'RPT003', joiningDate: '2026-01-01' });

    await tenant.as(async (tx) => {
      for (const [id, dept] of [[alice, engineering], [bob, engineering], [carol, sales]] as const) {
        await tx.query(`UPDATE core.employee SET department_id = $3 WHERE tenant_id = $1 AND id = $2`,
          [tx.tenantId, id, dept]);
        await tx.query(
          `UPDATE core.employment_history SET department_id = $3, location_id = $4
            WHERE tenant_id = $1 AND employee_id = $2`,
          [tx.tenantId, id, dept, tenant.locationId]);
      }

      // Carol transfers from Sales to Engineering on 1 July. This is what makes the
      // headcount report's source observable: after the transfer `core.employee` says
      // Engineering for her on every date, while the history says Sales until July.
      await tx.query(
        `UPDATE core.employment_history SET effective_to = '2026-06-30'::date
          WHERE tenant_id = $1 AND employee_id = $2`,
        [tx.tenantId, carol]);
      await tx.query(
        `INSERT INTO core.employment_history
           (tenant_id, employee_id, company_id, department_id, location_id,
            employment_type, employment_status, change_reason, effective_from)
         VALUES ($1,$2,$3,$4,$5,'full_time','active','transfer','2026-07-01'::date)`,
        [tx.tenantId, carol, tenant.companyId, engineering, tenant.locationId]);
      await tx.query(`UPDATE core.employee SET department_id = $3 WHERE tenant_id = $1 AND id = $2`,
        [tx.tenantId, carol, engineering]);

      // Payroll: two finalized slips in June, plus one draft that must never be counted.
      await payrollRun(tx, {
        companyId: tenant.companyId,
        periodStart: '2026-06-01',
        periodEnd: '2026-06-30',
        slips: [
          { employeeId: alice, slipNumber: 'RPT-JUN-1', gross: '100000.00', deduction: '1800.00',
            tax: '5000.00', net: '93200.00', employer: '1800.00' },
          { employeeId: bob, slipNumber: 'RPT-JUN-2', gross: '50000.00', deduction: '1800.00',
            tax: '1000.00', net: '47200.00', employer: '1800.00' },
          { employeeId: carol, slipNumber: 'RPT-JUN-3', gross: '999999.00', deduction: '0.00',
            tax: '0.00', net: '999999.00', employer: '0.00', status: 'draft' },
        ],
      });
    });
  });

  after(async () => {
    await dropTestTenant(tenant.tenantId);
    await dropTestTenant(other.tenantId);
    await closePools();
  });

  describe('the catalogue', () => {
    it('covers exactly the reports the PRD names, less the two that are not specified', () => {
      // s.22 names eleven. Attrition has no formula or measurement window anywhere in the
      // PRD, and hiring depends on recruitment, which is P2 and not built. Neither is
      // guessed at here, and this pins that they are absent on purpose.
      assert.deepEqual([...REPORT_TYPES].sort(), [
        'absence', 'attendance', 'audit_activity', 'compensation', 'expenses',
        'headcount', 'leave', 'overtime', 'payroll_cost',
      ]);
      assert.equal(REPORT_TYPES.includes('attrition' as never), false);
      assert.equal(REPORT_TYPES.includes('hiring' as never), false);
    });

    it('gates every report on a real permission, and the sensitive ones on sensitive permissions', async () => {
      const { rows } = await withPlatform('maintenance', (tx) =>
        tx.query<{ code: string; sensitive: boolean }>('SELECT code, sensitive FROM identity.permission'));
      const known = new Map(rows.map((r) => [r.code, r.sensitive]));

      for (const definition of allReportDefinitions()) {
        assert.ok(
          known.has(definition.permission),
          `${definition.type} is gated on "${definition.permission}", which is not a permission that exists`,
        );
        if (definition.sensitive) {
          assert.equal(
            known.get(definition.permission), true,
            `${definition.type} exports sensitive data but "${definition.permission}" is not marked sensitive, ` +
            'so it would not carry the MFA requirement either',
          );
        }
      }
    });

    it('protects salary and audit behind the permissions that already protect them', () => {
      // The whole authorization design in one assertion: there is no `report.run`, so running
      // a report can never be a way around the permission on the underlying data (PRD s.7).
      assert.equal(reportDefinition('payroll_cost').permission, 'payroll.read');
      assert.equal(reportDefinition('compensation').permission, 'compensation.read');
      assert.equal(reportDefinition('audit_activity').permission, 'audit.read');
      assert.equal(reportDefinition('headcount').permission, 'employee.read');
      assert.equal(
        allReportDefinitions().some((d) => d.permission.startsWith('report.')), false,
        'no report may be gated on a reporting-specific permission',
      );
    });
  });

  describe('headcount', () => {
    it('counts from effective-dated history, grouped by department', async () => {
      const rows = await tenant.as((tx) =>
        reportDefinition('headcount').run(tx, tx.tenantId, RANGE));

      const byDept = Object.fromEntries(rows.map((r) => [r.department, r.headcount]));
      assert.deepEqual(byDept, { Engineering: 2, Sales: 1 });
    });

    it('answers as of the date asked, not as of today', async () => {
      // Everyone joined 2026-01-01, so a date before that has nobody in it. Reading
      // core.employee instead of its history would answer 3 regardless of the date.
      const rows = await tenant.as((tx) =>
        reportDefinition('headcount').run(tx, tx.tenantId, { dateFrom: '2025-01-01', dateTo: '2025-12-31' }));
      assert.deepEqual(rows, []);
    });

    it('places a transferred employee where they were, not where they are now', async () => {
      // Carol is in Engineering today and was in Sales in June. Reading `core.employee`
      // would report her in Engineering for June as well — the misleading historical answer
      // that effective dating exists to prevent (PRD s.35).
      const june = await tenant.as((tx) =>
        reportDefinition('headcount').run(tx, tx.tenantId, RANGE));
      assert.deepEqual(
        Object.fromEntries(june.map((r) => [r.department, r.headcount])),
        { Engineering: 2, Sales: 1 },
      );

      const august = await tenant.as((tx) =>
        reportDefinition('headcount').run(tx, tx.tenantId, { dateFrom: '2026-08-01', dateTo: '2026-08-31' }));
      assert.deepEqual(
        Object.fromEntries(august.map((r) => [r.department, r.headcount])),
        { Engineering: 3 },
        'after the transfer she counts in Engineering, and Sales is empty',
      );
    });

    it('narrows to a department when asked', async () => {
      const rows = await tenant.as((tx) =>
        reportDefinition('headcount').run(tx, tx.tenantId, { ...RANGE, departmentId: engineering }));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.department, 'Engineering');
      assert.equal(rows[0]!.headcount, 2);
    });
  });

  describe('payroll cost', () => {
    it('sums finalized slips and leaves drafts out', async () => {
      const rows = await tenant.as((tx) =>
        reportDefinition('payroll_cost').run(tx, tx.tenantId, RANGE));

      // Alice 100000 + Bob 50000. Carol's draft of 999999 is not payroll cost: it is a
      // calculation nobody has approved, which recalculation may still replace.
      const engineeringRow = rows.find((r) => r.department === 'Engineering')!;
      assert.equal(engineeringRow.employees, 2);
      assert.equal(engineeringRow.gross_amount, '150000.00');
      assert.equal(engineeringRow.deduction_amount, '3600.00');
      assert.equal(engineeringRow.tax_amount, '6000.00');
      assert.equal(engineeringRow.net_amount, '140400.00');
      assert.equal(engineeringRow.employer_contribution, '3600.00');

      assert.equal(
        rows.some((r) => r.department === 'Sales'), false,
        'Sales has only a draft slip, so it must not appear in payroll cost at all',
      );
    });

    it('reports employer contribution separately from employee deductions', async () => {
      // ADR-021/022 put employer PF/ESI outside net pay. Folding it into deductions, or into
      // a single "cost" total, would be an accounting definition the PRD does not give.
      const rows = await tenant.as((tx) =>
        reportDefinition('payroll_cost').run(tx, tx.tenantId, RANGE));
      const row = rows.find((r) => r.department === 'Engineering')!;

      assert.equal(
        Number(row.gross_amount) - Number(row.deduction_amount) - Number(row.tax_amount),
        Number(row.net_amount),
        'net must reconcile from gross less employee deductions and tax',
      );
      assert.ok(Number(row.employer_contribution) > 0);
      assert.equal(
        Object.keys(row).includes('total_cost'), false,
        'no single cost total: the PRD does not define what payroll cost comprises',
      );
    });

    it('excludes periods outside the requested range', async () => {
      const rows = await tenant.as((tx) =>
        reportDefinition('payroll_cost').run(tx, tx.tenantId, { dateFrom: '2026-07-01', dateTo: '2026-07-31' }));
      assert.deepEqual(rows, []);
    });
  });

  describe('tenant isolation', () => {
    it('returns nothing for a tenant that has no data, with the same query', async () => {
      // The other tenant runs the identical report over the identical range. Anything but an
      // empty result would mean the report reached across the boundary.
      for (const definition of allReportDefinitions()) {
        const rows = await other.as((tx) => definition.run(tx, tx.tenantId, RANGE));
        assert.deepEqual(rows, [], `${definition.type} returned another tenant's rows`);
      }
    });

    it('cannot be pointed at another tenant department by passing its id', async () => {
      // The filter is a uuid from the caller. Supplying one that belongs elsewhere must
      // narrow to nothing, never widen: the tenant predicate and RLS both still apply.
      const rows = await other.as((tx) =>
        reportDefinition('headcount').run(tx, tx.tenantId, { ...RANGE, departmentId: engineering }));
      assert.deepEqual(rows, []);
    });

    it('fails closed when no tenant context is set', async () => {
      // RLS is the boundary underneath the predicate, so it has to hold on its own.
      const client = await getAppPool().connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM analytics.report_run');
        assert.equal(rows[0]!.n, 0, 'with no tenant context the app role must see no report runs');
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });
  });

  describe('requesting a report', () => {
    it('records the request, returns it pending, and queues exactly one event', async () => {
      const run = await tenant.as((tx) =>
        requestReport(tx, { reportType: 'headcount', parameters: RANGE }));

      assert.equal(run.status, 'pending');
      assert.equal(run.report_type, 'headcount');
      assert.equal(run.row_count, null);
      assert.equal(run.document_id, null);

      const events = await tenant.as(async (tx) => {
        const { rows } = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM integration.event_outbox
            WHERE tenant_id = $1 AND event_type = 'ReportRequested' AND aggregate_id = $2`,
          [tx.tenantId, run.id]);
        return rows[0]!.n;
      });
      assert.equal(events, 1, 'the row and the event must commit together, exactly once');
    });

    it('audits the request as the sensitive operation it is', async () => {
      const run = await tenant.as((tx) =>
        requestReport(tx, { reportType: 'payroll_cost', parameters: RANGE }));

      const entry = await tenant.as(async (tx) => {
        const { rows } = await tx.query<{ action: string; metadata: Record<string, unknown> }>(
          `SELECT action, metadata FROM audit.audit_log
            WHERE tenant_id = $1 AND entity_type = 'report_run' AND entity_id = $2`,
          [tx.tenantId, run.id]);
        return rows[0];
      });
      assert.ok(entry, 'asking for a payroll cost export must leave a trail');
      assert.equal(entry!.action, 'report.requested');
      assert.equal(entry!.metadata.sensitive_report, true);
    });

    it('refuses a reversed date range instead of reporting nothing', async () => {
      await assert.rejects(
        tenant.as((tx) => requestReport(tx, {
          reportType: 'headcount',
          parameters: { dateFrom: '2026-06-30', dateTo: '2026-06-01' },
        })),
        /dateTo cannot be before dateFrom/,
      );
    });

    it('accepts a multi-year range rather than imposing a limit nobody asked for', async () => {
      // There is no maximum range. The PRD does not bound a report period, no other
      // date-filtered endpoint here bounds one, and a report's size is governed by what it
      // groups by rather than by how long the range is. The export size is bounded in the
      // generator instead, which is where a resource limit belongs.
      const run = await tenant.as((tx) => requestReport(tx, {
        reportType: 'payroll_cost',
        parameters: { dateFrom: '2020-01-01', dateTo: '2026-12-31' },
      }));
      assert.equal(run.status, 'pending');
    });

    it('still produces the right answer over a range far wider than the data', async () => {
      const rows = await tenant.as((tx) =>
        reportDefinition('payroll_cost').run(tx, tx.tenantId,
          { dateFrom: '2016-01-01', dateTo: '2026-12-31' }));
      const engineering = rows.find((r) => r.department === 'Engineering')!;
      assert.equal(engineering.gross_amount, '150000.00', 'a wider window must not change the total');
    });

    it('refuses a report type that does not exist', async () => {
      await assert.rejects(
        tenant.as((tx) => requestReport(tx, { reportType: 'attrition' as never, parameters: RANGE })),
        /No such report/,
      );
    });

    it('refuses a date that is not a date', async () => {
      await assert.rejects(
        tenant.as((tx) => requestReport(tx, {
          reportType: 'headcount',
          parameters: { dateFrom: 'last-tuesday', dateTo: '2026-06-30' },
        })),
        /must be YYYY-MM-DD/,
      );
    });

    it('gives the same answer however many times the status is read', async () => {
      const run = await tenant.as((tx) =>
        requestReport(tx, { reportType: 'overtime', parameters: RANGE }));

      const reads = await Promise.all([1, 2, 3].map(() => tenant.as((tx) => getReportRun(tx, run.id))));
      for (const read of reads) {
        assert.equal(read.id, run.id);
        assert.equal(read.status, 'pending');
      }
    });

    it('does not tell another tenant whether the id exists', async () => {
      // The same rejection for a report that exists elsewhere and one that never existed,
      // so an id cannot be probed for existence across the boundary.
      const run = await tenant.as((tx) =>
        requestReport(tx, { reportType: 'leave', parameters: RANGE }));

      const real = await other.as((tx) => getReportRun(tx, run.id).catch((e) => e.message));
      const imaginary = await other.as((tx) =>
        getReportRun(tx, '11111111-1111-4111-8111-111111111111').catch((e) => e.message));
      assert.equal(real, imaginary);
    });

    it('reads back a run by id, and never another tenant run', async () => {
      const run = await tenant.as((tx) =>
        requestReport(tx, { reportType: 'absence', parameters: RANGE }));

      const mine = await tenant.as((tx) => getReportRun(tx, run.id));
      assert.equal(mine.id, run.id);

      await assert.rejects(other.as((tx) => getReportRun(tx, run.id)), /not found|Report run/i);
    });

    it('lists this tenant runs only', async () => {
      const mine = await tenant.as((tx) => listReportRuns(tx));
      const theirs = await other.as((tx) => listReportRuns(tx));

      assert.ok(mine.length > 0);
      assert.deepEqual(theirs, []);
    });
  });
});
