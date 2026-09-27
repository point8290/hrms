import { useState } from 'react';
import { can, get, post, put } from '../lib/api.ts';
import {
  Alert, Badge, Card, Empty, ErrorMessage, Field, Loading, Modal, Table, useLoad,
} from '../components/ui.tsx';

/**
 * The operational half of organization setup: the configuration a workspace needs before
 * anybody can actually take leave, be paid, or claim an expense.
 *
 * Split into its own file purely for size — these render inside the existing Organization
 * screen, under its tabs, using the same components and tokens. There is no second navigation
 * surface and no second configuration model.
 *
 * Everything here calls an API that already existed. Nothing was added to the backend for it.
 */

type Option = { id: string; name: string };

/** Entity types the workflow engine routes, from `WORKFLOW_ENTITIES`. */
const WORKFLOW_ENTITIES = [
  'leave_application', 'expense_claim', 'attendance_correction',
  'employee_change', 'payroll_run', 'separation',
] as const;

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

type LeaveType = {
  id: string; name: string; code: string; is_paid: boolean;
  allow_half_day: boolean; requires_approval: boolean; include_holidays: boolean;
};

export function LeaveSetup() {
  const types = useLoad(() => get<{ leave_types: LeaveType[] }>('/api/leave/types'), []);
  const employees = useLoad(
    () => get<{ employees: Array<{ id: string; employee_code: string; first_name: string; last_name: string }> }>(
      '/api/employees?scope=all&limit=200').catch(() => ({ employees: [] })),
    [],
  );
  const [adding, setAdding] = useState(false);
  const [allocating, setAllocating] = useState(false);

  const manages = can('leave.manage');

  return (
    <>
      <Card
        title="Leave types"
        flush
        actions={manages && !adding
          ? <button className="small primary" onClick={() => setAdding(true)}>Add leave type</button>
          : undefined}
      >
        {types.loading ? (
          <Loading label="Loading leave types" />
        ) : (
          <Table
            caption="Leave types"
            rows={types.data?.leave_types ?? []}
            keyOf={(row) => row.id}
            empty={
              <Empty title="No leave types yet">
                Nobody can apply for leave until at least one type exists.
              </Empty>
            }
            columns={[
              {
                header: 'Type',
                render: (r) => (
                  <span className="stack" style={{ gap: 2 }}>
                    <strong>{r.name}</strong>
                    <span className="muted small mono">{r.code}</span>
                  </span>
                ),
              },
              { header: 'Paid', render: (r) => <Badge value={r.is_paid ? 'active' : 'draft'} /> },
              { header: 'Half day', render: (r) => (r.allow_half_day ? 'allowed' : 'no') },
              { header: 'Approval', render: (r) => (r.requires_approval ? 'required' : 'automatic') },
            ]}
          />
        )}
      </Card>

      {manages && (
        <Card
          title="Allocations"
          actions={!allocating
            ? <button className="small" onClick={() => setAllocating(true)}>Allocate leave</button>
            : undefined}
        >
          <p className="muted small" style={{ margin: 0 }}>
            An employee's balance comes from allocations. Without one, a leave type exists but
            has no days behind it. Allocation history is on each employee's Leave tab.
          </p>
        </Card>
      )}

      {adding && (
        <NewLeaveType onClose={() => setAdding(false)} onCreated={() => { setAdding(false); types.reload(); }} />
      )}
      {allocating && (
        <NewAllocation
          leaveTypes={types.data?.leave_types ?? []}
          employees={employees.data?.employees ?? []}
          onClose={() => setAllocating(false)}
          onCreated={() => setAllocating(false)}
        />
      )}
    </>
  );
}

