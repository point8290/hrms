import { Link } from 'react-router-dom';
import { useState } from 'react';
import { canAny, currentSession, formatDate, formatMoney, get, post } from '../lib/api.ts';
import {
  Alert, Badge, Card, Empty, ErrorMessage, Loading, Page, Person, Table, useLoad,
} from '../components/ui.tsx';

type Approval = {
  id: string; entity_type: string; entity_id: string;
  due_at: string | null; subject_name: string | null;
};
type OnboardingTask = {
  id: string; title: string; description: string | null; category: string;
  due_date: string | null; is_mandatory: boolean; status: string; overdue: boolean;
  requires_document_type: string | null;
  joiner_name: string; joiner_code: string;
};
type LeaveApplication = {
  id: string; status: string; start_date: string; end_date: string; quantity: string;
};
type ExpenseClaim = {
  id: string; claim_number: string; title: string; status: string;
  total_claimed_amount: string; currency: string;
};

const LABELS: Record<string, string> = {
  leave_application: 'Leave request',
  expense_claim: 'Expense claim',
  attendance_correction: 'Attendance correction',
};

/**
 * "What needs me?"
 *
 * The one screen in the product that answers that question for whoever is signed in,
 * whatever their role. Everything here is real backend state — an approval task the workflow
 * engine assigned, an onboarding task the plan created, a claim still sitting in draft. There
 * is no separate to-do list and nothing is invented: if the product cannot point at an
 * authoritative record, it does not appear.
 *
 * Sections are permission-gated the same way the API is, so an employee sees their own work
 * and an approver additionally sees what is queued for them. Somebody who is both — most
 * managers — sees both, in one place, which is the point.
 */
export function MyWorkPage() {
  const session = currentSession();
  const employeeId = session?.user.employeeId ?? null;
  const isApprover = canAny('leave.approve', 'expense.approve', 'attendance.correct');

  const approvals = useLoad(
    () => (isApprover
      ? get<{ approvals: Approval[] }>('/api/approvals')
      : Promise.resolve({ approvals: [] })),
    [],
  );

  const tasks = useLoad(
    () => (canAny('onboarding.read.self', 'onboarding.read')
      ? get<{ tasks: OnboardingTask[] }>('/api/onboarding/my-tasks')
      : Promise.resolve({ tasks: [] })),
    [],
  );

  const leave = useLoad(
    () => (employeeId && canAny('leave.read.self', 'leave.read')
      ? get<{ applications: LeaveApplication[] }>(`/api/leave/applications?employeeId=${employeeId}`)
      : Promise.resolve({ applications: [] })),
    [employeeId],
  );

  const claims = useLoad(
    () => (employeeId && canAny('expense.read.self', 'expense.read')
      ? get<{ claims: ExpenseClaim[] }>(`/api/expense-claims?employeeId=${employeeId}`)
      : Promise.resolve({ claims: [] })),
    [employeeId],
  );

  const pendingLeave = (leave.data?.applications ?? []).filter((a) => a.status === 'pending_approval');
  const draftClaims = (claims.data?.claims ?? []).filter((c) => c.status === 'draft');
  const waitingOnMe = approvals.data?.approvals.length ?? 0;
  const myTasks = tasks.data?.tasks.length ?? 0;

  const loading = approvals.loading || tasks.loading || leave.loading || claims.loading;
  const nothing =
    !loading && waitingOnMe === 0 && myTasks === 0 && pendingLeave.length === 0 && draftClaims.length === 0;

  return (
    <Page
      title="My work"
      subtitle="Everything waiting on you, and everything you are waiting for."
    >
      <ErrorMessage error={approvals.error ?? tasks.error ?? leave.error ?? claims.error} />

      {loading && <Loading label="Gathering your work" />}

      {nothing && (
        <Card>
          <Empty title="You are all caught up">
            Nothing needs your attention right now. Anything raised for you, or assigned to
            you, will appear here.
          </Empty>
        </Card>
      )}

      {waitingOnMe > 0 && (
        <Card
          title="Waiting on your decision"
          actions={<Link to="/approvals">Open approvals</Link>}
          flush
        >
          <Table
            caption="Approvals assigned to you"
            rows={approvals.data!.approvals}
            keyOf={(row) => row.id}
            columns={[
              {
                header: 'Request',
                render: (r) => LABELS[r.entity_type] ?? r.entity_type.replace(/_/g, ' '),
              },
              { header: 'From', render: (r) => <Person name={r.subject_name} size="sm" /> },
              {
                header: 'Due',
                render: (r) =>
                  !r.due_at ? <span className="muted">—</span>
                  : new Date(r.due_at) < new Date() ? <span className="badge overdue">overdue</span>
                  : formatDate(r.due_at),
              },
              {
                header: '',
                render: () => <Link className="button small" to="/approvals">Review</Link>,
              },
            ]}
          />
        </Card>
      )}

      {myTasks > 0 && <OnboardingTasks tasks={tasks.data!.tasks} onDone={() => tasks.reload()} />}

      {pendingLeave.length > 0 && (
        <Card title="Your requests in flight" actions={<Link to="/leave">Open leave</Link>} flush>
          <Table
            caption="Your leave requests awaiting a decision"
            rows={pendingLeave}
            keyOf={(row) => row.id}
            columns={[
              { header: 'Leave', render: (r) => `${r.start_date} to ${r.end_date}` },
              { header: 'Days', numeric: true, render: (r) => r.quantity },
              { header: 'Status', render: (r) => <Badge value={r.status} /> },
              {
                header: '',
                render: () => <span className="muted small">Waiting on your approver</span>,
              },
            ]}
          />
        </Card>
      )}

      {draftClaims.length > 0 && (
        <Card
          title="Expense claims you have not submitted"
          actions={<Link to="/expenses">Open expenses</Link>}
          flush
        >
          <Table
            caption="Draft expense claims"
            rows={draftClaims}
            keyOf={(row) => row.id}
            columns={[
              { header: 'Claim', render: (r) => r.claim_number },
              { header: 'Title', render: (r) => r.title },
              {
                header: 'Amount',
                numeric: true,
                render: (r) => formatMoney(r.total_claimed_amount, r.currency),
              },
              {
                header: '',
                render: (r) => (
                  <Link className="button small" to={`/expenses/${r.id}`}>Open</Link>
                ),
              },
            ]}
          />
        </Card>
      )}
    </Page>
  );
}

