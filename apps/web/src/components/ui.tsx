import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api.ts';

/** Small presentational pieces shared across pages. */

export function Card({
  title, actions, children, flush,
}: { title?: string; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  // The heading labels the region, so a screen reader announces "Waiting on you, region"
  // rather than dropping the user into an unnamed group of rows.
  const id = title ? `card-${title.replace(/\W+/g, '-').toLowerCase()}` : undefined;
  return (
    <section className={flush ? 'card flush' : 'card'} aria-labelledby={id}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h2 id={id}>{title}</h2>}
          <div className="spacer" />
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label, value, hint, actionable,
}: { label: string; value: ReactNode; hint?: ReactNode; actionable?: boolean }) {
  return (
    <div className={actionable ? 'stat actionable' : 'stat'}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/** Status pill. The CSS class is derived from the value so new statuses degrade gracefully. */
export function Badge({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="muted">—</span>;
  return <span className={`badge ${value}`}>{value.replace(/_/g, ' ')}</span>;
}

export function Alert({
  kind, children,
}: { kind: 'error' | 'success' | 'info' | 'warning'; children: ReactNode }) {
  // Errors and warnings are announced; a success confirmation is polite rather than urgent.
  const assertive = kind === 'error' || kind === 'warning';
  return (
    <div className={`alert ${kind}`} role={assertive ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

/**
 * Renders an API failure for a human.
 *
 * Validation details from the server are surfaced rather than swallowed, because "Request
 * validation failed" alone tells the user nothing about which field to fix.
 */
export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  if (error instanceof ApiError) {
    const details = Array.isArray(error.details) ? error.details : null;
    return (
      <Alert kind="error">
        <div>{error.message}</div>
        {details && (
          <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {details.map((d: any, i: number) => (
              <li key={i}>
                {d.path}: {d.message}
              </li>
            ))}
          </ul>
        )}
      </Alert>
    );
  }
  return <Alert kind="error">{String((error as Error)?.message ?? error)}</Alert>;
}

export function Empty({
  children, title, actions,
}: { children?: ReactNode; title?: string; actions?: ReactNode }) {
  return (
    <div className="empty">
      {title && <div className="empty-title">{title}</div>}
      {children && <div className="empty-body">{children}</div>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  );
}

export function Table<T>({
  columns,
  rows,
  empty = 'Nothing to show',
  keyOf,
  onRowClick,
  caption,
}: {
  columns: Array<{ header: string; render: (row: T) => ReactNode; numeric?: boolean }>;
  rows: T[];
  empty?: ReactNode;
  keyOf: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  caption?: string;
}) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap">
      <table>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.header} className={c.numeric ? 'num' : undefined}>
                {/* An action column carries no visible header, but an unnamed column
                    header is announced as blank. Name it for assistive tech only. */}
                {c.header || <span className="sr-only">Actions</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={keyOf(row, index)}
              className={onRowClick ? 'clickable' : undefined}
              // A clickable row stays reachable by keyboard; controls inside the row keep
              // their own focus, so Enter here is an addition rather than the only route.
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (event) => {
                      if (event.key === 'Enter' && event.target === event.currentTarget) {
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
            >
              {columns.map((c) => (
                <td key={c.header} className={c.numeric ? 'num' : undefined}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type Loadable<T> = { data: T | null; loading: boolean; error: unknown; reload: () => void };

/**
 * Loads data for a page.
 *
 * Deliberately minimal — no cache, no client-side store. Pages here are short-lived
 * views over server state, and a stale cache on a payroll figure is worse than a refetch.
 */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loader()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, reload: () => setNonce((n) => n + 1) };
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="empty" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="stack" aria-hidden="true">
        <div className="skeleton" style={{ width: '40%' }} />
        <div className="skeleton" style={{ width: '70%' }} />
        <div className="skeleton" style={{ width: '55%' }} />
      </div>
    </div>
  );
}

export function Page({
  title,
  subtitle,
  actions,
  breadcrumbs,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: ReactNode;
  children: ReactNode;
}) {
  // The document title follows the page, so browser history and screen-reader page
  // announcements say where the user is rather than repeating the product name.
  useEffect(() => {
    const previous = document.title;
    const brand = previous.split(' \u00b7 ').pop() ?? 'People';
    document.title = `${title} \u00b7 ${brand}`;
    return () => {
      document.title = previous;
    };
  }, [title]);

  return (
    <>
      {breadcrumbs && <nav className="breadcrumbs" aria-label="Breadcrumb">{breadcrumbs}</nav>}
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
    </>
  );
}


// ---------------------------------------------------------------------------
// Workflow and detail primitives.
//
// These exist so a state machine looks the same wherever it appears. The backend owns the
// states; everything here only renders them. Nothing below decides what comes next.
// ---------------------------------------------------------------------------

export type TimelineEntry = {
  title: ReactNode;
  meta?: ReactNode;
  state?: 'done' | 'current' | 'failed' | 'pending';
};

/** Vertical history: what happened, in order, with who and when. */
export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) return <Empty>Nothing has happened yet.</Empty>;
  return (
    <ol className="timeline">
      {entries.map((entry, index) => (
        <li key={index} className={entry.state ?? 'pending'}>
          <div className="tl-title">{entry.title}</div>
          {entry.meta && <div className="tl-meta">{entry.meta}</div>}
        </li>
      ))}
    </ol>
  );
}

/**
 * Horizontal progress through a known sequence of states.
 *
 * `steps` comes from the backend's own vocabulary and `current` is whatever the server
 * reports. A status the server sends that is not in `steps` still renders as current rather
 * than as "no progress at all", so an unfamiliar state never looks like a stalled one.
 */
export function Stepper({
  steps, current, failed,
}: { steps: readonly string[]; current: string | null | undefined; failed?: boolean }) {
  const index = current ? steps.indexOf(current) : -1;
  return (
    <div className="stepper" role="list" aria-label="Progress">
      {steps.map((step, i) => {
        const state =
          failed && i === index ? 'failed'
          : index >= 0 && i < index ? 'done'
          : i === index ? 'current'
          : '';
        return (
          <div
            key={step}
            role="listitem"
            className={`step ${state}`}
            aria-current={i === index ? 'step' : undefined}
          >
            {step.replace(/_/g, ' ')}
          </div>
        );
      })}
    </div>
  );
}

/** Label/value pairs for a detail page. */
export function Definitions({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="definitions">
      {items.map((item) => (
        <div key={item.label} style={{ display: 'contents' }}>
          <dt>{item.label}</dt>
          <dd>{item.value ?? <span className="muted">&mdash;</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Initials for a person. Decorative, so it is hidden from assistive technology. */
export function Avatar({ name, size }: { name: string | null | undefined; size?: 'sm' | 'lg' }) {
  const initials = (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('');
  return (
    <span className={`avatar ${size ?? ''}`} aria-hidden="true">
      {initials || '?'}
    </span>
  );
}

/** A person as the product presents them: who they are, then what they are. */
export function Person({
  name, meta, size,
}: { name: string | null | undefined; meta?: ReactNode; size?: 'sm' | 'lg' }) {
  return (
    <span className="person">
      <Avatar name={name} size={size} />
      <span style={{ minWidth: 0 }}>
        <span className="person-name">{name ?? 'Unknown'}</span>
        {meta && <span className="person-meta" style={{ display: 'block' }}>{meta}</span>}
      </span>
    </span>
  );
}

/**
 * A modal dialog.
 *
 * Focus moves in on open and Escape closes, because a dialog a keyboard user cannot leave is
 * worse than no dialog at all. A backdrop click deliberately does not close it: these carry
 * decisions such as rejecting a request, and a stray click should not discard typing.
 */
export function Modal({
  title, children, onClose, footer,
}: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(
      'input, textarea, select, button, [tabindex]:not([tabindex="-1"])',
    )?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h2>{title}</h2>
        {children}
        {footer && <div className="modal-actions">{footer}</div>}
      </div>
    </div>
  );
}

/** A side panel, for detail without losing the list behind it. */
export function Drawer({
  title, subtitle, children, onClose, footer,
}: {
  title: string; subtitle?: ReactNode; children: ReactNode;
  onClose: () => void; footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button, a, input, textarea, select')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="drawer-head">
          <div>
            <h2 style={{ margin: 0 }}>{title}</h2>
            {subtitle && <div className="muted small" style={{ marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close">&#10005;</button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </>
  );
}

/** Tabs for a detail page. Only ever given sections with real data behind them. */
export function Tabs({
  tabs, active, onChange,
}: { tabs: Array<{ id: string; label: string }>; active: string; onChange: (id: string) => void }) {
  // A tab strip with one tab is chrome that explains nothing and cannot be used —
  // the page title already says where you are.
  if (tabs.length < 2) return null;
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={tab.id === active}
          className={`tab${tab.id === active ? ' active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** A labelled field whose hint and error are wired for assistive technology. */
export function Field({
  label, children, error, hint, required, htmlFor,
}: {
  label: string; children: ReactNode; error?: string | null;
  hint?: ReactNode; required?: boolean; htmlFor?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>
        {label}
        {required && <span className="required" aria-hidden="true"> *</span>}
      </label>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
      {error && <div className="field-error" role="alert">{error}</div>}
    </div>
  );
}
