"""Chapter VI-A exemption caps.

What is being pinned down:

  1. min(eligible, cap), never negative, never more than declared, in Decimal.
  2. Eligibility and the ceiling are *different steps*. Declaring 200,000 and having 180,000
     accepted gives min(180,000, 150,000), not 150,000 of the declared figure.
  3. Sections are capped independently. 80C being over its limit says nothing about 80D.
  4. An annual cap is not a monthly one, and nothing is multiplied or divided by twelve.
  5. A section whose rule cannot be resolved fails *that employee*, rather than defaulting to
     unlimited, to zero, or to last year's number.
"""

from __future__ import annotations

import copy
import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.calculation import calculate  # noqa: E402
from app.exemptions import (  # noqa: E402
    ExemptionError,
    calculate_section_exemptions,
)

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
            "slabs": [
                {"upto": 300000, "rate": 0},
                {"upto": 700000, "rate": 0.05},
                {"upto": None, "rate": 0.2},
            ],
            "rebate_limit": 700000,
            "rebate_max": 25000,
            "cess_rate": 0.04,
        },
    }
}


def section(code="80C", declared="100000", cap="150000", *, eligible=None,
            status="declared", regimes=("old",), version=1, name=None):
    return {
        "section_code": code,
        "name": name or f"Section {code}",
        "declared_amount": declared,
        "eligible_amount": eligible,
        "status": status,
        "rule_id": "rule-1",
        "rule_version": version,
        "rule_source": "platform",
        "max_amount": cap,
        "applicable_regimes": list(regimes),
    }


def envelope(*sections, label="2026-27"):
    return {
        "tax_year_id": "ty-1",
        "tax_year_label": label,
        "regime": "old",
        "sections": list(sections),
    }


def allowed(*sections, regime="old"):
    return calculate_section_exemptions(envelope(*sections), regime=regime)


# ---------------------------------------------------------------------------


class CapBehaviour(unittest.TestCase):
    def test_below_the_cap_allows_the_whole_declaration(self):
        result = allowed(section(declared="100000", cap="150000"))
        self.assertEqual(result.total, Decimal("100000.00"))
        self.assertFalse(result.sections[0].capped)

    def test_exactly_at_the_cap(self):
        result = allowed(section(declared="150000", cap="150000"))
        self.assertEqual(result.total, Decimal("150000.00"))
        self.assertFalse(result.sections[0].capped, "at the ceiling is not over it")

    def test_one_rupee_below_the_cap(self):
        result = allowed(section(declared="149999", cap="150000"))
        self.assertEqual(result.total, Decimal("149999.00"))
        self.assertFalse(result.sections[0].capped)

    def test_one_rupee_above_the_cap(self):
        result = allowed(section(declared="150001", cap="150000"))
        self.assertEqual(result.total, Decimal("150000.00"))
        self.assertTrue(result.sections[0].capped)

    def test_far_above_the_cap(self):
        result = allowed(section(declared="2000000", cap="150000"))
        self.assertEqual(result.total, Decimal("150000.00"))

    def test_zero_declaration(self):
        result = allowed(section(declared="0"))
        self.assertEqual(result.total, Decimal("0.00"))

    def test_zero_cap_allows_nothing(self):
        # A configured ceiling of zero is a real answer, not a missing one: the section
        # exists this year but gives nothing.
        result = allowed(section(declared="100000", cap="0"))
        self.assertEqual(result.total, Decimal("0.00"))
        self.assertIn("ceiling", result.sections[0].reason)

    def test_a_paisa_declaration_survives_intact(self):
        result = allowed(section(declared="12345.67", cap="150000"))
        self.assertEqual(result.total, Decimal("12345.67"))
        self.assertIsInstance(result.total, Decimal)

    def test_never_negative(self):
        result = allowed(section(declared="-5000", cap="150000"))
        self.assertEqual(result.total, Decimal("0.00"))

    def test_arithmetic_is_decimal_throughout(self):
        result = allowed(section(declared="33333.33", cap="150000"))
        for value in (
            result.sections[0].declared_amount,
            result.sections[0].eligible_amount,
            result.sections[0].configured_cap,
            result.sections[0].allowed_exemption,
            result.total,
        ):
            self.assertIsInstance(value, Decimal)


