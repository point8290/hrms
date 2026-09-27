import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { can, currentSession, formatDate, formatMoney, get, post, today } from '../lib/api.ts';
import { uploadDocument, ACCEPTED_UPLOAD_TYPES } from '../lib/documents.ts';
import { Alert, Badge, Card, Definitions, Empty, ErrorMessage, Field, Loading, Page, Stepper, Table, Timeline, useLoad } from '../components/ui.tsx';

type Claim = {
  id: string; claim_number: string; claim_date: string; title: string; status: string;
  total_claimed_amount: string; total_sanctioned_amount: string | null;
  reimbursable_amount: string | null; currency: string;
  submitted_at: string | null; decided_at: string | null; decision_note: string | null;
  paid_at: string | null; payment_reference: string | null;
  business_purpose: string | null;
};
type Line = {
  id: string; expense_type: string; expense_type_name: string; expense_date: string;
  description: string; claimed_amount: string; sanctioned_amount: string | null;
};
type ExpenseType = {
  id: string; code: string; name: string; receipt_required: boolean;
  requires_business_purpose: boolean; limit_amount: string | null;
};

/**
 * The lifecycle an expense claim moves through, in the backend's own vocabulary.
 *
 * Listed here only so the UI can draw progress; the server decides which state a claim is in
 * and which transitions are legal. A status the server reports that is not in this list still
 * renders (see Stepper), so this array being incomplete degrades the picture rather than the
 * product.
 */
const CLAIM_FLOW = [
  'draft', 'manager_review', 'finance_review', 'approved', 'payment_pending', 'paid',
] as const;

/** Claims this person can see: their own by default, their reports' if they may. */
export function ExpensesPage() {
  const session = currentSession();
  const employeeId = session?.user.employeeId ?? null;
  const [creating, setCreating] = useState(false);

  const claims = useLoad(
    () => (employeeId
      ? get<{ claims: Claim[] }>(`/api/expense-claims?employeeId=${employeeId}&limit=100`)
      : Promise.resolve({ claims: [] })),
    [employeeId],
  );

  const navigate = useNavigate();

  return (
    <Page
      title="Expenses"
      subtitle="Claims you have raised, and what has happened to them."
      actions={
        can('expense.submit') && !creating ? (
          <button className="primary" onClick={() => setCreating(true)}>New claim</button>
        ) : undefined
      }
    >
      <ErrorMessage error={claims.error} />

      {!employeeId && (
        <Alert kind="info">
          This account is not linked to an employee record, so there are no personal claims to
          show.
        </Alert>
      )}

      {creating && (
        <NewClaim
          employeeId={employeeId!}
          onCancel={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            navigate(`/expenses/${id}`);
          }}
        />
      )}

      <Card flush>
        {claims.loading ? (
          <Loading label="Loading your claims" />
        ) : (
          <Table
            caption="Your expense claims"
            rows={claims.data?.claims ?? []}
            keyOf={(row) => row.id}
            onRowClick={(row) => navigate(`/expenses/${row.id}`)}
            empty={
              <Empty title="No claims yet">
                Raise a claim when you have spent money on the company's behalf. It goes to
                your approver, and you will be told what they decide.
              </Empty>
            }
            columns={[
              { header: 'Claim', render: (r) => r.claim_number },
              { header: 'Title', render: (r) => r.title },
              { header: 'Date', render: (r) => formatDate(r.claim_date) },
              {
                header: 'Claimed',
                numeric: true,
                render: (r) => formatMoney(r.total_claimed_amount, r.currency),
              },
              { header: 'Status', render: (r) => <Badge value={r.status} /> },
              {
                header: '',
                render: (r) => <Link className="button small" to={`/expenses/${r.id}`}>Open</Link>,
              },
            ]}
          />
        )}
      </Card>
    </Page>
  );
}

