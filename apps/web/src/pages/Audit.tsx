import { useState } from 'react';
import { get } from '../lib/api.ts';
import { Card, ErrorMessage, Loading, Page, Table, useLoad } from '../components/ui.tsx';

type Entry = {
  id: string;
  actor_label: string;
  entity_type: string;
  entity_id: string | null;
  action: string;
  is_sensitive: boolean;
  created_at: string;
  correlation_id: string | null;
};

/**
 * Read-only audit trail.
 *
 * The underlying table is append-only, so this view can only show what actually happened.
 * There is deliberately no edit or delete affordance to offer.
 */
export function AuditPage() {
  const [sensitiveOnly, setSensitiveOnly] = useState(false);
  const entries = useLoad(
    () => get<{ entries: Entry[] }>(`/api/audit?limit=100&sensitiveOnly=${sensitiveOnly}`),
    [sensitiveOnly],
  );

  return (
    <Page
      title="Audit trail"
      subtitle="Append-only record of who changed what, and when."
      actions={
        <label className="inline" style={{ marginBottom: 0 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={sensitiveOnly}
            onChange={(e) => setSensitiveOnly(e.target.checked)}
          />
          Sensitive actions only
        </label>
      }
    >
      <ErrorMessage error={entries.error} />
      <Card>
        {entries.loading ? (
          <Loading />
        ) : (
          <Table
            rows={entries.data?.entries ?? []}
            keyOf={(row) => row.id}
            empty="No audit records."
            columns={[
              { header: 'When', render: (r) => new Date(r.created_at).toLocaleString('en-IN') },
              { header: 'Actor', render: (r) => r.actor_label },
              { header: 'Action', render: (r) => <span className="mono small">{r.action}</span> },
              { header: 'Entity', render: (r) => r.entity_type.replace(/_/g, ' ') },
              {
                header: '',
                render: (r) => (r.is_sensitive ? <span className="badge warn">sensitive</span> : null),
              },
            ]}
          />
        )}
      </Card>
    </Page>
  );
}
