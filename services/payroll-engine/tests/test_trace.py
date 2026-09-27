"""Trace context propagation into the Python engine.

The gap this covers: the Node API stamped a `traceparent` on every outbox row and put it on
the envelope, and Python threw it away. A payroll run started by an HTTP request produced a
`PayrollCalculated` event, a payslip job and a notification that were, as far as any tracing
backend could tell, three unrelated things that happened to occur at the same time.

Two properties are being pinned down. The trace must survive the crossing, and nothing
sensitive must cross with it — a trace id is an opaque identifier and is safe to ship to an
observability backend; a payroll payload is not.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))

from hrms_engine.trace import (  # noqa: E402
    TraceContext,
    continue_trace,
    current_trace,
    current_trace_id,
    format_traceparent,
    new_span_id,
    outgoing_traceparent,
    parse_traceparent,
)

VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"


class ParseTraceparent(unittest.TestCase):
    def test_parses_a_well_formed_header(self):
        parsed = parse_traceparent(VALID)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736")
        self.assertEqual(parsed.span_id, "00f067aa0ba902b7")
        self.assertEqual(parsed.flags, "01")

    def test_accepts_upper_case_and_surrounding_space(self):
        parsed = parse_traceparent(f"  {VALID.upper()}  ")
        self.assertEqual(parsed.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736")

    def test_round_trips(self):
        self.assertEqual(format_traceparent(parse_traceparent(VALID)), VALID)

    def test_rejects_the_all_zero_sentinels(self):
        # The spec's "invalid" values. Propagating them would join every trace to every other.
        self.assertIsNone(parse_traceparent("00-" + "0" * 32 + "-00f067aa0ba902b7-01"))
        self.assertIsNone(parse_traceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-" + "0" * 16 + "-01"))

    def test_returns_none_for_anything_malformed_and_never_raises(self):
        # A bad header must not fail payroll. The work happens; it is simply uncorrelated.
        for header in [
            None,
            "",
            "not-a-traceparent",
            "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",  # unsupported version
            "00-4bf92f3577b34da6a3ce929d0e0e47-00f067aa0ba902b7-01",  # short trace id
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902-01",  # short span id
            "00-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-00f067aa0ba902b7-01",  # not hex
            VALID + "-extra",
            123,
            {"traceparent": VALID},
        ]:
            with self.subTest(header=header):
                self.assertIsNone(parse_traceparent(header))


class ContinueTrace(unittest.TestCase):
    def test_runs_the_block_inside_the_incoming_trace(self):
        with continue_trace(VALID) as context:
            self.assertEqual(context.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736")
            self.assertEqual(current_trace_id(), "4bf92f3577b34da6a3ce929d0e0e4736")

    def test_mints_a_child_span_rather_than_impersonating_the_parent(self):
        with continue_trace(VALID) as context:
            # Same trace, new span: the engine is a step in the chain, not a replacement for
            # the step that sent it the work.
            self.assertEqual(context.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736")
            self.assertNotEqual(context.span_id, "00f067aa0ba902b7")
            self.assertRegex(context.span_id, r"^[0-9a-f]{16}$")

    def test_emits_a_traceparent_on_the_way_out(self):
        with continue_trace(VALID):
            outgoing = outgoing_traceparent()
        self.assertIsNotNone(outgoing)
        self.assertTrue(outgoing.startswith("00-4bf92f3577b34da6a3ce929d0e0e4736-"))
        self.assertIsNotNone(parse_traceparent(outgoing))

    def test_does_not_invent_a_trace_when_the_envelope_carried_none(self):
        # A root trace with no parent anywhere looks like a request that never happened,
        # which is worse than an honest absence.
        with continue_trace(None) as context:
            self.assertIsNone(context)
            self.assertIsNone(outgoing_traceparent())
            self.assertIsNone(current_trace_id())

    def test_does_not_invent_a_trace_from_a_malformed_one(self):
        with continue_trace("garbage") as context:
            self.assertIsNone(context)
            self.assertIsNone(outgoing_traceparent())

    def test_restores_the_previous_context_on_the_way_out(self):
        self.assertIsNone(current_trace())
        with continue_trace(VALID):
            self.assertIsNotNone(current_trace())
        # Connections and threads are pooled and reused across tenants. A context that
        # leaked past its block would attribute one tenant's payroll to another's trace.
        self.assertIsNone(current_trace())

    def test_restores_the_previous_context_even_when_the_handler_raises(self):
        with self.assertRaises(RuntimeError):
            with continue_trace(VALID):
                raise RuntimeError("handler failed")
        self.assertIsNone(current_trace())

    def test_nests(self):
        outer = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        inner = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00"
        with continue_trace(outer):
            with continue_trace(inner):
                self.assertEqual(current_trace_id(), "0af7651916cd43dd8448eb211c80319c")
            self.assertEqual(current_trace_id(), "4bf92f3577b34da6a3ce929d0e0e4736")

    def test_span_ids_do_not_repeat(self):
        self.assertEqual(len({new_span_id() for _ in range(200)}), 200)


class CarriesNothingSensitive(unittest.TestCase):
    def test_a_trace_context_holds_only_opaque_identifiers(self):
        with continue_trace(VALID) as context:
            self.assertEqual(set(TraceContext._fields), {"trace_id", "span_id", "flags"})
            # Everything in it is hex. There is nowhere for a name, a salary or an employee
            # id to be smuggled into something destined for a third-party backend.
            self.assertRegex(context.trace_id, r"^[0-9a-f]{32}$")
            self.assertRegex(context.span_id, r"^[0-9a-f]{16}$")
            self.assertRegex(context.flags, r"^[0-9a-f]{2}$")


if __name__ == "__main__":
    unittest.main()
