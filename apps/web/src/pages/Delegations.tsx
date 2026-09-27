import { useState } from 'react';
import { can, currentSession, formatDate, get, post } from '../lib/api.ts';
import {
  Alert, Badge, Card, Empty, ErrorMessage, Field, Loading, Modal, Table, useLoad,
} from '../components/ui.tsx';

type Delegation = {
  id: string;
  delegator_user_id: string;
  delegate_user_id: string;
  entity_types: string[];
  starts_at: string;
  ends_at: string;
  revoked_at: string | null;
  delegator_name?: string | null;
  delegate_name?: string | null;
};

const WORKFLOW_ENTITIES = [
  'leave_application', 'expense_claim', 'attendance_correction',
  'employee_change', 'payroll_run', 'separation',
] as const;

/**
 * Handing approval authority to somebody else for a stretch of time.
 *
 * Delegation does not move the task. The engine resolves delegated authority at the moment a
 * decision is taken, which is why a revoked or expired delegation stops working immediately
 * and why nothing here rewrites an assignment. This screen only records the arrangement.
 *
 * Anyone may delegate their own authority; delegating somebody *else's* needs
 * `workflow.manage`, and the server enforces that rather than this form.
 */
export function Delegations() {
  const session = currentSession();
  const delegations = useLoad(
    () => get<{ delegations: Delegation[] }>('/api/workflow-delegations'),
    [],
  );
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function revoke(id: string) {
    setError(null);
    try {
      await post(`/api/workflow-delegations/${id}/revoke`, {});
      setMessage('Delegation revoked. It stops applying to any decision taken from now on.');
      delegations.reload();
    } catch (err) {
      setError(err);
    }
  }

  const rows = delegations.data?.delegations ?? [];
  const now = Date.now();
  const active = (d: Delegation) =>
    !d.revoked_at && new Date(d.starts_at).getTime() <= now && new Date(d.ends_at).getTime() >= now;

  return (
    <>
      {message && <Alert kind="success">{message}</Alert>}
      <ErrorMessage error={error} />
      <ErrorMessage error={delegations.error} />

      <Card
        title="Delegations"
        flush
        actions={!creating
          ? <button className="small primary" onClick={() => setCreating(true)}>Delegate approvals</button>
          : undefined}
      >
        {delegations.loading ? (
          <Loading label="Loading delegations" />
        ) : (
          <Table
            caption="Approval delegations"
            rows={rows}
            keyOf={(row) => row.id}
            empty={
              <Empty title="No delegations">
                Delegate your approvals when you are away, so requests do not sit waiting.
              </Empty>
            }
            columns={[
              {
                header: 'From',
                render: (r) => (r.delegator_user_id === session?.user.id
                  ? 'You'
                  : r.delegator_name ?? r.delegator_user_id.slice(0, 8)),
              },
              {
                header: 'To',
                render: (r) => (r.delegate_user_id === session?.user.id
                  ? 'You'
                  : r.delegate_name ?? r.delegate_user_id.slice(0, 8)),
              },
              {
                header: 'Covers',
                render: (r) => (r.entity_types ?? []).map((e) => e.replace(/_/g, ' ')).join(', '),
              },
              {
                header: 'Window',
                render: (r) => `${formatDate(r.starts_at)} – ${formatDate(r.ends_at)}`,
              },
              {
                header: 'Status',
                render: (r) => (
                  <Badge value={r.revoked_at ? 'cancelled' : active(r) ? 'active' : 'pending'} />
                ),
              },
              {
                header: '',
                render: (r) => (!r.revoked_at && (r.delegator_user_id === session?.user.id || can('workflow.manage'))
                  ? <button className="small" onClick={() => revoke(r.id)}>Revoke</button>
                  : null),
              },
            ]}
          />
        )}
      </Card>

      <Card>
        <p className="muted small" style={{ margin: 0 }}>
          Authority is resolved when a decision is taken, not when the task is created — so a
          delegation starts and stops applying exactly at its window, and revoking one takes
          effect immediately. A delegate cannot approve anything the delegator could not.
        </p>
      </Card>

      {creating && (
        <NewDelegation
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); delegations.reload(); }}
        />
      )}
    </>
  );
}

function NewDelegation({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  // Delegation is between *users*, so the list is people with a login, which the employee
  // directory carries as `user_id`.
  const employees = useLoad(
    () => get<{ employees: Array<{ id: string; user_id: string | null; employee_code: string; first_name: string; last_name: string }> }>(
      '/api/employees?scope=all&limit=200').catch(() => ({ employees: [] })),
    [],
  );

  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ delegateUserId: '', startsAt: today, endsAt: today });
  const [entityTypes, setEntityTypes] = useState<string[]>(['leave_application', 'expense_claim']);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const candidates = (employees.data?.employees ?? []).filter((e) => e.user_id);

  async function submit() {
    const found: Record<string, string> = {};
    if (!form.delegateUserId) found.delegateUserId = 'Choose who takes your approvals.';
    if (entityTypes.length === 0) found.entityTypes = 'Choose at least one request type.';
    if (form.endsAt < form.startsAt) found.endsAt = 'The end cannot precede the start.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      await post('/api/workflow-delegations', {
        delegateUserId: form.delegateUserId,
        entityTypes,
        // The API takes timestamps; a whole-day window is the useful default.
        startsAt: `${form.startsAt}T00:00:00.000Z`,
        endsAt: `${form.endsAt}T23:59:59.000Z`,
      });
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Delegate approvals"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy}>Delegate</button>
        </>
      }
    >
      <ErrorMessage error={error} />

      {candidates.length === 0 && (
        <Alert kind="info">
          Nobody else in this workspace has a login yet, so there is nobody to delegate to.
        </Alert>
      )}

      <Field label="Delegate to" required htmlFor="dg-to" error={errors.delegateUserId}
        hint="They can approve what you could, for this window only.">
        <select id="dg-to" value={form.delegateUserId}
          aria-invalid={errors.delegateUserId ? 'true' : undefined}
          onChange={(e) => setForm({ ...form, delegateUserId: e.target.value })}>
          <option value="">Choose&hellip;</option>
          {candidates.map((e) => (
            <option key={e.id} value={e.user_id!}>
              {e.first_name} {e.last_name} ({e.employee_code})
            </option>
          ))}
        </select>
      </Field>

      <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
        <legend className="t-meta" style={{ padding: 0 }}>Request types</legend>
        {errors.entityTypes && <div className="field-error" role="alert">{errors.entityTypes}</div>}
        <div className="inline">
          {WORKFLOW_ENTITIES.map((entity) => (
            <label key={entity} className="inline" style={{ fontWeight: 400, marginBottom: 0 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={entityTypes.includes(entity)}
                onChange={(e) => setEntityTypes(e.target.checked
                  ? [...entityTypes, entity]
                  : entityTypes.filter((t) => t !== entity))} />
              <span>{entity.replace(/_/g, ' ')}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="row">
        <Field label="From" required htmlFor="dg-from">
          <input id="dg-from" type="date" value={form.startsAt}
            onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
        </Field>
        <Field label="Until" required htmlFor="dg-until" error={errors.endsAt}>
          <input id="dg-until" type="date" value={form.endsAt}
            aria-invalid={errors.endsAt ? 'true' : undefined}
            onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