class EligibilityIsNotTheCap(unittest.TestCase):
    """The distinction the brief is emphatic about, and the one easiest to collapse."""

    def test_eligibility_narrows_first_then_the_ceiling_applies(self):
        # Declared 200,000; a verifier accepted 180,000; the ceiling is 150,000.
        result = allowed(section(declared="200000", eligible="180000",
                                 status="verified", cap="150000"))
        row = result.sections[0]
        self.assertEqual(row.declared_amount, Decimal("200000.00"))
        self.assertEqual(row.eligible_amount, Decimal("180000.00"))
        self.assertEqual(row.configured_cap, Decimal("150000.00"))
        self.assertEqual(row.allowed_exemption, Decimal("150000.00"))

    def test_eligibility_below_the_cap_binds_instead(self):
        # Only 90,000 was supportable, so the 150,000 ceiling never comes into it.
        result = allowed(section(declared="200000", eligible="90000",
                                 status="verified", cap="150000"))
        self.assertEqual(result.total, Decimal("90000.00"))
        self.assertFalse(result.sections[0].capped)

    def test_an_unassessed_declaration_stands_at_its_declared_figure(self):
        # Nobody has looked yet. That is the behaviour this system already had, kept.
        row = allowed(section(declared="120000", eligible=None, status="declared")).sections[0]
        self.assertEqual(row.eligible_amount, Decimal("120000.00"))

    def test_a_rejected_declaration_allows_nothing(self):
        result = allowed(section(declared="150000", status="rejected", cap="150000"))
        self.assertEqual(result.total, Decimal("0.00"))
        self.assertIn("rejected", result.sections[0].reason)

    def test_nobody_is_eligible_for_more_than_they_declared(self):
        row = allowed(section(declared="50000", eligible="90000",
                              status="verified", cap="150000")).sections[0]
        self.assertEqual(row.eligible_amount, Decimal("50000.00"))
        self.assertEqual(row.allowed_exemption, Decimal("50000.00"))

    def test_all_four_figures_are_recorded_not_just_the_last(self):
        detail = allowed(section(declared="200000", eligible="180000",
                                 status="verified", cap="150000")).sections[0].as_detail()
        self.assertEqual(detail["declared_amount"], "200000.00")
        self.assertEqual(detail["eligible_amount"], "180000.00")
        self.assertEqual(detail["configured_cap"], "150000.00")
        self.assertEqual(detail["allowed_exemption"], "150000.00")
        self.assertTrue(detail["capped_by_statute"])
        self.assertEqual(detail["rule_version"], 1)
        self.assertEqual(detail["tax_year"], "2026-27")


class IndependentSections(unittest.TestCase):
    def test_each_section_is_capped_against_its_own_ceiling(self):
        result = allowed(
            section("80C", declared="200000", cap="150000"),
            section("80D", declared="10000", cap="25000"),
        )
        by_code = {s.section_code: s for s in result.sections}
        self.assertEqual(by_code["80C"].allowed_exemption, Decimal("150000.00"))
        self.assertEqual(by_code["80D"].allowed_exemption, Decimal("10000.00"))
        self.assertEqual(result.total, Decimal("160000.00"))

    def test_one_section_over_its_cap_does_not_reduce_another(self):
        over_only = allowed(section("80C", declared="900000", cap="150000"))
        with_second = allowed(
            section("80C", declared="900000", cap="150000"),
            section("80D", declared="25000", cap="25000"),
        )
        self.assertEqual(
            with_second.total - over_only.total,
            Decimal("25000.00"),
            "80D is unaffected by 80C being over its limit",
        )

    def test_no_single_global_cap_is_applied_across_sections(self):
        # Three sections at their ceilings total 225,000. A global 150,000 cap — the bug this
        # guards against — would report 150,000.
        result = allowed(
            section("80C", declared="150000", cap="150000"),
            section("80D", declared="25000", cap="25000"),
            section("80CCD(1B)", declared="50000", cap="50000"),
        )
        self.assertEqual(result.total, Decimal("225000.00"))

    def test_sections_keep_their_own_rule_versions(self):
        result = allowed(
            section("80C", version=3),
            section("80D", declared="10000", cap="25000", version=7),
        )
        versions = {s.section_code: s.rule_version for s in result.sections}
        self.assertEqual(versions, {"80C": 3, "80D": 7})


