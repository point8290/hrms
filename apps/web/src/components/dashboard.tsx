import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, Empty, Loading, Table } from './ui.tsx';

/**
 * Dashboard primitives.
 *
 * One set of cards, composed differently per role — not seven dashboards. Everything here
 * builds on the existing components and tokens; there is no dashboard-specific stylesheet and
 * no second UI system.
 *
 * The rule these enforce is **action over decoration**: a card either tells somebody what
 * needs doing, or states a fact they need in order to decide. Nothing here computes a metric
 * of its own — every number comes from an authoritative endpoint, and a number the API cannot
 * supply is simply not shown rather than approximated.
 */

/** A titled band of cards. */
export function DashboardSection({
  title, description, children,
}: { title: string; description?: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 24 }}>
      <h2 className="t-section" style={{ margin: '0 0 2px' }}>{title}</h2>
      {description && <p className="t-meta" style={{ margin: '0 0 12px' }}>{description}</p>}
      {children}
    </section>
  );
}

/**
 * A single number with its meaning.
 *
 * `tone` never carries meaning on its own — the label and hint always say what the number is,
 * so the card is still readable to somebody who cannot distinguish the colours.
 */
export function MetricCard({
  label, value, hint, tone, to,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'attention' | 'neutral';
  to?: string;
}) {
  const body = (
    <div className={tone === 'attention' ? 'stat actionable' : 'stat'}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
  return to ? <Link to={to} style={{ color: 'inherit', textDecoration: 'none' }}>{body}</Link> : body;
}

/**
 * Work that needs this person, with enough context to act.
 *
 * Deliberately a table rather than a count: "3 approvals" sends somebody hunting, whereas the
 * rows tell them what the three are before they click.
 */
export function PendingWorkCard<T>({
  title, rows, columns, keyOf, loading, emptyTitle, emptyBody, actionLabel, actionTo,
}: {
  title: string;
  rows: T[];
  columns: Array<{ header: string; render: (row: T) => ReactNode; numeric?: boolean }>;
  keyOf: (row: T, index: number) => string;
  loading?: boolean;
  emptyTitle: string;
  emptyBody?: string;
  actionLabel?: string;
  actionTo?: string;
}) {
  return (
    <Card
      title={title}
      flush
      actions={actionTo && actionLabel ? <Link to={actionTo}>{actionLabel}</Link> : undefined}
    >
      {loading ? (
        <Loading label={`Loading ${title.toLowerCase()}`} />
      ) : (
        <Table
          caption={title}
          rows={rows}
          keyOf={keyOf}
          columns={columns}
          empty={<Empty title={emptyTitle}>{emptyBody}</Empty>}
        />
      )}
    </Card>
  );
}

/** One thing the person can do from here, with a sentence on why they would. */
export function QuickAction({
  label, to, description,
}: { label: string; to: string; description: string }) {
  return (
    <Link to={to} className="card" style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>
      <div className="t-section">{label}</div>
      <div className="t-meta" style={{ marginTop: 2 }}>{description}</div>
    </Link>
  );
}

/**
 * A short list of states and how many things are in each.
 *
 * Used where a role's question is "where is everything?" rather than "what must I do?" —
 * payroll runs by status, for instance.
 */
export function StatusSummary({
  title, counts, to, linkLabel, empty,
}: {
  title: string;
  counts: Array<{ status: string; count: number; label?: string }>;
  to?: string;
  linkLabel?: string;
  empty?: string;
}) {
  return (
    <Card title={title} actions={to && linkLabel ? <Link to={to}>{linkLabel}</Link> : undefined}>
      {counts.length === 0 ? (
        <Empty>{empty ?? 'Nothing to show.'}</Empty>
      ) : (
        <div className="inline" style={{ gap: 16 }}>
          {counts.map((entry) => (
            <span key={entry.status} className="inline" style={{ gap: 6 }}>
              <Badge value={entry.status} />
              <span className="t-num">{entry.count}</span>
              {entry.label && <span className="muted small">{entry.label}</span>}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Recent activity, newest first. Facts, not a feed to scroll. */
export function RecentActivity({
  title, items, to, linkLabel, empty,
}: {
  title: string;
  items: Array<{ id: string; primary: ReactNode; secondary?: ReactNode }>;
  to?: string;
  linkLabel?: string;
  empty?: string;
}) {
  return (
    <Card title={title} actions={to && linkLabel ? <Link to={to}>{linkLabel}</Link> : undefined}>
      {items.length === 0 ? (
        <Empty>{empty ?? 'Nothing recent.'}</Empty>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} className="stack">
          {items.map((item) => (
            <li key={item.id}>
              <div>{item.primary}</div>
              {item.secondary && <div className="muted small">{item.secondary}</div>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
