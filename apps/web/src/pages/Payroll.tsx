import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { can, formatDate, formatMoney, get, post } from '../lib/api.ts';
import {
  Alert, Badge, Card, Empty, ErrorMessage, Field, Loading, Modal, Page, Stat, Table, useLoad,
} from '../components/ui.tsx';

type Period = {
  id: string;
  name: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  status: string;
  /** The most recent run for this period, when one exists. */
  latest_run_id: string | null;
  latest_run_status: string | null;
};

type Run = {
  id: string;
  status: string;
  run_type: string;
  calculation_version: string;
  employee_count: number;
  total_gross: string;
  total_deduction: string;
  total_net: string;
  failure_reason: string | null;
  period_name: string;
  period_start: string;
  period_end: string;
  failed_count: number;
};

type RunEmployee = {
  employee_id: string;
  employee_code: string;
  name: string;
  status: string;
  gross_amount: string;
  deduction_amount: string;
  tax_amount: string;
  net_amount: string;
  failure_reason: string | null;
  salary_slip_id: string | null;
  lop_days: string | null;
  payable_days: string | null;
};

export function PayrollPage() {
  const navigate = useNavigate();
  const periods = useLoad(() => get<{ periods: Period[] }>('/api/payroll-periods'), []);
  const companies = useLoad(
    () => get<{ companies: Array<{ id: string; name: string }> }>('/api/companies')
      .catch(() => ({ companies: [] as Array<{ id: string; name: string }> })),
    [],
  );
  const [creating, setCreating] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [startedRunId, setStartedRunId] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Array<{ employee_id: string; reason: string }>>([]);

  /**
   * Starting a run.
   *
   * Payroll refuses to snapshot days attendance never evaluated (ADR-007), because doing so
   * under-reports loss of pay. In production the scheduler closes each day as the tenant's
   * cutoff passes; a period the scheduler has not reached yet therefore has to be overridden
   * deliberately, with a stated reason that is audited as sensitive.
   *
   * So a refusal here is not an error to retry — it is a decision to take, and the screen
   * opens the readiness panel rather than showing a raw 422.
   */
  async function startRun(periodId: string, override?: { reason: string }) {
    setBusy(true);
    setError(null);
    setSkipped([]);
    try {
      const result = await post<{ id: string; skipped: Array<{ employee_id: string; reason: string }> }>(
        '/api/payroll-runs',
        {
          payrollPeriodId: periodId,
          ...(override
            ? {
                allowIncompleteAttendance: true,
                incompleteAttendanceReason: override.reason,
              }
            : {}),
        },
      );
      setStartedRunId(result.id);
      setSkipped(result.skipped ?? []);
      setBlocked(null);
    } catch (err) {
      // `attendance_not_closed` is the one refusal with a route forward.
      const code = (err as { code?: string })?.code;
      if (code === 'attendance_not_closed') setBlocked(periodId);
      else setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page
      title="Payroll"
      subtitle="Creating a run freezes its inputs. Calculation happens asynchronously against that snapshot."
      actions={
        can('payroll.run') && !creating ? (
          <button className="primary" onClick={() => setCreating(true)}>New period</button>
        ) : undefined
      }
    >
      <ErrorMessage error={error} />

      {blocked && (
        <AttendanceReadiness
          periodId={blocked}
          onClose={() => setBlocked(null)}
          onOverride={(reason) => startRun(blocked, { reason })}
          busy={busy}
        />
      )}

      {creating && (
        <NewPeriod
          companies={companies.data?.companies ?? []}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); periods.reload(); }}
        />
      )}

      {startedRunId && (
        <div className="alert success">
          Run created. <Link to={`/payroll/${startedRunId}`}>Open it</Link> to watch the calculation
          and review the result.
          {skipped.length > 0 && (
            <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {skipped.map((s) => (
                <li key={s.employee_id}>
                  {s.employee_id}: {s.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Card title="Payroll periods">
        {periods.loading ? (
          <Loading />
        ) : (
          <Table
            rows={periods.data?.periods ?? []}
            keyOf={(row) => row.id}
            caption="Payroll periods, most recent first"
            onRowClick={(r) => { if (r.latest_run_id) navigate(`/payroll/${r.latest_run_id}`); }}
            empty={
              <Empty title="No payroll periods yet">
                A period is the window payroll is calculated for. Create one to start a run.
              </Empty>
            }
            columns={[
              { header: 'Period', render: (r) => r.name },
              { header: 'From', render: (r) => formatDate(r.period_start) },
              { header: 'To', render: (r) => formatDate(r.period_end) },
              { header: 'Pay date', render: (r) => formatDate(r.pay_date) },
              { header: 'Status', render: (r) => <Badge value={r.status} /> },
              {
                header: 'Run',
                render: (r) =>
                  r.latest_run_status ? <Badge value={r.latest_run_status} /> : <span className="muted">—</span>,
              },
              {
                header: '',
                render: (r) =>
                  can('payroll.run') && r.status === 'open' ? (
                    <button className="primary" disabled={busy} onClick={() => startRun(r.id)}>
                      Start run
                    </button>
                  ) : r.latest_run_id ? (
                    // The row is clickable too, but a visible link is what tells you so.
                    <Link to={`/payroll/${r.latest_run_id}`} onClick={(e) => e.stopPropagation()}>
                      Open run
                    </Link>
                  ) : null,
              },
            ]}
          />
        )}
      </Card>
    </Page>
  );
}

export function PayrollRunPage() {
  const { id } = useParams<{ id: string }>();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const run = useLoad(() => get<Run>(`/api/payroll-runs/${id}`), [id]);
  const employees = useLoad(
    () => get<{ employees: RunEmployee[] }>(`/api/payroll-runs/${id}/employees`),
    [id],
  );

  async function act(action: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/payroll-runs/${id}/${action}`, body);
      run.reload();
      employees.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (run.loading) return <Loading />;
  if (run.error) return <ErrorMessage error={run.error} />;
  if (!run.data) return null;

  const r = run.data;

  // Mirrors the per-button conditions below. Kept next to them so the two cannot drift:
  // if this says there are actions, at least one button renders.
  const hasActions =
    (r.status === 'calculated' && can('payroll.run')) ||
    (r.status === 'under_review' && can('payroll.approve')) ||
    (r.status === 'approved' && can('payroll.finalize')) ||
    (['calculated', 'under_review', 'failed'].includes(r.status) && can('payroll.run')) ||
    (!['finalized', 'paid', 'payment_pending', 'cancelled'].includes(r.status) && can('payroll.run'));
  const isCalculating = r.status === 'calculating' || r.status === 'validating';

  return (
    <Page
      title={`Payroll — ${r.period_name}`}
      subtitle={
        <span className="inline">
          <Badge value={r.status} />
          <span className="muted small">
            {formatDate(r.period_start)} – {formatDate(r.period_end)} · {r.calculation_version}
          </span>
        </span>
      }
      actions={<Link to="/payroll">Back to payroll</Link>}
    >
      <ErrorMessage error={error} />

      {isCalculating && (
        <div className="alert info">
          The payroll engine is calculating from the frozen snapshot.{' '}
          <button onClick={() => { run.reload(); employees.reload(); }}>Refresh</button>
        </div>
      )}

      {r.failure_reason && <div className="alert error">{r.failure_reason}</div>}

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat label="Employees" value={r.employee_count} hint={r.failed_count > 0 ? `${r.failed_count} failed` : 'all calculated'} />
        <Stat label="Gross" value={formatMoney(r.total_gross)} />
        <Stat label="Deductions" value={formatMoney(r.total_deduction)} />
        <Stat label="Net payable" value={formatMoney(r.total_net)} />
      </div>

      {/* Every action is gated by status and permission, so a terminal run leaves the
          card empty — previously it still rendered as "Actions" with a lone note pushed
          to the right by a spacer. Say what state the run is in instead. */}
      {!hasActions ? (
        <Card title={r.status === 'finalized' ? 'This run is closed' : 'No actions available'}>
          <p className="muted" style={{ margin: 0 }}>
            {r.status === 'finalized'
              ? 'Corrections now require an adjustment or a supplementary run.'
              : `Nothing can be done to a run in the ${r.status.replace(/_/g, ' ')} state from here.`}
          </p>
        </Card>
      ) : (
      <Card title="Actions">
        <div className="inline">
          {r.status === 'calculated' && can('payroll.run') && (
            <button className="primary" disabled={busy} onClick={() => act('review')}>
              Send for review
            </button>
          )}
          {r.status === 'under_review' && can('payroll.approve') && (
            <button className="primary" disabled={busy || r.failed_count > 0} onClick={() => act('approve')}>
              Approve
            </button>
          )}
          {r.status === 'approved' && can('payroll.finalize') && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                if (window.confirm('Finalizing makes every payslip in this run immutable. Continue?')) {
                  void act('finalize');
                }
              }}
            >
              Finalize
            </button>
          )}
          {['calculated', 'under_review', 'failed'].includes(r.status) && can('payroll.run') && (
            <button disabled={busy} onClick={() => act('recalculate')}>
              Recalculate
            </button>
          )}
          {!['finalized', 'paid', 'payment_pending', 'cancelled'].includes(r.status) && can('payroll.run') && (
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                const reason = window.prompt('Reason for cancelling this run');
                if (reason) void act('cancel', { reason });
              }}
            >
              Cancel run
            </button>
          )}
        </div>
      </Card>
      )}

      <Card title="Employees in this run">
        {employees.loading ? (
          <Loading />
        ) : (
          <Table
            rows={employees.data?.employees ?? []}
            keyOf={(row) => row.employee_id}
            empty="No employees in this run."
            columns={[
              { header: 'Code', render: (e) => <span className="mono">{e.employee_code}</span> },
              { header: 'Name', render: (e) => e.name },
              { header: 'Paid days', numeric: true, render: (e) => e.payable_days ?? '—' },
              { header: 'LOP', numeric: true, render: (e) => (Number(e.lop_days) ? e.lop_days : '—') },
              { header: 'Gross', numeric: true, render: (e) => formatMoney(e.gross_amount) },
              { header: 'Deductions', numeric: true, render: (e) => formatMoney(e.deduction_amount) },
              { header: 'Tax', numeric: true, render: (e) => formatMoney(e.tax_amount) },
              { header: 'Net', numeric: true, render: (e) => <strong>{formatMoney(e.net_amount)}</strong> },
              {
                header: 'Status',
                render: (e) =>
                  e.status === 'failed' ? (
                    <span title={e.failure_reason ?? ''}>
                      <Badge value="failed" />
                    </span>
                  ) : (
                    <Badge value={e.status} />
                  ),
              },
            ]}
          />
        )}

        {(employees.data?.employees ?? []).some((e) => e.status === 'failed') && (
          <div className="alert error" style={{ marginTop: 14 }}>
            <strong>Failed employees</strong>
            <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {(employees.data?.employees ?? [])
                .filter((e) => e.status === 'failed')
                .map((e) => (
                  <li key={e.employee_id}>
                    {e.employee_code}: {e.failure_reason}
                  </li>
                ))}
            </ul>
            <p className="small" style={{ marginBottom: 0 }}>
              Fix the underlying data and recalculate. The run cannot be approved while any
              employee has failed.
            </p>
          </div>
        )}
      </Card>
    </Page>
  );
}


/**
 * Creating a payroll period.
 *
 * A period is the window a run calculates over, and the server derives its tax year from the
 * dates — which is why the response reports that tax year back and this form shows it. The
 * form validates only what it can say something useful about before the request; every other
 * rule (overlapping periods, a locked tax year, a company that cannot run payroll) belongs to
 * the server and its message is surfaced unchanged.
 */
function NewPeriod({
  companies, onClose, onCreated,
}: {
  companies: Array<{ id: string; name: string }>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const firstOfMonth = new Date();
  const start = new Date(Date.UTC(firstOfMonth.getUTCFullYear(), firstOfMonth.getUTCMonth(), 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const [form, setForm] = useState({
    companyId: companies[0]?.id ?? '',
    name: start.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    periodStart: iso(start),
    periodEnd: iso(end),
    payDate: iso(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1))),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<{ label: string } | null>(null);

  const set = (key: string, value: string) => setForm({ ...form, [key]: value });

  async function submit() {
    const found: Record<string, string> = {};
    if (!form.companyId) found.companyId = 'A period belongs to a company.';
    if (!form.name.trim()) found.name = 'Give the period a name.';
    if (form.periodEnd < form.periodStart) found.periodEnd = 'The end cannot precede the start.';
    if (form.payDate < form.periodStart) found.payDate = 'Pay date cannot precede the period.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      const result = await post<{ id: string; tax_year: { label: string } }>(
        '/api/payroll-periods',
        {
          companyId: form.companyId,
          name: form.name.trim(),
          periodStart: form.periodStart,
          periodEnd: form.periodEnd,
          payDate: form.payDate,
        },
      );
      setCreated({ label: result.tax_year?.label ?? '' });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New payroll period"
      onClose={onClose}
      footer={
        created ? (
          <button className="primary" onClick={onCreated}>Done</button>
        ) : (
          <>
            <button onClick={onClose} disabled={busy}>Cancel</button>
            <button className="primary" onClick={submit} disabled={busy}>Create period</button>
          </>
        )
      }
    >
      <ErrorMessage error={error} />

      {created ? (
        <Alert kind="success">
          Period created{created.label ? ` in tax year ${created.label}` : ''}. You can start a
          run against it from the list.
        </Alert>
      ) : (
        <>
          {companies.length === 0 && (
            <Alert kind="warning">
              There is no company in this workspace yet. Create one under Organization first —
              payroll is run per company.
            </Alert>
          )}

          <Field label="Company" required htmlFor="p-company" error={errors.companyId}>
            <select id="p-company" value={form.companyId}
              aria-invalid={errors.companyId ? 'true' : undefined}
              onChange={(e) => set('companyId', e.target.value)}>
              <option value="">Choose&hellip;</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>

          <Field label="Name" required htmlFor="p-name" error={errors.name}
            hint="How this period is referred to, for example &ldquo;June 2026&rdquo;.">
            <input id="p-name" value={form.name}
              aria-invalid={errors.name ? 'true' : undefined}
              onChange={(e) => set('name', e.target.value)} />
          </Field>

          <div className="row">
            <Field label="Period start" required htmlFor="p-start">
              <input id="p-start" type="date" value={form.periodStart}
                onChange={(e) => set('periodStart', e.target.value)} />
            </Field>
            <Field label="Period end" required htmlFor="p-end" error={errors.periodEnd}>
              <input id="p-end" type="date" value={form.periodEnd}
                aria-invalid={errors.periodEnd ? 'true' : undefined}
                onChange={(e) => set('periodEnd', e.target.value)} />
            </Field>
            <Field label="Pay date" required htmlFor="p-pay" error={errors.payDate}
              hint="Determines the tax year.">
              <input id="p-pay" type="date" value={form.payDate}
                aria-invalid={errors.payDate ? 'true' : undefined}
                onChange={(e) => set('payDate', e.target.value)} />
            </Field>
          </div>
        </>
      )}
    </Modal>
  );
}


/**
 * Why payroll refused, and the one way past it.
 *
 * Shows the actual coverage the server reports rather than restating the error, because the
 * decision an operator has to make is "how much is missing, and am I willing to say why" —
 * which needs the numbers. The reason is mandatory and at least ten characters because that
 * is what the API accepts, and because "test" on an audited override is worth nothing to
 * whoever reads it later.
 */
function AttendanceReadiness({
  periodId, onClose, onOverride, busy,
}: {
  periodId: string;
  onClose: () => void;
  onOverride: (reason: string) => void;
  busy: boolean;
}) {
  const readiness = useLoad(
    () => get<{
      period_start: string; period_end: string;
      expected_days: number; closed_days: number; missing_days?: number;
    }>(`/api/payroll-periods/${periodId}/attendance-readiness`),
    [periodId],
  );
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);

  const data = readiness.data;
  const missing = data ? data.expected_days - data.closed_days : 0;

  return (
    <Modal
      title="Attendance is not closed for this period"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="danger"
            disabled={busy}
            onClick={() => {
              if (reason.trim().length < 10) {
                setReasonError('Say why, in at least ten characters — this is audited.');
                return;
              }
              onOverride(reason.trim());
            }}
          >
            Run anyway
          </button>
        </>
      }
    >
      {readiness.loading && <Loading label="Checking attendance coverage" />}
      <ErrorMessage error={readiness.error} />

      {data && (
        <>
          <Alert kind="warning">
            {missing} of {data.expected_days} day(s) in {data.period_start} to {data.period_end}{' '}
            have not been closed. Running payroll now would under-report loss of pay for those
            days.
          </Alert>
          <p className="muted small">
            Attendance closes automatically as each day passes. If this period is in the past,
            or you accept the incomplete data, you can override — the reason is recorded on the
            audit trail as a sensitive action.
          </p>
          <Field label="Reason for running anyway" required htmlFor="ar-reason" error={reasonError}>
            <textarea id="ar-reason" value={reason}
              aria-invalid={reasonError ? 'true' : undefined}
              onChange={(e) => { setReason(e.target.value); if (reasonError) setReasonError(null); }} />
          </Field>
        </>
      )}
    </Modal>
  );
}