/** Onboarding tasks assigned to this person, completable in place. */
function OnboardingTasks({
  tasks, onDone,
}: { tasks: OnboardingTask[]; onDone: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function complete(task: OnboardingTask) {
    setBusyId(task.id);
    setError(null);
    try {
      await post(`/api/onboarding/tasks/${task.id}/complete`, {});
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusyId(null);
    }
  }

  const overdue = tasks.filter((t) => t.overdue).length;

  return (
    <Card title="Tasks assigned to you" flush>
      {overdue > 0 && (
        <div style={{ padding: '0 20px' }}>
          <Alert kind="warning">
            {overdue} {overdue === 1 ? 'task is' : 'tasks are'} past their due date.
          </Alert>
        </div>
      )}
      {error !== null && <div style={{ padding: '0 20px' }}><ErrorMessage error={error} /></div>}
      <Table
        caption="Onboarding tasks assigned to you"
        rows={tasks}
        keyOf={(row) => row.id}
        columns={[
          {
            header: 'Task',
            render: (r) => (
              <span className="stack" style={{ gap: 2 }}>
                <strong>{r.title}</strong>
                {r.description && <span className="muted small">{r.description}</span>}
                <span className="muted small">
                  For {r.joiner_name} · {r.category}
                  {r.is_mandatory && ' · required'}
                </span>
              </span>
            ),
          },
          {
            header: 'Due',
            render: (r) =>
              !r.due_date ? <span className="muted">—</span>
              : r.overdue ? <span className="badge overdue">{r.due_date}</span>
              : r.due_date,
          },
          { header: 'Status', render: (r) => <Badge value={r.status} /> },
          {
            header: '',
            render: (r) =>
              // A task that needs a document is completed where the document is uploaded,
              // not from a list — offering a bare "Done" here would let somebody close it
              // without the thing it exists to collect.
              r.requires_document_type ? (
                <span className="muted small">Needs a document</span>
              ) : (
                <button
                  className="small"
                  disabled={busyId === r.id}
                  onClick={() => complete(r)}
                >
                  Mark done
                </button>
              ),
          },
        ]}
      />
    </Card>
  );
}
