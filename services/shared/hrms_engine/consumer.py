"""Queue consumption loop shared by the calculation engines.

Mirrors the Node side deliberately: the same at-least-once semantics, the same visibility
timeout, the same dead-letter behaviour. Local development uses a Postgres-backed queue so
duplicate delivery is exercised in tests rather than discovered in production.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import time
from dataclasses import dataclass
from typing import Any, Callable

from .db import platform_transaction
from .trace import continue_trace, current_trace_id

log = logging.getLogger(__name__)

REQUIRED_ENVELOPE_FIELDS = (
    "event_id",
    "event_type",
    "tenant_id",
    "aggregate_type",
    "aggregate_id",
    "occurred_at",
)


@dataclass
class Message:
    receipt_handle: str
    body: dict[str, Any]
    #: How many times the broker says this message has been delivered.
    #:
    #: `None` means the broker did not say, which is not the same as "once". It is the sole
    #: input to the exhaustion decision, so a missing value must never be quietly rounded
    #: down to a fresh first delivery — see `_settle_failure`.
    receive_count: int | None


class Queue:
    def receive(self, queue_name: str, max_messages: int, visibility_seconds: int) -> list[Message]:
        raise NotImplementedError

    def delete(self, queue_name: str, receipt_handle: str) -> None:
        raise NotImplementedError

    def release(self, queue_name: str, receipt_handle: str, delay_seconds: int) -> None:
        raise NotImplementedError

    def dead_letter(self, queue_name: str, receipt_handle: str, reason: str) -> None:
        """Takes a message out of circulation permanently, with a reason.

        Terminal, and deliberately not a delete: a consumer that gives up has to say so
        somewhere durable. Dropping the message loses the evidence that an event was never
        handled — for payroll, the evidence that someone was not paid correctly.

        What "terminal" means is the driver's to decide, because the two drivers have
        different terminal mechanisms: SQS has a redrive policy and its own dead letter
        queue, the local driver has `dead_lettered_at`. Both must end the same way — the
        message never comes back down the ordinary receive path.
        """
        raise NotImplementedError


class LocalQueue(Queue):
    """Postgres-backed transport for development and integration tests."""

    def receive(self, queue_name: str, max_messages: int, visibility_seconds: int) -> list[Message]:
        with platform_transaction("queue-receive") as cur:
            cur.execute(
                """
                UPDATE integration.local_queue_message m
                   SET visible_at = now() + (%s || ' seconds')::interval,
                       receive_count = m.receive_count + 1
                 WHERE m.id IN (
                   SELECT id FROM integration.local_queue_message
                    WHERE queue_name = %s
                      AND deleted_at IS NULL
                      -- A dead-lettered message is terminal. Without this the local driver
                      -- had no terminal state at all: a message the consumer had given up
                      -- on came straight back on the next poll, for ever, which is the one
                      -- failure migration 0020 exists to prevent.
                      AND dead_lettered_at IS NULL
                      AND visible_at <= now()
                    ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED
                 )
                 RETURNING m.id, m.body, m.receive_count
                """,
                (str(visibility_seconds), queue_name, max_messages),
            )
            return [
                Message(receipt_handle=str(row["id"]), body=row["body"], receive_count=row["receive_count"])
                for row in cur.fetchall()
            ]

    def delete(self, queue_name: str, receipt_handle: str) -> None:
        with platform_transaction("queue-delete") as cur:
            cur.execute(
                "UPDATE integration.local_queue_message SET deleted_at = now() WHERE id = %s",
                (int(receipt_handle),),
            )

    def release(self, queue_name: str, receipt_handle: str, delay_seconds: int) -> None:
        with platform_transaction("queue-release") as cur:
            cur.execute(
                """
                UPDATE integration.local_queue_message
                   SET visible_at = now() + (%s || ' seconds')::interval
                 WHERE id = %s
                """,
                (str(delay_seconds), int(receipt_handle)),
            )

    def dead_letter(self, queue_name: str, receipt_handle: str, reason: str) -> None:
        """Marks the message terminal in the database, which is where this driver's DLQ is.

        The row is kept, not deleted: it *is* the dead letter queue (migration 0020), read
        by a person rather than polled by a service, and `receive` above excludes it.

        First write wins. A second dead-letter of the same message — only reachable through
        an unexpected race, since the row is already invisible to `receive` — leaves the
        original timestamp and the original reason in place. Those are the evidence of what
        actually went wrong first, and overwriting them with a later, vaguer failure would
        destroy the thing the row is being kept for.
        """
        with platform_transaction("queue-dead-letter") as cur:
            cur.execute(
                """
                UPDATE integration.local_queue_message
                   SET dead_lettered_at = now(), dead_letter_reason = %s
                 WHERE id = %s AND dead_lettered_at IS NULL
                """,
                (reason[:1000], int(receipt_handle)),
            )


def _parse_receive_count(message: dict[str, Any]) -> int | None:
    """Reads `ApproximateReceiveCount`, or returns None rather than guessing.

    This one number decides whether a failing message is retried or given up on, and the
    previous version defaulted it to 1 when SQS did not supply it. That reads as "this is
    the first delivery", so `receive_count >= max_receives` could never become true and the
    consumer would never dead-letter anything — the exact failure the dead-letter work was
    done to remove, reintroduced through a default argument. A non-numeric value was worse
    still: `int()` raised inside `receive`, the poll loop caught it, and the queue stalled
    with every poll failing.

    None means "the broker did not tell us", and `_settle_failure` treats it as exhausted.
    That is only reachable for a message whose handler has already failed, so it cannot
    dead-letter healthy work; the cost is the remaining retries on a message that was
    failing anyway, and the benefit is that the decision is never made on a number nobody
    supplied.
    """
    raw = message.get("Attributes", {}).get("ApproximateReceiveCount")
    if raw is None:
        log.error(
            "SQS returned no ApproximateReceiveCount for message %s; retries cannot be "
            "counted, so a failure will be treated as terminal",
            message.get("MessageId", "?"),
        )
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        log.error(
            "SQS returned a non-numeric ApproximateReceiveCount (%r) for message %s; "
            "retries cannot be counted, so a failure will be treated as terminal",
            raw, message.get("MessageId", "?"),
        )
        return None


class SqsQueue(Queue):
    def __init__(self, region: str, queue_urls: dict[str, str]) -> None:
        import boto3  # imported lazily so local runs need no AWS dependency

        self._client = boto3.client("sqs", region_name=region)
        self._urls = queue_urls

    def _url(self, queue_name: str) -> str:
        url = self._urls.get(queue_name)
        if not url:
            raise RuntimeError(f"no SQS URL configured for queue {queue_name}")
        return url

    def receive(self, queue_name: str, max_messages: int, visibility_seconds: int) -> list[Message]:
        response = self._client.receive_message(
            QueueUrl=self._url(queue_name),
            MaxNumberOfMessages=min(max_messages, 10),
            VisibilityTimeout=visibility_seconds,
            WaitTimeSeconds=20,
            # Deprecated in favour of `MessageSystemAttributeNames`, and still the supported
            # spelling: it is present and functional in every botocore the pinned
            # `boto3==1.35.81` can resolve (1.35.81 through 1.35.99, checked against the
            # service model, not the documentation). Either spelling returns the value under
            # `Attributes`. Left alone deliberately — a working call is not worth changing
            # for tidiness, and `tests/test_queue_dead_letter.py` asserts the parameter this
            # adapter sends is one the installed botocore actually accepts, so the day that
            # stops being true is a failing test rather than a silent one.
            AttributeNames=["ApproximateReceiveCount"],
        )
        return [
            Message(
                receipt_handle=m["ReceiptHandle"],
                body=json.loads(m.get("Body") or "{}"),
                receive_count=_parse_receive_count(m),
            )
            for m in response.get("Messages", [])
        ]

    def delete(self, queue_name: str, receipt_handle: str) -> None:
        self._client.delete_message(QueueUrl=self._url(queue_name), ReceiptHandle=receipt_handle)

    def release(self, queue_name: str, receipt_handle: str, delay_seconds: int) -> None:
        self._client.change_message_visibility(
            QueueUrl=self._url(queue_name), ReceiptHandle=receipt_handle, VisibilityTimeout=delay_seconds
        )

    def dead_letter(self, queue_name: str, receipt_handle: str, reason: str) -> None:
        """Hands the message back to SQS so the redrive policy moves it to the DLQ.

        On SQS the broker owns dead-lettering: `infra/terraform/queues.tf` sets a redrive
        policy with `maxReceiveCount`, and once a message has been received that many times
        without being deleted SQS moves it to the dead letter queue itself. Deleting it here
        would destroy the very message the DLQ exists to preserve, so this makes it visible
        immediately and lets the broker make the move.

        The same call as `apps/api/src/infra/queue.ts`, for the same reason. Without it the
        consumer simply stopped touching an exhausted message and let the visibility timeout
        run out — which reached the DLQ eventually, but only after burning every remaining
        receive at the consumer's full visibility window (fifteen minutes each, for payroll).
        Returning it at zero collapses that to the next poll.

        `reason` is not sent: SQS carries no per-message annotation, so the reason lives in
        the log line the caller writes. Kept in the signature because the local driver has
        somewhere durable to put it and the contract is one contract.
        """
        self._client.change_message_visibility(
            QueueUrl=self._url(queue_name), ReceiptHandle=receipt_handle, VisibilityTimeout=0
        )


def build_queue() -> Queue:
    if os.environ.get("QUEUE_DRIVER", "local") == "sqs":
        return SqsQueue(
            region=os.environ.get("AWS_REGION", "ap-south-1"),
            queue_urls={
                "workforce-jobs": os.environ.get("SQS_WORKFORCE_QUEUE_URL", ""),
                "payroll-jobs": os.environ.get("SQS_PAYROLL_QUEUE_URL", ""),
                "platform-jobs": os.environ.get("SQS_PLATFORM_QUEUE_URL", ""),
            },
        )
    return LocalQueue()


def valid_envelope(body: dict[str, Any]) -> bool:
    return all(body.get(field) for field in REQUIRED_ENVELOPE_FIELDS)


Handler = Callable[[dict[str, Any]], None]


def _settle_failure(
    queue: Queue,
    queue_name: str,
    consumer_name: str,
    message: Message,
    body: dict[str, Any],
    max_receives: int,
    err: BaseException,
) -> None:
    """Decides what becomes of a message whose handler raised: retry, or give up for good.

    Two things make this a function rather than four lines inline.

    The first is the decision itself. Below the limit the message is released with capped
    backoff and will be tried again. At the limit it is dead-lettered — durably terminal,
    with the reason attached. What it must never be is *neither*: the previous version
    logged "exhausted retries and is left for the DLQ" and then did nothing at all, so the
    visibility timeout expired and the message came back, was given up on again, and came
    back again. On the local driver, which has no broker-side redrive to catch it, that is
    a loop with no exit; one such message was observed on its three hundred and sixty-sixth
    receive. `max_receives` was not a limit, it was a threshold past which the consumer
    stopped trying but kept being asked.

    The second is that this runs inside the `except` of the message loop, where an escaping
    exception would propagate past the loop and past `while running` and take the process
    down. One unsettleable message would become an outage — the precise opposite of what
    dead-lettering is for. So a settle failure is caught, logged, and left alone: the
    message keeps its visibility timeout, comes back when it expires, and is retried. It is
    never reported as terminal when it is not.
    """
    try:
        # `None` is "the broker did not say how many times this has been delivered", and it
        # groups with exhausted rather than with "try again". Retrying on an uncountable
        # attempt is the unbounded loop this whole mechanism exists to prevent, so the
        # unknown case takes the terminal branch and says so in the reason.
        exhausted = message.receive_count is None or message.receive_count >= max_receives
        if exhausted:
            attempts = (
                "an unknown number of" if message.receive_count is None
                else str(message.receive_count)
            )
            reason = (
                f"{consumer_name} gave up after {attempts} receives: "
                f"{type(err).__name__}: {err}"
            )
            queue.dead_letter(queue_name, message.receipt_handle, reason)
            log.error(
                "dead-lettered %s event_id=%s tenant=%s after %s receives: %s",
                body.get("event_type"), body.get("event_id"), body.get("tenant_id"),
                message.receive_count, reason,
            )
        else:
            backoff = min(2 ** message.receive_count, 300)
            queue.release(queue_name, message.receipt_handle, backoff)
    except Exception:
        log.exception(
            "could not settle %s event_id=%s; it keeps its visibility timeout and will be "
            "redelivered rather than being treated as handled",
            body.get("event_type"), body.get("event_id"),
        )


def run_consumer(
    queue_name: str,
    consumer_name: str,
    handlers: dict[str, Handler],
    *,
    visibility_seconds: int = 120,
    max_receives: int = 5,
    idle_sleep_seconds: float = 2.0,
    max_iterations: int | None = None,
) -> None:
    """Polls a queue and dispatches envelopes to per-event-type handlers.

    Failure policy, in order of preference:
      * a malformed envelope is deleted immediately — retrying it can never help, and
        without tenant_id it cannot be processed safely at all
      * an event type nobody handles is deleted, so it does not block the queue
      * a handler exception is released for retry with backoff, until max_receives, at
        which point it is dead-lettered — terminal, with the reason kept, and never
        delivered down the ordinary path again

    A message is settled on exactly one of those paths every time round. Leaving one
    untouched is not a fifth option: it means redelivery when the visibility timeout
    expires, which for an exhausted message is a loop rather than a retry.
    """
    queue = build_queue()
    running = True

    def stop(signum, _frame):  # pragma: no cover - signal path
        nonlocal running
        log.info("received signal %s, finishing current batch", signum)
        running = False

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, stop)
        except ValueError:  # pragma: no cover - not the main thread
            pass

    iterations = 0
    while running:
        if max_iterations is not None and iterations >= max_iterations:
            break
        iterations += 1

        try:
            messages = queue.receive(queue_name, 10, visibility_seconds)
        except Exception:
            log.exception("failed to poll %s", queue_name)
            time.sleep(idle_sleep_seconds)
            continue

        if not messages:
            time.sleep(idle_sleep_seconds)
            continue

        for message in messages:
            body = message.body or {}

            if not valid_envelope(body):
                log.error("discarding malformed envelope: %s", json.dumps(body)[:500])
                queue.delete(queue_name, message.receipt_handle)
                continue

            handler = handlers.get(body["event_type"])
            if handler is None:
                log.debug("no handler for %s on %s; discarding", body["event_type"], queue_name)
                queue.delete(queue_name, message.receipt_handle)
                continue

            # Run inside the trace the envelope carried, so everything this handler does —
            # including the events it emits — belongs to the request that caused it rather
            # than appearing out of nowhere. A missing or malformed traceparent is not a
            # reason to refuse the work; the handler simply runs untraced.
            try:
                with continue_trace(body.get("traceparent")):
                    handler(body)
                    trace_id = current_trace_id()
            except Exception as err:
                log.exception(
                    "handler failed for %s event_id=%s (receive %s/%s)",
                    body["event_type"], body["event_id"], message.receive_count, max_receives,
                )
                _settle_failure(queue, queue_name, consumer_name, message, body, max_receives, err)
                continue

            # The work is committed; only the acknowledgement is left. Deliberately outside
            # the try above: a delete that fails is not a handler failure, and treating it
            # as one would count another failed attempt and — on a message that had already
            # failed its way to the limit before finally succeeding — dead-letter it. That
            # raises a DLQ alarm for work that was actually done, which is worse than the
            # thing it is reporting.
            #
            # Letting it be redelivered instead is safe and always was: every handler claims
            # through `processed_event` first, so the next delivery does nothing and deletes
            # cleanly.
            try:
                queue.delete(queue_name, message.receipt_handle)
                log.info(
                    "processed %s event_id=%s tenant=%s trace=%s",
                    body["event_type"], body["event_id"], body["tenant_id"], trace_id or "-",
                )
            except Exception:
                log.exception(
                    "processed %s event_id=%s but could not acknowledge it; it will be "
                    "redelivered and skipped as already handled",
                    body["event_type"], body["event_id"],
                )
