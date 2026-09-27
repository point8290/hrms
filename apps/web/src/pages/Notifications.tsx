import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDate, get, post, put } from '../lib/api.ts';
import { notificationLink } from '../lib/links.ts';
import {
  Alert, Card, Empty, ErrorMessage, Loading, Page, Tabs, useLoad,
} from '../components/ui.tsx';

type Notification = {
  id: string;
  category: string;
  template_code: string;
  subject: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
  read_at: string | null;
};

type Preference = { category: string; channel: 'email' | 'in_app'; enabled: boolean };

/**
 * The in-app inbox and the preferences behind it (PRD s.18, s.20).
 *
 * Only in-app notifications appear. An email was delivered to a mailbox this product does not
 * own, and listing sent mail back here would be a second copy of it — the API deliberately
 * does not return them, and this screen says so rather than leaving the absence unexplained.
 *
 * Every row links to the thing it is about where such a screen exists. Where it does not, the
 * row is plainly not clickable rather than pointing at a route that would 404; the mapping
 * lives in lib/links.ts so the gap is recorded in one place.
 */
export function NotificationsPage() {
  const [tab, setTab] = useState('inbox');

  return (
    <Page title="Notifications" subtitle="What the product has told you.">
      <Tabs
        tabs={[
          { id: 'inbox', label: 'Inbox' },
          { id: 'preferences', label: 'Preferences' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'inbox' ? <Inbox /> : <Preferences />}
    </Page>
  );
}

function Inbox() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const inbox = useLoad(
    () => get<{ notifications: Notification[]; unread: number }>(
      `/api/notifications?unreadOnly=${unreadOnly}&limit=100`,
    ),
    [unreadOnly],
  );
  const [error, setError] = useState<unknown>(null);

  async function markRead(id: string) {
    setError(null);
    try {
      await post(`/api/notifications/${id}/read`, {});
      inbox.reload();
    } catch (err) {
      setError(err);
    }
  }

  const rows = inbox.data?.notifications ?? [];

  return (
    <>
      <ErrorMessage error={error} />
      <ErrorMessage error={inbox.error} />

      <div className="filter-bar">
        <label className="inline" style={{ marginBottom: 0 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={unreadOnly}
            onChange={(event) => setUnreadOnly(event.target.checked)}
          />
          <span>Unread only</span>
        </label>
        <div className="spacer" />
        <span className="muted small">
          {inbox.data ? `${inbox.data.unread} unread` : ''}
        </span>
      </div>

      <Card>
        {inbox.loading ? (
          <Loading label="Loading your notifications" />
        ) : rows.length === 0 ? (
          <Empty title={unreadOnly ? 'Nothing unread' : 'No notifications yet'}>
            {unreadOnly
              ? 'Everything here has been read.'
              : 'When something happens that concerns you, it will appear here.'}
          </Empty>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {rows.map((notification) => (
              <NotificationRow
                key={notification.id}
                notification={notification}
                onRead={() => markRead(notification.id)}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card title="About these notifications">
        <p className="muted small" style={{ margin: 0 }}>
          Only in-app notifications are listed. Emails were delivered to your mailbox and are
          not repeated here. Some notifications cannot be switched off — a payslip becoming
          available, or a request waiting on your approval — because missing them has
          consequences the product cannot undo for you.
        </p>
      </Card>
    </>
  );
}

function NotificationRow({
  notification, onRead,
}: { notification: Notification; onRead: () => void }) {
  const href = notificationLink(notification);
  const unread = notification.read_at === null;

  return (
    <li className={`notif${unread ? ' unread' : ''}`}>
      <span className={`notif-dot${unread ? '' : ' read'}`} aria-hidden="true" />
      <div className="notif-body">
        <div className="notif-subject">
          {notification.subject ?? notification.template_code}
        </div>
        <div className="muted small">
          {formatDate(notification.created_at)} · {notification.category}
          {unread ? '' : ' · read'}
        </div>
      </div>
      <div className="inline">
        {href ? (
          <Link className="button small" to={href} onClick={unread ? onRead : undefined}>
            Open
          </Link>
        ) : (
          // Honest about the gap: the notification is real, the destination is not built.
          <span className="muted small">No screen yet</span>
        )}
        {unread && (
          <button className="small ghost" onClick={onRead}>
            Mark read
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * What this person may switch off, and what they may not.
 *
 * Mandatory categories are not rendered as disabled switches — offering a control the server
 * will refuse is worse than not offering one — they are listed separately with the reason.
 */
function Preferences() {
  const prefs = useLoad(
    () => get<{ preferences: Preference[]; mandatory_categories: string[] }>(
      '/api/notification-preferences',
    ),
    [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  async function toggle(preference: Preference, enabled: boolean) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await put('/api/notification-preferences', {
        preferences: [{ category: preference.category, channel: preference.channel, enabled }],
      });
      setSaved(true);
      prefs.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (prefs.loading) return <Loading label="Loading your preferences" />;

  const byCategory = new Map<string, Preference[]>();
  for (const preference of prefs.data?.preferences ?? []) {
    byCategory.set(preference.category, [...(byCategory.get(preference.category) ?? []), preference]);
  }

  return (
    <>
      <ErrorMessage error={error} />
      <ErrorMessage error={prefs.error} />
      {saved && <Alert kind="success">Saved.</Alert>}

      <Card title="Choose what you receive">
        {byCategory.size === 0 ? (
          <Empty>There is nothing configurable for your role.</Empty>
        ) : (
          <div className="stack gap-4">
            {[...byCategory.entries()].map(([category, entries]) => (
              <div key={category}>
                <div className="t-section" style={{ textTransform: 'capitalize' }}>{category}</div>
                <div className="inline" style={{ marginTop: 6, gap: 20 }}>
                  {entries.map((preference) => (
                    <label
                      key={preference.channel}
                      className="inline"
                      style={{ marginBottom: 0, fontWeight: 400 }}
                    >
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        disabled={busy}
                        checked={preference.enabled}
                        onChange={(event) => toggle(preference, event.target.checked)}
                      />
                      <span>{preference.channel === 'in_app' ? 'In-app' : 'Email'}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {(prefs.data?.mandatory_categories.length ?? 0) > 0 && (
        <Card title="Always sent">
          <p className="muted small" style={{ marginTop: 0 }}>
            These cannot be switched off:{' '}
            <strong style={{ textTransform: 'capitalize' }}>
              {prefs.data!.mandatory_categories.join(', ')}
            </strong>
            . They carry things you are accountable for — a payslip becoming available, or a
            request that will stall until you act on it.
          </p>
        </Card>
      )}
    </>
  );
}
