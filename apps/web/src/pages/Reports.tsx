import { useState } from 'react';
import { formatDate, get, post, today } from '../lib/api.ts';
import {
  Alert, Badge, Card, Empty, ErrorMessage, Field, Loading, Page, Table, useLoad,
} from '../components/ui.tsx';

type ReportDefinition = {
  type: string;
  permission: string;
  sensitive: boolean;
  grain: string;
  columns: string[];
};

type ReportRun = {
  id: string;
  report_type: string;
  status: string;
  parameters: { dateFrom?: string; dateTo?: string } | null;
  row_count: number | null;
  document_id: string | null;
  requested_at: string;
  completed_at: string | null;
  failure_reason: string | null;
};

const LABELS: Record<string, string> = {
  headcount: 'Headcount',
  attendance: 'Attendance',
  absence: 'Absence',
  overtime: 'Overtime',
  leave: 'Leave',
  payroll_cost: 'Payroll cost',
  compensation: 'Compensation',
  expenses: 'Expenses',
  audit_activity: 'Audit activity',
};

/**
 * One reporting surface for all nine reports.
 *
 * There is a single framework here rather than nine pages: every report takes the same
 * parameters, runs the same way and produces the same artefact, and what differs — its
 * permission, whether it is sensitive, its grain and its columns — is data the catalogue
 * already returns. A report added to the backend appears here without a front-end change.
 *
 * The catalogue endpoint is already narrowed to what the caller may run, so this screen never
 * has to decide what to hide: listing a report somebody cannot run would be a list of things
 * to go and ask an administrator for.
 *
 * Generation is asynchronous — the API accepts the request and a worker produces the export —
 * so the run appears immediately as `pending` and the list is refreshed rather than the screen
 * pretending to wait.
 */
export function ReportsPage() {
  const types = useLoad(() => get<{ types: ReportDefinition[] }>('/api/reports/types'), []);
  const runs = useLoad(() => get<{ runs: ReportRun[] }>('/api/reports?limit=50'), []);

  const [selected, setSelected] = useState<string>('');
  const [range, setRange] = useState(() => {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { dateFrom: start.toISOString().slice(0, 10), dateTo: today() };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const available = types.data?.types ?? [];
  const definition = available.find((d) => d.type === selected) ?? null;

  async function run() {
    const found: Record<string, string> = {};
    if (!selected) found.type = 'Choose a report.';
    if (range.dateTo < range.dateFrom) found.dateTo = 'The end cannot precede the start.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await post('/api/reports', {
        reportType: selected,
        parameters: { dateFrom: range.dateFrom, dateTo: range.dateTo },
      });
      setMessage('Requested. It is generated in the background and appears below.');
      runs.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function download(runId: string) {
    setError(null);
    try {
      const result = await get<{ url: string }>(`/api/reports/${runId}/download-url`);
      // The local driver returns a path; a browser resolves it against this origin.
      window.open(new URL(result.url, window.location.origin).toString(), '_blank', 'noopener');
    } catch (err) {
      setError(err);
    }
  }

  if (types.loading) return <Loading label="Loading the report catalogue" />;

  return (
    <Page
      title="Reports"
      subtitle="Generated from finalized data. Exports are produced in the background."
      actions={<button onClick={() => runs.reload()}>Refresh</button>}
    >
      <ErrorMessage error={error} />
      <ErrorMessage error={types.error} />
      {message && <Alert kind="success">{message}</Alert>}

      {available.length === 0 ? (
        <Card>
          <Empty title="No reports available to you">
            Reports are gated on the permission that protects their data. Your role holds none
            of them.
          </Empty>
        </Card>
      ) : (
        <Card title="Run a report">
          <div className="row">
            <Field label="Report" required htmlFor="r-type" error={errors.type}>
              <select id="r-type" value={selected}
                aria-invalid={errors.type ? 'true' : undefined}
                onChange={(e) => setSelected(e.target.value)}>
                <option value="">Choose&hellip;</option>
                {available.map((d) => (
                  <option key={d.type} value={d.type}>
                    {LABELS[d.type] ?? d.type.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="From" required htmlFor="r-from">
              <input id="r-from" type="date" value={range.dateFrom}
                onChange={(e) => setRange({ ...range, dateFrom: e.target.value })} />
            </Field>
            <Field label="To" required htmlFor="r-to" error={errors.dateTo}
              hint={definition?.grain === 'point_in_time' ? 'This report is as-of this date.' : undefined}>
              <input id="r-to" type="date" value={range.dateTo}
                aria-invalid={errors.dateTo ? 'true' : undefined}
                onChange={(e) => setRange({ ...range, dateTo: e.target.value })} />
            </Field>
            <div className="shrink">
              <button className="primary" disabled={busy} onClick={run}>Generate</button>
            </div>
          </div>

          {definition && (
            <p className="muted small" style={{ marginBottom: 0 }}>
              {definition.sensitive && <><Badge value="warn" /> Sensitive — downloads are audited. </>}
              Columns: {definition.columns.join(', ')}.
            </p>
          )}
        </Card>
      )}

      <Card title="Recent reports" flush>
        {runs.loading ? (
          <Loading label="Loading recent reports" />
        ) : (
          <Table
            caption="Recently generated reports"
            rows={runs.data?.runs ?? []}
            keyOf={(row) => row.id}
            empty={<Empty title="Nothing generated yet">Run a report above.</Empty>}
            columns={[
              {
                header: 'Report',
                render: (r) => LABELS[r.report_type] ?? r.report_type.replace(/_/g, ' '),
              },
              {
                header: 'Range',
                render: (r) => (r.parameters?.dateFrom
                  ? `${r.parameters.dateFrom} to ${r.parameters.dateTo}`
                  : <span className="muted">—</span>),
              },
              { header: 'Requested', render: (r) => formatDate(r.requested_at) },
              { header: 'Rows', numeric: true, render: (r) => r.row_count ?? <span className="muted">—</span> },
              {
                header: 'Status',
                render: (r) => (
                  <span className="stack" style={{ gap: 2 }}>
                    <Badge value={r.status} />
                    {r.failure_reason && <span className="muted small">{r.failure_reason}</span>}
                  </span>
                ),
              },
              {
                header: '',
                render: (r) => (r.status === 'completed' && r.document_id
                  ? <button className="small" onClick={() => download(r.id)}>Download</button>
                  : <span className="muted small">
                      {r.status === 'pending' || r.status === 'running' ? 'generating…' : ''}
                    </span>),
              },
            ]}
          />
        )}
      </Card>
    </Page>
  );
}
