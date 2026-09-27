"""The proof cutoff: what an unproved declaration is worth once the date has gone.

Four states, and they are not interchangeable:

    declared    stated, nobody has looked yet          -> stands at the declared figure
    verified    proof examined and accepted            -> stands at the verified figure
    rejected    proof examined and refused             -> nothing
    unverified  still unproved after the cutoff        -> nothing

Only the first three are rows. `unverified` is decided per payroll run and arrives on the
snapshot as `effective_status`, because whether the cutoff has passed is a fact about the run
rather than about the declaration.

The engine compares no dates. `cutoff_passed` is a boolean Node computed once. These tests
assert that: pass a contradictory date and the boolean still wins, because a second
comparison in a second language is a second set of boundary assumptions.
"""

from __future__ import annotations

import copy
import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.calculation import calculate  # noqa: E402
from app.exemptions import ExemptionError, calculate_section_exemptions  # noqa: E402

INCOME_TAX_CONFIG = {
    "regimes": {
        "old": {
            "standard_deduction": 50000,
            "slabs": [
                {"upto": 250000, "rate": 0},
                {"upto": 500000, "rate": 0.05},
                {"upto": 1000000, "rate": 0.2},
                {"upto": None, "rate": 0.3},
            ],
            "rebate_limit": 500000,
            "rebate_max": 12500,
            "cess_rate": 0.04,
        },
        "new": {
            "standard_deduction": 75000,
            "slabs": [{"upto": 300000, "rate": 0}, {"upto": None, "rate": 0.2}],
            "rebate_limit": 700000,
            "rebate_max": 25000,
            "cess_rate": 0.04,
        },
    }
}

CUTOFF = "2027-01-31"


def section(
    code="80C",
    declared="150000",
    cap="150000",
    *,
    status="declared",
    effective=None,
    eligible=None,
    cutoff=CUTOFF,
    passed=False,
    reference="2026-06-30",
    regimes=("old",),
):
    return {
        "section_code": code,
        "name": f"Section {code}",
        "declared_amount": declared,
        "eligible_amount": eligible,
        "status": status,
        # Node derives this; the engine never recomputes it.
        "effective_status": effective if effective is not None else status,
        "proof_cutoff_date": cutoff,
        "cutoff_reference_date": reference,
        "cutoff_passed": passed,
        "require_proof_after_cutoff": True,
        "verified_at": None,
        "rule_id": "rule-1",
        "rule_version": 1,
        "rule_source": "platform",
        "max_amount": cap,
        "applicable_regimes": list(regimes),
    }


def envelope(*sections, cutoff=CUTOFF, reference="2026-06-30", passed=False):
    return {
        "tax_year_id": "ty-1",
        "tax_year_label": "2026-27",
        "regime": "old",
        "proof_cutoff_date": cutoff,
        "cutoff_reference_date": reference,
        "cutoff_passed": passed,
        "require_proof_after_cutoff": True,
        "require_proof_cutoff": False,
        "sections": list(sections),
    }


def allowed(*sections, regime="old", **kw):
    return calculate_section_exemptions(envelope(*sections, **kw), regime=regime)


# ---------------------------------------------------------------------------