class Regime(unittest.TestCase):
    def test_a_section_the_regime_does_not_give_allows_nothing(self):
        result = allowed(section(declared="150000", regimes=("old",)), regime="new")
        self.assertEqual(result.total, Decimal("0.00"))
        self.assertFalse(result.sections[0].applicable)
        self.assertIn("not available under the new regime", result.sections[0].reason)

    def test_a_section_the_regime_does_give_is_applied(self):
        result = allowed(section(declared="150000", regimes=("old", "new")), regime="new")
        self.assertEqual(result.total, Decimal("150000.00"))

    def test_the_declared_figure_is_still_recorded_when_the_regime_refuses_it(self):
        # The employee declared it; the payslip should say so and say why it gave nothing.
        row = allowed(section(declared="150000", regimes=("old",)), regime="new").sections[0]
        self.assertEqual(row.declared_amount, Decimal("150000.00"))
        self.assertEqual(row.allowed_exemption, Decimal("0.00"))


class FailClosed(unittest.TestCase):
    def test_an_unresolved_rule_raises_rather_than_guessing(self):
        broken = section()
        broken["max_amount"] = None
        broken["unresolved_reason"] = "no exemption rule is in force for section 80C in 2026-27"
        with self.assertRaises(ExemptionError) as caught:
            calculate_section_exemptions(
                envelope(broken), regime="old", employee_label="employee E1"
            )
        message = str(caught.exception)
        # Everything an administrator needs without opening the database.
        self.assertIn("employee E1", message)
        self.assertIn("80C", message)
        self.assertIn("2026-27", message)

    def test_a_missing_ceiling_is_never_read_as_unlimited(self):
        broken = section(declared="5000000")
        broken["max_amount"] = None
        with self.assertRaises(ExemptionError):
            calculate_section_exemptions(envelope(broken), regime="old")

    def test_a_section_with_no_code_is_refused(self):
        nameless = section()
        nameless["section_code"] = ""
        with self.assertRaises(ExemptionError):
            calculate_section_exemptions(envelope(nameless), regime="old")

    def test_no_declarations_is_not_a_failure(self):
        self.assertEqual(calculate_section_exemptions(envelope(), regime="old").total,
                         Decimal("0.00"))


# ---------------------------------------------------------------------------
# Through calculate(), where the exemption meets the annual estimate.
# ---------------------------------------------------------------------------


def snapshot(*sections, regime="old", months_remaining=12, legacy_declared=None,
             pay_structure=True, tax_year_id="ty-1"):
    snap = {
        "employee_json": {"id": "emp-1", "employee_code": "E1", "state_code": None},
        "attendance_json": {
            "total_days": "30", "employed_days": "30", "lop_units": "0",
            "months_remaining_in_fy": months_remaining,
        },
        "leave_json": {},
        "compensation_json": {
            "base_amount": "200000",
            "currency": "INR",
            "pay_structure": pay_structure,
            "components": [
                {"code": "BASIC", "name": "Basic", "component_type": "earning",
                 "calculation_type": "percentage", "percentage": "50",
                 "percentage_of_code": "BASE", "semantic_role": "basic",
                 "taxable": True, "affects_lop": True, "sequence_no": 1},
            ],
        },
        "tax_json": {
            "regime": regime, "declared_amount": legacy_declared or "0",
            "pf_applicable": False, "esi_applicable": False,
        },
        "statutory_json": {
            "required": ["income_tax"],
            "income_tax": {"version": 1, "config": INCOME_TAX_CONFIG},
        },
        "additional_json": [],
        "hra_json": {"applicable": False, "reason": "no rent declared"},
        "exemption_json": {
            "tax_year_id": tax_year_id,
            "tax_year_label": "2026-27",
            "regime": regime,
            "sections": list(sections),
        },
    }
    if tax_year_id is None:
        snap["exemption_json"] = {"sections": []}
    return snap


