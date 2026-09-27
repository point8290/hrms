import { useState } from 'react';
import { Link } from 'react-router-dom';
import { can, canAny, currentSession, formatDate, formatMoney, get, post, today } from '../lib/api.ts';
import {
  Alert, Badge, Card, Empty, ErrorMessage, Page, Person, useLoad,
} from '../components/ui.tsx';
import {
  DashboardSection, MetricCard, PendingWorkCard, QuickAction, RecentActivity, StatusSummary,
} from '../components/dashboard.tsx';

/**
 * The landing page, composed from role-driven sections.
 *
 * There is one dashboard, not seven. Each section declares the permissions it needs and is
 * rendered only for somebody who holds them, which means a person who is both a manager and
 * an employee — most managers — sees both sets in one place rather than choosing a mode.
 *
 * Every figure comes from an endpoint that already owns it. Nothing is computed here that the
 * backend does not already answer, and where an API cannot supply something the section is
 * omitted rather than filled with an estimate.
 */
export function DashboardPage() {
  const session = currentSession();
  const employeeId = session?.user.employeeId ?? null;
  const firstName = session?.user.name.split(' ')[0] ?? 'there';

  const isApprover = canAny('leave.approve', 'expense.approve', 'attendance.correct');
  const isHr = canAny('employee.manage', 'onboarding.manage');
  const isPayroll = can('payroll.read');
  const isFinance = can('expense.finance');
  const isAdmin = canAny('tenant.manage', 'org.manage', 'user.manage');

  return (
    <Page title={`Hello, ${firstName}`} subtitle={session?.tenant.name}>
      {!employeeId && (
        <Alert kind="info">
          This account is not linked to an employee record, so the self-service sections are
          empty. Administration still works.
        </Alert>
      )}

      <SelfService employeeId={employeeId} />
      {isApprover && <ManagerSection />}
      {isHr && <HrSection />}
      {isPayroll && <PayrollSection />}
      {isFinance && <FinanceSection />}
      {isAdmin && <AdminSection />}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Employee
// ---------------------------------------------------------------------------

function SelfService({ employeeId }: { employeeId: string | null }) {
  const balances = useLoad(
    () => (employeeId && canAny('leave.read.self', 'leave.read')
      ? get<{ balances: Array<{ leave_type_id: string; name: string; balance: number }> }>(
          `/api/leave/balance?employeeId=${employeeId}&asOf=${today()}`)
      : Promise.resolve({ balances: [] })),
    [employeeId],
  );
  const applications = useLoad(
    () => (employeeId && canAny('leave.read.self', 'leave.read')
      ? get<{ applications: Array<{ id: string; status: string; start_date: string; end_date: string }> }>(
          `/api/leave/applications?employeeId=${employeeId}`)
      : Promise.resolve({ applications: [] })),
    [employeeId],
  );
  const payslips = useLoad(
    () => (employeeId && canAny('payslip.read.self', 'payroll.read')
      ? get<{ payslips: Array<{ id: string; slip_number: string; period_start: string; net_amount: string; currency: string }> }>(
          `/api/payslips?employeeId=${employeeId}`)
      : Promise.resolve({ payslips: [] })),
    [employeeId],
  );
  const tasks = useLoad(
    () => (canAny('onboarding.read.self', 'onboarding.read')
      ? get<{ tasks: Array<{ id: string; title: string; overdue: boolean }> }>('/api/onboarding/my-tasks')
      : Promise.resolve({ tasks: [] })),
    [],
  );
  const claims = useLoad(
    () => (employeeId && canAny('expense.read.self', 'expense.read')
      ? get<{ claims: Array<{ id: string; claim_number: string; status: string; total_claimed_amount: string; currency: string }> }>(
          `/api/expense-claims?employeeId=${employeeId}&limit=50`)
      : Promise.resolve({ claims: [] })),
    [employeeId],
  );
  const notifications = useLoad(
    () => get<{ unread: number }>('/api/notifications?limit=1').catch(() => ({ unread: 0 })),
    [],
  );

  if (!employeeId) return null;

  const latest = payslips.data?.payslips?.[0];
  const totalLeave = balances.data?.balances.reduce((sum, b) => sum + Number(b.balance), 0) ?? 0;
  const pendingLeave = (applications.data?.applications ?? []).filter((a) => a.status === 'pending_approval');
  const openClaims = (claims.data?.claims ?? []).filter(
    (c) => c.status !== 'paid' && c.status !== 'rejected' && c.status !== 'cancelled',
  );
  const myTasks = tasks.data?.tasks ?? [];

  return (
    <DashboardSection title="You" description="Your own state, and anything you still owe.">
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <MetricCard
          label="Leave balance"
          value={balances.loading ? '…' : totalLeave}
          hint="days across all types"
          to="/leave"
        />
        <MetricCard
          label="Tasks assigned to you"
          value={tasks.loading ? '…' : myTasks.length}
          hint={myTasks.some((t) => t.overdue) ? 'some are overdue' : 'onboarding and documents'}
          tone={myTasks.length > 0 ? 'attention' : undefined}
          to="/my-work"
        />
        <MetricCard
          label="Open expense claims"
          value={claims.loading ? '…' : openClaims.length}
          hint="not yet paid or closed"
          to="/expenses"
        />
        <MetricCard
          label="Unread notifications"
          value={notifications.loading ? '…' : notifications.data?.unread ?? 0}
          hint="in-app"
          to="/notifications"
        />
      </div>

      <div className="grid cols-2">
        <Card title="Attendance" actions={<Link to="/attendance">Open attendance</Link>}>
          <CheckIn employeeId={employeeId} />
        </Card>

        <RecentActivity
          title="Your requests"
          to="/leave"
          linkLabel="Open leave"
          empty="You have nothing in flight."
          items={[
            ...pendingLeave.map((a) => ({
              id: a.id,
              primary: <>Leave {a.start_date} to {a.end_date}</>,
              secondary: <>Waiting on your approver</>,
            })),
            ...openClaims.slice(0, 3).map((c) => ({
              id: c.id,
              primary: <>Claim {c.claim_number} · {formatMoney(c.total_claimed_amount, c.currency)}</>,
              secondary: <Badge value={c.status} />,
            })),
          ]}
        />
      </div>

      {latest && (
        <Card title="Latest payslip" actions={<Link to="/payslips">All payslips</Link>}>
          <div className="inline">
            <span className="t-num" style={{ fontSize: 20 }}>
              {formatMoney(latest.net_amount, latest.currency)}
            </span>
            <span className="muted small">
              {latest.slip_number} · period from {formatDate(latest.period_start)}
            </span>
          </div>
        </Card>
      )}
    </DashboardSection>
  );
}

/** Self-service check-in. Records an observation; derived attendance follows. */
function CheckIn({ employeeId }: { employeeId: string }) {
  const [state, setState] = useState<{ busy: boolean; message: string | null; error: unknown }>({
    busy: false, message: null, error: null,
  });

  if (!can('attendance.checkin')) {
    return <p className="muted small" style={{ margin: 0 }}>You cannot record attendance yourself.</p>;
  }

  async function punch(direction: 'in' | 'out') {
    setState({ busy: true, message: null, error: null });
    try {
      const result = await post<{ attendance_date: string; duplicate: boolean }>(
        '/api/attendance/checkins',
        { employeeId, checkinAt: new Date().toISOString(), direction, source: 'web' },
      );
      setState({
        busy: false, error: null,
        message: result.duplicate
          ? 'That check-in was already recorded.'
          : `Checked ${direction} for ${formatDate(result.attendance_date)}. Your attendance will update shortly.`,
      });
    } catch (err) {
      setState({ busy: false, message: null, error: err });
    }
  }

  return (
    <>
      <ErrorMessage error={state.error} />
      {state.message && <div className="alert info" role="status">{state.message}</div>}
      <div className="inline">
        <button className="primary" disabled={state.busy} onClick={() => punch('in')}>Check in</button>
        <button disabled={state.busy} onClick={() => punch('out')}>Check out</button>
      </div>
      <p className="muted small" style={{ marginBottom: 0 }}>
        Recorded in your location's timezone. Working hours are calculated afterwards.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

function ManagerSection() {
  const approvals = useLoad(
    () => get<{ approvals: Array<{ id: string; entity_type: string; subject_name: string | null; due_at: string | null }> }>(
      '/api/approvals'),
    [],
  );
  const team = useLoad(
    () => (canAny('employee.read', 'employee.read.team')
      ? get<{ employees: Array<{ id: string; employment_status: string }> }>('/api/employees?scope=team&limit=200')
      : Promise.resolve({ employees: [] })),
    [],
  );

  const rows = approvals.data?.approvals ?? [];
  const overdue = rows.filter((r) => r.due_at && new Date(r.due_at) < new Date()).length;
  const members = team.data?.employees ?? [];

  return (
    <DashboardSection title="Your team" description="What your team needs from you.">
      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        <MetricCard
          label="Waiting on your decision"
          value={approvals.loading ? '…' : rows.length}
          hint={overdue > 0 ? `${overdue} past their due date` : 'requests'}
          tone={rows.length > 0 ? 'attention' : undefined}
          to="/approvals"
        />
        <MetricCard
          label="Team members"
          value={team.loading ? '…' : members.length}
          hint="in your reporting line"
          to="/employees"
        />
        <MetricCard
          label="On notice or onboarding"
          value={team.loading ? '…' : members.filter((m) => m.employment_status !== 'active').length}
          hint="not yet fully active"
          to="/employees"
        />
      </div>

      <PendingWorkCard
        title="Approvals"
        loading={approvals.loading}
        rows={rows.slice(0, 6)}
        keyOf={(row) => row.id}
        emptyTitle="Nothing is waiting on you"
        emptyBody="Requests raised by your team will appear here."
        actionLabel="Open approvals"
        actionTo="/approvals"
        columns={[
          { header: 'Request', render: (r) => r.entity_type.replace(/_/g, ' ') },
          { header: 'From', render: (r) => <Person name={r.subject_name} size="sm" /> },
          {
            header: 'Due',
            render: (r) =>
              !r.due_at ? <span className="muted">—</span>
              : new Date(r.due_at) < new Date() ? <span className="badge overdue">overdue</span>
              : formatDate(r.due_at),
          },
        ]}
      />
    </DashboardSection>
  );
}

// ---------------------------------------------------------------------------
// HR
// ---------------------------------------------------------------------------

function HrSection() {
  const employees = useLoad(
    () => get<{ employees: Array<{ id: string; employment_status: string; joining_date: string; first_name: string; last_name: string }> }>(
      '/api/employees?scope=all&limit=200'),
    [],
  );
  const plans = useLoad(
    () => (can('onboarding.read')
      ? get<{ plans: Array<{ id: string; employee_id: string; employee_name?: string; status: string; completed_count: number; task_count: number; overdue_count: number }> }>(
          '/api/onboarding/plans')
      : Promise.resolve({ plans: [] })),
    [],
  );

  const people = employees.data?.employees ?? [];
  const byStatus = new Map<string, number>();
  for (const person of people) {
    byStatus.set(person.employment_status, (byStatus.get(person.employment_status) ?? 0) + 1);
  }
  const open = (plans.data?.plans ?? []).filter((p) => p.status === 'in_progress');

  return (
    <DashboardSection title="People operations" description="The workforce, and what needs HR.">
      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        <MetricCard
          label="Headcount"
          value={employees.loading ? '…' : people.length}
          hint="employees on record"
          to="/employees"
        />
        <MetricCard
          label="Onboarding in progress"
          value={plans.loading ? '…' : open.length}
          hint="plans not yet complete"
          tone={open.length > 0 ? 'attention' : undefined}
          to="/employees"
        />
        <MetricCard
          label="Overdue onboarding tasks"
          value={plans.loading ? '…' : open.reduce((sum, p) => sum + (p.overdue_count ?? 0), 0)}
          hint="past their due date"
          to="/my-work"
        />
      </div>

      <StatusSummary
        title="Workforce by status"
        to="/employees"
        linkLabel="Open people"
        empty="No employees yet."
        counts={[...byStatus.entries()].map(([status, count]) => ({ status, count }))}
      />

      <PendingWorkCard
        title="Onboarding"
        loading={plans.loading}
        rows={open.slice(0, 6)}
        keyOf={(row) => row.id}
        emptyTitle="No onboarding in progress"
        emptyBody="Start onboarding from an employee's record once they are created."
        actionLabel="Open people"
        actionTo="/employees"
        columns={[
          {
            header: 'Employee',
            render: (r) => (
              <Link to={`/employees/${r.employee_id}`}>{r.employee_name ?? 'View employee'}</Link>
            ),
          },
          {
            header: 'Progress',
            render: (r) => <span className="t-num">{r.completed_count ?? 0} / {r.task_count ?? 0}</span>,
          },
          {
            header: 'Overdue',
            render: (r) => (r.overdue_count > 0
              ? <span className="badge overdue">{r.overdue_count}</span>
              : <span className="muted">none</span>),
          },
        ]}
      />

      <div className="grid cols-2">
        <QuickAction
          label="Add an employee"
          to="/employees"
          description="Create the record, then start their onboarding from it."
        />
        <QuickAction
          label="Organization setup"
          to="/organization"
          description="Companies, locations, departments and who has access."
        />
      </div>
    </DashboardSection>
  );
}

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

function PayrollSection() {
  const periods = useLoad(
    () => get<{ periods: Array<{ id: string; name: string; status: string }> }>('/api/payroll-periods'),
    [],
  );

  const rows = periods.data?.periods ?? [];
  const byStatus = new Map<string, number>();
  for (const period of rows) byStatus.set(period.status, (byStatus.get(period.status) ?? 0) + 1);

  return (
    <DashboardSection title="Payroll" description="Where each period has got to.">
      <StatusSummary
        title="Periods by status"
        to="/payroll"
        linkLabel="Open payroll"
        empty="No payroll periods yet."
        counts={[...byStatus.entries()].map(([status, count]) => ({ status, count }))}
      />
      <PendingWorkCard
        title="Recent periods"
        loading={periods.loading}
        rows={rows.slice(0, 6)}
        keyOf={(row) => row.id}
        emptyTitle="No payroll periods"
        emptyBody="Create a period to begin a payroll run."
        actionLabel="Open payroll"
        actionTo="/payroll"
        columns={[
          { header: 'Period', render: (r) => r.name },
          { header: 'Status', render: (r) => <Badge value={r.status} /> },
        ]}
      />
    </DashboardSection>
  );
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

function FinanceSection() {
  /**
   * Finance has no queue endpoint yet, and this section says so rather than inventing one.
   *
   * `GET /api/expense-claims` resolves exactly one employee — the caller, or whoever they
   * name — because `resolveTargetEmployee` is built for self-service and delegated reads. A
   * finance user needs the opposite shape: every claim in `finance_review`, whoever raised
   * it. There is no endpoint for that, so there is nothing authoritative to count, and
   * counting something else would be worse than showing nothing.
   *
   * Recorded as a gap in docs/knowledge/product-workflows.md.
   */
  return (
    <DashboardSection title="Finance" description="Money waiting on a decision.">
      <Card title="Claims awaiting finance">
        <Empty title="No finance queue yet">
          A manager's approval moves a claim to <strong>finance review</strong>, and the
          backend records that state correctly. What it does not yet offer is a way to list
          every claim in it — expense listing resolves a single employee at a time. Until that
          exists this panel would have to guess, so it shows nothing instead.
        </Empty>
      </Card>
      <div className="grid cols-2">
        <QuickAction
          label="Expenses"
          to="/expenses"
          description="Open a claim directly if you have its reference."
        />
        <QuickAction
          label="Payroll"
          to="/payroll"
          description="Finalized runs awaiting downstream payment."
        />
      </div>
    </DashboardSection>
  );
}

// ---------------------------------------------------------------------------
// Tenant admin
// ---------------------------------------------------------------------------

function AdminSection() {
  const companies = useLoad(() => get<{ companies: unknown[] }>('/api/companies').catch(() => ({ companies: [] })), []);
  const locations = useLoad(() => get<{ locations: unknown[] }>('/api/locations').catch(() => ({ locations: [] })), []);
  const departments = useLoad(() => get<{ departments: unknown[] }>('/api/departments').catch(() => ({ departments: [] })), []);
  const roles = useLoad(() => (can('role.manage') || can('user.manage')
    ? get<{ roles: unknown[] }>('/api/roles').catch(() => ({ roles: [] }))
    : Promise.resolve({ roles: [] })), []);

  const outstanding = [
    (companies.data?.companies.length ?? 0) === 0 && 'a company',
    (locations.data?.locations.length ?? 0) === 0 && 'a location',
    (departments.data?.departments.length ?? 0) === 0 && 'departments',
  ].filter(Boolean) as string[];

  return (
    <DashboardSection title="Workspace" description="Whether this organization is ready to run.">
      {outstanding.length > 0 && (
        <Alert kind="warning">
          Still to set up: {outstanding.join(', ')}. Payroll cannot run without a company.
        </Alert>
      )}

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <MetricCard label="Companies" value={companies.data?.companies.length ?? 0} to="/organization" />
        <MetricCard label="Locations" value={locations.data?.locations.length ?? 0} to="/organization" />
        <MetricCard label="Departments" value={departments.data?.departments.length ?? 0} to="/organization" />
        <MetricCard label="Roles" value={roles.data?.roles.length ?? 0} to="/organization" />
      </div>

      <div className="grid cols-2">
        <QuickAction
          label="Organization setup"
          to="/organization"
          description="Companies, locations, departments, designations and access."
        />
        {can('tenant.manage') && (
          <QuickAction
            label="Branding"
            to="/settings"
            description="Name, logo, colours and density for this workspace."
          />
        )}
      </div>
    </DashboardSection>
  );
}
