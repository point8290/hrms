import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDate, formatMoney, get, post } from '../lib/api.ts';
import {
  Alert, Badge, Card, Definitions, Empty, ErrorMessage, Field, Loading, Modal, Page, Person,
  Table, useLoad,
} from '../components/ui.tsx';

type Claim = {
  id: string; employee_id: string; claim_number: string; claim_date: string; title: string;
  status: string; total_claimed_amount: string; total_sanctioned_amount: string | null;
  reimbursable_amount: string | null; currency: string;
  submitted_at: string | null; paid_at: string | null; payment_reference: string | null;
  employee_name: string; employee_code: string;
};

type Line = {
  id: string; expense_type_name: string; expense_date: string; description: string;
  claimed_amount: string; sanctioned_amount: string | null; receipt_document_id: string | null;
};

/**
 * The finance queue.
 *
 * Reads `GET /api/expense-claims?scope=finance`, which is gated on `expense.finance` — a
 * manager holding `expense.approve` does not get here, because approving your own team's
 * claims is a different authority from seeing every claim in the company.
 *
 * Two actions, both of which already existed: sanction decides how much the company actually
 * pays, line by line; pay records that the money left. Neither invents a financial rule — the
 * server owns the state machine and this screen offers whichever action the claim's current
 * state admits.
 */
