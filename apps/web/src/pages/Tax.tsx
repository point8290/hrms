import { useState } from 'react';
import { can, currentSession, formatMoney, get, post, put } from '../lib/api.ts';
import {
  Alert, Badge, Card, Definitions, Empty, ErrorMessage, Field, Loading, Modal, Page, Person,
  Table, Tabs, useLoad,
} from '../components/ui.tsx';

type Declaration = {
  id: string;
  employee_id: string;
  financial_year: string;
  regime: 'old' | 'new';
  declarations: Record<string, number> | null;
  declared_amount: string;
  verified_amount: string | null;
  status: string;
  employee_name?: string;
  employee_code?: string;
};

type TaxYear = { id: string; label: string; status?: string; proof_cutoff_date?: string | null };

/**
 * Tax declarations.
 *
 * `tax.declare.self` has been granted to every Employee since the permission catalogue was
 * written, with no screen behind it. This is that screen, plus the verifier's side of the same
 * record.
 *
 * Nothing here computes tax. The declaration is what an employee *claims* they will invest or
 * spend; the payroll engine decides what that is worth, and the verified figure — set by
 * somebody holding `tax.manage` — is what it actually uses. The UI carries the numbers and
 * the statuses the backend returns and applies no rules of its own.
 */
export function TaxPage() {
  const canVerify = can('tax.manage');
  const canDeclare = can('tax.declare.self');
  const [tab, setTab] = useState(canDeclare ? 'mine' : 'review');

  const tabs = [
    ...(canDeclare ? [{ id: 'mine', label: 'My declaration' }] : []),
    ...(canVerify ? [{ id: 'review', label: 'Review' }] : []),
  ];

  return (
    <Page title="Tax" subtitle="What you have declared, and what payroll will use.">
      {tabs.length > 1 && <Tabs tabs={tabs} active={tab} onChange={setTab} />}
      {tab === 'mine' && canDeclare && <MyDeclaration />}
      {tab === 'review' && canVerify && <ReviewQueue />}
      {tabs.length === 0 && (
        <Card><Empty title="Nothing here for your role" /></Card>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Employee
// ---------------------------------------------------------------------------

/**
 * The exemption headings an employee declares against.
 *
 * These are the keys the API stores in its `declarations` map. It accepts any key with a
 * non-negative number, so this list is the product's vocabulary rather than a rule — the
 * server does not validate heading names, and the payroll engine resolves what each is worth
 * from the statutory rules it already holds.
 */
const HEADINGS = [
  { key: 'section_80c', label: 'Section 80C', hint: 'PF, ELSS, life insurance, tuition fees' },
  { key: 'section_80d', label: 'Section 80D', hint: 'Health insurance premium' },
  { key: 'section_80ccd_1b', label: 'Section 80CCD(1B)', hint: 'NPS, over and above 80C' },
  { key: 'section_80tta', label: 'Section 80TTA', hint: 'Interest on savings' },
  { key: 'home_loan_interest', label: 'Home loan interest', hint: 'Section 24(b)' },
];

function MyDeclaration() {
  const session = currentSession();
  const employeeId = session?.user.employeeId ?? null;

  const years = useLoad(
    () => get<{ tax_years: TaxYear[] }>('/api/tax/years').catch(() => ({ tax_years: [] as TaxYear[] })),
    [],
  );
  const declarations = useLoad(
    () => get<{ declarations: Declaration[] }>('/api/tax/declarations'),
    [],
  );
  const [editing, setEditing] = useState(false);

  if (!employeeId) {
    return (
      <Card>
        <Alert kind="info">
          This account is not linked to an employee record, so there is no declaration to make.
        </Alert>
      </Card>
    );
  }

  if (declarations.loading) return <Loading label="Loading your declaration" />;

  const rows = declarations.data?.declarations ?? [];
  const current = rows[0] ?? null;

  return (
    <>
      <ErrorMessage error={declarations.error} />

      <Card
        title="Your declaration"
        actions={
          !editing && current?.status !== 'verified' ? (
            <button className="small primary" onClick={() => setEditing(true)}>
              {current ? 'Update' : 'Declare'}
            </button>
          ) : undefined
        }
      >
        {!current ? (
          <Empty title="Nothing declared yet">
            Declaring what you plan to invest lets payroll withhold the right amount of tax
            rather than correcting it later in the year.
          </Empty>
        ) : (
          <>
            <Definitions
              items={[
                { label: 'Financial year', value: current.financial_year },
                { label: 'Regime', value: current.regime === 'new' ? 'New regime' : 'Old regime' },
                { label: 'Status', value: <Badge value={current.status} /> },
                {
                  label: 'Declared',
                  value: <span className="t-num">{formatMoney(current.declared_amount)}</span>,
                },
                ...(current.verified_amount
                  ? [{
                      label: 'Verified',
                      value: <span className="t-num">{formatMoney(current.verified_amount)}</span>,
                    }]
                  : []),
              ]}
            />
            {current.status === 'verified' && (
              <Alert kind="info">
                Verified. Payroll uses the verified figure, which may differ from what you
                declared if the proofs did not cover all of it.
              </Alert>
            )}
          </>
        )}
      </Card>

      {current?.declarations && Object.keys(current.declarations).length > 0 && (
        <Card title="Breakdown" flush>
          <Table
            caption="Declared amounts by heading"
            rows={Object.entries(current.declarations).map(([key, value]) => ({ key, value }))}
            keyOf={(row) => row.key}
            columns={[
              {
                header: 'Heading',
                render: (r) => HEADINGS.find((h) => h.key === r.key)?.label ?? r.key.replace(/_/g, ' '),
              },
              { header: 'Amount', numeric: true, render: (r) => formatMoney(String(r.value)) },
            ]}
          />
        </Card>
      )}

      {rows.length > 1 && (
        <Card title="Previous years" flush>
          <Table
            caption="Previous declarations"
            rows={rows.slice(1)}
            keyOf={(row) => row.id}
            columns={[
              { header: 'Year', render: (r) => r.financial_year },
              { header: 'Regime', render: (r) => r.regime },
              { header: 'Declared', numeric: true, render: (r) => formatMoney(r.declared_amount) },
              { header: 'Status', render: (r) => <Badge value={r.status} /> },
            ]}
          />
        </Card>
      )}

      {editing && (
        <DeclarationForm
          existing={current}
          years={years.data?.tax_years ?? []}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); declarations.reload(); }}
        />
      )}
    </>
  );
}

function DeclarationForm({
  existing, years, onClose, onSaved,
}: {
  existing: Declaration | null;
  years: TaxYear[];
  onClose: () => void;
  onSaved: () => void;
}) {
  // The API expects a year like "2026-27". Tax years the backend already knows about are
  // offered; otherwise the current one is derived from today's date on an April boundary,
  // which is the financial year this product is built around.
  const now = new Date();
  const startYear = now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const derived = `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;

  const [financialYear, setFinancialYear] = useState(existing?.financial_year ?? derived);
  const [regime, setRegime] = useState<'old' | 'new'>(existing?.regime ?? 'new');
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(HEADINGS.map((h) => [h.key, String(existing?.declarations?.[h.key] ?? '')])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const total = Object.values(amounts).reduce((sum, v) => sum + (Number(v) || 0), 0);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const declarations = Object.fromEntries(
        Object.entries(amounts)
          .filter(([, value]) => Number(value) > 0)
          .map(([key, value]) => [key, Number(value)]),
      );
      await put('/api/tax/declarations', { financialYear, regime, declarations });
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Declare your investments"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy}>Submit declaration</button>
        </>
      }
    >
      <ErrorMessage error={error} />
      <p className="muted small" style={{ marginTop: 0 }}>
        Declare what you expect to invest this year. Payroll withholds tax against it, and your
        employer may ask for proof before the year ends.
      </p>

      <div className="row">
        <Field label="Financial year" required htmlFor="t-year">
          {years.length > 0 ? (
            <select id="t-year" value={financialYear} onChange={(e) => setFinancialYear(e.target.value)}>
              {years.map((y) => <option key={y.id} value={y.label}>{y.label}</option>)}
            </select>
          ) : (
            <input id="t-year" value={financialYear} placeholder="2026-27"
              onChange={(e) => setFinancialYear(e.target.value)} />
          )}
        </Field>
        <Field label="Regime" required htmlFor="t-regime"
          hint="The new regime has lower rates and fewer exemptions.">
          <select id="t-regime" value={regime}
            onChange={(e) => setRegime(e.target.value as 'old' | 'new')}>
            <option value="new">New regime</option>
            <option value="old">Old regime</option>
          </select>
        </Field>
      </div>

      {regime === 'new' && (
        <Alert kind="info">
          Most of these exemptions do not apply under the new regime. The payroll engine
          decides what each one is worth — nothing is discarded here.
        </Alert>
      )}

      {HEADINGS.map((heading) => (
        <Field key={heading.key} label={heading.label} htmlFor={`t-${heading.key}`} hint={heading.hint}>
          <input id={`t-${heading.key}`} type="number" min="0" step="1"
            value={amounts[heading.key] ?? ''}
            onChange={(e) => setAmounts({ ...amounts, [heading.key]: e.target.value })} />
        </Field>
      ))}

      <div className="divider" />
      <div className="inline">
        <span className="t-meta">Total declared</span>
        <span className="t-num">{formatMoney(String(total))}</span>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

function ReviewQueue() {
  const declarations = useLoad(
    () => get<{ declarations: Declaration[] }>('/api/tax/declarations?scope=review'),
    [],
  );
  const [verifying, setVerifying] = useState<Declaration | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const rows = declarations.data?.declarations ?? [];
  const submitted = rows.filter((r) => r.status === 'submitted');

  return (
    <>
      <ErrorMessage error={declarations.error} />
      {message && <Alert kind="success">{message}</Alert>}

      <Card title="Awaiting verification" flush>
        {declarations.loading ? (
          <Loading label="Loading declarations" />
        ) : (
          <Table
            caption="Declarations awaiting verification"
            rows={submitted}
            keyOf={(row) => row.id}
            empty={<Empty title="Nothing to verify">Submitted declarations appear here.</Empty>}
            columns={[
              {
                header: 'Employee',
                render: (r) => <Person name={r.employee_name ?? 'Unknown'} meta={r.employee_code} size="sm" />,
              },
              { header: 'Year', render: (r) => r.financial_year },
              { header: 'Regime', render: (r) => r.regime },
              {
                header: 'Declared',
                numeric: true,
                render: (r) => <span className="t-num">{formatMoney(r.declared_amount)}</span>,
              },
              {
                header: '',
                render: (r) => (
                  <button className="small primary" onClick={() => setVerifying(r)}>Verify</button>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Card title="Already verified" flush>
        <Table
          caption="Verified declarations"
          rows={rows.filter((r) => r.status !== 'submitted')}
          keyOf={(row) => row.id}
          empty="Nothing verified yet."
          columns={[
            {
              header: 'Employee',
              render: (r) => <Person name={r.employee_name ?? 'Unknown'} meta={r.employee_code} size="sm" />,
            },
            { header: 'Year', render: (r) => r.financial_year },
            { header: 'Declared', numeric: true, render: (r) => formatMoney(r.declared_amount) },
            {
              header: 'Verified',
              numeric: true,
              render: (r) => (r.verified_amount
                ? <span className="t-num">{formatMoney(r.verified_amount)}</span>
                : <span className="muted">—</span>),
            },
            { header: 'Status', render: (r) => <Badge value={r.status} /> },
          ]}
        />
      </Card>

      {verifying && (
        <VerifyDeclaration
          declaration={verifying}
          onClose={() => setVerifying(null)}
          onDone={() => {
            setVerifying(null);
            setMessage('Verified. Payroll will use the verified amount.');
            declarations.reload();
          }}
        />
      )}
    </>
  );
}

function VerifyDeclaration({
  declaration, onClose, onDone,
}: { declaration: Declaration; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(declaration.declared_amount);
  const [note, setNote] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    if (!(Number(amount) >= 0)) {
      setAmountError('Enter the amount the proofs actually support.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post(`/api/tax/declarations/${declaration.id}/verify`, {
        verifiedAmount: Number(amount),
        ...(note.trim() ? { note: note.trim() } : {}),
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
      title={`Verify — ${declaration.employee_name ?? declaration.employee_code ?? 'employee'}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy}>Verify</button>
        </>
      }
    >
      <ErrorMessage error={error} />
      <p className="muted small" style={{ marginTop: 0 }}>
        The verified amount is what payroll uses. Entering less than was declared reduces the
        exemption and increases tax withheld for the rest of the year.
      </p>

      <Definitions
        items={[
          { label: 'Financial year', value: declaration.financial_year },
          { label: 'Regime', value: declaration.regime },
          {
            label: 'Declared',
            value: <span className="t-num">{formatMoney(declaration.declared_amount)}</span>,
          },
        ]}
      />

      {declaration.declarations && Object.keys(declaration.declarations).length > 0 && (
        <ul className="small" style={{ paddingLeft: 18 }}>
          {Object.entries(declaration.declarations).map(([key, value]) => (
            <li key={key}>
              {HEADINGS.find((h) => h.key === key)?.label ?? key.replace(/_/g, ' ')}:{' '}
              {formatMoney(String(value))}
            </li>
          ))}
        </ul>
      )}

      <div className="divider" />

      <Field label="Verified amount" required htmlFor="v-amount" error={amountError}>
        <input id="v-amount" type="number" min="0" value={amount}
          aria-invalid={amountError ? 'true' : undefined}
          onChange={(e) => { setAmount(e.target.value); if (amountError) setAmountError(null); }} />
      </Field>
      <Field label="Note" htmlFor="v-note" hint="Recorded on the audit trail.">
        <textarea id="v-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}
