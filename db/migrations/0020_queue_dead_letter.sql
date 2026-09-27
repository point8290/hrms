-- 0020 dead-letter state for the local queue driver.
--
-- On SQS a redrive policy moves a message aside once it has been received too many times.
-- The local driver had no equivalent, so a message no handler could process was redelivered
-- for ever: one poison event permanently degraded the consumer, and the failure looked like
-- "the worker is slow" rather than "this event cannot be processed".
--
-- Development and CI are where that bug is cheap to find, so the local driver now models
-- the dead letter too. Keeping the two drivers behaviourally equal is the whole point of
-- having a local one.

ALTER TABLE integration.local_queue_message
  ADD COLUMN dead_lettered_at   timestamptz,
  ADD COLUMN dead_letter_reason text;

-- The dead letter queue itself: small, and meant to be read by a human.
CREATE INDEX idx_local_queue_dead_lettered
  ON integration.local_queue_message (queue_name, dead_lettered_at DESC)
  WHERE dead_lettered_at IS NOT NULL;

COMMENT ON COLUMN integration.local_queue_message.dead_lettered_at IS
  'Set when a consumer gave up. The message is kept, not deleted: it is the evidence that an event was never processed.';