function NewLeaveType({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    name: '', code: '', isPaid: true, allowHalfDay: true,
    requiresApproval: true, includeHolidays: false, carryForwardEnabled: false, isLop: false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    const found: Record<string, string> = {};
    if (!form.name.trim()) found.name = 'Required.';
    if (!form.code.trim()) found.code = 'Required.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      await post('/api/leave/types', { ...form, name: form.name.trim(), code: form.code.trim().toUpperCase() });
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (key: keyof typeof form, label: string, hint?: string) => (
    <label className="inline" style={{ marginBottom: 8, fontWeight: 400 }}>
      <input type="checkbox" style={{ width: 'auto' }} checked={form[key] as boolean}
        onChange={(e) => setForm({ ...form, [key]: e.target.checked })} />
      <span>{label}{hint && <span className="muted small"> — {hint}</span>}</span>
    </label>
  );

  return (
    <Modal title="New leave type" onClose={onClose} footer={
      <>
        <button onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary" onClick={submit} disabled={busy}>Create</button>
      </>
    }>
      <ErrorMessage error={error} />
      <div className="row">
        <Field label="Name" required htmlFor="lt-name" error={errors.name}>
          <input id="lt-name" value={form.name} aria-invalid={errors.name ? 'true' : undefined}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Code" required htmlFor="lt-code" error={errors.code} hint="Short, e.g. EL.">
          <input id="lt-code" value={form.code} aria-invalid={errors.code ? 'true' : undefined}
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
        </Field>
      </div>
      <div className="stack" style={{ gap: 0 }}>
        {toggle('isPaid', 'Paid leave')}
        {toggle('allowHalfDay', 'Half days allowed')}
        {toggle('requiresApproval', 'Needs approval')}
        {toggle('includeHolidays', 'Counts holidays', 'holidays inside the range are deducted')}
        {toggle('carryForwardEnabled', 'Carries forward')}
        {toggle('isLop', 'Loss of pay', 'reduces payable days')}
      </div>
    </Modal>
  );
}

function NewAllocation({
  leaveTypes, employees, onClose, onCreated,
}: {
  leaveTypes: LeaveType[];
  employees: Array<{ id: string; employee_code: string; first_name: string; last_name: string }>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const year = new Date().getUTCFullYear();
  const [form, setForm] = useState({
    employeeId: '', leaveTypeId: '', quantity: '12',
    periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, proRateFromJoining: false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    const found: Record<string, string> = {};
    if (!form.employeeId) found.employeeId = 'Choose an employee.';
    if (!form.leaveTypeId) found.leaveTypeId = 'Choose a leave type.';
    if (!(Number(form.quantity) >= 0)) found.quantity = 'Enter a number of days.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      await post('/api/leave/allocations', {
        employeeId: form.employeeId,
        leaveTypeId: form.leaveTypeId,
        quantity: Number(form.quantity),
        periodStart: form.periodStart,
        periodEnd: form.periodEnd,
        proRateFromJoining: form.proRateFromJoining,
        source: 'manual',
      });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Allocate leave" onClose={onClose} footer={
      done ? <button className="primary" onClick={onCreated}>Done</button> : (
        <>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy}>Allocate</button>
        </>
      )
    }>
      <ErrorMessage error={error} />
      {done ? (
        <Alert kind="success">Allocated. The employee's balance reflects it immediately.</Alert>
      ) : (
        <>
          <Field label="Employee" required htmlFor="al-emp" error={errors.employeeId}>
            <select id="al-emp" value={form.employeeId}
              aria-invalid={errors.employeeId ? 'true' : undefined}
              onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
              <option value="">Choose&hellip;</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.first_name} {e.last_name} ({e.employee_code})</option>
              ))}
            </select>
          </Field>
          <div className="row">
            <Field label="Leave type" required htmlFor="al-type" error={errors.leaveTypeId}>
              <select id="al-type" value={form.leaveTypeId}
                aria-invalid={errors.leaveTypeId ? 'true' : undefined}
                onChange={(e) => setForm({ ...form, leaveTypeId: e.target.value })}>
                <option value="">Choose&hellip;</option>
                {leaveTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Days" required htmlFor="al-qty" error={errors.quantity}>
              <input id="al-qty" type="number" min="0" step="0.5" value={form.quantity}
                aria-invalid={errors.quantity ? 'true' : undefined}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
            </Field>
          </div>
          <div className="row">
            <Field label="Period start" htmlFor="al-start">
              <input id="al-start" type="date" value={form.periodStart}
                onChange={(e) => setForm({ ...form, periodStart: e.target.value })} />
            </Field>
            <Field label="Period end" htmlFor="al-end">
              <input id="al-end" type="date" value={form.periodEnd}
                onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} />
            </Field>
          </div>
          <label className="inline" style={{ fontWeight: 400 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={form.proRateFromJoining}
              onChange={(e) => setForm({ ...form, proRateFromJoining: e.target.checked })} />
            <span>Pro-rate from the joining date</span>
          </label>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

type HolidayList = {
  id: string; name: string; year: number; is_default: boolean;
  weekly_offs: number[]; location_id: string | null;
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function CalendarSetup() {
  const lists = useLoad(() => get<{ holiday_lists: HolidayList[] }>('/api/holiday-lists'), []);
  const [adding, setAdding] = useState(false);

  return (
    <>
      <Card
        title="Holiday calendars"
        flush
        actions={can('org.manage') && !adding
          ? <button className="small primary" onClick={() => setAdding(true)}>Add calendar</button>
          : undefined}
      >
        {lists.loading ? (
          <Loading label="Loading calendars" />
        ) : (
          <Table
            caption="Holiday calendars"
            rows={lists.data?.holiday_lists ?? []}
            keyOf={(row) => row.id}
            empty={
              <Empty title="No calendar yet">
                Attendance is derived against a calendar — weekly offs and holidays come from
                here.
              </Empty>
            }
            columns={[
              { header: 'Name', render: (r) => r.name },
              { header: 'Year', render: (r) => r.year },
              {
                header: 'Weekly offs',
                render: (r) => (r.weekly_offs ?? []).map((d) => DAYS[d]?.slice(0, 3)).join(', ') || '—',
              },
              { header: 'Default', render: (r) => (r.is_default ? <Badge value="active" /> : <span className="muted">—</span>) },
            ]}
          />
        )}
      </Card>

      {adding && (
        <NewHolidayList onClose={() => setAdding(false)} onCreated={() => { setAdding(false); lists.reload(); }} />
      )}
    </>
  );
}

function NewHolidayList({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const year = new Date().getUTCFullYear();
  const [form, setForm] = useState({ name: `Holidays ${year}`, year: String(year), isDefault: true });
  const [weeklyOffs, setWeeklyOffs] = useState<number[]>([0]);
  const [holidays, setHolidays] = useState<Array<{ date: string; name: string }>>([]);
  const [draft, setDraft] = useState({ date: '', name: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await post('/api/holiday-lists', {
        name: form.name.trim(),
        year: Number(form.year),
        isDefault: form.isDefault,
        weeklyOffs,
        holidays: holidays.map((h) => ({ ...h, isOptional: false })),
      });
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New holiday calendar" onClose={onClose} footer={
      <>
        <button onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary" onClick={submit} disabled={busy}>Create calendar</button>
      </>
    }>
      <ErrorMessage error={error} />
      <div className="row">
        <Field label="Name" required htmlFor="hl-name">
          <input id="hl-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Year" required htmlFor="hl-year">
          <input id="hl-year" type="number" value={form.year}
            onChange={(e) => setForm({ ...form, year: e.target.value })} />
        </Field>
      </div>

      <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
        <legend className="t-meta" style={{ padding: 0 }}>Weekly offs</legend>
        <div className="inline">
          {DAYS.map((day, index) => (
            <label key={day} className="inline" style={{ fontWeight: 400, marginBottom: 0 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={weeklyOffs.includes(index)}
                onChange={(e) => setWeeklyOffs(e.target.checked
                  ? [...weeklyOffs, index].sort()
                  : weeklyOffs.filter((d) => d !== index))} />
              <span>{day.slice(0, 3)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="row">
        <Field label="Holiday date" htmlFor="hl-date">
          <input id="hl-date" type="date" value={draft.date}
            onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
        </Field>
        <Field label="Holiday name" htmlFor="hl-hname">
          <input id="hl-hname" value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <div className="shrink">
          <button type="button" disabled={!draft.date || !draft.name.trim()}
            onClick={() => { setHolidays([...holidays, { ...draft, name: draft.name.trim() }]); setDraft({ date: '', name: '' }); }}>
            Add holiday
          </button>
        </div>
      </div>

      {holidays.length > 0 && (
        <ul className="small" style={{ paddingLeft: 18 }}>
          {holidays.map((h, i) => (
            <li key={`${h.date}-${i}`}>
              {h.date} — {h.name}{' '}
              <button type="button" className="ghost small"
                onClick={() => setHolidays(holidays.filter((_, j) => j !== i))}>remove</button>
            </li>
          ))}
        </ul>
      )}

      <label className="inline" style={{ fontWeight: 400 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={form.isDefault}
          onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} />
        <span>Use as the default calendar</span>
      </label>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Workforce
// ---------------------------------------------------------------------------

type ShiftType = {
  id: string; name: string; code: string; start_time: string; end_time: string;
  break_minutes: number;
};

export function WorkforceSetup() {
  const shifts = useLoad(() => get<{ shift_types: ShiftType[] }>('/api/shift-types'), []);
  const employees = useLoad(
    () => get<{ employees: Array<{ id: string; employee_code: string; first_name: string; last_name: string }> }>(
      '/api/employees?scope=all&limit=200').catch(() => ({ employees: [] })),
    [],
  );
  const holidayLists = useLoad(
    () => get<{ holiday_lists: Option[] }>('/api/holiday-lists').catch(() => ({ holiday_lists: [] })),
    [],
  );
  const [adding, setAdding] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const manages = can('shift.manage');

  return (
    <>
      <Card
        title="Shift types"
        flush
        actions={manages && !adding
          ? <button className="small primary" onClick={() => setAdding(true)}>Add shift</button>
          : undefined}
      >
        {shifts.loading ? (
          <Loading label="Loading shifts" />
        ) : (
          <Table
            caption="Shift types"
            rows={shifts.data?.shift_types ?? []}
            keyOf={(row) => row.id}
            empty={
              <Empty title="No shift types yet">
                Attendance is measured against a shift — working hours, grace and overtime all
                come from it.
              </Empty>
            }
            columns={[
              { header: 'Shift', render: (r) => <>{r.name} <span className="muted mono small">{r.code}</span></> },
              { header: 'Hours', render: (r) => `${String(r.start_time).slice(0, 5)}–${String(r.end_time).slice(0, 5)}` },
              { header: 'Break', numeric: true, render: (r) => `${r.break_minutes} min` },
            ]}
          />
        )}
      </Card>

      {manages && (
        <Card
          title="Assignment"
          actions={!assigning
            ? <button className="small" onClick={() => setAssigning(true)}>Assign a shift</button>
            : undefined}
        >
          <p className="muted small" style={{ margin: 0 }}>
            An employee without a shift assignment has no schedule to measure attendance
            against.
          </p>
        </Card>
      )}

      {adding && (
        <NewShiftType onClose={() => setAdding(false)} onCreated={() => { setAdding(false); shifts.reload(); }} />
      )}
      {assigning && (
        <AssignShift
          shifts={shifts.data?.shift_types ?? []}
          employees={employees.data?.employees ?? []}
          holidayLists={holidayLists.data?.holiday_lists ?? []}
          onClose={() => setAssigning(false)}
        />
      )}
    </>
  );
}

function NewShiftType({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    name: 'General', code: 'GEN', startTime: '09:00', endTime: '18:00',
    breakMinutes: '60', graceInMinutes: '10', overtimeEnabled: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await post('/api/shift-types', {
        name: form.name.trim(), code: form.code.trim().toUpperCase(),
        startTime: form.startTime, endTime: form.endTime,
        breakMinutes: Number(form.breakMinutes),
        graceInMinutes: Number(form.graceInMinutes),
        overtimeEnabled: form.overtimeEnabled,
      });
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New shift type" onClose={onClose} footer={
      <>
        <button onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary" onClick={submit} disabled={busy}>Create shift</button>
      </>
    }>
      <ErrorMessage error={error} />
      <div className="row">
        <Field label="Name" required htmlFor="st-name">
          <input id="st-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Code" required htmlFor="st-code">
          <input id="st-code" value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
        </Field>
      </div>
      <div className="row">
        <Field label="Starts" required htmlFor="st-start">
          <input id="st-start" type="time" value={form.startTime}
            onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
        </Field>
        <Field label="Ends" required htmlFor="st-end">
          <input id="st-end" type="time" value={form.endTime}
            onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
        </Field>
        <Field label="Break (minutes)" htmlFor="st-break">
          <input id="st-break" type="number" min="0" value={form.breakMinutes}
            onChange={(e) => setForm({ ...form, breakMinutes: e.target.value })} />
        </Field>
      </div>
      <div className="row">
        <Field label="Grace in (minutes)" htmlFor="st-grace">
          <input id="st-grace" type="number" min="0" value={form.graceInMinutes}
            onChange={(e) => setForm({ ...form, graceInMinutes: e.target.value })} />
        </Field>
      </div>
      <label className="inline" style={{ fontWeight: 400 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={form.overtimeEnabled}
          onChange={(e) => setForm({ ...form, overtimeEnabled: e.target.checked })} />
        <span>Track overtime</span>
      </label>
    </Modal>
  );
}

function AssignShift({
  shifts, employees, holidayLists, onClose,
}: {
  shifts: ShiftType[];
  employees: Array<{ id: string; employee_code: string; first_name: string; last_name: string }>;
  holidayLists: Option[];
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    employeeId: '', shiftTypeId: '', holidayListId: '',
    effectiveFrom: new Date().toISOString().slice(0, 10),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await post('/api/shift-assignments', {
        employeeId: form.employeeId,
        shiftTypeId: form.shiftTypeId,
        effectiveFrom: form.effectiveFrom,
        ...(form.holidayListId ? { holidayListId: form.holidayListId } : {}),
      });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Assign a shift" onClose={onClose} footer={
      done ? <button className="primary" onClick={onClose}>Done</button> : (
        <>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={submit}
            disabled={busy || !form.employeeId || !form.shiftTypeId}>Assign</button>
        </>
      )
    }>
      <ErrorMessage error={error} />
      {done ? <Alert kind="success">Assigned. Attendance is measured against it from the effective date.</Alert> : (
        <>
          <Field label="Employee" required htmlFor="sa-emp">
            <select id="sa-emp" value={form.employeeId}
              onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
              <option value="">Choose&hellip;</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.first_name} {e.last_name} ({e.employee_code})</option>
              ))}
            </select>
          </Field>
          <div className="row">
            <Field label="Shift" required htmlFor="sa-shift">
              <select id="sa-shift" value={form.shiftTypeId}
                onChange={(e) => setForm({ ...form, shiftTypeId: e.target.value })}>
                <option value="">Choose&hellip;</option>
                {shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Holiday calendar" htmlFor="sa-cal">
              <select id="sa-cal" value={form.holidayListId}
                onChange={(e) => setForm({ ...form, holidayListId: e.target.value })}>
                <option value="">Default</option>
                {holidayLists.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            </Field>
            <Field label="Effective from" required htmlFor="sa-from">
              <input id="sa-from" type="date" value={form.effectiveFrom}
                onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
            </Field>
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Expense
// ---------------------------------------------------------------------------

type ExpenseType = {
  id: string; code: string; name: string; receipt_required: boolean;
  requires_business_purpose: boolean; limit_amount: string | null;
};

export function ExpenseSetup() {
  const types = useLoad(() => get<{ expense_types: ExpenseType[] }>('/api/expense-types'), []);
  const [adding, setAdding] = useState(false);

  return (
    <>
      <Card
        title="Expense types"
        flush
        actions={can('expense.manage') && !adding
          ? <button className="small primary" onClick={() => setAdding(true)}>Add expense type</button>
          : undefined}
      >
        {types.loading ? (
          <Loading label="Loading expense types" />
        ) : (
          <Table
            caption="Expense types"
            rows={types.data?.expense_types ?? []}
            keyOf={(row) => row.id}
            empty={
              <Empty title="No expense types yet">
                Nobody can raise a claim until at least one type exists.
              </Empty>
            }
            columns={[
              { header: 'Type', render: (r) => <>{r.name} <span className="muted mono small">{r.code}</span></> },
              { header: 'Receipt', render: (r) => (r.receipt_required ? 'required' : 'optional') },
              { header: 'Purpose', render: (r) => (r.requires_business_purpose ? 'required' : 'optional') },
              { header: 'Limit', numeric: true, render: (r) => r.limit_amount ?? <span className="muted">none</span> },
            ]}
          />
        )}
      </Card>

      {adding && (
        <NewExpenseType onClose={() => setAdding(false)} onCreated={() => { setAdding(false); types.reload(); }} />
      )}
    </>
  );
}

function NewExpenseType({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    code: '', name: '', receiptRequired: true, requiresBusinessPurpose: false, limitAmount: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    const found: Record<string, string> = {};
    if (!form.code.trim()) found.code = 'Required.';
    if (!form.name.trim()) found.name = 'Required.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      await post('/api/expense-types', {
        code: form.code.trim().toUpperCase(),
        name: form.name.trim(),
        receiptRequired: form.receiptRequired,
        requiresBusinessPurpose: form.requiresBusinessPurpose,
        ...(Number(form.limitAmount) > 0 ? { limitAmount: Number(form.limitAmount) } : {}),
      });
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New expense type" onClose={onClose} footer={
      <>
        <button onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary" onClick={submit} disabled={busy}>Create</button>
      </>
    }>
      <ErrorMessage error={error} />
      <div className="row">
        <Field label="Name" required htmlFor="et-name" error={errors.name}>
          <input id="et-name" value={form.name} aria-invalid={errors.name ? 'true' : undefined}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Code" required htmlFor="et-code" error={errors.code}>
          <input id="et-code" value={form.code} aria-invalid={errors.code ? 'true' : undefined}
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
        </Field>
        <Field label="Limit per claim" htmlFor="et-limit" hint="Optional.">
          <input id="et-limit" type="number" min="0" value={form.limitAmount}
            onChange={(e) => setForm({ ...form, limitAmount: e.target.value })} />
        </Field>
      </div>
      <label className="inline" style={{ fontWeight: 400, marginBottom: 8 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={form.receiptRequired}
          onChange={(e) => setForm({ ...form, receiptRequired: e.target.checked })} />
        <span>Receipt required</span>
      </label>
      <label className="inline" style={{ fontWeight: 400 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={form.requiresBusinessPurpose}
          onChange={(e) => setForm({ ...form, requiresBusinessPurpose: e.target.checked })} />
        <span>Business purpose required</span>
      </label>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Workflow routing
// ---------------------------------------------------------------------------

type WorkflowDefinition = {
  id: string; name: string; entity_type: string; version: number;
  status: string; definition: { steps?: Array<Record<string, unknown>> } | null;
};

/**
 * Approval routing.
 *
 * The engine's semantics are not touched here: this screen writes a definition through the
 * existing `PUT /api/workflows/:entityType`, which versions it and validates the steps. The
 * form offers the two approver kinds that need no further configuration — the requester's
 * reporting manager, or a named role — because those are what a tenant can express without
 * picking individual people, and the server rejects anything it does not accept.
 */
export function WorkflowSetup() {
  const workflows = useLoad(
    () => get<{ workflows: WorkflowDefinition[] }>('/api/workflows').catch(() => ({ workflows: [] })),
    [],
  );
  const [editing, setEditing] = useState<string | null>(null);

  const active = new Map(
    (workflows.data?.workflows ?? [])
      .filter((w) => w.status === 'active')
      .map((w) => [w.entity_type, w]),
  );

  return (
    <>
      <Card title="Approval routing" flush>
        {workflows.loading ? (
          <Loading label="Loading workflows" />
        ) : (
          <Table
            caption="Approval routing by request type"
            rows={WORKFLOW_ENTITIES.map((entity) => ({ entity, definition: active.get(entity) ?? null }))}
            keyOf={(row) => row.entity}
            columns={[
              { header: 'Request type', render: (r) => r.entity.replace(/_/g, ' ') },
              {
                header: 'Routing',
                render: (r) => (r.definition
                  ? <>{r.definition.name} <span className="muted small">v{r.definition.version}</span></>
                  : <span className="muted">no approval — decided immediately</span>),
              },
              {
                header: 'Steps',
                numeric: true,
                render: (r) => r.definition?.definition?.steps?.length ?? 0,
              },
              {
                header: '',
                render: (r) => (can('workflow.manage')
                  ? <button className="small" onClick={() => setEditing(r.entity)}>
                      {r.definition ? 'Change' : 'Configure'}
                    </button>
                  : null),
              },
            ]}
          />
        )}
      </Card>

      <Card>
        <p className="muted small" style={{ margin: 0 }}>
          A request type with no routing is approved the moment it is submitted — the engine has
          nowhere to send it. Saving a definition creates a new version; requests already in
          flight keep the version they started under.
        </p>
      </Card>

      {editing && (
        <EditWorkflow
          entityType={editing}
          existing={active.get(editing) ?? null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); workflows.reload(); }}
        />
      )}
    </>
  );
}

function EditWorkflow({
  entityType, existing, onClose, onSaved,
}: {
  entityType: string;
  existing: WorkflowDefinition | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const roles = useLoad(() => get<{ roles: Option[] }>('/api/roles').catch(() => ({ roles: [] })), []);
  const [name, setName] = useState(existing?.name ?? `${entityType.replace(/_/g, ' ')} approval`);
  const [steps, setSteps] = useState<Array<{ approver: string; roleName: string; slaHours: string }>>(
    [{ approver: 'reporting_manager', roleName: '', slaHours: '24' }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await put(`/api/workflows/${entityType}`, {
        name: name.trim(),
        steps: steps.map((step, index) => ({
          sequence: index + 1,
          approver: step.approver,
          ...(step.approver === 'role' ? { role_name: step.roleName } : {}),
          ...(Number(step.slaHours) > 0 ? { sla_hours: Number(step.slaHours) } : {}),
          skip_if_unresolved: false,
        })),
      });
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Approval routing — ${entityType.replace(/_/g, ' ')}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy}>Save routing</button>
        </>
      }
    >
      <ErrorMessage error={error} />
      <Field label="Name" required htmlFor="wf-name">
        <input id="wf-name" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      {steps.map((step, index) => (
        <div key={index} className="row" style={{ alignItems: 'flex-end' }}>
          <Field label={`Step ${index + 1} approver`} htmlFor={`wf-approver-${index}`}>
            <select id={`wf-approver-${index}`} value={step.approver}
              onChange={(e) => setSteps(steps.map((s, i) => i === index ? { ...s, approver: e.target.value } : s))}>
              <option value="reporting_manager">The requester's manager</option>
              <option value="role">Anyone holding a role</option>
            </select>
          </Field>
          {step.approver === 'role' && (
            <Field label="Role" htmlFor={`wf-role-${index}`}>
              <select id={`wf-role-${index}`} value={step.roleName}
                onChange={(e) => setSteps(steps.map((s, i) => i === index ? { ...s, roleName: e.target.value } : s))}>
                <option value="">Choose&hellip;</option>
                {(roles.data?.roles ?? []).map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Due within (hours)" htmlFor={`wf-sla-${index}`}>
            <input id={`wf-sla-${index}`} type="number" min="0" value={step.slaHours}
              onChange={(e) => setSteps(steps.map((s, i) => i === index ? { ...s, slaHours: e.target.value } : s))} />
          </Field>
          {steps.length > 1 && (
            <div className="shrink">
              <button type="button" className="ghost small"
                onClick={() => setSteps(steps.filter((_, i) => i !== index))}>remove</button>
            </div>
          )}
        </div>
      ))}

      <button type="button" className="small"
        onClick={() => setSteps([...steps, { approver: 'reporting_manager', roleName: '', slaHours: '24' }])}>
        Add a step
      </button>
    </Modal>
  );
}
