"""Dead-lettering in the Python queue consumers.

The gap this covers: `max_receives` was not a limit, it was a threshold past which the
consumer stopped *trying* and kept being *asked*. On reaching it the consumer logged
"exhausted retries and is left for the DLQ" and then neither deleted, released nor
dead-lettered the message — so the visibility timeout expired, the message came back, was
given up on again, and came back again.

On SQS the broker's redrive policy eventually caught it. The local driver has no redrive,
so there was no exit at all: a development database was found holding 1,477 payroll and 26
workforce messages in that state, one of them on its 366th receive, against 0 dead-lettered
— while the Node consumer, which does dead-letter, had 1,362 dead-lettered and 0 still
circulating on the queue it owns.

What is being pinned here is one invariant, stated two ways because the two drivers reach
it differently:

    a message that has reached max_receives must never again be delivered down the
    ordinary receive path.

For the local driver that means `dead_lettered_at` is set and `receive` excludes it. For
SQS it means the message goes back to the broker at visibility zero so the redrive policy
moves it, rather than being deleted (which would destroy the evidence) or abandoned (which
is what it was doing).

The lifecycle tests use a fake queue so they run in CI, where the calculation-engine job
deliberately has no database. The SQL predicate that actually enforces the invariant cannot
be proved against a fake, so those tests talk to a real Postgres and skip without one.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))

from hrms_engine.consumer import (  # noqa: E402
    LocalQueue,
    Message,
    Queue,
    SqsQueue,
    _parse_receive_count,
    _settle_failure,
    run_consumer,
)


def setUpModule() -> None:
    # Every failure path here is deliberate, and the consumer logs each with a traceback.
    # Left on, twenty-odd expected stack traces bury a real one.
    logging.disable(logging.CRITICAL)


def tearDownModule() -> None:
    logging.disable(logging.NOTSET)


QUEUE = "payroll-jobs"

TENANT = "11111111-2222-3333-4444-555555555555"
TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"


def envelope(event_id: str, event_type: str = "PayrollRunCreated") -> dict[str, Any]:
    return {
        "event_id": event_id,
        "event_type": event_type,
        "tenant_id": TENANT,
        "aggregate_type": "payroll_run",
        "aggregate_id": "99999999-8888-7777-6666-555555555555",
        "occurred_at": "2026-06-01T00:00:00Z",
        "correlation_id": "corr-1",
        "traceparent": TRACEPARENT,
    }


class FakeQueue(Queue):
    """An in-memory queue with SQS's semantics, not a mock.

    It counts receives, hides a received message until it is released, and refuses to hand
    back anything deleted or dead-lettered. That is enough to drive the consumer through a
    whole retry lifecycle and observe where each message ends up, which is what these tests
    are about — the SQL is proved separately, against Postgres.
    """

    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self.dead_letter_calls = 0
        self.fail_dead_letter = False
        self.fail_delete = False

    def add(self, body: dict[str, Any]) -> str:
        handle = str(len(self.rows))
        self.rows.append(
            {"handle": handle, "body": body, "receive_count": 0, "visible": True,
             "deleted": False, "dead_lettered_at": None, "reason": None},
        )
        return handle

    def row(self, handle: str) -> dict[str, Any]:
        return next(r for r in self.rows if r["handle"] == handle)

    def receive(self, queue_name: str, max_messages: int, visibility_seconds: int) -> list[Message]:
        out: list[Message] = []
        for r in self.rows:
            if len(out) >= max_messages:
                break
            if r["deleted"] or r["dead_lettered_at"] is not None or not r["visible"]:
                continue
            r["receive_count"] += 1
            r["visible"] = False  # the visibility timeout
            out.append(Message(r["handle"], r["body"], r["receive_count"]))
        return out

    def delete(self, queue_name: str, receipt_handle: str) -> None:
        if self.fail_delete:
            raise RuntimeError("the acknowledgement failed")
        self.row(receipt_handle)["deleted"] = True

    def release(self, queue_name: str, receipt_handle: str, delay_seconds: int) -> None:
        self.row(receipt_handle)["visible"] = True

    def dead_letter(self, queue_name: str, receipt_handle: str, reason: str) -> None:
        self.dead_letter_calls += 1
        if self.fail_dead_letter:
            raise RuntimeError("the dead letter write failed")
        r = self.row(receipt_handle)
        if r["dead_lettered_at"] is None:  # first write wins, as the local driver does
            r["dead_lettered_at"] = "now"
            r["reason"] = reason


def drive(queue: FakeQueue, handlers: dict[str, Any], iterations: int, max_receives: int = 3) -> None:
    """Runs the real consumer loop against the fake queue for a bounded number of polls."""
    with mock.patch("hrms_engine.consumer.build_queue", return_value=queue):
        run_consumer(
            QUEUE,
            "payroll-engine",
            handlers,
            max_receives=max_receives,
            idle_sleep_seconds=0,
            max_iterations=iterations,
        )


def always_fails(_body: dict[str, Any]) -> None:
    raise ValueError("handler blew up")


class RetryLifecycle(unittest.TestCase):
    def test_failure_below_the_limit_stays_retryable(self):
        q = FakeQueue()
        handle = q.add(envelope("e1"))

        drive(q, {"PayrollRunCreated": always_fails}, iterations=1, max_receives=3)

        row = q.row(handle)
        self.assertEqual(row["receive_count"], 1)
        self.assertIsNone(row["dead_lettered_at"], "one failure must not be terminal")
        self.assertTrue(row["visible"], "it must have been released for another attempt")
        self.assertFalse(row["deleted"], "a retryable failure must not be dropped")

    def test_failure_at_the_limit_is_dead_lettered(self):
        q = FakeQueue()
        handle = q.add(envelope("e2"))

        drive(q, {"PayrollRunCreated": always_fails}, iterations=3, max_receives=3)

        row = q.row(handle)
        self.assertEqual(row["receive_count"], 3)
        self.assertIsNotNone(row["dead_lettered_at"], "reaching max_receives must be terminal")
        self.assertFalse(row["deleted"], "the message is kept: it is the evidence")

    def test_the_reason_records_what_actually_failed(self):
        q = FakeQueue()
        handle = q.add(envelope("e3"))

        drive(q, {"PayrollRunCreated": always_fails}, iterations=3, max_receives=3)

        reason = q.row(handle)["reason"]
        # Not just "it failed": which consumer gave up, after how many attempts, and the
        # exception. A DLQ row nobody can diagnose from is barely better than a deleted one.
        self.assertIn("payroll-engine", reason)
        self.assertIn("3 receives", reason)
        self.assertIn("ValueError", reason)
        self.assertIn("handler blew up", reason)

    def test_a_dead_lettered_message_is_never_delivered_again(self):
        q = FakeQueue()
        handle = q.add(envelope("e4"))

        drive(q, {"PayrollRunCreated": always_fails}, iterations=3, max_receives=3)
        self.assertEqual(q.row(handle)["receive_count"], 3)

        # The loop this test exists for. Twenty more polls: before the fix every one of them
        # delivered the message again, and the count would now read 23.
        drive(q, {"PayrollRunCreated": always_fails}, iterations=20, max_receives=3)

        self.assertEqual(
            q.row(handle)["receive_count"], 3,
            "an exhausted message must not be received again, ever",
        )
        self.assertEqual(q.dead_letter_calls, 1, "and must not be dead-lettered repeatedly")

    def test_a_successful_handler_deletes_and_does_not_dead_letter(self):
        q = FakeQueue()
        handle = q.add(envelope("e5"))

        drive(q, {"PayrollRunCreated": lambda body: None}, iterations=1)

        row = q.row(handle)
        self.assertTrue(row["deleted"])
        self.assertIsNone(row["dead_lettered_at"])
        self.assertEqual(q.dead_letter_calls, 0)


class FailureIsolation(unittest.TestCase):
    def test_an_exhausted_message_does_not_stop_the_consumer(self):
        q = FakeQueue()
        processed: list[str] = []
        poison = q.add(envelope("poison"))
        healthy = q.add(envelope("healthy", event_type="PayslipRequested"))

        drive(
            q,
            {
                "PayrollRunCreated": always_fails,
                "PayslipRequested": lambda body: processed.append(body["event_id"]),
            },
            iterations=3,
            max_receives=3,
        )

        self.assertIsNotNone(q.row(poison)["dead_lettered_at"])
        self.assertEqual(processed, ["healthy"], "the healthy message must still be handled")
        self.assertTrue(q.row(healthy)["deleted"])

    def test_a_failed_dead_letter_write_neither_crashes_nor_claims_success(self):
        q = FakeQueue()
        q.fail_dead_letter = True
        handle = q.add(envelope("e6"))

        # Must return normally. This runs inside the `except` of the message loop, so an
        # exception escaping here would take the whole worker down — one unsettleable
        # message becoming an outage.
        drive(q, {"PayrollRunCreated": always_fails}, iterations=1, max_receives=1)

        row = q.row(handle)
        self.assertIsNone(
            row["dead_lettered_at"],
            "a dead-letter that failed must not be recorded as having succeeded",
        )
        self.assertFalse(row["deleted"], "and must not fall through to a silent drop")

    def test_a_failed_acknowledgement_is_not_mistaken_for_a_handler_failure(self):
        # The nasty case the dead-letter work created: a message that failed its way to the
        # limit and then finally succeeded, whose delete then fails. Treating that as another
        # handler failure would dead-letter work that was actually done — a DLQ alarm for a
        # job that completed, which is worse than the thing it reports.
        q = FakeQueue()
        q.fail_delete = True
        handled: list[str] = []
        handle = q.add(envelope("e9"))
        q.row(handle)["receive_count"] = 2  # one short: the next receive is the third

        drive(q, {"PayrollRunCreated": lambda body: handled.append(body["event_id"])},
              iterations=1, max_receives=3)

        self.assertEqual(handled, ["e9"], "the handler did run and did succeed")
        self.assertEqual(q.dead_letter_calls, 0, "successful work must never be dead-lettered")
        self.assertIsNone(q.row(handle)["dead_lettered_at"])

    def test_a_failed_acknowledgement_leaves_the_message_to_be_redelivered(self):
        q = FakeQueue()
        q.fail_delete = True
        handle = q.add(envelope("e10"))

        drive(q, {"PayrollRunCreated": lambda body: None}, iterations=1, max_receives=3)

        # Not deleted and not terminal, so it comes back — and the next delivery is a no-op,
        # because every handler claims through `processed_event` before doing anything.
        self.assertFalse(q.row(handle)["deleted"])
        self.assertIsNone(q.row(handle)["dead_lettered_at"])

    def test_the_consumer_keeps_going_after_a_failed_dead_letter(self):
        q = FakeQueue()
        q.fail_dead_letter = True
        q.add(envelope("bad"))
        processed: list[str] = []
        q.add(envelope("good", event_type="PayslipRequested"))

        drive(
            q,
            {
                "PayrollRunCreated": always_fails,
                "PayslipRequested": lambda body: processed.append(body["event_id"]),
            },
            iterations=1,
            max_receives=1,
        )

        self.assertEqual(processed, ["good"])


class ExistingFailurePolicy(unittest.TestCase):
    """Branches that were already correct, pinned so the dead-letter work did not move them."""

    def test_a_malformed_envelope_is_deleted_rather_than_retried(self):
        q = FakeQueue()
        handle = q.add({"event_type": "PayrollRunCreated"})  # no event_id, no tenant_id

        drive(q, {"PayrollRunCreated": always_fails}, iterations=1)

        row = q.row(handle)
        self.assertTrue(row["deleted"], "a retry can never fix a malformed envelope")
        self.assertIsNone(row["dead_lettered_at"])

    def test_an_unhandled_event_type_is_deleted_rather_than_blocking_the_queue(self):
        q = FakeQueue()
        handle = q.add(envelope("e7", event_type="SomethingElseHappened"))

        drive(q, {"PayrollRunCreated": always_fails}, iterations=1)

        self.assertTrue(q.row(handle)["deleted"])
        self.assertEqual(q.dead_letter_calls, 0)


class ProductionAdapter(unittest.TestCase):
    """The SQS driver, which reaches the same terminal state by a different route.

    Worth its own tests because LocalQueue passing proves nothing about production: the two
    drivers share a contract, not an implementation.
    """

    def sqs(self):
        # Built without __init__ so no boto3 client, credentials or region are needed.
        q = object.__new__(SqsQueue)
        q._client = mock.Mock()
        q._urls = {QUEUE: "https://sqs.example/queue"}
        return q

    def test_dead_letter_hands_the_message_back_for_the_redrive_policy(self):
        q = self.sqs()

        q.dead_letter(QUEUE, "receipt-1", "gave up")

        q._client.change_message_visibility.assert_called_once_with(
            QueueUrl="https://sqs.example/queue", ReceiptHandle="receipt-1", VisibilityTimeout=0
        )

    def test_dead_letter_never_deletes_the_message(self):
        q = self.sqs()

        q.dead_letter(QUEUE, "receipt-1", "gave up")

        # Deleting would destroy the very message the dead letter queue exists to preserve,
        # and SQS would never redrive it. `infra/terraform/queues.tf` owns the move.
        q._client.delete_message.assert_not_called()

    def test_the_consumer_invokes_the_production_adapter_on_exhaustion(self):
        # The end-to-end wiring: a real consumer loop, over the real SqsQueue, on a mocked
        # boto3 client. Proves the fix reaches production rather than only LocalQueue.
        sqs = self.sqs()
        sqs._client.receive_message.return_value = {
            "Messages": [
                {
                    "ReceiptHandle": "receipt-1",
                    "Body": json.dumps(envelope("e8")),
                    "Attributes": {"ApproximateReceiveCount": "3"},
                }
            ]
        }

        with mock.patch("hrms_engine.consumer.build_queue", return_value=sqs):
            run_consumer(
                QUEUE, "payroll-engine", {"PayrollRunCreated": always_fails},
                max_receives=3, idle_sleep_seconds=0, max_iterations=1,
            )

        sqs._client.change_message_visibility.assert_called_once_with(
            QueueUrl="https://sqs.example/queue", ReceiptHandle="receipt-1", VisibilityTimeout=0
        )
        sqs._client.delete_message.assert_not_called()


class ReceiveCountParsing(unittest.TestCase):
    """The one number the exhaustion decision rests on.

    `ApproximateReceiveCount` is the sole input to "has this been tried enough times", and
    the previous parser defaulted it to 1 when SQS did not supply it — which reads as a
    fresh first delivery, so `receive_count >= max_receives` could never become true and
    nothing would ever be dead-lettered. A non-numeric value was worse: `int()` raised
    inside `receive`, the poll loop swallowed it, and the queue stalled.
    """

    def test_a_numeric_count_is_read_as_given(self):
        self.assertEqual(_parse_receive_count({"Attributes": {"ApproximateReceiveCount": "4"}}), 4)

    def test_a_missing_attribute_is_unknown_not_one(self):
        self.assertIsNone(_parse_receive_count({"Attributes": {}}))
        self.assertIsNone(_parse_receive_count({}))

    def test_a_non_numeric_count_is_unknown_rather_than_an_exception(self):
        # It used to raise here, inside `receive`, which failed every poll of the queue.
        self.assertIsNone(_parse_receive_count({"Attributes": {"ApproximateReceiveCount": "many"}}))
        self.assertIsNone(_parse_receive_count({"Attributes": {"ApproximateReceiveCount": None}}))

    def test_an_unknown_count_is_treated_as_exhausted_not_as_a_first_delivery(self):
        q = FakeQueue()
        handle = q.add(envelope("unknown-count"))
        q.rows[0]["receive_count"] = None  # what the SQS adapter now hands over

        # `drive` would re-count, so settle directly against the same code path the
        # consumer uses.
        _settle_failure(q, QUEUE, "payroll-engine", Message(handle, envelope("unknown-count"), None),
                        envelope("unknown-count"), 5, ValueError("handler blew up"))

        self.assertIsNotNone(
            q.row(handle)["dead_lettered_at"],
            "an uncountable attempt must not be retried forever; unknown groups with exhausted",
        )
        self.assertIn("an unknown number of", q.row(handle)["reason"])

    def test_a_known_count_below_the_limit_still_retries(self):
        # The guard above must not have turned every failure terminal.
        q = FakeQueue()
        handle = q.add(envelope("known-count"))
        _settle_failure(q, QUEUE, "payroll-engine", Message(handle, {}, 1), {}, 5,
                        ValueError("handler blew up"))

        self.assertIsNone(q.row(handle)["dead_lettered_at"])
        self.assertTrue(q.row(handle)["visible"], "it must have been released for another attempt")


class RetryLimitMatchesInfrastructure(unittest.TestCase):
    """Application `max_receives` against the SQS redrive policy.

    These are the same policy from two sides, and the reason they must agree is mechanical
    rather than stylistic. On SQS the application does not move a message to the DLQ: it
    returns it at visibility zero and the broker's `maxReceiveCount` moves it. So a consumer
    that gives up *below* the redrive does not stop the work — the message comes straight
    back, the handler runs again, and it gives up again, spinning until the broker's count
    catches up. One that gives up *above* it never gets to decide, and no reason is ever
    recorded. Equality puts the application's decision on the last delivery the broker
    permits.
    """

    ROOT = Path(__file__).resolve().parents[3]

    def read(self, relative: str) -> str:
        return (self.ROOT / relative).read_text(encoding="utf-8")

    def test_terraform_node_and_python_agree_on_the_retry_limit(self):
        terraform = re.search(r"max_receive_count\s*=\s*(\d+)", self.read("infra/terraform/queues.tf"))
        node = re.search(r"MAX_RECEIVES\s*=\s*(\d+)", self.read("apps/worker/src/consumer.ts"))
        python_default = re.search(
            r"max_receives:\s*int\s*=\s*(\d+)", self.read("services/shared/hrms_engine/consumer.py")
        )
        payroll = re.search(
            r"run_consumer\([^)]*max_receives=(\d+)", self.read("services/payroll-engine/app/main.py"),
            re.S,
        )

        for name, match in [("terraform", terraform), ("node", node),
                            ("python default", python_default), ("payroll engine", payroll)]:
            self.assertIsNotNone(match, f"could not find the retry limit for {name}")

        found = {
            "terraform redrive": int(terraform.group(1)),
            "node consumer": int(node.group(1)),
            "python default": int(python_default.group(1)),
            "payroll engine": int(payroll.group(1)),
        }
        self.assertEqual(
            len(set(found.values())), 1,
            f"application retry limits must match the SQS redrive policy, got {found}",
        )

    def test_the_workforce_engine_takes_the_default(self):
        # It passes no `max_receives`, so it inherits the shared default — which the test
        # above pins to the redrive policy. Asserted so that adding an explicit value there
        # cannot quietly reintroduce the drift.
        main = self.read("services/workforce-engine/app/main.py")
        self.assertNotIn("max_receives", main)


HAS_DB = bool(os.environ.get("PLATFORM_DATABASE_URL") or os.environ.get("DATABASE_URL"))

try:
    import botocore.session as _botocore_session
except ImportError:  # pragma: no cover - boto3 is a production dependency, absent in some dev envs
    _botocore_session = None


@unittest.skipUnless(_botocore_session, "botocore is not installed")
class SqsDependencyContract(unittest.TestCase):
    """What the installed botocore actually accepts, rather than what the docs say.

    `SqsQueue.receive` asks for the receive count with `AttributeNames`, which AWS has
    deprecated in favour of `MessageSystemAttributeNames`. Deprecated is not removed, and it
    is still present and functional in every botocore the pinned `boto3==1.35.81` can
    resolve — so the call was left alone rather than changed for tidiness. That is only a
    safe decision while it stays true, which is what this asserts: against the installed
    service model, not against a changelog.
    """

    def setUp(self):
        self.model = _botocore_session.get_session().get_service_model("sqs")
        self.receive = self.model.operation_model("ReceiveMessage")

    def test_the_parameter_the_adapter_sends_is_one_botocore_accepts(self):
        source = (Path(__file__).resolve().parents[2] / "shared" / "hrms_engine" / "consumer.py").read_text(
            encoding="utf-8"
        )
        sent = re.search(r"(AttributeNames|MessageSystemAttributeNames)=\[\"ApproximateReceiveCount\"\]", source)
        self.assertIsNotNone(sent, "could not find the receive-count request parameter in the adapter")

        self.assertIn(
            sent.group(1), self.receive.input_shape.members,
            f"the adapter sends {sent.group(1)}, which this botocore does not accept",
        )

    def test_the_receive_count_comes_back_under_attributes(self):
        # Both spellings of the request return the value in the same place, which is why the
        # deprecation does not change the parsing.
        message = self.receive.output_shape.members["Messages"].member
        self.assertIn("Attributes", message.members)


@unittest.skipUnless(HAS_DB, "PLATFORM_DATABASE_URL / DATABASE_URL is not set")
class LocalQueueTerminalState(unittest.TestCase):
    """The predicate that actually enforces the invariant, against a real Postgres.

    A fake cannot prove this: the thing under test is one SQL clause, and the bug was that
    the clause was missing.
    """

    def setUp(self):
        from hrms_engine.db import platform_transaction

        self.platform_transaction = platform_transaction
        self.queue_name = f"test-dlq-{os.getpid()}-{id(self)}"
        self.ids: list[int] = []

    def tearDown(self):
        # These rows are this test's own, keyed by a queue name nothing else uses.
        with self.platform_transaction("test-cleanup") as cur:
            cur.execute(
                "DELETE FROM integration.local_queue_message WHERE queue_name = %s",
                (self.queue_name,),
            )

    def enqueue(self, body: dict[str, Any]) -> int:
        with self.platform_transaction("test-enqueue") as cur:
            cur.execute(
                """
                INSERT INTO integration.local_queue_message (queue_name, body)
                VALUES (%s, %s::jsonb) RETURNING id
                """,
                (self.queue_name, json.dumps(body)),
            )
            row_id = cur.fetchone()["id"]
        self.ids.append(row_id)
        return row_id

    def row(self, row_id: int) -> dict[str, Any]:
        with self.platform_transaction("test-read") as cur:
            cur.execute(
                """
                SELECT body, receive_count, visible_at, deleted_at,
                       dead_lettered_at, dead_letter_reason
                  FROM integration.local_queue_message WHERE id = %s
                """,
                (row_id,),
            )
            return cur.fetchone()

    def test_receive_returns_a_live_message(self):
        # The control. Without it, every exclusion below could pass by returning nothing.
        row_id = self.enqueue(envelope("live"))

        received = LocalQueue().receive(self.queue_name, 10, 0)

        self.assertEqual([m.receipt_handle for m in received], [str(row_id)])

    def test_dead_letter_records_the_terminal_state(self):
        row_id = self.enqueue(envelope("dl"))

        LocalQueue().dead_letter(self.queue_name, str(row_id), "gave up after 3 receives")

        row = self.row(row_id)
        self.assertIsNotNone(row["dead_lettered_at"])
        self.assertEqual(row["dead_letter_reason"], "gave up after 3 receives")
        self.assertIsNone(row["deleted_at"], "the message is kept, not deleted")

    def test_receive_excludes_a_dead_lettered_message(self):
        row_id = self.enqueue(envelope("dl2"))
        LocalQueue().dead_letter(self.queue_name, str(row_id), "terminal")

        # Visibility is irrelevant: the row is immediately visible and still must not come
        # back. Before the fix this returned it, on this poll and on every poll after.
        received = LocalQueue().receive(self.queue_name, 10, 0)

        self.assertEqual(received, [], "a dead-lettered message must never be delivered again")

    def test_release_cannot_resurrect_a_dead_lettered_message(self):
        row_id = self.enqueue(envelope("dl3"))
        q = LocalQueue()
        q.dead_letter(self.queue_name, str(row_id), "terminal")

        # A stray release — a racing worker settling a message it received before the
        # dead-letter landed. It moves `visible_at`, and that must not be enough.
        q.release(self.queue_name, str(row_id), 0)

        self.assertEqual(q.receive(self.queue_name, 10, 0), [])

    def test_an_expired_visibility_timeout_cannot_resurrect_it_either(self):
        row_id = self.enqueue(envelope("dl4"))
        q = LocalQueue()
        q.dead_letter(self.queue_name, str(row_id), "terminal")

        with self.platform_transaction("test-expire") as cur:
            cur.execute(
                "UPDATE integration.local_queue_message SET visible_at = now() - INTERVAL '1 day' WHERE id = %s",
                (row_id,),
            )

        # This is exactly the mechanism that produced 366 receives: the old code left the
        # message alone and let the timeout bring it back.
        self.assertEqual(q.receive(self.queue_name, 10, 0), [])

    def test_dead_lettering_twice_keeps_the_first_reason(self):
        row_id = self.enqueue(envelope("dl5"))
        q = LocalQueue()

        q.dead_letter(self.queue_name, str(row_id), "the original failure")
        first = self.row(row_id)["dead_lettered_at"]
        q.dead_letter(self.queue_name, str(row_id), "a later, vaguer failure")

        row = self.row(row_id)
        self.assertEqual(row["dead_letter_reason"], "the original failure")
        self.assertEqual(row["dead_lettered_at"], first, "the first terminal decision stands")

    def test_the_dead_lettered_row_keeps_its_tenant_event_and_trace(self):
        body = envelope("dl6")
        row_id = self.enqueue(body)

        LocalQueue().dead_letter(self.queue_name, str(row_id), "terminal")

        kept = self.row(row_id)["body"]
        # A DLQ row is read by a person working out who was affected and what to replay.
        # Without the tenant it names nobody; without the trace it joins to nothing.
        self.assertEqual(kept["tenant_id"], TENANT)
        self.assertEqual(kept["event_id"], "dl6")
        self.assertEqual(kept["event_type"], "PayrollRunCreated")
        self.assertEqual(kept["correlation_id"], "corr-1")
        self.assertEqual(kept["traceparent"], TRACEPARENT)

    def test_receive_never_returns_more_rows_than_asked_for(self):
        """The claim is `IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)`.

        Node deliberately avoids that form — its comments warn that a locking subquery can
        be evaluated more than once and hand back more rows than the limit, and the
        scheduler's comment records having seen exactly that. So the Python driver was
        checked rather than assumed, and on PostgreSQL 16 it does not over-claim: the plan
        pulls the subquery up and materialises it once (`HashAggregate` over a `Subquery
        Scan` containing the `Limit`), so the limit is applied once and the outer update
        joins against its output.

        That is a property of a query plan, which is exactly the kind of thing that changes
        under a different version or different statistics. Left as it is — a working claim
        is not worth rewriting on a hypothetical — and pinned here so a regression is a
        failing test rather than a duplicate payroll job.
        """
        for i in range(12):
            self.enqueue(envelope(f"limit-{i}"))

        for limit in (1, 3, 7):
            received = LocalQueue().receive(self.queue_name, limit, 60)
            self.assertLessEqual(
                len(received), limit,
                f"asked for {limit} and got {len(received)}: the claim over-ran its limit",
            )
            self.assertEqual(len(received), limit, "and it should be full while rows remain")

    def test_receive_stops_at_what_is_available_rather_than_blocking(self):
        # The boundary the other direction: fewer rows than asked for is normal, not an
        # error, and must not be padded or repeated.
        a = self.enqueue(envelope("only-a"))
        b = self.enqueue(envelope("only-b"))

        received = LocalQueue().receive(self.queue_name, 10, 60)

        self.assertEqual(sorted(m.receipt_handle for m in received), sorted([str(a), str(b)]))

    def test_concurrent_consumers_take_disjoint_batches(self):
        """`SKIP LOCKED` under real contention, which is where over-claiming would show.

        Threads rather than sequential calls, released together by a barrier: each opens its
        own connection and transaction, so the interleaving is genuine rather than simulated.
        """
        import threading

        for i in range(40):
            self.enqueue(envelope(f"concurrent-{i}"))

        consumers, limit = 6, 5
        barrier = threading.Barrier(consumers)
        batches: list[list[str]] = []
        failures: list[str] = []

        def claim() -> None:
            try:
                barrier.wait()
                batches.append([m.receipt_handle for m in LocalQueue().receive(self.queue_name, limit, 60)])
            except Exception as err:  # pragma: no cover - a failure here is the finding
                failures.append(repr(err))

        threads = [threading.Thread(target=claim) for _ in range(consumers)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(failures, [])
        for batch in batches:
            self.assertLessEqual(len(batch), limit, f"a consumer claimed {len(batch)} for a limit of {limit}")

        handles = [h for batch in batches for h in batch]
        self.assertEqual(
            len(handles), len(set(handles)),
            "two consumers claimed the same message: SKIP LOCKED did not keep the batches disjoint",
        )

    def test_a_dead_lettered_message_does_not_block_the_next_one(self):
        dead = self.enqueue(envelope("dead"))
        alive = self.enqueue(envelope("alive"))
        q = LocalQueue()
        q.dead_letter(self.queue_name, str(dead), "terminal")

        received = q.receive(self.queue_name, 10, 0)

        self.assertEqual([m.receipt_handle for m in received], [str(alive)])


if __name__ == "__main__":
    unittest.main()
