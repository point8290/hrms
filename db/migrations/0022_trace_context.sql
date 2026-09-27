-- 0022 trace context on the outbox.
--
-- An HTTP request finalizes payroll; seconds later the publisher picks the event up; SQS
-- delivers it to a worker; the worker fans out one event per employee; a Python engine
-- finishes minutes after the request that started it returned. Without a trace id carried
-- across every one of those hops, "why did this employee's payslip not arrive" is answered
-- by correlating timestamps by hand.
--
-- W3C `traceparent` rather than a bespoke id, because it is what OpenTelemetry and every
-- APM vendor already speak, and because correlation_id answers a different question:
-- correlation_id groups work by business cause, traceparent reconstructs one causal chain.

ALTER TABLE integration.event_outbox
  ADD COLUMN traceparent text
    CHECK (traceparent IS NULL OR traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');

COMMENT ON COLUMN integration.event_outbox.traceparent IS
  'W3C trace context of whatever caused this event, so the async work joins the trace of the request that started it.';