class FourStates(unittest.TestCase):
    def test_declared_before_the_cutoff_stands(self):
        result = allowed(section(status="declared", passed=False))
        self.assertEqual(result.total, Decimal("150000.00"))
        self.assertEqual(result.sections[0].effective_status, "declared")

    def test_verified_stands_at_the_verified_figure(self):
        result = allowed(
            section(status="verified", eligible="120000", declared="150000")
        )
        self.assertEqual(result.total, Decimal("120000.00"))

    def test_rejected_gives_nothing(self):
        result = allowed(section(status="rejected"))
        self.assertEqual(result.total, Decimal("0.00"))
        self.assertIn("rejected", result.sections[0].reason)

    def test_unverified_after_the_cutoff_gives_nothing(self):
        result = allowed(
            section(status="declared", effective="unverified", passed=True,
                    reference="2027-02-28"),
            passed=True, reference="2027-02-28",
        )
        row = result.sections[0]
        self.assertEqual(result.total, Decimal("0.00"))
        self.assertEqual(row.effective_status, "unverified")
        self.assertIn("never proved", row.reason)
        self.assertIn(CUTOFF, row.reason)

    def test_the_four_states_are_not_equivalent(self):
        totals = {
            s: allowed(section(status=st, effective=ef, eligible=el)).total
            for s, st, ef, el in [
                ("declared", "declared", None, None),
                ("verified", "verified", None, "150000"),
                ("rejected", "rejected", None, None),
                ("unverified", "declared", "unverified", None),
            ]
        }
        self.assertEqual(totals["declared"], Decimal("150000.00"))
        self.assertEqual(totals["verified"], Decimal("150000.00"))
        self.assertEqual(totals["rejected"], Decimal("0.00"))
        self.assertEqual(totals["unverified"], Decimal("0.00"))


class DeclaredAmountIsNeverDestroyed(unittest.TestCase):
    """Nothing about the cutoff rewrites what the employee said."""

    def test_the_declared_figure_survives_an_unverified_outcome(self):
        row = allowed(
            section(declared="150000", status="declared", effective="unverified", passed=True)
        ).sections[0]
        self.assertEqual(row.declared_amount, Decimal("150000.00"))
        self.assertEqual(row.eligible_amount, Decimal("0"))
        self.assertEqual(row.allowed_exemption, Decimal("0"))

    def test_the_declared_figure_survives_a_rejection(self):
        row = allowed(section(declared="150000", status="rejected")).sections[0]
        self.assertEqual(row.declared_amount, Decimal("150000.00"))

    def test_the_explanation_carries_the_whole_story(self):
        detail = allowed(
            section(declared="150000", status="declared", effective="unverified",
                    passed=True, reference="2027-02-28")
        ).sections[0].as_detail()
        # Every figure the brief asks to be explainable.
        self.assertEqual(detail["declared_amount"], "150000.00")
        self.assertEqual(Decimal(detail["eligible_amount"]), Decimal("0"))
        self.assertEqual(Decimal(detail["allowed_exemption"]), Decimal("0"))
        self.assertEqual(detail["status"], "declared")
        self.assertEqual(detail["effective_status"], "unverified")
        self.assertEqual(detail["proof_cutoff_date"], CUTOFF)
        self.assertTrue(detail["cutoff_passed"])


class TheEngineComparesNoDates(unittest.TestCase):
    def test_the_frozen_boolean_wins_over_the_dates_beside_it(self):
        # Reference date well past the cutoff, but Node said not passed. The engine must not
        # second-guess it — one comparison, in one place, or the two languages drift.
        contradictory = section(
            status="declared", effective="declared",
            cutoff="2027-01-31", reference="2027-12-31", passed=False,
        )
        self.assertEqual(allowed(contradictory).total, Decimal("150000.00"))

    def test_and_the_other_way_round(self):
        contradictory = section(
            status="declared", effective="unverified",
            cutoff="2027-01-31", reference="2026-04-01", passed=True,
        )
        self.assertEqual(allowed(contradictory).total, Decimal("0.00"))

    def test_a_missing_cutoff_date_is_not_a_passed_cutoff(self):
        result = allowed(section(status="declared", cutoff=None, passed=False))
        self.assertEqual(result.total, Decimal("150000.00"))
        self.assertIsNone(result.sections[0].proof_cutoff_date)


