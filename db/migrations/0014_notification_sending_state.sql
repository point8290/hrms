-- 0014 add the `sending` notification state.
--
-- Email is no longer sent inside the database transaction that claims the row. Sending
-- inside a transaction holds row locks across a network call to an email provider, and a
-- transaction that fails after a successful send loses the record of it — so the retry
-- delivers a second copy to a real person.
--
-- The dispatcher now runs three phases separated by commits:
--   claim (commit) -> send (no transaction open) -> settle (commit)
--
-- `sending` is the state between the first two. A row left in it means a worker died
-- mid-send; the stale sweep returns it to `pending`.

ALTER TABLE notification.notification
  DROP CONSTRAINT notification_status_check;

ALTER TABLE notification.notification
  ADD CONSTRAINT notification_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'suppressed'));

-- Keeps the stale-sweep lookup cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_notification_sending
  ON notification.notification (tenant_id, updated_at)
  WHERE status = 'sending';
