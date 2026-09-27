import { useState } from 'react';
import { can, currentSession, formatDate, formatDays, formatMinutes, get, post } from '../lib/api.ts';
import { Badge, Card, ErrorMessage, Loading, Page, Stat, Table, useLoad } from '../components/ui.tsx';

type Day = {
  date: string;
  status: string;
  first_in_at: string | null;
  last_out_at: string | null;
  working_minutes: number;
  late_minutes: number;
  early_exit_minutes: number;
  overtime_minutes: number;
  lop_units: string;
  has_missing_punch: boolean;
  is_corrected: boolean;
};

type Summary = {
  present: number;
  absent: number;
  half_day: number;
  on_leave: number;
  weekly_off: number;
  holiday: number;
  lop_units: number;
  working_minutes: number;
  overtime_minutes: number;
};

type Correction = {
  id: string;
  attendance_date: string;
  reason: string;
  status: string;
  proposed_status: string | null;
};

function monthRange(offsetMonths = 0): { from: string; to: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

export function AttendancePage() {
  const employeeId = currentSession()?.user.employeeId ?? null;
  const [range, setRange] = useState(monthRange());

  const attendance = useLoad(
    () =>
      employeeId
        ? get<{ summary: Summary; days: Day[] }>(
            `/api/attendance?employeeId=${employeeId}&from=${range.from}&to=${range.to}`,
          )
        : Promise.resolve(null),
    [employeeId, range.from, range.to],
  );

  const corrections = useLoad(
    () =>
      employeeId
        ? get<{ corrections: Correction[] }>(`/api/attendance/corrections?employeeId=${employeeId}`)
        : Promise.resolve({ corrections: [] }),
    [employeeId],
  );

  if (!employeeId) {
    return (
      <Page title="Attendance">
        <Card>
          <p className="muted" style={{ margin: 0 }}>This account is not linked to an employee record.</p>
        </Card>
      </Page>
    );
  }

  const summary = attendance.data?.summary;

  return (
    <Page
      title="Attendance"
      subtitle="Attendance is derived from your check-ins. Raw check-ins are never edited; corrections are requested and approved."
      actions={
        <div className="inline">
          <button onClick={() => setRange(monthRange(-1))}>Previous month</button>
          <button onClick={() => setRange(monthRange())}>This month</button>
        </div>
      }
    >
      <ErrorMessage error={attendance.error} />

      {summary && (
        <div className="grid cols-4" style={{ marginBottom: 16 }}>
          <Stat label="Present" value={summary.present} hint={`${summary.half_day} half day(s)`} />
          <Stat label="Absent" value={summary.absent} />
          <Stat label="On leave" value={summary.on_leave} />
          <Stat label="Hours worked" value={formatMinutes(summary.working_minutes)} hint={`${formatMinutes(summary.overtime_minutes)} overtime`} />
          <Stat label="Loss of pay" value={formatDays(summary.lop_units)} hint="days" />
        </div>
      )}

      <Card title={`${formatDate(range.from)} – ${formatDate(range.to)}`}>
        {attendance.loading ? (
          <Loading />
        ) : (
          <Table
            rows={attendance.data?.days ?? []}
            keyOf={(row) => row.date}
            empty="No attendance derived for this period yet."
            columns={[
              { header: 'Date', render: (r) => formatDate(r.date) },
              { header: 'Status', render: (r) => <Badge value={r.status} /> },
              {
                header: 'In / Out',
                render: (r) => (
                  <span className="mono small">
                    {r.first_in_at ? new Date(r.first_in_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—'}
                    {' → '}
                    {r.last_out_at ? new Date(r.last_out_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—'}
                  </span>
                ),
              },
              { header: 'Worked', numeric: true, render: (r) => formatMinutes(r.working_minutes) },
              { header: 'Late', numeric: true, render: (r) => (r.late_minutes ? formatMinutes(r.late_minutes) : '—') },
              { header: 'Overtime', numeric: true, render: (r) => formatMinutes(r.overtime_minutes) },
              { header: 'LOP', numeric: true, render: (r) => (Number(r.lop_units) ? formatDays(r.lop_units) : '—') },
              {
                header: '',
                render: (r) => (
                  <span className="inline small">
                    {r.has_missing_punch && <span className="badge warn">missing punch</span>}
                    {r.is_corrected && <span className="badge info">corrected</span>}
                  </span>
                ),
              },
            ]}
          />
        )}
      </Card>

      <CorrectionCard employeeId={employeeId} onRaised={corrections.reload} />

      <Card title="Correction requests">
        {corrections.loading ? (
          <Loading />
        ) : (
          <Table
            rows={corrections.data?.corrections ?? []}
            keyOf={(row) => row.id}
            empty="No correction requests."
            columns={[
              { header: 'Date', render: (r) => formatDate(r.attendance_date) },
              { header: 'Reason', render: (r) => r.reason },
              { header: 'Proposed', render: (r) => (r.proposed_status ? <Badge value={r.proposed_status} /> : 'time change') },
              { header: 'Status', render: (r) => <Badge value={r.status} /> },
            ]}
          />
        )}
      </Card>
    </Page>
  );
}

function CorrectionCard({ employeeId, onRaised }: { employeeId: string; onRaised: () => void }) {
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [inAt, setInAt] = useState('');
  const [outAt, setOutAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  if (!can('attendance.read.self')) return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await post('/api/attendance/corrections', {
        employeeId,
        attendanceDate: date,
        reason,
        // Times are sent as absolute instants; the engine resolves them against the shift.
        proposedInAt: inAt ? new Date(`${date}T${inAt}`).toISOString() : undefined,
        proposedOutAt: outAt ? new Date(`${date}T${outAt}`).toISOString() : undefined,
      });
      setDone(true);
      setReason('');
      setInAt('');
      setOutAt('');
      onRaised();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Request a correction">
      <ErrorMessage error={error} />
      {done && (
        <div className="alert success">
          Request submitted. Your original check-ins are unchanged — attendance is re-derived
          only after the correction is approved.
        </div>
      )}
      <form onSubmit={submit}>
        <div className="row">
          <div>
            <label htmlFor="cdate">Date</label>
            <input id="cdate" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="cin">Actual in</label>
            <input id="cin" type="time" value={inAt} onChange={(e) => setInAt(e.target.value)} />
          </div>
          <div>
            <label htmlFor="cout">Actual out</label>
            <input id="cout" type="time" value={outAt} onChange={(e) => setOutAt(e.target.value)} />
          </div>
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="creason">Reason</label>
          <input
            id="creason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Forgot to check out"
            required
            minLength={3}
          />
        </div>
        <button className="primary" type="submit" disabled={busy || !date || (!inAt && !outAt)}>
          {busy ? 'Submitting…' : 'Request correction'}
        </button>
      </form>
    </Card>
  );
}
