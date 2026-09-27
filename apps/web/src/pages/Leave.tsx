import { useState, type FormEvent } from 'react';
import { can, currentSession, formatDate, formatDays, get, post, today } from '../lib/api.ts';
import { Badge, Card, ErrorMessage, Loading, Page, Table, useLoad } from '../components/ui.tsx';

type LeaveType = { id: string; name: string; code: string; allow_half_day: boolean; is_lop: boolean };
type Application = {
  id: string;
  leave_type_name: string;
  start_date: string;
  end_date: string;
  quantity: string;
  status: string;
  reason: string | null;
  decision_note: string | null;
};
type Balance = { leave_type_id: string; code: string; name: string; allocated: number; consumed: number; balance: number };
type LedgerEntry = {
  id: string;
  entry_type: string;
  quantity: string;
  effective_date: string;
  leave_type: string;
  source_type: string;
  notes: string | null;
};

export function LeavePage() {
  const employeeId = currentSession()?.user.employeeId ?? null;
  const [tab, setTab] = useState<'applications' | 'ledger'>('applications');

  const types = useLoad(() => get<{ leave_types: LeaveType[] }>('/api/leave/types'), []);
  const balances = useLoad(
    () =>
      employeeId
        ? get<{ balances: Balance[] }>(`/api/leave/balance?employeeId=${employeeId}&asOf=${today()}`)
        : Promise.resolve({ balances: [] }),
    [employeeId],
  );
  const applications = useLoad(
    () =>
      employeeId
        ? get<{ applications: Application[] }>(`/api/leave/applications?employeeId=${employeeId}`)
        : Promise.resolve({ applications: [] }),
    [employeeId],
  );
  const ledger = useLoad(
    () =>
      employeeId && tab === 'ledger'
        ? get<{ entries: LedgerEntry[] }>(`/api/leave/ledger?employeeId=${employeeId}&limit=100`)
        : Promise.resolve({ entries: [] }),
    [employeeId, tab],
  );

  function refreshAll() {
    balances.reload();
    applications.reload();
    ledger.reload();
  }

  if (!employeeId) {
    return (
      <Page title="Leave">
        <Card>
          <p className="muted" style={{ margin: 0 }}>This account is not linked to an employee record.</p>
        </Card>
      </Page>
    );
  }

  return (
    <Page title="Leave" subtitle="Balances are derived from the leave ledger, not stored as a running total.">
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        {(balances.data?.balances ?? []).map((b) => (
          <div className={b.balance < 0 ? 'stat actionable' : 'stat'} key={b.leave_type_id}>
            <div className="label">{b.name}</div>
            {/* A negative balance means more was taken than allocated. Shown plainly it
                reads as an ordinary figure, so it is marked and named. */}
            <div className="value" style={b.balance < 0 ? { color: 'var(--danger)' } : undefined}>
              {formatDays(b.balance)}
            </div>
            <div className="hint">
              {b.allocated} allocated · {b.consumed} used
            </div>
          </div>
        ))}
      </div>

      {can('leave.apply') && (
        <ApplyForm
          employeeId={employeeId}
          types={types.data?.leave_types ?? []}
          onApplied={refreshAll}
        />
      )}

      <Card
        title={tab === 'applications' ? 'My applications' : 'Ledger'}
        actions={
          <div className="segmented" role="group" aria-label="View">
            <button
              aria-pressed={tab === 'applications'}
              onClick={() => setTab('applications')}
            >
              Applications
            </button>
            <button aria-pressed={tab === 'ledger'} onClick={() => setTab('ledger')}>
              Ledger
            </button>
          </div>
        }
      >
        {tab === 'applications' ? (
          applications.loading ? (
            <Loading />
          ) : (
            <>
              <ErrorMessage error={applications.error} />
              <Table
                rows={applications.data?.applications ?? []}
                keyOf={(row) => row.id}
                empty="No leave applications yet."
                columns={[
                  { header: 'Type', render: (r) => r.leave_type_name },
                  { header: 'From', render: (r) => formatDate(r.start_date) },
                  { header: 'To', render: (r) => formatDate(r.end_date) },
                  { header: 'Days', numeric: true, render: (r) => formatDays(r.quantity) },
                  { header: 'Status', render: (r) => <Badge value={r.status} /> },
                  {
                    header: '',
                    render: (r) =>
                      ['submitted', 'pending_approval', 'approved'].includes(r.status) ? (
                        <CancelButton id={r.id} onDone={refreshAll} />
                      ) : (
                        <span className="muted small">{r.decision_note ?? ''}</span>
                      ),
                  },
                ]}
              />
            </>
          )
        ) : ledger.loading ? (
          <Loading />
        ) : (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              Every entry is append-only. A cancellation adds a reversal rather than removing
              the original consumption.
            </p>
            <Table
              rows={ledger.data?.entries ?? []}
              keyOf={(row) => row.id}
              empty="No ledger entries yet."
              columns={[
                { header: 'Date', render: (r) => formatDate(r.effective_date) },
                { header: 'Type', render: (r) => r.leave_type },
                { header: 'Entry', render: (r) => <Badge value={r.entry_type} /> },
                {
                  header: 'Quantity',
                  numeric: true,
                  render: (r) => (
                    <span style={{ color: Number(r.quantity) < 0 ? 'var(--danger)' : 'var(--success)' }}>
                      {Number(r.quantity) > 0 ? '+' : ''}
                      {r.quantity}
                    </span>
                  ),
                },
                { header: 'Source', render: (r) => <span className="small muted">{r.source_type.replace(/_/g, ' ')}</span> },
              ]}
            />
          </>
        )}
      </Card>
    </Page>
  );
}

function CancelButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await post(`/api/leave/applications/${id}/cancel`, { reason: 'Cancelled by employee' });
          onDone();
        } finally {
          setBusy(false);
        }
      }}
    >
      Cancel
    </button>
  );
}

function ApplyForm({
  employeeId,
  types,
  onApplied,
}: {
  employeeId: string;
  types: LeaveType[];
  onApplied: () => void;
}) {
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState(today());
  const [startHalfDay, setStartHalfDay] = useState(false);
  const [endHalfDay, setEndHalfDay] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<string | null>(null);

  const selected = types.find((t) => t.id === leaveTypeId);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await post<{ quantity: number; status: string; excluded_days: number }>(
        '/api/leave/applications',
        { employeeId, leaveTypeId, startDate, endDate, startHalfDay, endHalfDay, reason: reason || undefined },
      );
      setResult(
        `${response.quantity} day(s) requested — ${response.status.replace(/_/g, ' ')}` +
          (response.excluded_days > 0
            ? `. ${response.excluded_days} non-working day(s) in the range were not counted.`
            : '.'),
      );
      setReason('');
      onApplied();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Apply for leave">
      <ErrorMessage error={error} />
      {result && <div className="alert success">{result}</div>}

      <form onSubmit={submit}>
        <div className="row">
          <div>
            <label htmlFor="type">Leave type</label>
            <select id="type" value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} required>
              <option value="">Select…</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.is_lop ? ' (unpaid)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="from">From</label>
            <input id="from" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="to">To</label>
            <input id="to" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
          </div>
        </div>

        {selected?.allow_half_day && (
          <div className="row" style={{ marginTop: 10 }}>
            <label className="inline" style={{ marginBottom: 0 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={startHalfDay}
                onChange={(e) => setStartHalfDay(e.target.checked)}
              />
              First day is a half day
            </label>
            <label className="inline" style={{ marginBottom: 0 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={endHalfDay}
                onChange={(e) => setEndHalfDay(e.target.checked)}
              />
              Last day is a half day
            </label>
          </div>
        )}

        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="reason">Reason</label>
          <input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" />
        </div>

        <button className="primary" type="submit" disabled={busy || !leaveTypeId}>
          {busy ? 'Submitting…' : 'Submit request'}
        </button>
      </form>
    </Card>
  );
}
