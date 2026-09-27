-- 0037 notifications: in-app read state, category, and employee preferences.
--
-- Extends the delivery model that already exists rather than replacing it. What was already
-- there and is deliberately untouched:
--
--   * `channel` already permits 'in_app' — the CHECK has allowed it since 0007, so the
--     channel model needed nothing;
--   * `status` already covers PRD s.18.3 end to end: pending = PENDING, sending = PROCESSING,
--     sent = SENT, failed = FAILED, and RETRY is the existing "back to pending with
--     retry_count + 1". No new status is added, because none would carry new meaning;
--   * `dedupe_key` with its partial unique index is already the deduplication mechanism;
--     s.18.6 only changes what goes *into* the key, not how it is enforced;
--   * retry/backoff/stale reclaim in apps/worker/src/notifications.ts.
--
-- READ is the one state with nowhere to live. s.18.3 has it as a sub-state of SENT for in-app
-- only ("SENT → READ"), so it is a timestamp on the row rather than a status: a read
-- notification is still sent, and a status would make those two facts compete.
--
-- Data validated before writing this: 461 notifications, all channel='email', all status='sent',
-- none without a dedupe key. Every constraint below is therefore added validated.
--
-- No payroll object is referenced, altered or reconstructed here.

-- ---------------------------------------------------------------------------
-- 1. In-app read state and the category a preference is expressed against.
-- ---------------------------------------------------------------------------

ALTER TABLE notification.notification
  ADD COLUMN read_at  timestamptz,
  -- Preferences are per category (PRD s.20), not per template: an employee turns off "leave"
  -- notifications, not "leave.rejected". Stored on the row so a notification can say which
  -- preference governed it without re-deriving it from the template code.
  ADD COLUMN category text NOT NULL DEFAULT 'general';

ALTER TABLE notification.notification
  -- Reading is an in-app concept. An email that was opened is not something this system
  -- knows, and pretending otherwise would put a number in front of an operator that nothing
  -- maintains.
  ADD CONSTRAINT notification_read_is_in_app
    CHECK (read_at IS NULL OR channel = 'in_app'),
  -- Unsent means unread. Otherwise a failed notification could be marked read.
  ADD CONSTRAINT notification_read_implies_sent
    CHECK (read_at IS NULL OR status = 'sent');

-- The employee's inbox, and the unread count on it.
CREATE INDEX idx_notification_inbox
  ON notification.notification (tenant_id, recipient_user_id, created_at DESC)
  WHERE channel = 'in_app';

COMMENT ON COLUMN notification.notification.read_at IS
  'In-app only. SENT -> READ (PRD s.18.3); a read notification is still sent.';
COMMENT ON COLUMN notification.notification.category IS
  'Preference category (PRD s.20). Mandatory categories ignore preferences entirely (s.18.4).';

-- ---------------------------------------------------------------------------
-- 2. Employee notification preferences.
--
-- One row per (user, category, channel), and only ever an *opt-out*: the absence of a row
-- means "send", so a preference that was never expressed can never suppress anything. That is
-- the fail-closed direction for notifications — the damage from a missed payslip alert is
-- worse than the damage from one the employee did not want.
--
-- There is no tenant-level preference table. PRD s.20 names a tenant policy layer but defines
-- no content for it beyond "may restrict disabling mandatory notifications", which is what the
-- mandatory classification already does. Inventing a configurable tenant policy would be
-- inventing semantics; the gap is reported instead.
-- ---------------------------------------------------------------------------

CREATE TABLE notification.notification_preference (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES identity.app_user(id) ON DELETE CASCADE,

  category   text NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('email', 'in_app')),
  enabled    boolean NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One opinion per person per category per channel.
  CONSTRAINT notification_preference_unique UNIQUE (tenant_id, user_id, category, channel)
);

-- The lookup made once per notification, per channel.
CREATE INDEX idx_notification_preference_lookup
  ON notification.notification_preference (tenant_id, user_id, category);

ALTER TABLE notification.notification_preference ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON notification.notification_preference
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON notification.notification_preference
  TO hrms_app, hrms_platform;

CREATE TRIGGER touch_notification_notification_preference
  BEFORE UPDATE ON notification.notification_preference
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON TABLE notification.notification_preference IS
  'Per-employee opt-out for a notification category and channel (PRD s.20). Never suppresses a mandatory category (s.18.4).';