class CutoffWithOtherRules(unittest.TestCase):
    def test_the_section_cap_still_applies_to_a_verified_amount(self):
        result = allowed(
            section(declared="200000", eligible="180000", status="verified", cap="150000")
        )
        # Proof, then eligibility, then the ceiling. All three, in that order.
        self.assertEqual(result.total, Decimal("150000.00"))
        self.assertTrue(result.sections[0].capped)

    def test_the_regime_still_applies_and_is_checked_before_proof(self):
        result = allowed(section(status="verified", eligible="150000"), regime="new")
        self.assertEqual(result.total, Decimal("0.00"))
        self.assertFalse(result.sections[0].applicable)
        self.assertIn("not available under the new regime", result.sections[0].reason)

    def test_sections_are_cut_off_independently(self):
        # 80C never proved, 80D proved. One being unverified says nothing about the other.
        result = allowed(
            section("80C", declared="150000", status="declared", effective="unverified",
                    passed=True),
            section("80D", declared="20000", cap="25000", status="verified",
                    eligible="20000", passed=True),
            passed=True,
        )
        by_code = {s.section_code: s for s in result.sections}
        self.assertEqual(by_code["80C"].allowed_exemption, Decimal("0"))
        self.assertEqual(by_code["80D"].allowed_exemption, Decimal("20000.00"))
        self.assertEqual(result.total, Decimal("20000.00"))

    def test_late_verification_restores_eligibility(self):
        # Proof accepted in February, after a January cutoff. Verification is what matters,
        # not when it happened — the tenant's HR policy allowed it, and the row says
        # `verified`, so the cutoff never comes into play.
        result = allowed(
            section(status="verified", eligible="150000", passed=True, reference="2027-02-28"),
            passed=True, reference="2027-02-28",
        )
        self.assertEqual(result.total, Decimal("150000.00"))
        self.assertEqual(result.sections[0].effective_status, "verified")


class FailClosed(unittest.TestCase):
    def test_a_missing_cutoff_the_tenant_requires_fails_this_employee(self):
        broken = section()
        broken["unresolved_reason"] = (
            "tenant policy requires a proof cutoff, but tax year 2026-27 has none configured"
        )
        with self.assertRaises(ExemptionError) as caught:
            calculate_section_exemptions(
                envelope(broken), regime="old", employee_label="employee E1"
            )
        message = str(caught.exception)
        self.assertIn("employee E1", message)
        self.assertIn("80C", message)
        self.assertIn("requires a proof cutoff", message)

    def test_it_does_not_silently_choose_a_date(self):
        broken = section(cutoff=None)
        broken["unresolved_reason"] = "tenant policy requires a proof cutoff"
        with self.assertRaises(ExemptionError):
            calculate_section_exemptions(envelope(broken, cutoff=None), regime="old")


# ---------------------------------------------------------------------------
# Through calculate(), where the cutoff meets the annual estimate.
# ---------------------------------------------------------------------------


def snapshot(*sections, regime="old", months_remaining=12, **kw):
    return {
        "employee_json": {"id": "emp-1", "employee_code": "E1", "state_code": None},
        "attendance_json": {
            "total_days": "30", "employed_days": "30", "lop_units": "0",
            "months_remaining_in_fy": months_remaining,
        },
        "leave_json": {},
        "compensation_json": {
            "base_amount": "200000",
            "currency": "INR",
            "pay_structure": True,
            "components": [
                {"code": "BASIC", "name": "Basic", "component_type": "earning",
                 "calculation_type": "percentage", "percentage": "50",
                 "percentage_of_code": "BASE", "semantic_role": "basic",
                 "taxable": True, "affects_lop": True, "sequence_no": 1},
            ],
        },
        "tax_json": {
            "regime": regime, "declared_amount": "0",
            "pf_applicable": False, "esi_applicable": False,
        },
        "statutory_json": {
            "required": ["income_tax"],
            "income_tax": {"version": 1, "config": INCOME_TAX_CONFIG},
        },
        "additional_json": [],
        "hra_json": {"applicable": False, "reason": "no rent declared"},
        "exemption_json": envelope(*sections, **kw),
    }


def exemption_line(result, code):
    return next((c for c in result.components if c.code == f"EXEMPTION_{code}"), None)


