import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import './styles.css';
import { can, canAny, currentSession, get, logout, restore, type Session } from './lib/api.ts';
import { applyBranding, type Branding } from './lib/branding.ts';
import { Loading } from './components/ui.tsx';
import { LoginPage } from './pages/Login.tsx';
import { DashboardPage } from './pages/Dashboard.tsx';
import { MyWorkPage } from './pages/MyWork.tsx';
import { AttendancePage } from './pages/Attendance.tsx';
import { LeavePage } from './pages/Leave.tsx';
import { ExpensesPage, ExpenseClaimPage } from './pages/Expenses.tsx';
import { ApprovalsPage } from './pages/Approvals.tsx';
import { NotificationsPage } from './pages/Notifications.tsx';
import { EmployeesPage, EmployeeDetailPage } from './pages/Employees.tsx';
import { PayrollPage, PayrollRunPage } from './pages/Payroll.tsx';
import { PayslipsPage } from './pages/Payslips.tsx';
import { AuditPage } from './pages/Audit.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { OrganizationPage } from './pages/Organization.tsx';
import { ReportsPage } from './pages/Reports.tsx';
import { TaxPage } from './pages/Tax.tsx';
import { FinancePage } from './pages/Finance.tsx';
import { AccountPage } from './pages/Account.tsx';

/**
 * Navigation is permission-driven rather than role-driven.
 *
 * The server is the authority on what a caller may do; mirroring its permission codes here
 * means the menu never offers an action the API will refuse, and a role composed of existing
 * permissions needs no front-end change. It also means the same shell serves every role —
 * what differs is which entries appear, not which application you are in.
 *
 * The grouping is by what a person is doing, not by which module owns the table: "Me" is
 * self-service, "Team" is work that arrives from other people, "Administration" is running
 * the organisation.
 */
const NAV = [
  { group: 'Me', items: [
    { to: '/my-work', label: 'My work', show: () => true, badge: 'work' as const },
    { to: '/', label: 'Home', show: () => true },
    { to: '/attendance', label: 'Attendance', show: () => canAny('attendance.read.self', 'attendance.read') },
    { to: '/leave', label: 'Leave', show: () => canAny('leave.read.self', 'leave.read') },
    { to: '/expenses', label: 'Expenses', show: () => canAny('expense.read.self', 'expense.read') },
    { to: '/payslips', label: 'Payslips', show: () => canAny('payslip.read.self', 'payroll.read') },
    { to: '/tax', label: 'Tax', show: () => canAny('tax.declare.self', 'tax.manage') },
    { to: '/notifications', label: 'Notifications', show: () => true, badge: 'unread' as const },
    { to: '/account', label: 'Account', show: () => true },
  ]},
  { group: 'Team', items: [
    // Every approver, not only leave and attendance: an expense-only approver previously
    // had no route to their own queue.
    { to: '/approvals', label: 'Approvals', show: () => canAny('leave.approve', 'expense.approve', 'attendance.correct'), badge: 'approvals' as const },
    { to: '/employees', label: 'People', show: () => canAny('employee.read', 'employee.read.team') },
    // Finance is a distinct authority: approving your own team's claims is not the same as
    // deciding what the company pays.
    { to: '/finance', label: 'Finance', show: () => can('expense.finance') },
  ]},
  { group: 'Administration', items: [
    { to: '/payroll', label: 'Payroll', show: () => can('payroll.read') },
    // Every report is permission-gated server side, so the entry appears for anyone holding
    // at least one of the permissions the catalogue is filtered by.
    { to: '/reports', label: 'Reports', show: () => canAny(
      'employee.read', 'attendance.read', 'leave.read', 'payroll.read',
      'compensation.read', 'expense.read', 'audit.read',
    ) },
    // org.read is what the collection endpoints require, so anyone who can read the
    // organization can open the page; the add controls inside it need org.manage.
    { to: '/organization', label: 'Organization', show: () => canAny('org.manage', 'user.manage', 'role.manage') },
    { to: '/audit', label: 'Audit trail', show: () => can('audit.read') },
    { to: '/settings', label: 'Settings', show: () => can('tenant.manage') },
  ]},
];

/**
 * Counts that belong in the navigation itself.
 *
 * Both come from the same endpoints the pages use, so a badge can never disagree with the
 * screen it points at. Fetched once per shell mount rather than polled: a number that is a
 * few minutes stale is not worth a request every few seconds from every open tab.
 */
