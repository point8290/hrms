import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { can, formatDate, formatMoney, get, post, today } from '../lib/api.ts';
import { Alert, Badge, Card, Definitions, Empty, ErrorMessage, Field, Loading, Modal, Page, Person, Stepper, Table, Tabs, Timeline, useLoad } from '../components/ui.tsx';

type Employee = {
  id: string; employee_code: string; first_name: string; last_name: string;
  work_email: string | null; employment_status: string; employment_type: string;
  joining_date: string; department: string | null; designation: string | null;
  manager_code: string | null;
};

type EmployeeDetail = Employee & {
  personal_email: string | null; phone: string | null; date_of_birth: string | null;
  gender: string | null; confirmation_date: string | null; exit_date: string | null;
  company: string; location: string | null;
  manager_employee_id: string | null; manager_name: string | null;
};

type Option = { id: string; name: string };

/**
 * The employment statuses the backend actually accepts, in the order employment moves
 * through them. Taken from the `employmentStatus` enums on POST /api/employees and
 * POST /api/employees/:id/lifecycle — not invented, and not extended.
 */
const LIFECYCLE = ['onboarding', 'probation', 'active', 'notice'] as const;

/** Reasons `POST /api/employees/:id/lifecycle` accepts. */
const CHANGE_REASONS = [
  'confirmation', 'promotion', 'transfer', 'demotion', 'manager_change', 'status_change', 'correction',
] as const;

const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'] as const;

export function EmployeesPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  // Without directory access the server narrows results to the caller's reporting line,
  // so this page works for a manager as well as for HR.
  const scope = can('employee.read') ? 'all' : 'team';

  const employees = useLoad(
    () =>
      get<{ employees: Employee[] }>(
        `/api/employees?scope=${scope}&limit=100` +
          (search ? `&search=${encodeURIComponent(search)}` : '') +
          (status ? `&status=${status}` : ''),
      ),
    [search, status, scope],
  );

  return (
    <Page
      title="People"
      subtitle={scope === 'team' ? 'Your reporting line.' : 'Everyone in this workspace.'}
      actions={
        can('employee.manage') && !creating ? (
          <button className="primary" onClick={() => setCreating(true)}>Add employee</button>
        ) : undefined
      }
    >
      {creating && (
        <NewEmployee
          onCancel={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); navigate(`/employees/${id}`); }}
        />
      )}

      <div className="filter-bar">
        <Field label="Search" htmlFor="search">
          <input
            id="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or employee code"
          />
        </Field>
        <Field label="Status" htmlFor="status">
          <select id="status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {[...LIFECYCLE, 'separated'].map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </Field>
      </div>

      <ErrorMessage error={employees.error} />

      <Card flush>
        {employees.loading ? (
          <Loading label="Loading people" />
        ) : (
          <Table
            caption="People in this workspace"
            rows={employees.data?.employees ?? []}
            keyOf={(row) => row.id}
            onRowClick={(row) => navigate(`/employees/${row.id}`)}
            empty={
              <Empty title="Nobody here yet">
                {can('employee.manage')
                  ? 'Add your first employee to get started.'
                  : 'Nobody reports to you yet.'}
              </Empty>
            }
            columns={[
              {
                header: 'Employee',
                render: (r) => (
                  <Person
                    name={`${r.first_name} ${r.last_name}`}
                    meta={`${r.employee_code}${r.work_email ? ` · ${r.work_email}` : ''}`}
                  />
                ),
              },
              { header: 'Department', render: (r) => r.department ?? <span className="muted">—</span> },
              { header: 'Designation', render: (r) => r.designation ?? <span className="muted">—</span> },
              { header: 'Joined', render: (r) => formatDate(r.joining_date) },
              { header: 'Status', render: (r) => <Badge value={r.employment_status} /> },
            ]}
          />
        )}
      </Card>
    </Page>
  );
}

/**
 * Creating an employee.
 *
 * The fields mirror `POST /api/employees` exactly. A company is mandatory there, so the form
 * refuses to submit without one and says why rather than letting the server reject it — but
 * every other rule still belongs to the server, and its errors are surfaced verbatim.
 */