class ThroughTheEngine(unittest.TestCase):
    def test_an_unverified_declaration_after_cutoff_raises_the_tax(self):
        before = calculate(snapshot(
            section(status="declared", passed=False), reference="2026-12-31",
        ))
        after = calculate(snapshot(
            section(status="declared", effective="unverified", passed=True,
                    reference="2027-02-28"),
            passed=True, reference="2027-02-28",
        ))
        self.assertEqual(before.section_exemption_total, Decimal("150000.00"))
        self.assertEqual(after.section_exemption_total, Decimal("0"))

        before_tds = next(c for c in before.components if c.code == "TDS")
        after_tds = next(c for c in after.components if c.code == "TDS")
        # The exemption is gone from the annual estimate, so the remaining liability rises.
        self.assertGreater(
            Decimal(after_tds.detail["annual_taxable"]),
            Decimal(before_tds.detail["annual_taxable"]),
        )

    def test_the_payslip_still_shows_the_line_and_why_it_gave_nothing(self):
        result = calculate(snapshot(
            section(declared="150000", status="declared", effective="unverified",
                    passed=True, reference="2027-02-28"),
            passed=True, reference="2027-02-28",
        ))
        line = exemption_line(result, "80C")
        # Present with a zero amount, not absent. "Declared 150,000, allowed nothing, here is
        # why" is the answer an employee needs in June.
        self.assertIsNotNone(line)
        self.assertEqual(line.amount, Decimal("0"))
        self.assertEqual(line.detail["declared_amount"], "150000.00")
        self.assertEqual(line.detail["effective_status"], "unverified")
        self.assertTrue(line.detail["cutoff_passed"])

    def test_the_cutoff_is_not_a_monthly_reset(self):
        # The annual exemption is an annual figure whatever the month. Two runs with the same
        # proof state and different months remaining allow the same amount.
        april = calculate(snapshot(section(status="verified", eligible="150000"),
                                   months_remaining=12))
        march = calculate(snapshot(section(status="verified", eligible="150000"),
                                   months_remaining=1))
        self.assertEqual(april.section_exemption_total, march.section_exemption_total)
        self.assertEqual(april.section_exemption_total, Decimal("150000.00"))

    def test_gross_and_net_are_untouched_by_the_cutoff(self):
        with_exemption = calculate(snapshot(section(status="declared", passed=False)))
        without = calculate(snapshot(
            section(status="declared", effective="unverified", passed=True), passed=True,
        ))
        # Chapter VI-A reduces what tax is assessed on. Losing it raises the tax, and moves
        # nothing else.
        self.assertEqual(with_exemption.gross_amount, without.gross_amount)
        self.assertGreater(without.tax_amount, with_exemption.tax_amount)
        self.assertEqual(
            without.net_amount,
            without.gross_amount - without.deduction_amount - without.tax_amount,
        )

    def test_hra_is_unaffected_by_the_section_proof_cutoff(self):
        snap = snapshot(
            section(status="declared", effective="unverified", passed=True), passed=True,
        )
        snap["compensation_json"]["components"].append(
            {"code": "HRA", "name": "House Rent Allowance", "component_type": "earning",
             "calculation_type": "percentage", "percentage": "40",
             "percentage_of_code": "BASIC", "semantic_role": "house_rent_allowance",
             "taxable": True, "affects_lop": True, "sequence_no": 2}
        )
        snap["hra_json"] = {
            "applicable": True, "rent_amount": "40000",
            "metro_classification": "metro", "projection": [],
        }
        result = calculate(snap)
        # The section cutoff governs chapter VI-A. HRA is section 10(13A) with its own
        # proof story, deliberately untouched by this phase.
        self.assertEqual(result.hra_exemption, Decimal("30000.00"))
        self.assertEqual(result.section_exemption_total, Decimal("0"))

    def test_determinism_and_no_mutation(self):
        snap = snapshot(
            section(status="declared", effective="unverified", passed=True), passed=True,
        )
        original = copy.deepcopy(snap)
        first, second = calculate(snap), calculate(snap)
        self.assertEqual(first.section_exemption_total, second.section_exemption_total)
        self.assertEqual(snap, original)


if __name__ == "__main__":
    unittest.main()
