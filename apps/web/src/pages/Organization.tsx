import { useState } from 'react';
import { Link } from 'react-router-dom';
import { can, canAny, get, post } from '../lib/api.ts';
import {
  Alert, Badge, Card, Definitions, Empty, ErrorMessage, Field, Loading, Modal, Page, Table,
  Tabs, useLoad,
} from '../components/ui.tsx';
import {
  CalendarSetup, ExpenseSetup, LeaveSetup, WorkflowSetup, WorkforceSetup,
} from './OrganizationSetup.tsx';
import { CompensationSetup } from './Compensation.tsx';

type Tenant = {
  id: string; name: string; slug: string; timezone: string; locale: string;
  currency: string; country_code: string; fy_start_month: number; status: string;
};
type Company = { id: string; name: string; legal_name: string; tax_identifier: string | null; status: string };
type Location = { id: string; name: string; timezone: string; state_code: string | null; address: string | null };
type Department = { id: string; name: string; code: string | null };
type Designation = { id: string; name: string; grade: string | null };
type Branch = { id: string; name: string };
type Role = { id: string; name: string; description: string | null; is_system: boolean; permissions: string[] };

/**
 * Organization setup for a Tenant Admin or Owner.
 *
 * Everything here is an existing API — companies, locations, departments, designations, users
 * and roles all have collection endpoints already, and this screen is the first thing to call
 * them. Nothing new was added to the backend for it.
 *
 * Tenant identity itself (timezone, locale, currency, financial year) is shown but not
 * editable, because there is no update endpoint for it. Rendering a form that the server
 * cannot accept would be worse than showing the values and saying so.
 */
export function OrganizationPage() {
  const [tab, setTab] = useState('overview');

  // Each tab is offered only where the caller can actually do something on it, using the same
  // permissions the API enforces.
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'companies', label: 'Companies' },
    { id: 'locations', label: 'Locations' },
    { id: 'structure', label: 'Structure' },
    ...(canAny('leave.manage', 'leave.read') ? [{ id: 'leave', label: 'Leave' }] : []),
    ...(canAny('org.manage', 'org.read') ? [{ id: 'calendar', label: 'Calendar' }] : []),
    ...(canAny('shift.manage', 'shift.read') ? [{ id: 'workforce', label: 'Shifts' }] : []),
    ...(canAny('expense.manage', 'expense.read.self') ? [{ id: 'expense', label: 'Expenses' }] : []),
    ...(canAny('compensation.manage', 'compensation.read') ? [{ id: 'pay', label: 'Compensation' }] : []),
    ...(can('workflow.manage') ? [{ id: 'workflow', label: 'Approvals' }] : []),
    ...(can('user.manage') || can('role.manage') ? [{ id: 'access', label: 'People & access' }] : []),
  ];

  return (
    <Page
      title="Organization"
      subtitle="How this workspace is set up."
      actions={can('tenant.manage') ? <Link className="button" to="/settings">Branding</Link> : undefined}
    >
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      {tab === 'overview' && <Overview />}
      {tab === 'companies' && <Companies />}
      {tab === 'locations' && <Locations />}
      {tab === 'structure' && <Structure />}
      {tab === 'leave' && <LeaveSetup />}
      {tab === 'calendar' && <CalendarSetup />}
      {tab === 'workforce' && <WorkforceSetup />}
      {tab === 'expense' && <ExpenseSetup />}
      {tab === 'pay' && <CompensationSetup />}
      {tab === 'workflow' && <WorkflowSetup />}
      {tab === 'access' && <Access />}
    </Page>
  );
}

