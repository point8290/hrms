import { useState } from 'react';
import { formatDate, formatMoney, get, post } from '../lib/api.ts';
import {
  Alert, Badge, Card, Definitions, Drawer, ErrorMessage, Field, Loading, Page, Person,
  Table, Tabs, Timeline, useLoad, type TimelineEntry,
} from '../components/ui.tsx';
import { Delegations } from './Delegations.tsx';

type Approval = {
  id: string;
  entity_type: string;
  entity_id: string;
  sequence_no: number;
  due_at: string | null;
  subject_employee_id: string | null;
  subject_name: string | null;
};

type Detail = {
  task: {
    id: string; entity_type: string; entity_id: string; sequence_no: number;
    status: string; due_at: string | null; created_at: string;
    group_mode: string | null; group_quorum: number | null;
    is_fallback: boolean; fallback_reason: string | null;
    escalated_at: string | null; escalation_reason: string | null;
    delegation_id: string | null;
    instance_status: string; current_sequence: number; attempt_no: number;
    subject_name: string | null; subject_code: string | null;
    initiated_by_name: string | null; escalated_to_name: string | null;
  };
  context: Record<string, any> | null;
  history: Array<{
    sequence_no: number; status: string; decision_note: string | null;
    decided_at: string | null; decided_by_name: string | null;
    approver_name: string | null; is_fallback: boolean; escalated_at: string | null;
  }>;
};

const LABELS: Record<string, string> = {
  leave_application: 'Leave request',
  expense_claim: 'Expense claim',
  attendance_correction: 'Attendance correction',
};

/**
 * The approver inbox.
 *
 * Only tasks assigned to this person that are also the current step appear here — the server
 * decides both, so a later approver never sees work that is not yet theirs and the UI cannot
 * offer an action the API would refuse.
 *
 * The list stays deliberately light; opening a row fetches the full context. That split
 * matters because the decision itself needs the request in front of the approver: approving
 * leave without seeing its dates, or a claim without its amount, is a rubber stamp rather
 * than an approval.
 */
