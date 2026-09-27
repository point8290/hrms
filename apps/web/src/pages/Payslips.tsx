import { useState } from 'react';
import { currentSession, formatDate, formatMoney, get } from '../lib/api.ts';
import { Badge, Card, ErrorMessage, Loading, Page, Table, useLoad } from '../components/ui.tsx';

type Payslip = {
  id: string;
  slip_number: string;
  period_start: string;
  period_end: string;
  payable_days: string;
  lop_days: string;
  gross_amount: string;
  deduction_amount: string;
  tax_amount: string;
  net_amount: string;
  currency: string;
  status: string;
  document_id: string | null;
};

type Component = {
  code: string;
  name: string;
  component_type: string;
  amount: string;
  is_statutory: boolean;
};

export function PayslipsPage() {
  const employeeId = currentSession()?.user.employeeId ?? null;
  const [openId, setOpenId] = useState<string | null>(null);

  const payslips = useLoad(
    () =>
      employeeId
        ? get<{ payslips: Payslip[] }>(`/api/payslips?employeeId=${employeeId}`)
        : Promise.resolve({ payslips: [] }),
    [employeeId],
  );

  return (
    <Page title="Payslips" subtitle="A finalized payslip is an immutable record of what was paid.">
      <ErrorMessage error={payslips.error} />
      <Card>
        {payslips.loading ? (
          <Loading />
        ) : (
          <Table
            rows={payslips.data?.payslips ?? []}
            keyOf={(row) => row.id}
            empty="No payslips yet."
            columns={[
              { header: 'Payslip', render: (r) => <span className="mono">{r.slip_number}</span> },
              {
                header: 'Period',
                render: (r) => `${formatDate(r.period_start)} – ${formatDate(r.period_end)}`,
              },
              { header: 'Paid days', numeric: true, render: (r) => r.payable_days },
              { header: 'Gross', numeric: true, render: (r) => formatMoney(r.gross_amount, r.currency) },
              {
                header: 'Net',
                numeric: true,
                render: (r) => <strong>{formatMoney(r.net_amount, r.currency)}</strong>,
              },
              { header: 'Status', render: (r) => <Badge value={r.status} /> },
              {
                header: '',
                render: (r) => (
                  <span className="inline">
                    <button onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                      {openId === r.id ? 'Hide' : 'Breakdown'}
                    </button>
                    {r.document_id && <DownloadButton documentId={r.document_id} />}
                  </span>
                ),
              },
            ]}
          />
        )}
      </Card>

      {openId && <PayslipDetail id={openId} />}
    </Page>
  );
}

function DownloadButton({ documentId }: { documentId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          // The API authorizes the request and returns a short-lived URL; the binary
          // itself never passes through the application.
          const result = await get<{ url: string }>(`/api/documents/${documentId}/download-url`);
          window.open(result.url, '_blank', 'noopener');
        } finally {
          setBusy(false);
        }
      }}
    >
      Download PDF
    </button>
  );
}

function PayslipDetail({ id }: { id: string }) {
  const detail = useLoad(() => get<any>(`/api/payslips/${id}`), [id]);

  if (detail.loading) return <Loading />;
  if (detail.error) return <ErrorMessage error={detail.error} />;
  if (!detail.data) return null;

  const currency: string = detail.data.currency;
  const components: Component[] = detail.data.components ?? [];
  const section = (type: string) => components.filter((c) => c.component_type === type);

  return (
    <Card title={`Breakdown — ${detail.data.slip_number}`}>
      <div className="grid cols-2">
        <div>
          <h3 className="small muted">Earnings</h3>
          <Table
            rows={section('earning')}
            keyOf={(row) => row.code}
            columns={[
              { header: 'Component', render: (r) => r.name },
              { header: 'Amount', numeric: true, render: (r) => formatMoney(r.amount, currency) },
            ]}
          />
        </div>
        <div>
          <h3 className="small muted">Deductions</h3>
          <Table
            rows={section('deduction')}
            keyOf={(row) => row.code}
            columns={[
              { header: 'Component', render: (r) => `${r.name}${r.is_statutory ? ' *' : ''}` },
              { header: 'Amount', numeric: true, render: (r) => formatMoney(r.amount, currency) },
            ]}
          />
        </div>
      </div>

      {section('employer_contribution').length > 0 && (
        <>
          <h3 className="small muted" style={{ marginTop: 18 }}>
            Employer contributions — not deducted from net pay
          </h3>
          <Table
            rows={section('employer_contribution')}
            keyOf={(row) => row.code}
            columns={[
              { header: 'Component', render: (r) => r.name },
              { header: 'Amount', numeric: true, render: (r) => formatMoney(r.amount, currency) },
            ]}
          />
        </>
      )}

      <div
        className="inline"
        style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}
      >
        <span className="muted small">
          Calculated by {detail.data.calculation_version} · {detail.data.payable_days} paid days
          {Number(detail.data.lop_days) > 0 ? ` · ${detail.data.lop_days} LOP` : ''}
        </span>
        <div className="spacer" />
        <strong style={{ fontSize: 16 }}>{formatMoney(detail.data.net_amount, currency)}</strong>
      </div>
    </Card>
  );
}