function useWorkCounts() {
  const [counts, setCounts] = useState({ approvals: 0, unread: 0 });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [approvals, notifications] = await Promise.all([
        canAny('leave.approve', 'expense.approve', 'attendance.correct')
          ? get<{ approvals: unknown[] }>('/api/approvals').catch(() => ({ approvals: [] }))
          : Promise.resolve({ approvals: [] }),
        get<{ unread: number }>('/api/notifications?limit=1').catch(() => ({ unread: 0 })),
      ]);
      if (!cancelled) {
        setCounts({ approvals: approvals.approvals.length, unread: notifications.unread });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return counts;
}

function Shell({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const [branding, setBranding] = useState<Branding | null>(null);
  const counts = useWorkCounts();

  // The tenant's brand is applied as design tokens once the session exists. Until it
  // resolves the product's own identity is shown, so a slow lookup never blocks the app.
  useEffect(() => {
    let cancelled = false;
    get<Branding>('/api/tenant/branding')
      .then((result) => {
        if (cancelled) return;
        setBranding(result);
        applyBranding(result);
      })
      .catch(() => {
        /* branding is presentation; failing to load it must not break the product */
      });
    return () => {
      cancelled = true;
    };
  }, [session.tenant.id]);

  const name = branding?.display_name ?? session.tenant.name;
  const badgeFor = (badge?: 'work' | 'unread' | 'approvals') =>
    badge === 'unread' ? counts.unread
    : badge === 'approvals' || badge === 'work' ? counts.approvals
    : 0;

  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to content</a>

      <nav className="sidebar" aria-label="Primary">
        <div className="brand">
          {branding?.logo_url
            ? <img className="brand-logo" src={branding.logo_url} alt="" />
            : <span className="brand-mark">{name.slice(0, 1).toUpperCase()}</span>}
          <span className="brand-text">
            <span className="brand-name truncate">{name}</span>
            <small className="brand-sub truncate">{session.user.name}</small>
          </span>
        </div>

        {NAV.map((group) => {
          const visible = group.items.filter((item) => item.show());
          if (visible.length === 0) return null;
          return (
            <div key={group.group} className="nav-section">
              <div className="nav-group">{group.group}</div>
              {visible.map((item) => {
                const count = badgeFor(item.badge);
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
                  >
                    <span>{item.label}</span>
                    {count > 0 && (
                      <span className="nav-count">
                        {count}
                        <span className="sr-only"> items need attention</span>
                      </span>
                    )}
                  </NavLink>
                );
              })}
            </div>
          );
        })}

        <div className="sidebar-footer">
          <button onClick={onSignOut} style={{ width: '100%' }}>Sign out</button>
        </div>
      </nav>

      <main className="main" id="main">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/my-work" element={<MyWorkPage />} />
          <Route path="/attendance" element={<AttendancePage />} />
          <Route path="/leave" element={<LeavePage />} />
          <Route path="/expenses" element={<ExpensesPage />} />
          <Route path="/expenses/:id" element={<ExpenseClaimPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/employees" element={<EmployeesPage />} />
          <Route path="/employees/:id" element={<EmployeeDetailPage />} />
          <Route path="/payroll" element={<PayrollPage />} />
          <Route path="/payroll/:id" element={<PayrollRunPage />} />
          <Route path="/payslips" element={<PayslipsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/organization" element={<OrganizationPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/tax" element={<TaxPage />} />
          <Route path="/finance" element={<FinancePage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}

/** A dead end is still a page: say what happened and offer the way back. */
function NotFound() {
  return (
    <div className="empty">
      <div className="empty-title">That page does not exist</div>
      <div className="empty-body muted">
        The link may be old, or the feature may not be part of your role.
      </div>
      <div className="empty-actions">
        <Link className="button primary" to="/my-work">Go to my work</Link>
      </div>
    </div>
  );
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [restoring, setRestoring] = useState(true);

  // A page refresh should not sign the user out: the stored refresh token is exchanged
  // for a fresh access token before the first render decides what to show.
  useEffect(() => {
    restore()
      .then(setSession)
      .finally(() => setRestoring(false));
  }, []);

  if (restoring) return <Loading label="Restoring your session" />;
  if (!session) return <LoginPage onSignedIn={setSession} />;

  return (
    <Shell
      session={session}
      onSignOut={() => {
        logout();
        setSession(null);
      }}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

export { currentSession, useNavigate };