/** Setup completeness, so an administrator can see what is still missing. */
function Overview() {
  const tenant = useLoad(() => get<Tenant>('/api/tenant'), []);
  const companies = useLoad(() => get<{ companies: Company[] }>('/api/companies'), []);
  const locations = useLoad(() => get<{ locations: Location[] }>('/api/locations'), []);
  const departments = useLoad(() => get<{ departments: Department[] }>('/api/departments'), []);
  const designations = useLoad(() => get<{ designations: Designation[] }>('/api/designations'), []);
  const employees = useLoad(
    () => get<{ employees: unknown[] }>('/api/employees?scope=all&limit=1').catch(() => ({ employees: [] })),
    [],
  );

  if (tenant.loading) return <Loading label="Loading the organization" />;

  const checklist = [
    { label: 'A company exists', done: (companies.data?.companies.length ?? 0) > 0, where: 'Companies' },
    { label: 'A location exists', done: (locations.data?.locations.length ?? 0) > 0, where: 'Locations' },
    { label: 'Departments defined', done: (departments.data?.departments.length ?? 0) > 0, where: 'Departments & roles' },
    { label: 'Designations defined', done: (designations.data?.designations.length ?? 0) > 0, where: 'Departments & roles' },
    { label: 'At least one employee', done: (employees.data?.employees.length ?? 0) > 0, where: 'People' },
  ];
  const outstanding = checklist.filter((item) => !item.done);

  return (
    <>
      <ErrorMessage error={tenant.error} />

      <Card title="Setup">
        {outstanding.length === 0 ? (
          <Alert kind="success">This workspace has everything it needs to run payroll.</Alert>
        ) : (
          <Alert kind="info">
            {outstanding.length} {outstanding.length === 1 ? 'thing is' : 'things are'} still to
            be set up.
          </Alert>
        )}
        <Table
          caption="Setup checklist"
          rows={checklist}
          keyOf={(row) => row.label}
          columns={[
            { header: 'Step', render: (r) => r.label },
            {
              header: 'Status',
              render: (r) => <Badge value={r.done ? 'completed' : 'pending'} />,
            },
            { header: 'Where', render: (r) => <span className="muted small">{r.where}</span> },
          ]}
        />
      </Card>

      {tenant.data && (
        <Card title="Workspace">
          <Definitions
            items={[
              { label: 'Name', value: tenant.data.name },
              { label: 'Workspace address', value: <span className="mono">{tenant.data.slug}</span> },
              { label: 'Status', value: <Badge value={tenant.data.status} /> },
              { label: 'Timezone', value: tenant.data.timezone },
              { label: 'Locale', value: tenant.data.locale },
              { label: 'Currency', value: tenant.data.currency },
              { label: 'Country', value: tenant.data.country_code },
              {
                label: 'Financial year starts',
                value: new Intl.DateTimeFormat('en-GB', { month: 'long' })
                  .format(new Date(Date.UTC(2000, Number(tenant.data.fy_start_month) - 1, 1))),
              },
            ]}
          />
          <p className="muted small" style={{ marginBottom: 0 }}>
            These are fixed when the workspace is created. Changing them retrospectively would
            move every historical payroll period and tax year, so the product does not offer
            it — the branding and display settings that can safely change live under Settings.
          </p>
        </Card>
      )}
    </>
  );
}

/**
 * A collection with an add form.
 *
 * Every organization collection has the same shape on the server — GET returns a list, POST
 * creates one, both gated on `org.read` / `org.manage` — so they share one component here
 * rather than five near-identical ones.
 */
function Collection<T extends { id: string }>({
  title, path, columns, fields, empty,
}: {
  title: string;
  path: string;
  columns: Array<{ header: string; render: (row: T) => React.ReactNode }>;
  fields: Array<{ key: string; label: string; required?: boolean; hint?: string; type?: string; defaultValue?: string }>;
  empty: string;
}) {
  const rows = useLoad(() => get<Record<string, T[]>>(`/api/${path}`), []);
  const [adding, setAdding] = useState(false);

  return (
    <>
      <Card
        title={title}
        flush
        actions={
          can('org.manage') && !adding ? (
            <button className="small primary" onClick={() => setAdding(true)}>Add</button>
          ) : undefined
        }
      >
        {rows.loading ? (
          <Loading label={`Loading ${title.toLowerCase()}`} />
        ) : (
          <Table
            caption={title}
            rows={rows.data?.[path] ?? []}
            keyOf={(row) => row.id}
            empty={<Empty title={empty}>{can('org.manage') ? 'Add the first one above.' : ''}</Empty>}
            columns={columns}
          />
        )}
      </Card>

      {adding && (
        <AddToCollection
          title={title}
          path={path}
          fields={fields}
          onClose={() => setAdding(false)}
          onAdded={() => { setAdding(false); rows.reload(); }}
        />
      )}
    </>
  );
}

