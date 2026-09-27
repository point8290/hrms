import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  closePools,
  withPlatform,
  withTenant,
  SYSTEM_ACTOR,
  type TenantTx,
} from '@hrms/api/src/infra/db/pool.ts';
import { setQueue } from '@hrms/api/src/infra/queue.ts';
import { setStorage, type Storage } from '@hrms/api/src/infra/storage.ts';
import { HANDLERS } from '../src/handlers.ts';
import { createPeriod } from '@hrms/api/src/modules/payroll/service.ts';

/**
 * Payslip generation, at the sizes and in the failure modes that actually happen.
 *
 * Payslips are the highest-consequence fan-out in the system: one finalized run becomes one
 * document per employee, each rendered, uploaded and notified. The failure that matters is
 * never "it crashed" — it is "employee 2,317 silently has no payslip", which nobody notices
 * until they ask for it.
 *
 * So every test below asks the same question in a different way: after the failure, is every
 * employee either done or retryable? "Neither" is the bug.
 */

const hasDatabase = Boolean(process.env.DATABASE_URL);
const skipWithoutDb = {
  skip: hasDatabase ? false : 'DATABASE_URL is not set (docker compose up -d postgres && npm run db:migrate)',
};

/** Above the 4,000-employee target this is meant to cover; adjust with SCALE_EMPLOYEES. */
const SCALE = Number(process.env.SCALE_EMPLOYEES ?? 4000);