export function ApprovalsPage() {
  const approvals = useLoad(() => get<{ approvals: Approval[] }>('/api/approvals'), []);
  const [openId, setOpenId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [tab, setTab] = useState('queue');

  return (
    <Page
      title="Approvals"
      subtitle="Requests waiting on your decision."
      actions={tab === 'queue'
        ? <button onClick={() => approvals.reload()}>Refresh</button>
        : undefined}
    >
      <Tabs
        tabs={[
          { id: 'queue', label: 'Waiting on you' },
          { id: 'delegation', label: 'Delegation' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'delegation' && <Delegations />}
      {tab !== 'queue' ? null : <>
      {message && <Alert kind="success">{message}</Alert>}
      <ErrorMessage error={approvals.error} />

      <Card flush>
        {approvals.loading ? (
          <Loading label="Loading your approvals" />
        ) : (
          <Table
            caption="Requests awaiting your decision"
            rows={approvals.data?.approvals ?? []}
            keyOf={(row) => row.id}
            onRowClick={(row) => setOpenId(row.id)}
            empty="Nothing is waiting on you."
            columns={[
              {
                header: 'Request',
                render: (r) => (
                  <span className="stack" style={{ gap: 2 }}>
                    <strong>{LABELS[r.entity_type] ?? r.entity_type.replace(/_/g, ' ')}</strong>
                    <span className="muted small">Step {r.sequence_no}</span>
                  </span>
                ),
              },
              { header: 'From', render: (r) => <Person name={r.subject_name} size="sm" /> },
              {
                header: 'Due',
                render: (r) => {
                  if (!r.due_at) return <span className="muted">—</span>;
                  const overdue = new Date(r.due_at) < new Date();
                  return overdue
                    ? <span className="badge overdue">overdue</span>
                    : <span>{formatDate(r.due_at)}</span>;
                },
              },
              {
                header: '',
                render: (r) => (
                  <button className="primary small" onClick={() => setOpenId(r.id)}>
                    Review
                  </button>
                ),
              },
            ]}
          />
        )}
      </Card>

      </>}

      {openId && (
        <ApprovalDrawer
          taskId={openId}
          onClose={() => setOpenId(null)}
          onDecided={(outcome) => {
            setOpenId(null);
            setMessage(
              outcome === 'in_progress'
                ? 'Recorded. The request now moves to the next approver.'
                : `Request ${outcome}.`,
            );
            approvals.reload();
          }}
        />
      )}
    </Page>
  );
}

/** One request, with everything needed to decide it and nothing that is not. */
function ApprovalDrawer({
  taskId, onClose, onDecided,
}: { taskId: string; onClose: () => void; onDecided: (outcome: string) => void }) {
  const detail = useLoad(() => get<Detail>(`/api/approvals/${taskId}`), [taskId]);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function decide(decision: 'approved' | 'rejected') {
    // A rejection without a reason leaves the requester with no idea what to change, so the
    // reason is required here as well as being recorded on the task.
    if (decision === 'rejected' && note.trim().length === 0) {
      setNoteError('Tell them why, so they know what to change.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await post<{ outcome: string }>(`/api/approvals/${taskId}/decision`, {
        decision,
        note: note.trim() || undefined,
      });
      onDecided(result.outcome);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const d = detail.data;
  const title = d ? (LABELS[d.task.entity_type] ?? d.task.entity_type.replace(/_/g, ' ')) : 'Request';

  return (
    <Drawer
      title={title}
      subtitle={d ? `From ${d.task.subject_name ?? 'unknown'}${d.task.subject_code ? ` · ${d.task.subject_code}` : ''}` : undefined}
      onClose={onClose}
      footer={
        d && (
          <>
            <button onClick={onClose} disabled={busy}>Cancel</button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => (rejecting ? decide('rejected') : setRejecting(true))}
            >
              {rejecting ? 'Confirm rejection' : 'Reject'}
            </button>
            <button className="primary" disabled={busy} onClick={() => decide('approved')}>
              Approve
            </button>
          </>
        )
      }
    >
      {detail.loading && <Loading label="Loading the request" />}
      <ErrorMessage error={detail.error} />
      <ErrorMessage error={error} />

      {d && (
        <div className="stack gap-4">
          {d.task.escalated_at && (
            <Alert kind="warning">
              Escalated {formatDate(d.task.escalated_at)}
              {d.task.escalation_reason ? ` — ${d.task.escalation_reason}` : ''}
              {d.task.escalated_to_name ? `, to ${d.task.escalated_to_name}` : ''}
            </Alert>
          )}
          {d.task.is_fallback && (
            <Alert kind="info">
              This task was routed to you as a fallback approver
              {d.task.fallback_reason ? ` — ${d.task.fallback_reason}` : ''}.
            </Alert>
          )}
          {d.task.delegation_id && (
            <Alert kind="info">You hold this task through a delegation.</Alert>
          )}

          <RequestContext entityType={d.task.entity_type} context={d.context} />

          <section>
            <h3 className="t-section" style={{ margin: '0 0 8px' }}>Routing</h3>
            <Definitions
              items={[
                { label: 'Raised by', value: d.task.initiated_by_name ?? '—' },
                { label: 'Step', value: `${d.task.sequence_no} of this request` },
                { label: 'Request state', value: <Badge value={d.task.instance_status} /> },
                {
                  label: 'Approval mode',
                  value: d.task.group_mode
                    ? `${d.task.group_mode}${d.task.group_quorum ? ` (quorum ${d.task.group_quorum})` : ''}`
                    : 'single approver',
                },
                { label: 'Due', value: d.task.due_at ? formatDate(d.task.due_at) : 'no due date' },
                ...(d.task.attempt_no > 1
                  ? [{ label: 'Attempt', value: `resubmission ${d.task.attempt_no}` }]
                  : []),
              ]}
            />
          </section>

          <section>
            <h3 className="t-section" style={{ margin: '0 0 8px' }}>History</h3>
            <Timeline entries={historyOf(d)} />
          </section>

          {rejecting && (
            <Field
              label="Reason for rejection"
              required
              htmlFor="rejection-note"
              error={noteError}
              hint="The requester sees this."
            >
              <textarea
                id="rejection-note"
                value={note}
                aria-invalid={noteError ? 'true' : undefined}
                onChange={(event) => {
                  setNote(event.target.value);
                  if (noteError) setNoteError(null);
                }}
              />
            </Field>
          )}
          {!rejecting && (
            <Field label="Note (optional)" htmlFor="approval-note">
              <textarea
                id="approval-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
          )}
        </div>
      )}
    </Drawer>
  );
}

function historyOf(d: Detail): TimelineEntry[] {
  return d.history.map((entry) => ({
    title: (
      <>
        Step {entry.sequence_no} · <Badge value={entry.status} />
        {entry.is_fallback && <span className="muted small"> (fallback)</span>}
      </>
    ),
    meta: (
      <>
        {entry.approver_name && <>Assigned to {entry.approver_name}. </>}
        {entry.decided_at
          ? <>Decided by {entry.decided_by_name ?? 'unknown'} on {formatDate(entry.decided_at)}.</>
          : <>Awaiting a decision.</>}
        {entry.decision_note && <div style={{ marginTop: 2 }}>“{entry.decision_note}”</div>}
      </>
    ),
    state:
      entry.status === 'approved' ? 'done'
      : entry.status === 'rejected' ? 'failed'
      : entry.sequence_no === d.task.current_sequence ? 'current'
      : 'pending',
  }));
}

/**
 * The request itself, in whatever shape its module uses.
 *
 * An entity type the backend understands but this screen does not is shown as "no preview",
 * not hidden — the approver should know something is there that the product cannot yet
 * render, rather than being shown an empty panel and assuming the request is empty.
 */
function RequestContext({
  entityType, context,
}: { entityType: string; context: Record<string, any> | null }) {
  if (!context) {
    return (
      <Alert kind="info">
        This product version cannot preview a {entityType.replace(/_/g, ' ')} yet. The routing
        and history below still apply.
      </Alert>
    );
  }

  if (entityType === 'leave_application') {
    return (
      <section>
        <h3 className="t-section" style={{ margin: '0 0 8px' }}>Request</h3>
        <Definitions
          items={[
            { label: 'Leave type', value: context.leave_type_name },
            {
              label: 'Dates',
              value: `${context.start_date} to ${context.end_date}`,
            },
            { label: 'Days', value: <span className="t-num">{context.quantity}</span> },
            { label: 'Reason', value: context.reason || <span className="muted">not given</span> },
            { label: 'Current status', value: <Badge value={context.status} /> },
          ]}
        />
      </section>
    );
  }

  if (entityType === 'expense_claim') {
    return (
      <section>
        <h3 className="t-section" style={{ margin: '0 0 8px' }}>Claim</h3>
        <Definitions
          items={[
            { label: 'Claim', value: context.claim_number },
            { label: 'Title', value: context.title },
            { label: 'Date', value: context.claim_date },
            {
              label: 'Amount claimed',
              value: (
                <span className="t-num">
                  {formatMoney(context.total_claimed_amount, context.currency)}
                </span>
              ),
            },
            {
              label: 'Purpose',
              value: context.business_purpose || <span className="muted">not given</span>,
            },
            { label: 'Current status', value: <Badge value={context.status} /> },
          ]}
        />
      </section>
    );
  }

  if (entityType === 'attendance_correction') {
    return (
      <section>
        <h3 className="t-section" style={{ margin: '0 0 8px' }}>Correction</h3>
        <Definitions
          items={[
            { label: 'Date', value: context.attendance_date },
            { label: 'Proposed status', value: <Badge value={context.proposed_status} /> },
            {
              label: 'Proposed in',
              value: context.proposed_in_at ? formatDate(context.proposed_in_at) : '—',
            },
            {
              label: 'Proposed out',
              value: context.proposed_out_at ? formatDate(context.proposed_out_at) : '—',
            },
            { label: 'Reason', value: context.reason || <span className="muted">not given</span> },
          ]}
        />
      </section>
    );
  }

  return null;
}