function AddToCollection({
  title, path, fields, onClose, onAdded,
}: {
  title: string;
  path: string;
  fields: Array<{ key: string; label: string; required?: boolean; hint?: string; type?: string; defaultValue?: string }>;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.key, f.defaultValue ?? ''])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    const found: Record<string, string> = {};
    for (const field of fields) {
      if (field.required && !values[field.key]?.trim()) found[field.key] = 'Required.';
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      // Empty optional fields are dropped rather than sent as '', which the server's
      // validators would reject for anything typed more strictly than a string.
      const payload = Object.fromEntries(
        Object.entries(values).filter(([, value]) => value.trim() !== ''),
      );
      await post(`/api/${path}`, payload);
      onAdded();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Add to ${title.toLowerCase()}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy}>Add</button>
        </>
      }
    >
      <ErrorMessage error={error} />
      {fields.map((field) => (
        <Field
          key={field.key}
          label={field.label}
          required={field.required}
          hint={field.hint}
          htmlFor={`add-${field.key}`}
          error={errors[field.key]}
        >
          <input
            id={`add-${field.key}`}
            type={field.type ?? 'text'}
            value={values[field.key] ?? ''}
            aria-invalid={errors[field.key] ? 'true' : undefined}
            onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
          />
        </Field>
      ))}
    </Modal>
  );
}

function Companies() {
  return (
    <Collection<Company>
      title="Companies"
      path="companies"
      empty="No company yet"
      columns={[
        { header: 'Name', render: (r) => r.name },
        { header: 'Legal name', render: (r) => r.legal_name },
        { header: 'Tax identifier', render: (r) => r.tax_identifier ?? <span className="muted">—</span> },
        { header: 'Status', render: (r) => <Badge value={r.status} /> },
      ]}
      fields={[
        { key: 'name', label: 'Name', required: true },
        { key: 'legalName', label: 'Legal name', required: true },
        { key: 'taxIdentifier', label: 'Tax identifier', hint: 'PAN or equivalent.' },
        { key: 'pfNumber', label: 'PF number' },
        { key: 'esiNumber', label: 'ESI number' },
      ]}
    />
  );
}

function Locations() {
  return (
    <Collection<Location>
      title="Locations"
      path="locations"
      empty="No location yet"
      columns={[
        { header: 'Name', render: (r) => r.name },
        { header: 'Timezone', render: (r) => r.timezone },
        { header: 'State', render: (r) => r.state_code ?? <span className="muted">—</span> },
        { header: 'Address', render: (r) => r.address ?? <span className="muted">—</span> },
      ]}
      fields={[
        { key: 'name', label: 'Name', required: true },
        { key: 'timezone', label: 'Timezone', defaultValue: 'Asia/Kolkata', required: true },
        {
          key: 'stateCode',
          label: 'State code',
          hint: 'Drives professional tax, so it must match the statutory state.',
        },
        { key: 'address', label: 'Address' },
      ]}
    />
  );
}

function Structure() {
  return (
    <>
      <Collection<Department>
        title="Departments"
        path="departments"
        empty="No department yet"
        columns={[
          { header: 'Name', render: (r) => r.name },
          { header: 'Code', render: (r) => r.code ?? <span className="muted">—</span> },
        ]}
        fields={[
          { key: 'name', label: 'Name', required: true },
          { key: 'code', label: 'Code' },
        ]}
      />
      <Collection<Branch>
        title="Branches"
        path="branches"
        empty="No branch yet"
        columns={[
          { header: 'Name', render: (r) => r.name },
        ]}
        fields={[
          { key: 'name', label: 'Name', required: true },
        ]}
      />
      <Collection<Designation>
        title="Designations"
        path="designations"
        empty="No designation yet"
        columns={[
          { header: 'Name', render: (r) => r.name },
          { header: 'Grade', render: (r) => r.grade ?? <span className="muted">—</span> },
        ]}
        fields={[
          { key: 'name', label: 'Name', required: true },
          { key: 'grade', label: 'Grade' },
        ]}
      />
    </>
  );
}

/**
 * Users and the roles they hold.
 *
 * Roles are listed with the permissions they carry so an administrator can see what granting
 * one actually means. Roles themselves are not editable here: the API exposes no update
 * endpoint for them, and the built-in roles are marked `is_system` precisely so they are not
 * quietly redefined.
 */