def exemption_lines(result):
    return [c for c in result.components if c.component_type == "exemption"]


class ThroughTheEngine(unittest.TestCase):
    def test_the_capped_total_reduces_annual_taxable_income(self):
        without = calculate(snapshot())
        with_80c = calculate(snapshot(section("80C", declared="150000", cap="150000")))

        without_tds = next(c for c in without.components if c.code == "TDS")
        with_tds = next(c for c in with_80c.components if c.code == "TDS")
        self.assertEqual(
            Decimal(without_tds.detail["annual_taxable"])
            - Decimal(with_tds.detail["annual_taxable"]),
            Decimal("150000.00"),
        )

    def test_the_exemption_does_not_touch_gross_or_net(self):
        plain = calculate(snapshot())
        with_80c = calculate(snapshot(section("80C", declared="150000", cap="150000")))
        # Chapter VI-A reduces the income tax is assessed on. It is not a deduction from pay,
        # so gross is identical and net moves only by the tax that is no longer withheld.
        self.assertEqual(plain.gross_amount, with_80c.gross_amount)
        self.assertGreater(with_80c.net_amount, plain.net_amount)
        self.assertEqual(
            with_80c.net_amount,
            with_80c.gross_amount - with_80c.deduction_amount - with_80c.tax_amount,
        )

    def test_one_informational_line_per_section(self):
        result = calculate(snapshot(
            section("80C", declared="200000", cap="150000"),
            section("80D", declared="10000", cap="25000"),
        ))
        lines = {c.code: c for c in exemption_lines(result)}
        self.assertIn("EXEMPTION_80C", lines)
        self.assertIn("EXEMPTION_80D", lines)
        self.assertEqual(lines["EXEMPTION_80C"].amount, Decimal("150000.00"))
        self.assertEqual(lines["EXEMPTION_80C"].detail["declared_amount"], "200000.00")
        self.assertTrue(lines["EXEMPTION_80C"].detail["capped_by_statute"])

    def test_exemption_lines_are_excluded_from_every_total(self):
        result = calculate(snapshot(section("80C", declared="150000", cap="150000")))
        earnings = sum((c.amount for c in result.components
                        if c.component_type == "earning"), Decimal("0"))
        self.assertEqual(earnings, result.gross_amount)
        self.assertEqual(result.section_exemption_total, Decimal("150000.00"))

    def test_the_annual_cap_is_not_applied_monthly(self):
        # The same declaration in a twelve-month-remaining period and a one-month-remaining
        # period must exempt the same *annual* amount. A monthly reading would scale it.
        april = calculate(snapshot(section("80C", declared="150000", cap="150000"),
                                   months_remaining=12))
        march = calculate(snapshot(section("80C", declared="150000", cap="150000"),
                                   months_remaining=1))
        self.assertEqual(april.section_exemption_total, march.section_exemption_total)
        self.assertEqual(april.section_exemption_total, Decimal("150000.00"))

    def test_no_multiplication_by_twelve_anywhere(self):
        result = calculate(snapshot(section("80C", declared="150000", cap="150000")))
        # 150,000 x 12 would be 1,800,000, which would wipe out the whole year's income.
        self.assertEqual(result.section_exemption_total, Decimal("150000.00"))
        tds = next(c for c in result.components if c.code == "TDS")
        self.assertEqual(tds.detail["section_exemptions"], "150000.00")

    def test_the_new_regime_gets_no_section_exemption(self):
        result = calculate(snapshot(section("80C", declared="150000", cap="150000"),
                                    regime="new"))
        self.assertEqual(result.section_exemption_total, Decimal("0"))

    def test_an_unresolved_section_fails_only_this_employee(self):
        broken = section()
        broken["max_amount"] = None
        broken["unresolved_reason"] = "no rule in force"
        with self.assertRaises(ExemptionError):
            calculate(snapshot(broken))
        # The next employee's snapshot is untouched and still calculates.
        self.assertEqual(
            calculate(snapshot(section("80C", declared="1000", cap="150000")))
            .section_exemption_total,
            Decimal("1000.00"),
        )

    def test_a_supplementary_run_does_not_re_apply_the_year_exemptions(self):
        snap = snapshot(pay_structure=False)
        snap["exemption_json"]["sections"] = []
        snap["additional_json"] = [
            {"code": "BONUS", "name": "Bonus", "component_type": "earning",
             "amount": "10000", "kind": "bonus", "taxable": True},
        ]
        result = calculate(snap)
        self.assertEqual(result.section_exemption_total, Decimal("0"))

    def test_hra_and_section_exemptions_coexist_without_interfering(self):
        snap = snapshot(section("80C", declared="150000", cap="150000"))
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
        # HRA stays a period figure; the section total stays annual. Two calculations, two
        # results, neither one derived from the other.
        #   basic 100,000, HRA 40,000, rent 40,000, metro
        #   A 40,000 | B 40,000 - 10,000 = 30,000 | C 50% of 100,000 = 50,000  ->  30,000
        self.assertEqual(result.hra_exemption, Decimal("30000.00"))
        self.assertEqual(result.section_exemption_total, Decimal("150000.00"))
        codes = {c.code for c in exemption_lines(result)}
        self.assertEqual(codes, {"HRA_EXEMPTION", "EXEMPTION_80C"})