export function FinancePage() {
  const claims = useLoad(
    () => get<{ claims: Claim[] }>('/api/expense-claims?scope=finance&limit=100'),
    [],
  );
  const [open, setOpen] = useState<Claim | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const rows = claims.data?.claims ?? [];
  const awaiting = rows.filter((c) => c.status === 'finance_review');
  const toPay = rows.filter((c) => c.status === 'approved' || c.status === 'payment_pending');

  return (
    <Page
      title="Finance"
      subtitle="Claims a manager has approved, waiting on finance."
      actions={<button onClick={() => claims.reload()}>Refresh</button>}
    >
      {message && <Alert kind="success">{message}</Alert>}
      <ErrorMessage error={claims.error} />

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="stat actionable">
          <div className="label">Awaiting your review</div>
          <div className="value">{claims.loading ? '…' : awaiting.length}</div>
          <div className="hint">manager-approved, not yet sanctioned</div>
        </div>
        <div className="stat">
          <div className="label">Sanctioned, awaiting payment</div>
          <div className="value">{claims.loading ? '…' : toPay.length}</div>
          <div className="hint">ready to be paid</div>
        </div>
      </div>

      <Card title="Awaiting review" flush>
        {claims.loading ? (
          <Loading label="Loading the finance queue" />
        ) : (
          <Table
            caption="Claims awaiting finance review"
            rows={awaiting}
            keyOf={(row) => row.id}
            onRowClick={(row) => setOpen(row)}
            empty={
              <Empty title="Nothing awaiting review">
                Claims appear here once a manager has approved them.
              </Empty>
            }
            columns={[
              { header: 'Claim', render: (r) => r.claim_number },
              {
                header: 'From',
                render: (r) => <Person name={r.employee_name} meta={r.employee_code} size="sm" />,
              },
              { header: 'Title', render: (r) => r.title },
              {
                header: 'Claimed',
                numeric: true,
                render: (r) => formatMoney(r.total_claimed_amount, r.currency),
              },
              {
                header: 'Submitted',
                render: (r) => (r.submitted_at ? formatDate(r.submitted_at) : <span className="muted">—</span>),
              },
              {
                header: '',
                render: (r) => (
                  <button className="small primary" onClick={() => setOpen(r)}>Review</button>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Card title="Sanctioned, awaiting payment" flush>
        <Table
          caption="Claims awaiting payment"
          rows={toPay}
          keyOf={(row) => row.id}
          onRowClick={(row) => setOpen(row)}
          empty="Nothing waiting to be paid."
          columns={[
            { header: 'Claim', render: (r) => r.claim_number },
            {
              header: 'From',
              render: (r) => <Person name={r.employee_name} meta={r.employee_code} size="sm" />,
            },
            {
              header: 'Sanctioned',
              numeric: true,
              render: (r) => (r.total_sanctioned_amount
                ? formatMoney(r.total_sanctioned_amount, r.currency)
                : <span className="muted">—</span>),
            },
            { header: 'Status', render: (r) => <Badge value={r.status} /> },
            {
              header: '',
              render: (r) => <button className="small primary" onClick={() => setOpen(r)}>Pay</button>,
            },
          ]}
        />
      </Card>

      {open && (
        <FinanceClaim
          claim={open}
          onClose={() => setOpen(null)}
          onDone={(what) => {
            setOpen(null);
            setMessage(what);
            claims.reload();
          }}
        />
      )}
    </Page>
  );
}

/** One claim, with whichever finance action its current state admits. */
function FinanceClaim({
  claim, onClose, onDone,
}: { claim: Claim; onClose: () => void; onDone: (message: string) => void }) {
  const detail = useLoad(
    () => get<Claim & { lines: Line[] }>(`/api/expense-claims/${claim.id}`),
    [claim.id],
  );

  const [sanctioned, setSanctioned] = useState<Record<string, string>>({});
  const [decisionNote, setDecisionNote] = useState('');
  const [reference, setReference] = useState('');
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const lines = detail.data?.lines ?? [];
  const amountFor = (line: Line) => sanctioned[line.id] ?? line.claimed_amount;
  const total = lines.reduce((sum, line) => sum + (Number(amountFor(line)) || 0), 0);

  async function sanction() {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/expense-claims/${claim.id}/sanction`, {
        lines: lines.map((line) => ({
          lineId: line.id,
          sanctionedAmount: Number(amountFor(line)),
        })),
        ...(decisionNote.trim() ? { decisionNote: decisionNote.trim() } : {}),
      });
      onDone(`Claim ${claim.claim_number} sanctioned.`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    if (!reference.trim()) {
      setReferenceError('A payment reference is required — it is how this is reconciled.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post(`/api/expense-claims/${claim.id}/pay`, { paymentReference: reference.trim() });
      onDone(`Claim ${claim.claim_number} marked paid.`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const isReview = claim.status === 'finance_review';

  return (
    <Modal
      title={`${claim.claim_number} — ${claim.title}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>Close</button>
          {isReview
            ? <button className="primary" onClick={sanction} disabled={busy || detail.loading}>
                Sanction {formatMoney(String(total), claim.currency)}
              </button>
            : <button className="primary" onClick={pay} disabled={busy}>Mark paid</button>}
        </>
      }
    >
      <ErrorMessage error={error} />
      <ErrorMessage error={detail.error} />
      {detail.loading && <Loading label="Loading the claim" />}

      {detail.data && (
        <>
          <Definitions
            items={[
              { label: 'Raised by', value: <Person name={claim.employee_name} meta={claim.employee_code} size="sm" /> },
              { label: 'Claim date', value: claim.claim_date },
              {
                label: 'Claimed',
                value: <span className="t-num">{formatMoney(claim.total_claimed_amount, claim.currency)}</span>,
              },
              { label: 'Status', value: <Badge value={claim.status} /> },
            ]}
          />

          <div className="divider" />

          {isReview ? (
            <>
              <h3 className="t-section" style={{ margin: '0 0 8px' }}>Sanction each line</h3>
              <p className="muted small" style={{ marginTop: 0 }}>
                Sanctioning less than claimed is how a partial reimbursement is recorded. The
                claimant sees both figures.
              </p>
              {lines.map((line) => (
                <div key={line.id} className="row" style={{ alignItems: 'flex-end' }}>
                  <div style={{ flex: '2 1 200px' }}>
                    <div className="t-meta">{line.expense_type_name} · {line.expense_date}</div>
                    <div>{line.description}</div>
                    <div className="muted small">
                      Claimed {formatMoney(line.claimed_amount, claim.currency)}
                      {line.receipt_document_id ? ' · receipt attached' : ' · no receipt'}
                    </div>
                  </div>
                  <Field label="Sanctioned" htmlFor={`s-${line.id}`}>
                    <input id={`s-${line.id}`} type="number" min="0" step="0.01"
                      value={amountFor(line)}
                      onChange={(e) => setSanctioned({ ...sanctioned, [line.id]: e.target.value })} />
                  </Field>
                </div>
              ))}
              <Field label="Note" htmlFor="s-note" hint="Shown to the claimant.">
                <textarea id="s-note" value={decisionNote}
                  onChange={(e) => setDecisionNote(e.target.value)} />
              </Field>
            </>
          ) : (
            <>
              <h3 className="t-section" style={{ margin: '0 0 8px' }}>Record the payment</h3>
              <Definitions
                items={[
                  {
                    label: 'Sanctioned',
                    value: claim.total_sanctioned_amount
                      ? <span className="t-num">{formatMoney(claim.total_sanctioned_amount, claim.currency)}</span>
                      : null,
                  },
                  {
                    label: 'Reimbursable',
                    value: claim.reimbursable_amount
                      ? <span className="t-num">{formatMoney(claim.reimbursable_amount, claim.currency)}</span>
                      : null,
                  },
                ]}
              />
              <Field label="Payment reference" required htmlFor="p-ref" error={referenceError}
                hint="Bank reference or transaction id, so this can be reconciled later.">
                <input id="p-ref" value={reference}
                  aria-invalid={referenceError ? 'true' : undefined}
                  onChange={(e) => { setReference(e.target.value); if (referenceError) setReferenceError(null); }} />
              </Field>
            </>
          )}

          <div className="divider" />
          <Link to={`/expenses/${claim.id}`} className="small">Open the full claim</Link>
        </>
      )}
    </Modal>
  );
}