function Access() {
  const roles = useLoad(() => get<{ roles: Role[] }>('/api/roles'), []);
  const employees = useLoad(
    () => get<{ employees: Array<{ id: string; employee_code: string; first_name: string; last_name: string; work_email: string | null }> }>(
      '/api/employees?scope=all&limit=200',
    ).catch(() => ({ employees: [] })),
    [],
  );
  const [inviting, setInviting] = useState(false);

  return (
    <>
      <Card
        title="Roles"
        flush
        actions={
          can('user.manage') && !inviting ? (
            <button className="small primary" onClick={() => setInviting(true)}>Give someone access</button>
          ) : undefined
        }
      >
        {roles.loading ? (
          <Loading label="Loading roles" />
        ) : (
          <Table
            caption="Roles in this workspace"
            rows={roles.data?.roles ?? []}
            keyOf={(row) => row.id}
            empty="No roles."
            columns={[
              {
                header: 'Role',
                render: (r) => (
                  <span className="stack" style={{ gap: 2 }}>
                    <strong>{r.name}</strong>
                    {r.description && <span className="muted small">{r.description}</span>}
                  </span>
                ),
              },
              {
                header: 'Permissions',
                numeric: true,
                render: (r) => <span className="t-num">{r.permissions.length}</span>,
              },
              {
                header: 'Type',
                render: (r) => <Badge value={r.is_system ? 'active' : 'draft'} />,
              },
            ]}
          />
        )}
      </Card>

      <Card title="About access">
        <p className="muted small" style={{ margin: 0 }}>
          A role is a set of permissions, and the API enforces permissions rather than role
          names — so the product behaves consistently however roles are composed. Roles holding
          a sensitive permission (payroll, compensation, bank, tax, audit) require a second
          factor at sign-in; that is not configurable.
        </p>
      </Card>

      {inviting && (
        <InviteUser
          roles={roles.data?.roles ?? []}
          employees={employees.data?.employees ?? []}
          onClose={() => setInviting(false)}
          onDone={() => setInviting(false)}
        />
      )}
    </>
  );
}

function InviteUser({
  roles, employees, onClose, onDone,
}: {
  roles: Role[];
  employees: Array<{ id: string; employee_code: string; first_name: string; last_name: string; work_email: string | null }>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState({ email: '', fullName: '', password: '', roleName: '', employeeId: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    const found: Record<string, string> = {};
    if (!form.email.trim()) found.email = 'Required.';
    if (form.fullName.trim().length < 2) found.fullName = 'Required.';
    // The server demands at least twelve characters; saying so here avoids a round trip.
    if (form.password.length < 12) found.password = 'At least 12 characters.';
    if (!form.roleName) found.roleName = 'Choose a role.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      await post('/api/users', {
        email: form.email.trim(),
        fullName: form.fullName.trim(),
        password: form.password,
        roleNames: [form.roleName],
        ...(form.employeeId ? { employeeId: form.employeeId } : {}),
      });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Give someone access"
      onClose={onClose}
      footer={
        done ? (
          <button className="primary" onClick={onDone}>Close</button>
        ) : (
          <>
            <button onClick={onClose} disabled={busy}>Cancel</button>
            <button className="primary" onClick={submit} disabled={busy}>Create account</button>
          </>
        )
      }
    >
      <ErrorMessage error={error} />
      {done ? (
        <Alert kind="success">
          The account is active. If the role holds a sensitive permission, they will be asked
          to set up an authenticator the first time they sign in.
        </Alert>
      ) : (
        <>
          <Field label="Email" required htmlFor="u-email" error={errors.email}>
            <input id="u-email" type="email" value={form.email}
              aria-invalid={errors.email ? 'true' : undefined}
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="Full name" required htmlFor="u-name" error={errors.fullName}>
            <input id="u-name" value={form.fullName}
              aria-invalid={errors.fullName ? 'true' : undefined}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          </Field>
          <Field label="Initial password" required htmlFor="u-pass" error={errors.password}
            hint="At least 12 characters. They can change it once signed in.">
            <input id="u-pass" type="password" value={form.password}
              aria-invalid={errors.password ? 'true' : undefined}
              onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
          <Field label="Role" required htmlFor="u-role" error={errors.roleName}>
            <select id="u-role" value={form.roleName}
              aria-invalid={errors.roleName ? 'true' : undefined}
              onChange={(e) => setForm({ ...form, roleName: e.target.value })}>
              <option value="">Choose…</option>
              {roles.map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
            </select>
          </Field>
          <Field label="Link to employee" htmlFor="u-emp"
            hint="Needed for self-service: leave, attendance, payslips and approvals all hang off the employee record.">
            <select id="u-emp" value={form.employeeId}
              onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
              <option value="">Not linked</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.first_name} {e.last_name} ({e.employee_code})
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
    </Modal>
  );
}