function NewEmployee({
  onCancel, onCreated,
}: { onCancel: () => void; onCreated: (id: string) => void }) {
  const companies = useLoad(() => get<{ companies: Option[] }>('/api/companies'), []);
  const locations = useLoad(() => get<{ locations: Option[] }>('/api/locations'), []);
  const departments = useLoad(() => get<{ departments: Option[] }>('/api/departments'), []);
  const designations = useLoad(() => get<{ designations: Option[] }>('/api/designations'), []);
  const managers = useLoad(
    () => get<{ employees: Employee[] }>('/api/employees?scope=all&limit=200'),
    [],
  );

  const [form, setForm] = useState({
    firstName: '', lastName: '', employeeCode: '', workEmail: '', personalEmail: '',
    phone: '', dateOfBirth: '', gender: '', companyId: '', locationId: '',
    departmentId: '', designationId: '', managerEmployeeId: '',
    employmentType: 'full_time', employmentStatus: 'onboarding', joiningDate: today(),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: string, value: string) => setForm({ ...form, [key]: value });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (!form.firstName.trim()) found.firstName = 'Required.';
    if (!form.lastName.trim()) found.lastName = 'Required.';
    if (!form.companyId) found.companyId = 'An employee must belong to a company.';
    if (!form.joiningDate) found.joiningDate = 'Required.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      // Only send what was filled in: the API treats most fields as optional, and sending
      // empty strings would fail validation for the ones it parses as emails or uuids.
      const optional = (value: string) => (value.trim() ? value.trim() : undefined);
      const created = await post<{ id: string }>('/api/employees', {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        companyId: form.companyId,
        joiningDate: form.joiningDate,
        employeeCode: optional(form.employeeCode),
        workEmail: optional(form.workEmail),
        personalEmail: optional(form.personalEmail),
        phone: optional(form.phone),
        dateOfBirth: optional(form.dateOfBirth),
        gender: optional(form.gender),
        locationId: optional(form.locationId),
        departmentId: optional(form.departmentId),
        designationId: optional(form.designationId),
        managerEmployeeId: optional(form.managerEmployeeId),
        employmentType: form.employmentType,
        employmentStatus: form.employmentStatus,
      });
      onCreated(created.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const options = (rows: Option[] | undefined) =>
    (rows ?? []).map((row) => <option key={row.id} value={row.id}>{row.name}</option>);

  return (
    <Card title="Add employee">
      <ErrorMessage error={error} />
      {companies.data?.companies.length === 0 && (
        <Alert kind="warning">
          There is no company in this workspace yet. An employee must belong to one — create it
          under Organization first.
        </Alert>
      )}

      <form onSubmit={submit}>
        <h3 className="t-section">Person</h3>
        <div className="row">
          <Field label="First name" required htmlFor="e-first" error={errors.firstName}>
            <input id="e-first" value={form.firstName}
              aria-invalid={errors.firstName ? 'true' : undefined}
              onChange={(e) => set('firstName', e.target.value)} />
          </Field>
          <Field label="Last name" required htmlFor="e-last" error={errors.lastName}>
            <input id="e-last" value={form.lastName}
              aria-invalid={errors.lastName ? 'true' : undefined}
              onChange={(e) => set('lastName', e.target.value)} />
          </Field>
          <Field label="Employee code" htmlFor="e-code" hint="Generated if left blank.">
            <input id="e-code" value={form.employeeCode}
              onChange={(e) => set('employeeCode', e.target.value)} />
          </Field>
        </div>

        <div className="row">
          <Field label="Work email" htmlFor="e-workmail">
            <input id="e-workmail" type="email" value={form.workEmail}
              onChange={(e) => set('workEmail', e.target.value)} />
          </Field>
          <Field label="Personal email" htmlFor="e-personalmail">
            <input id="e-personalmail" type="email" value={form.personalEmail}
              onChange={(e) => set('personalEmail', e.target.value)} />
          </Field>
          <Field label="Phone" htmlFor="e-phone">
            <input id="e-phone" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
          </Field>
        </div>

        <div className="row">
          <Field label="Date of birth" htmlFor="e-dob">
            <input id="e-dob" type="date" value={form.dateOfBirth}
              onChange={(e) => set('dateOfBirth', e.target.value)} />
          </Field>
          <Field label="Gender" htmlFor="e-gender">
            <select id="e-gender" value={form.gender} onChange={(e) => set('gender', e.target.value)}>
              <option value="">Not recorded</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="other">Other</option>
              <option value="undisclosed">Undisclosed</option>
            </select>
          </Field>
        </div>

        <div className="divider" />
        <h3 className="t-section">Organization</h3>
        <div className="row">
          <Field label="Company" required htmlFor="e-company" error={errors.companyId}>
            <select id="e-company" value={form.companyId}
              aria-invalid={errors.companyId ? 'true' : undefined}
              onChange={(e) => set('companyId', e.target.value)}>
              <option value="">Choose…</option>
              {options(companies.data?.companies)}
            </select>
          </Field>
          <Field label="Location" htmlFor="e-location">
            <select id="e-location" value={form.locationId}
              onChange={(e) => set('locationId', e.target.value)}>
              <option value="">Not set</option>
              {options(locations.data?.locations)}
            </select>
          </Field>
        </div>

        <div className="row">
          <Field label="Department" htmlFor="e-dept">
            <select id="e-dept" value={form.departmentId}
              onChange={(e) => set('departmentId', e.target.value)}>
              <option value="">Not set</option>
              {options(departments.data?.departments)}
            </select>
          </Field>
          <Field label="Designation" htmlFor="e-desig">
            <select id="e-desig" value={form.designationId}
              onChange={(e) => set('designationId', e.target.value)}>
              <option value="">Not set</option>
              {options(designations.data?.designations)}
            </select>
          </Field>
          <Field label="Reports to" htmlFor="e-manager">
            <select id="e-manager" value={form.managerEmployeeId}
              onChange={(e) => set('managerEmployeeId', e.target.value)}>
              <option value="">Nobody</option>
              {(managers.data?.employees ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.first_name} {m.last_name} ({m.employee_code})
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="divider" />
        <h3 className="t-section">Employment</h3>
        <div className="row">
          <Field label="Employment type" htmlFor="e-type">
            <select id="e-type" value={form.employmentType}
              onChange={(e) => set('employmentType', e.target.value)}>
              {EMPLOYMENT_TYPES.map((t) => (
                <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </Field>
          <Field
            label="Starting status"
            htmlFor="e-status"
            hint="Onboarding is the usual starting point for a new joiner."
          >
            <select id="e-status" value={form.employmentStatus}
              onChange={(e) => set('employmentStatus', e.target.value)}>
              <option value="onboarding">Onboarding</option>
              <option value="probation">Probation</option>
              <option value="active">Active</option>
            </select>
          </Field>
          <Field label="Joining date" required htmlFor="e-joining" error={errors.joiningDate}>
            <input id="e-joining" type="date" value={form.joiningDate}
              aria-invalid={errors.joiningDate ? 'true' : undefined}
              onChange={(e) => set('joiningDate', e.target.value)} />
          </Field>
        </div>

        <div className="inline" style={{ marginTop: 16 }}>
          <button className="primary" type="submit" disabled={busy}>Create employee</button>
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <span className="muted small">
            Access to the product is granted separately, under Organization.
          </span>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Employee detail
// ---------------------------------------------------------------------------

/**
 * The operational record for one person.
 *
 * Tabs appear only where there is real data or a real action behind them: a tab that exists
 * to make the page look complete teaches people to ignore tabs. Bank details are shown only
 * to somebody holding `employee.bank.read`, and the API returns nothing but the last four
 * digits in any case.
 */
export function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState('profile');

  const employee = useLoad(() => get<EmployeeDetail>(`/api/employees/${id}`), [id]);
  const history = useLoad(
    () => get<{ history: any[] }>(`/api/employees/${id}/employment-history`).catch(() => ({ history: [] })),
    [id],
  );
  const bank = useLoad(
    () => (can('employee.bank.read')
      ? get<any>(`/api/employees/${id}/bank-account`).catch(() => null)
      : Promise.resolve(null)),
    [id],
  );
  const plans = useLoad(
    () => (can('onboarding.read')
      ? get<{ plans: any[] }>('/api/onboarding/plans').catch(() => ({ plans: [] }))
      : Promise.resolve({ plans: [] })),
    [id],
  );

  // Each of these is offered as a tab only when the caller holds the permission *and* the
  // endpoint actually returns something. A tab that is always empty teaches people to ignore
  // tabs, so a failed or unauthorised read collapses to "no tab" rather than "empty tab".
  const documents = useLoad(
    () => (can('document.read')
      ? get<{ documents: any[] }>(`/api/documents?employeeId=${id}`).catch(() => ({ documents: [] }))
      : Promise.resolve({ documents: [] })),
    [id],
  );
  const leaveBalance = useLoad(
    () => (can('leave.read')
      ? get<{ balances: any[] }>(`/api/leave/balance?employeeId=${id}&asOf=${today()}`)
          .catch(() => ({ balances: [] }))
      : Promise.resolve({ balances: [] })),
    [id],
  );
  const compensation = useLoad(
    () => (can('compensation.read')
      ? get<any>(`/api/compensation/assignments/${id}`).catch(() => null)
      : Promise.resolve(null)),
    [id],
  );
  const taxDeclarations = useLoad(
    () => (can('tax.manage')
      ? get<{ declarations: any[] }>(`/api/tax/declarations?employeeId=${id}`)
          .catch(() => ({ declarations: [] }))
      : Promise.resolve({ declarations: [] })),
    [id],
  );

  if (employee.loading) return <Loading label="Loading the employee" />;
  if (employee.error) return <ErrorMessage error={employee.error} />;
  if (!employee.data) return null;

  const e = employee.data;
  const plan = (plans.data?.plans ?? []).find((p: any) => p.employee_id === id) ?? null;
  const separated = e.employment_status === 'separated' || Boolean(e.exit_date);

  const tabs = [
    { id: 'profile', label: 'Profile' },
    { id: 'employment', label: 'Employment' },
    ...(can('onboarding.read') ? [{ id: 'onboarding', label: 'Onboarding' }] : []),
    ...((leaveBalance.data?.balances.length ?? 0) > 0 ? [{ id: 'leave', label: 'Leave' }] : []),
    ...(compensation.data ? [{ id: 'compensation', label: 'Compensation' }] : []),
    ...((documents.data?.documents.length ?? 0) > 0 ? [{ id: 'documents', label: 'Documents' }] : []),
    ...((taxDeclarations.data?.declarations.length ?? 0) > 0 ? [{ id: 'tax', label: 'Tax' }] : []),
    ...(can('employee.bank.read') && bank.data ? [{ id: 'bank', label: 'Bank' }] : []),
    { id: 'history', label: 'History' },
  ];

  return (
    <Page
      title={`${e.first_name} ${e.last_name}`}
      breadcrumbs={<><Link to="/employees">People</Link><span className="sep">/</span><span>{e.employee_code}</span></>}
      subtitle={
        <span className="inline">
          <Badge value={e.employment_status} />
          <span className="muted small">
            {e.designation ?? 'No designation'}{e.department ? ` · ${e.department}` : ''}
          </span>
        </span>
      }
      actions={<Link className="button" to="/employees">Back to people</Link>}
    >
      {!separated && <Stepper steps={LIFECYCLE} current={e.employment_status} />}
      {separated && (
        <Alert kind="warning">
          This employee left on {e.exit_date ?? 'an unrecorded date'}. The record is kept for
          payroll and statutory history.
        </Alert>
      )}

      <div className="detail-grid">
        <div>
          <Tabs tabs={tabs} active={tab} onChange={setTab} />

          {tab === 'profile' && (
            <Card title="Profile">
              <Definitions
                items={[
                  { label: 'Employee code', value: e.employee_code },
                  { label: 'Work email', value: e.work_email },
                  { label: 'Personal email', value: e.personal_email },
                  { label: 'Phone', value: e.phone },
                  { label: 'Date of birth', value: e.date_of_birth },
                  { label: 'Gender', value: e.gender },
                ]}
              />
            </Card>
          )}

          {tab === 'employment' && (
            <Card title="Employment">
              <Definitions
                items={[
                  { label: 'Company', value: e.company },
                  { label: 'Location', value: e.location },
                  { label: 'Department', value: e.department },
                  { label: 'Designation', value: e.designation },
                  {
                    label: 'Reports to',
                    value: e.manager_employee_id
                      ? <Link to={`/employees/${e.manager_employee_id}`}>{e.manager_name}</Link>
                      : null,
                  },
                  { label: 'Employment type', value: e.employment_type?.replace(/_/g, ' ') },
                  { label: 'Status', value: <Badge value={e.employment_status} /> },
                  { label: 'Joined', value: e.joining_date },
                  { label: 'Confirmed', value: e.confirmation_date },
                  { label: 'Left', value: e.exit_date },
                ]}
              />
            </Card>
          )}

          {tab === 'onboarding' && (
            <OnboardingPanel
              employeeId={id!}
              plan={plan}
              onChanged={() => { plans.reload(); employee.reload(); }}
            />
          )}

          {tab === 'leave' && (
            <Card title="Leave balances" flush>
              <Table
                caption="Leave balances"
                rows={leaveBalance.data?.balances ?? []}
                keyOf={(row: any) => row.leave_type_id}
                empty="No leave allocated."
                columns={[
                  { header: 'Type', render: (r: any) => r.name },
                  { header: 'Allocated', numeric: true, render: (r: any) => r.allocated },
                  { header: 'Consumed', numeric: true, render: (r: any) => r.consumed },
                  { header: 'Balance', numeric: true, render: (r: any) => <strong>{r.balance}</strong> },
                ]}
              />
            </Card>
          )}

          {tab === 'compensation' && compensation.data && (
            <Card title="Compensation">
              <Definitions
                items={[
                  {
                    label: 'Structure',
                    value: compensation.data.structure_name ?? compensation.data.structure?.name,
                  },
                  {
                    label: 'Effective from',
                    value: compensation.data.effective_from,
                  },
                  {
                    label: 'Annual CTC',
                    value: compensation.data.annual_ctc
                      ? <span className="t-num">{formatMoney(compensation.data.annual_ctc)}</span>
                      : null,
                  },
                ]}
              />
              <p className="muted small" style={{ marginBottom: 0 }}>
                Salary structures and revisions are managed through the compensation API; this
                view is read-only.
              </p>
            </Card>
          )}

          {tab === 'documents' && (
            <Card title="Documents" flush>
              <Table
                caption="Documents on file"
                rows={documents.data?.documents ?? []}
                keyOf={(row: any) => row.id}
                empty="No documents on file."
                columns={[
                  { header: 'Document', render: (r: any) => r.filename },
                  { header: 'Type', render: (r: any) => String(r.document_type ?? '').replace(/_/g, ' ') },
                  { header: 'Uploaded', render: (r: any) => (r.created_at ? formatDate(r.created_at) : '—') },
                  { header: 'Status', render: (r: any) => <Badge value={r.status} /> },
                ]}
              />
            </Card>
          )}

          {tab === 'tax' && (
            <Card title="Tax declarations" flush>
              <Table
                caption="Tax declarations"
                rows={taxDeclarations.data?.declarations ?? []}
                keyOf={(row: any) => row.id}
                empty="Nothing declared."
                columns={[
                  { header: 'Year', render: (r: any) => r.financial_year },
                  { header: 'Regime', render: (r: any) => r.regime },
                  {
                    header: 'Declared',
                    numeric: true,
                    render: (r: any) => formatMoney(r.declared_amount),
                  },
                  {
                    header: 'Verified',
                    numeric: true,
                    render: (r: any) => (r.verified_amount
                      ? formatMoney(r.verified_amount)
                      : <span className="muted">—</span>),
                  },
                  { header: 'Status', render: (r: any) => <Badge value={r.status} /> },
                ]}
              />
            </Card>
          )}

          {tab === 'bank' && bank.data && (
            <Card title="Bank">
              <Definitions
                items={[
                  { label: 'Account holder', value: bank.data.account_holder },
                  { label: 'Bank', value: bank.data.bank_name },
                  { label: 'IFSC', value: bank.data.ifsc },
                  { label: 'Account', value: `•••• ${bank.data.account_number_last4 ?? '????'}` },
                ]}
              />
              <p className="muted small" style={{ marginBottom: 0 }}>
                The full account number is encrypted at rest and is never returned by the API.
              </p>
            </Card>
          )}

          {tab === 'history' && (
            <Card title="Employment history">
              <Timeline
                entries={[
                  ...(history.data?.history ?? []).map((row: any) => ({
                    title: <>{String(row.change_reason ?? 'change').replace(/_/g, ' ')}</>,
                    meta: (
                      <>
                        Effective {row.effective_from}
                        {row.employment_status ? ` · ${row.employment_status}` : ''}
                        {row.department ? ` · ${row.department}` : ''}
                      </>
                    ),
                    state: 'done' as const,
                  })),
                  { title: 'Joined', meta: e.joining_date, state: 'done' as const },
                ]}
              />
            </Card>
          )}
        </div>

        <aside className="action-panel">
          <LifecycleActions employee={e} onChanged={() => { employee.reload(); history.reload(); }} />
        </aside>
      </div>
    </Page>
  );
}

/**
 * Lifecycle actions, gated on `employee.lifecycle`.
 *
 * Only the two operations the backend actually provides appear: recording a change (which is
 * how status, department, designation, location and manager all move) and separation. There
 * is no "reactivate" button because there is no endpoint behind it — a separated employee is
 * brought back by recording a change, which is what the API supports.
 */
function LifecycleActions({
  employee, onChanged,
}: { employee: EmployeeDetail; onChanged: () => void }) {
  const [open, setOpen] = useState<'change' | 'separate' | null>(null);

  if (!can('employee.lifecycle')) {
    return (
      <Card title="Lifecycle">
        <p className="muted small" style={{ margin: 0 }}>
          You can view this record but not change it.
        </p>
      </Card>
    );
  }

  const separated = employee.employment_status === 'separated' || Boolean(employee.exit_date);

  return (
    <>
      <Card title="Lifecycle">
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>
            Every change is effective-dated and recorded in this person's history.
          </p>
          <button onClick={() => setOpen('change')}>Record a change</button>
          {!separated && (
            <button className="ghost danger-text" onClick={() => setOpen('separate')}>
              Record separation
            </button>
          )}
        </div>
      </Card>

      {open === 'change' && (
        <LifecycleChange
          employee={employee}
          onClose={() => setOpen(null)}
          onDone={() => { setOpen(null); onChanged(); }}
        />
      )}
      {open === 'separate' && (
        <Separation
          employee={employee}
          onClose={() => setOpen(null)}
          onDone={() => { setOpen(null); onChanged(); }}
        />
      )}
    </>
  );
}

function LifecycleChange({
  employee, onClose, onDone,
}: { employee: EmployeeDetail; onClose: () => void; onDone: () => void }) {
  const departments = useLoad(() => get<{ departments: Option[] }>('/api/departments'), []);
  const designations = useLoad(() => get<{ designations: Option[] }>('/api/designations'), []);
  const locations = useLoad(() => get<{ locations: Option[] }>('/api/locations'), []);
  const managers = useLoad(() => get<{ employees: Employee[] }>('/api/employees?scope=all&limit=200'), []);

  const [form, setForm] = useState({
    changeReason: 'status_change', effectiveFrom: today(),
    employmentStatus: employee.employment_status, employmentType: employee.employment_type,
    departmentId: '', designationId: '', locationId: '',
    managerEmployeeId: employee.manager_employee_id ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const set = (key: string, value: string) => setForm({ ...form, [key]: value });

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const optional = (v: string) => (v ? v : undefined);
      await post(`/api/employees/${employee.id}/lifecycle`, {
        changeReason: form.changeReason,
        effectiveFrom: form.effectiveFrom,
        employmentStatus: form.employmentStatus,
        employmentType: form.employmentType,
        departmentId: optional(form.departmentId),
        designationId: optional(form.designationId),
        locationId: optional(form.locationId),
        managerEmployeeId: optional(form.managerEmployeeId),
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Record an employment change"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy}>Record change</button>
        </>
      }
    >
      <ErrorMessage error={error} />
      <p className="muted small" style={{ marginTop: 0 }}>
        This writes a dated entry to {employee.first_name}'s employment history. Leave a field
        unset to keep it as it is.
      </p>

      <div className="row">
        <Field label="Reason" required htmlFor="lc-reason">
          <select id="lc-reason" value={form.changeReason}
            onChange={(e) => set('changeReason', e.target.value)}>
            {CHANGE_REASONS.map((r) => (
              <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </Field>
        <Field label="Effective from" required htmlFor="lc-date">
          <input id="lc-date" type="date" value={form.effectiveFrom}
            onChange={(e) => set('effectiveFrom', e.target.value)} />
        </Field>
      </div>

      <div className="row">
        <Field label="Status" htmlFor="lc-status">
          <select id="lc-status" value={form.employmentStatus}
            onChange={(e) => set('employmentStatus', e.target.value)}>
            {['onboarding', 'probation', 'active', 'notice', 'suspended'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Employment type" htmlFor="lc-type">
          <select id="lc-type" value={form.employmentType}
            onChange={(e) => set('employmentType', e.target.value)}>
            {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
          </select>
        </Field>
      </div>

      <div className="row">
        <Field label="Department" htmlFor="lc-dept">
          <select id="lc-dept" value={form.departmentId}
            onChange={(e) => set('departmentId', e.target.value)}>
            <option value="">Unchanged</option>
            {(departments.data?.departments ?? []).map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Designation" htmlFor="lc-desig">
          <select id="lc-desig" value={form.designationId}
            onChange={(e) => set('designationId', e.target.value)}>
            <option value="">Unchanged</option>
            {(designations.data?.designations ?? []).map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </Field>
      </div>

      <div className="row">
        <Field label="Location" htmlFor="lc-loc">
          <select id="lc-loc" value={form.locationId}
            onChange={(e) => set('locationId', e.target.value)}>
            <option value="">Unchanged</option>
            {(locations.data?.locations ?? []).map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Reports to" htmlFor="lc-mgr">
          <select id="lc-mgr" value={form.managerEmployeeId}
            onChange={(e) => set('managerEmployeeId', e.target.value)}>
            <option value="">Unchanged</option>
            {(managers.data?.employees ?? [])
              .filter((m) => m.id !== employee.id)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.first_name} {m.last_name} ({m.employee_code})
                </option>
              ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

/** Separation. Irreversible in practice, so it states the consequence and demands a reason. */
function Separation({
  employee, onClose, onDone,
}: { employee: EmployeeDetail; onClose: () => void; onDone: () => void }) {
  const [exitDate, setExitDate] = useState(today());
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    // The API requires at least three characters; asking here means the person is told
    // before the request rather than after it.
    if (reason.trim().length < 3) {
      setReasonError('Give a reason — it is kept on the employment record.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post(`/api/employees/${employee.id}/separate`, {
        exitDate,
        reason: reason.trim(),
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Record separation for ${employee.first_name} ${employee.last_name}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="danger" onClick={submit} disabled={busy}>
            Record separation
          </button>
        </>
      }
    >
      <ErrorMessage error={error} />
      <Alert kind="warning">
        This ends {employee.first_name}'s employment. They lose access to the product, stop
        appearing as an active employee, and will not be included in future payroll. Their
        record and payroll history are kept. There is no undo button for this — reversing it
        means recording a further employment change.
      </Alert>

      <Field label="Exit date" required htmlFor="sep-date">
        <input id="sep-date" type="date" value={exitDate}
          onChange={(e) => setExitDate(e.target.value)} />
      </Field>
      <Field label="Reason" required htmlFor="sep-reason" error={reasonError}
        hint="Recorded on the employment history.">
        <textarea id="sep-reason" value={reason}
          aria-invalid={reasonError ? 'true' : undefined}
          onChange={(e) => { setReason(e.target.value); if (reasonError) setReasonError(null); }} />
      </Field>
    </Modal>
  );
}

/**
 * Onboarding for this employee: start a plan, then watch it progress.
 *
 * This is the step that was missing — tasks could be completed but never created, so nothing
 * ever reached anybody's My Work.
 */
function OnboardingPanel({
  employeeId, plan, onChanged,
}: { employeeId: string; plan: any | null; onChanged: () => void }) {
  const templates = useLoad(
    () => get<{ templates: any[] }>('/api/onboarding/templates')
      .catch(() => ({ templates: [] as any[] })),
    [],
  );
  const detail = useLoad(
    () => (plan ? get<any>(`/api/onboarding/plans/${plan.id}`) : Promise.resolve(null)),
    [plan?.id],
  );

  const [templateId, setTemplateId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);

  const templateList = templates.data?.templates ?? [];

  async function start() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await post<{ task_count: number; unresolved_owners: number; template: string }>(
        '/api/onboarding/plans',
        { employeeId, ...(templateId ? { templateId } : {}) },
      );
      setNote(
        `Started "${result.template}" with ${result.task_count} task(s)` +
        (result.unresolved_owners > 0
          ? `. ${result.unresolved_owners} have no owner yet and will not appear in anyone's work.`
          : '. They are now in the owners\' work queues.'),
      );
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!plan) {
    return (
      <Card title="Onboarding">
        <ErrorMessage error={error} />
        {note && <Alert kind="success">{note}</Alert>}
        {!can('onboarding.manage') ? (
          <Empty title="No onboarding plan">
            This employee has no onboarding plan, and you cannot start one.
          </Empty>
        ) : (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              Starting onboarding creates the plan's tasks and puts each one into its owner's
              work queue.
            </p>
            <div className="row">
              <Field label="Template" htmlFor="ob-template"
                hint="Leave unset to use the template that matches this employee.">
                <select id="ob-template" value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}>
                  <option value="">Match automatically</option>
                  {templateList.map((t: any) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </Field>
              <div className="shrink">
                <button className="primary" onClick={start} disabled={busy}>
                  Start onboarding
                </button>
              </div>
            </div>
          </>
        )}
      </Card>
    );
  }

  const tasks = detail.data?.tasks ?? [];
  const done = tasks.filter((t: any) => t.status === 'completed' || t.status === 'skipped').length;

  return (
    <Card title="Onboarding" flush>
      <div style={{ padding: '0 20px' }}>
        <div className="inline" style={{ marginBottom: 12 }}>
          <Badge value={plan.status} />
          <span className="muted small">
            {plan.template_name} · {done} of {tasks.length} task(s) done
          </span>
        </div>
      </div>
      <Table
        caption="Onboarding tasks"
        rows={tasks}
        keyOf={(row: any) => row.id}
        empty="This plan has no tasks."
        columns={[
          {
            header: 'Task',
            render: (t: any) => (
              <span className="stack" style={{ gap: 2 }}>
                <strong>{t.title}</strong>
                <span className="muted small">
                  {t.category}{t.is_mandatory ? ' · required' : ''}
                </span>
              </span>
            ),
          },
          { header: 'Owner', render: (t: any) => t.owner_name ?? <span className="muted">unassigned</span> },
          { header: 'Due', render: (t: any) => t.due_date ?? <span className="muted">—</span> },
          { header: 'Status', render: (t: any) => <Badge value={t.status} /> },
        ]}
      />
    </Card>
  );
}