describe('payslip generation', skipWithoutDb, () => {
  let tenantId: string;
  let companyId: string;
  let runId: string;
  let periodId: string;

  const as = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    withTenant(tenantId, { ...SYSTEM_ACTOR, label: 'payslip-test' }, fn);

  /** An in-memory object store that can be told to fail. */
  function fakeStorage(): Storage & {
    objects: Map<string, Buffer>;
    failOn: (predicate: (key: string) => boolean) => void;
    puts: string[];
  } {
    const objects = new Map<string, Buffer>();
    const puts: string[] = [];
    let shouldFail: (key: string) => boolean = () => false;

    return {
      objects,
      puts,
      failOn(predicate) {
        shouldFail = predicate;
      },
      bucket: 'test-bucket',
      buildKey: (tenant, type, filename) => `tenants/${tenant}/${type}/${filename}`,
      async presignUpload(key, contentType) {
        return { url: `memory://${key}`, method: 'PUT', headers: { 'content-type': contentType }, bucket: 'test-bucket', key, expiresInSeconds: 60 };
      },
      async presignDownload(key) {
        return { url: `memory://${key}`, expiresInSeconds: 60 };
      },
      async putObject(key, body) {
        puts.push(key);
        if (shouldFail(key)) throw new Error('S3 is unavailable');
        objects.set(key, body);
      },
      async getObject(key) {
        const found = objects.get(key);
        if (!found) throw new Error('not found');
        return found;
      },
      async healthCheck() {},
    };
  }

  let store: ReturnType<typeof fakeStorage>;

  before(async () => {
    tenantId = await withPlatform('tenant-provisioning', async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO identity.tenant (name, slug, timezone) VALUES ($1, $2, 'Asia/Kolkata') RETURNING id`,
        [`Payslip ${randomUUID().slice(0, 8)}`, `payslip-${randomUUID().slice(0, 8)}`],
      );
      return rows[0]!.id;
    });

    // The queue is never exercised here — these tests drive handlers directly — but the
    // outbox writes go through it, so it must not reach a real broker.
    setQueue({
      async send() {},
      async receive() { return []; },
      async delete() {},
      async release() {},
      async deadLetter() {},
    });

    await as(async (tx) => {
      const company = await tx.query<{ id: string }>(
        `INSERT INTO core.company (tenant_id, name, legal_name)
         VALUES ($1, 'Test Co', 'Test Co Pvt Ltd') RETURNING id`,
        [tenantId],
      );
      companyId = company.rows[0]!.id;

      const period = await createPeriod(tx, {
        companyId,
        name: 'Jan 2026',
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
        payDate: '2026-02-01',
      });
      periodId = period.id;

      const run = await tx.query<{ id: string }>(
        `INSERT INTO payroll.payroll_run
           (tenant_id, payroll_period_id, company_id, status, calculation_version, run_sequence)
         VALUES ($1, $2, $3, 'finalized', 'v1', 1) RETURNING id`,
        [tenantId, periodId, companyId],
      );
      runId = run.rows[0]!.id;
    });
  });

  beforeEach(() => {
    store = fakeStorage();
    setStorage(store);
  });

  after(async () => {
    setStorage(undefined);
    setQueue(undefined);
    await withPlatform('maintenance', (tx) =>
      tx.query('SELECT identity.purge_tenant($1, $2)', [tenantId, 'payslip test teardown']),
    );
    await closePools();
  });

  /** Creates `count` employees with a finalized slip each, all on the same run. */
  async function createSlips(count: number, prefix: string, status = 'finalized'): Promise<string[]> {
    return as(async (tx) => {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const code = `${prefix}${String(i).padStart(5, '0')}`;
        const employee = await tx.query<{ id: string }>(
          `INSERT INTO core.employee
             (tenant_id, company_id, employee_code, first_name, last_name, work_email,
              joining_date, employment_status)
           VALUES ($1, $2, $3, 'Test', $4, $5, '2025-01-01', 'active') RETURNING id`,
          [tenantId, companyId, code, code, `${code.toLowerCase()}@example.com`],
        );
        const employeeId = employee.rows[0]!.id;

        const payrollEmployee = await tx.query<{ id: string }>(
          `INSERT INTO payroll.payroll_employee (tenant_id, payroll_run_id, employee_id, status)
           VALUES ($1, $2, $3, 'calculated') RETURNING id`,
          [tenantId, runId, employeeId],
        );
        // One snapshot per employee: the engine reads only the snapshot, so a slip without
        // one could never have been produced.
        const snapshot = await tx.query<{ id: string }>(
          `INSERT INTO payroll.payroll_input_snapshot
             (tenant_id, payroll_run_id, employee_id, employee_json, attendance_json, leave_json,
              compensation_json, tax_json, statutory_json)
           VALUES ($1,$2,$3,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb)
           RETURNING id`,
          [tenantId, runId, employeeId],
        );
        const slip = await tx.query<{ id: string }>(
          `INSERT INTO payroll.salary_slip
             (tenant_id, payroll_run_id, payroll_employee_id, employee_id, slip_number,
              period_start, period_end, total_days, payable_days, gross_amount, net_amount,
              calculation_version, snapshot_id, status, finalized_at)
           VALUES ($1,$2,$3,$4,$5,'2026-01-01','2026-01-31',31,31,50000,45000,'v1',$6,$7,
                   CASE WHEN $7 = 'finalized' THEN now() END)
           RETURNING id`,
          [
            tenantId, runId, payrollEmployee.rows[0]!.id, employeeId, `SLIP-${code}`,
            snapshot.rows[0]!.id, status,
          ],
        );
        ids.push(slip.rows[0]!.id);
      }
      return ids;
    });
  }

  function slipEvent(slipId: string, eventId = randomUUID()) {
    return {
      event_id: eventId,
      event_type: 'SalarySlipGenerated',
      schema_version: 1,
      tenant_id: tenantId,
      aggregate_type: 'salary_slip',
      aggregate_id: slipId,
      occurred_at: new Date().toISOString(),
      producer: 'test',
      payload: { salary_slip_id: slipId },
    };
  }

  async function documentCount(): Promise<number> {
    return as(async (tx) => {
      const { rows } = await tx.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM documents.document WHERE document_type = 'payslip'`,
      );
      return rows[0]!.count;
    });
  }

  it('produces a document and a notification for a single employee', async () => {
    const [slipId] = await createSlips(1, 'ONE');
    await HANDLERS.SalarySlipGenerated!(slipEvent(slipId!) as never);

    const result = await as(async (tx) => {
      const { rows } = await tx.query<{ document_id: string | null }>(
        'SELECT document_id FROM payroll.salary_slip WHERE id = $1',
        [slipId],
      );
      // By outcome rather than by dedupe-key shape: the key's composition is set by
      // PRD s.18.6 and is not what this test is about.
      const notifications = await tx.query<{ channel: string }>(
        `SELECT channel FROM notification.notification
          WHERE template_code = 'payroll.payslip_available'
            AND payload->>'salary_slip_id' = $1
          ORDER BY channel`,
        [slipId],
      );
      return { documentId: rows[0]!.document_id, channels: notifications.rows.map((r) => r.channel) };
    });

    assert.ok(result.documentId, 'the slip must be linked to a document');
    // Email only, and correctly so: this fixture's employee has a work address but no linked
    // app_user, so there is no portal inbox to put an in-app copy in. An employee who has a
    // login gets both (covered in the notification suite).
    assert.deepEqual(result.channels, ['email']);
    assert.equal(store.objects.size, 1, 'exactly one object uploaded');
  });

  it('is idempotent: a redelivered event produces no second payslip', async () => {
    const [slipId] = await createSlips(1, 'DUP');
    const event = slipEvent(slipId!);

    await HANDLERS.SalarySlipGenerated!(event as never);
    const afterFirst = await documentCount();

    // Same event id — the processed_event guard should short-circuit it.
    await HANDLERS.SalarySlipGenerated!(event as never);
    // Different event id, same slip — the `document_id IS NULL` re-check under lock catches
    // this one. Both paths matter: SQS redelivery produces the first, a re-emitted
    // PayrollFinalized produces the second.
    await HANDLERS.SalarySlipGenerated!(slipEvent(slipId!) as never);

    assert.equal(await documentCount(), afterFirst, 'a payslip must never be produced twice');
  });

  it('fans out one event per slip when a run is finalized, and only for slips without one', async () => {
    const slips = await createSlips(10, 'FAN');
    const event = {
      event_id: randomUUID(),
      event_type: 'PayrollFinalized',
      schema_version: 1,
      tenant_id: tenantId,
      aggregate_type: 'payroll_run',
      aggregate_id: runId,
      occurred_at: new Date().toISOString(),
      producer: 'test',
      payload: { payroll_run_id: runId },
    };

    const before = await outboxCount();
    await HANDLERS.PayrollFinalized!(event as never);
    const emitted = (await outboxCount()) - before;

    // Every slip still lacking a document, from this test and the earlier ones that failed
    // on purpose — the handler's filter is `document_id IS NULL`, not "slips I just made".
    const pending = await as(async (tx) => {
      const { rows } = await tx.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM payroll.salary_slip
          WHERE payroll_run_id = $1 AND status = 'finalized' AND document_id IS NULL`,
        [runId],
      );
      return rows[0]!.count;
    });

    assert.ok(emitted >= slips.length, `expected at least one event per new slip, got ${emitted}`);
    assert.ok(pending >= slips.length, 'the slips waiting for a document are the ones fanned out');
  });

  it('leaves the rest of the run intact when one employee fails', async () => {
    const slips = await createSlips(10, 'FAIL');
    const failing = slips[4]!;

    store.failOn((key) => key.includes('SLIP-FAIL00004'));

    const outcomes = await Promise.allSettled(
      slips.map((id) => HANDLERS.SalarySlipGenerated!(slipEvent(id) as never)),
    );

    const rejected = outcomes.filter((o) => o.status === 'rejected');
    assert.equal(rejected.length, 1, 'exactly the failing employee should fail');

    const produced = await as(async (tx) => {
      const { rows } = await tx.query<{ id: string; document_id: string | null }>(
        `SELECT id, document_id FROM payroll.salary_slip WHERE id = ANY($1::uuid[])`,
        [slips],
      );
      return rows;
    });

    for (const slip of produced) {
      if (slip.id === failing) {
        assert.equal(slip.document_id, null, 'the failed employee must stay unfinished, not half-finished');
      } else {
        assert.ok(slip.document_id, `employee ${slip.id} should have been unaffected`);
      }
    }
  });

  it('retries a failed employee successfully once storage recovers', async () => {
    const [slipId] = await createSlips(1, 'RETRY');

    store.failOn(() => true);
    await assert.rejects(HANDLERS.SalarySlipGenerated!(slipEvent(slipId!) as never), /unavailable/);

    const halfway = await as(async (tx) => {
      const { rows } = await tx.query<{ document_id: string | null }>(
        'SELECT document_id FROM payroll.salary_slip WHERE id = $1',
        [slipId],
      );
      return rows[0]!.document_id;
    });
    assert.equal(halfway, null, 'a failed upload must not leave a document row pointing at nothing');

    store.failOn(() => false);
    await HANDLERS.SalarySlipGenerated!(slipEvent(slipId!) as never);

    const recovered = await as(async (tx) => {
      const { rows } = await tx.query<{ document_id: string | null }>(
        'SELECT document_id FROM payroll.salary_slip WHERE id = $1',
        [slipId],
      );
      return rows[0]!.document_id;
    });
    assert.ok(recovered, 'the retry must complete the payslip');
  });

  it('does not produce a payslip for a slip that is no longer finalized', async () => {
    // Created cancelled rather than finalized-then-cancelled, because the database refuses
    // the latter outright — a finalized slip is immutable, which is the stronger guarantee.
    const [slipId] = await createSlips(1, 'CANCEL', 'cancelled');

    await HANDLERS.SalarySlipGenerated!(slipEvent(slipId!) as never);

    const document = await as(async (tx) => {
      const { rows } = await tx.query<{ document_id: string | null }>(
        'SELECT document_id FROM payroll.salary_slip WHERE id = $1',
        [slipId],
      );
      return rows[0]!.document_id;
    });
    assert.equal(document, null, 'a cancelled run must not hand an employee a payslip');
  });

  it('never opens a database transaction across the object store upload', async () => {
    // The regression this guards: the upload used to happen inside the tenant transaction,
    // holding a row lock across an S3 round trip. At four thousand payslips that exhausts
    // the connection pool. Proven by making the upload observe the transaction state.
    const [slipId] = await createSlips(1, 'TXN');

    let inTransactionDuringUpload: boolean | undefined;
    const original = store.putObject.bind(store);
    store.putObject = async (key, body, contentType) => {
      // If a transaction were open, the pool would have a client checked out with an
      // active transaction. Counting them from a *separate* connection is the honest check.
      inTransactionDuringUpload = await withPlatform('maintenance', async (tx) => {
        const { rows } = await tx.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE application_name = 'hrms-app' AND state = 'idle in transaction'`,
        );
        return (rows[0]?.count ?? 0) > 0;
      });
      return original(key, body, contentType);
    };

    await HANDLERS.SalarySlipGenerated!(slipEvent(slipId!) as never);
    assert.equal(
      inTransactionDuringUpload,
      false,
      'no tenant transaction may be open while an object is being uploaded',
    );
  });

  it(`generates ${SCALE} payslips without leaving any employee unfinished`, { timeout: 900_000 }, async () => {
    const slips = await createSlips(SCALE, 'BULK');

    // Concurrency bounded the way a worker fleet bounds it: several in flight, not all.
    const CONCURRENCY = 16;
    let cursor = 0;
    const failures: unknown[] = [];

    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (cursor < slips.length) {
          const index = cursor;
          cursor += 1;
          try {
            await HANDLERS.SalarySlipGenerated!(slipEvent(slips[index]!) as never);
          } catch (err) {
            failures.push(err);
          }
        }
      }),
    );

    assert.deepEqual(failures, [], 'no employee may fail at scale');

    const summary = await as(async (tx) => {
      const { rows } = await tx.query<{ total: number; with_document: number; notifications: number }>(
        `SELECT count(*)::int AS total,
                count(s.document_id)::int AS with_document,
                (SELECT count(*)::int FROM notification.notification n
                  WHERE n.template_code = 'payroll.payslip_available') AS notifications
           FROM payroll.salary_slip s
          WHERE s.id = ANY($1::uuid[])`,
        [slips],
      );
      return rows[0]!;
    });

    assert.equal(summary.total, SCALE);
    assert.equal(summary.with_document, SCALE, 'every employee must end with a payslip');
    assert.ok(summary.notifications >= SCALE, 'every employee must be told their payslip is ready');
  });

  async function outboxCount(): Promise<number> {
    return as(async (tx) => {
      const { rows } = await tx.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM integration.event_outbox
          WHERE event_type = 'SalarySlipGenerated'`,
      );
      return rows[0]!.count;
    });
  }
});