class LegacySnapshots(unittest.TestCase):
    """A run snapshotted before ceilings existed must still reproduce."""

    def test_a_pre_cap_snapshot_reapplies_its_uncapped_figure(self):
        # No tax_year_id in exemption_json marks a snapshot from before this phase. Those
        # runs applied tax_json.declared_amount uncapped; recalculating one must not
        # retroactively cap it, or it would not reproduce the payslip it recalculates.
        snap = snapshot(tax_year_id=None, legacy_declared="400000")
        result = calculate(snap)
        self.assertEqual(result.section_exemption_total, Decimal("400000.00"))
        self.assertEqual(exemption_lines(result)[0].detail["section_code"], "LEGACY")

    def test_a_pre_cap_snapshot_with_no_declaration_exempts_nothing(self):
        result = calculate(snapshot(tax_year_id=None, legacy_declared="0"))
        self.assertEqual(result.section_exemption_total, Decimal("0"))
        self.assertEqual(exemption_lines(result), [])

    def test_a_current_snapshot_ignores_the_legacy_figure(self):
        # Both present: the structured sections win, and the uncapped legacy number is not
        # added on top.
        snap = snapshot(section("80C", declared="50000", cap="150000"),
                        legacy_declared="400000")
        self.assertEqual(calculate(snap).section_exemption_total, Decimal("50000.00"))


class Determinism(unittest.TestCase):
    def test_the_same_snapshot_always_produces_the_same_result(self):
        snap = snapshot(
            section("80C", declared="200000", cap="150000"),
            section("80D", declared="10000", cap="25000"),
        )
        first, second = calculate(snap), calculate(snap)
        self.assertEqual(first.section_exemption_total, second.section_exemption_total)
        self.assertEqual(
            [c.detail for c in exemption_lines(first)],
            [c.detail for c in exemption_lines(second)],
        )

    def test_calculating_does_not_mutate_the_snapshot(self):
        snap = snapshot(section("80C", declared="150000", cap="150000"))
        original = copy.deepcopy(snap)
        calculate(snap)
        self.assertEqual(snap, original)


if __name__ == "__main__":
    unittest.main()