/** One claim: what is in it, where it has got to, and what can be done next. */
export function ExpenseClaimPage() {
  const { id } = useParams<{ id: string }>();
  const claim = useLoad(
    () => get<Claim & { lines: Line[] }>(`/api/expense-claims/${id}`),
    [id],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function act(action: 'submit' | 'cancel') {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/expense-claims/${id}/${action}`, {});
      claim.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (claim.loading) return <Loading label="Loading the claim" />;
  if (claim.error) return <ErrorMessage error={claim.error} />;
  if (!claim.data) return null;

  const c = claim.data;

  return (
    <Page
      title={c.title}
      breadcrumbs={<><Link to="/expenses">Expenses</Link><span className="sep">/</span><span>{c.claim_number}</span></>}
      subtitle={<span className="inline"><Badge value={c.status} /><span className="muted small">{c.claim_number}</span></span>}
      actions={<Link className="button" to="/expenses">Back to expenses</Link>}
    >
      <ErrorMessage error={error} />
      <Stepper steps={CLAIM_FLOW} current={c.status} failed={c.status === 'rejected'} />

      <div className="detail-grid">
        <div>
          <Card title="Claim">
            <Definitions
              items={[
                { label: 'Claim number', value: c.claim_number },
                { label: 'Date', value: c.claim_date },
                {
                  label: 'Total claimed',
                  value: <span className="t-num">{formatMoney(c.total_claimed_amount, c.currency)}</span>,
                },
                ...(c.total_sanctioned_amount
                  ? [{
                      label: 'Sanctioned',
                      value: <span className="t-num">{formatMoney(c.total_sanctioned_amount, c.currency)}</span>,
                    }]
                  : []),
                {
                  label: 'Purpose',
                  value: c.business_purpose || <span className="muted">not given</span>,
                },
              ]}
            />
          </Card>

          <Card title="Lines" flush>
            <Table
              caption="Lines on this claim"
              rows={claim.data.lines ?? []}
              keyOf={(row) => row.id}
              empty="This claim has no lines."
              columns={[
                { header: 'Type', render: (r) => r.expense_type_name },
                { header: 'Date', render: (r) => formatDate(r.expense_date) },
                { header: 'Description', render: (r) => r.description },
                {
                  header: 'Claimed',
                  numeric: true,
                  render: (r) => formatMoney(r.claimed_amount, c.currency),
                },
              ]}
            />
          </Card>

          <Card title="History">
            <Timeline
              entries={[
                { title: 'Raised', meta: c.claim_date, state: 'done' },
                {
                  title: 'Submitted for approval',
                  meta: c.submitted_at ? formatDate(c.submitted_at) : 'not submitted yet',
                  state: c.submitted_at ? 'done' : 'pending',
                },
                {
                  title: c.status === 'rejected' ? 'Rejected' : 'Approved',
                  meta: c.decided_at
                    ? <>{formatDate(c.decided_at)}{c.decision_note ? ` — “${c.decision_note}”` : ''}</>
                    : 'awaiting a decision',
                  state: c.decided_at ? (c.status === 'rejected' ? 'failed' : 'done') : 'pending',
                },
                {
                  title: 'Paid',
                  meta: c.paid_at
                    ? <>{formatDate(c.paid_at)}{c.payment_reference ? ` · ${c.payment_reference}` : ''}</>
                    : 'not paid yet',
                  state: c.paid_at ? 'done' : 'pending',
                },
              ]}
            />
          </Card>
        </div>

        <aside className="action-panel">
          <Card title="What happens next">
            <div className="stack">
              {c.status === 'draft' && (
                <>
                  <p className="muted small" style={{ margin: 0 }}>
                    This claim is still yours. Submitting it sends it to your approver.
                  </p>
                  <button className="primary" disabled={busy} onClick={() => act('submit')}>
                    Submit for approval
                  </button>
                </>
              )}
              {c.status === 'pending_approval' && (
                <>
                  <p className="muted small" style={{ margin: 0 }}>
                    Waiting on your approver. You will be notified when they decide.
                  </p>
                  <button disabled={busy} onClick={() => act('cancel')}>Cancel claim</button>
                </>
              )}
              {c.status === 'approved' && (
                <p className="muted small" style={{ margin: 0 }}>
                  Approved. Finance releases the payment; the reference appears here once it
                  has been made.
                </p>
              )}
              {c.status === 'rejected' && (
                <p className="muted small" style={{ margin: 0 }}>
                  Not approved{c.decision_note ? `: “${c.decision_note}”` : '.'} Raise a new
                  claim if you have more to add.
                </p>
              )}
              {c.status === 'paid' && (
                <p className="muted small" style={{ margin: 0 }}>
                  Paid{c.payment_reference ? ` · ${c.payment_reference}` : ''}. Nothing further
                  is needed from you.
                </p>
              )}
            </div>
          </Card>
        </aside>
      </div>
    </Page>
  );
}

/** Raising a claim. One line to start with; the API accepts up to fifty. */
function NewClaim({
  employeeId, onCancel, onCreated,
}: { employeeId: string; onCancel: () => void; onCreated: (id: string) => void }) {
  const types = useLoad(() => get<{ expense_types: ExpenseType[] }>('/api/expense-types'), []);
  const [form, setForm] = useState({
    title: '', claimDate: today(), businessPurpose: '',
    expenseTypeId: '', expenseDate: today(), description: '', claimedAmount: '',
  });
  const [receipt, setReceipt] = useState<{ documentId: string; filename: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const selected = types.data?.expense_types.find((t) => t.id === form.expenseTypeId);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (!form.title.trim()) found.title = 'Give the claim a title.';
    if (!form.expenseTypeId) found.expenseTypeId = 'Choose what this was spent on.';
    if (!form.description.trim()) found.description = 'Describe the expense.';
    if (!(Number(form.claimedAmount) > 0)) found.claimedAmount = 'Enter an amount above zero.';
    if (selected?.requires_business_purpose && !form.businessPurpose.trim()) {
      found.businessPurpose = 'This expense type needs a business purpose.';
    }
    // The server rejects a receipt-required line without a document. Checking here means the
    // person is told before they lose the form, rather than after a 422 they cannot act on.
    if (selected?.receipt_required && !receipt) {
      found.receipt = 'This expense type needs a receipt.';
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      const created = await post<{ id: string }>('/api/expense-claims', {
        employeeId,
        claimDate: form.claimDate,
        title: form.title.trim(),
        ...(form.businessPurpose.trim() ? { businessPurpose: form.businessPurpose.trim() } : {}),
        lines: [{
          expenseTypeId: form.expenseTypeId,
          expenseDate: form.expenseDate,
          description: form.description.trim(),
          claimedAmount: Number(form.claimedAmount),
          ...(receipt ? { receiptDocumentId: receipt.documentId } : {}),
        }],
      });
      onCreated(created.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="New expense claim">
      <ErrorMessage error={error} />
      <form onSubmit={submit}>
        <div className="row">
          <Field label="Title" required htmlFor="claim-title" error={errors.title}>
            <input
              id="claim-title"
              value={form.title}
              aria-invalid={errors.title ? 'true' : undefined}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </Field>
          <Field label="Claim date" htmlFor="claim-date">
            <input
              id="claim-date"
              type="date"
              value={form.claimDate}
              onChange={(e) => setForm({ ...form, claimDate: e.target.value })}
            />
          </Field>
        </div>

        <div className="row">
          <Field
            label="Expense type"
            required
            htmlFor="claim-type"
            error={errors.expenseTypeId}
            hint={selected?.receipt_required ? 'A receipt is required for this type.' : undefined}
          >
            <select
              id="claim-type"
              value={form.expenseTypeId}
              aria-invalid={errors.expenseTypeId ? 'true' : undefined}
              onChange={(e) => setForm({ ...form, expenseTypeId: e.target.value })}
            >
              <option value="">Choose…</option>
              {(types.data?.expense_types ?? []).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Spent on" htmlFor="claim-spent">
            <input
              id="claim-spent"
              type="date"
              value={form.expenseDate}
              onChange={(e) => setForm({ ...form, expenseDate: e.target.value })}
            />
          </Field>
          <Field label="Amount" required htmlFor="claim-amount" error={errors.claimedAmount}>
            <input
              id="claim-amount"
              type="number"
              min="0"
              step="0.01"
              value={form.claimedAmount}
              aria-invalid={errors.claimedAmount ? 'true' : undefined}
              onChange={(e) => setForm({ ...form, claimedAmount: e.target.value })}
            />
          </Field>
        </div>

        <Field label="Description" required htmlFor="claim-desc" error={errors.description}>
          <input
            id="claim-desc"
            value={form.description}
            aria-invalid={errors.description ? 'true' : undefined}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>

        <Field
          label="Business purpose"
          htmlFor="claim-purpose"
          error={errors.businessPurpose}
          required={selected?.requires_business_purpose}
        >
          <input
            id="claim-purpose"
            value={form.businessPurpose}
            aria-invalid={errors.businessPurpose ? 'true' : undefined}
            onChange={(e) => setForm({ ...form, businessPurpose: e.target.value })}
          />
        </Field>

        <ReceiptField
          employeeId={employeeId}
          required={Boolean(selected?.receipt_required)}
          value={receipt}
          error={errors.receipt}
          onChange={(next) => {
            setReceipt(next);
            if (next) setErrors(({ receipt: _drop, ...rest }) => rest);
          }}
        />

        <div className="inline">
          <button className="primary" type="submit" disabled={busy}>
            Create claim
          </button>
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <span className="muted small">
            Creating a claim does not submit it — you can review it first.
          </span>
        </div>
      </form>
    </Card>
  );
}


/**
 * Attaching a receipt.
 *
 * Three steps, which is the shape the document API already defines: ask for a presigned URL,
 * put the bytes straight at object storage, then confirm so the record becomes `available`.
 * The browser never holds storage credentials — the presigned URL is scoped to one key, one
 * method and a few minutes — and nothing here bypasses the document abstraction.
 *
 * A claim line references the confirmed document id, so what the approver eventually opens is
 * the authoritative record rather than something this form kept locally.
 */
function ReceiptField({
  employeeId, required, value, error, onChange,
}: {
  employeeId: string;
  required: boolean;
  value: { documentId: string; filename: string } | null;
  error?: string;
  onChange: (value: { documentId: string; filename: string } | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Clearing the input means a second attempt with the same file still fires a change.
    event.target.value = '';
    if (!file) return;

    setBusy(true);
    setFailure(null);
    try {
      const uploaded = await uploadDocument({
        file,
        employeeId,
        documentType: 'expense_receipt',
      });
      onChange({ documentId: uploaded.documentId, filename: file.name });
    } catch (err) {
      // Upload failures are their own category: the claim is not lost, only the attachment.
      setFailure(err instanceof Error ? err.message : 'The upload did not complete.');
      onChange(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Field
      label="Receipt"
      required={required}
      htmlFor="claim-receipt"
      error={error ?? failure}
      hint={
        required
          ? 'Required for this expense type. PDF, JPEG, PNG or WebP, up to 25 MB.'
          : 'Optional for this expense type. PDF, JPEG, PNG or WebP, up to 25 MB.'
      }
    >
      {value ? (
        <div className="inline">
          <span className="badge completed plain">Attached</span>
          <span className="truncate" style={{ maxWidth: 260 }}>{value.filename}</span>
          <button type="button" className="ghost small" onClick={() => onChange(null)}>
            Remove
          </button>
        </div>
      ) : (
        <input
          id="claim-receipt"
          type="file"
          accept={ACCEPTED_UPLOAD_TYPES.join(',')}
          disabled={busy}
          aria-invalid={error || failure ? 'true' : undefined}
          onChange={choose}
        />
      )}
      {busy && <div className="muted small" role="status">Uploading…</div>}
    </Field>
  );
}
