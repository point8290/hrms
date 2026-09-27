"""Employees' State Insurance: eligibility from the wage, figures from the rule.

Two properties carry the suite, and they are the ESI counterparts of what ADR-021 established
for provident fund.

**Nothing statutory is defaulted.** Neither rate nor the ceiling falls back to a literal in
the engine. The ceiling matters most of the three because it is not a cap on the contribution
— it is the *eligibility test*. A rule without one cannot answer who is covered, and a
fallback would silently enrol or exclude real people.

**Eligibility is derived, not declared.** An employee whose gross for the period is at or
under the ceiling is in the scheme; one above it is out. Nothing else about them is
consulted, which is why no "ESI eligible" attribute exists and none was added.

Deliberately not tested because deliberately not implemented: a configurable ESI wage basis,
state variation, contribution-period boundaries, and previous-employer ESI. None is in the
PRD. The wage basis is gross earnings, which is existing behaviour rather than an assumption
made here — the rule's own key is `gross_wage_ceiling`.
"""

from __future__ import annotations

import copy
import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.calculation import PayrollError, calculate  # noqa: E402
from app.statutory import EsiConfigError, calculate_esi, rupees  # noqa: E402

# The platform rule as seeded in migration 0008.
ESI_RULE = {
    "employee_rate": 0.0075,
    "employer_rate": 0.0325,
    "gross_wage_ceiling": 21000,
}

INCOME_TAX_CONFIG = {
    "regimes": {
        "new": {"slabs": [{"upto": 300000, "rate": 0}, {"upto": None, "rate": 0.2}],
                "standard_deduction": 75000, "rebate_limit": 700000, "rebate_max": 25000,
                "cess_rate": 0.04},
    }
}


def esi(gross, config=None, applicable=True):
    cfg = ESI_RULE if config is None else config
    return calculate_esi(Decimal(str(gross)), cfg, applicable=applicable)


# ---------------------------------------------------------------------------


class NothingStatutoryIsDefaulted(unittest.TestCase):
    """PRD: statutory rules are versioned data, "rather than scattered as hard-coded logic"."""

    def test_a_missing_ceiling_refuses_rather_than_assuming_one(self):
        # The most dangerous of the three: the ceiling decides who is covered at all.
        cfg = {k: v for k, v in ESI_RULE.items() if k != "gross_wage_ceiling"}
        with self.assertRaises(EsiConfigError) as caught:
            esi("15000", cfg)
        self.assertIn("gross_wage_ceiling", str(caught.exception))

    def test_a_missing_employee_rate_refuses(self):
        cfg = {k: v for k, v in ESI_RULE.items() if k != "employee_rate"}
        with self.assertRaises(EsiConfigError) as caught:
            esi("15000", cfg)
        self.assertIn("employee_rate", str(caught.exception))

    def test_a_missing_employer_rate_refuses(self):
        cfg = {k: v for k, v in ESI_RULE.items() if k != "employer_rate"}
        with self.assertRaises(EsiConfigError):
            esi("15000", cfg)

    def test_a_null_figure_is_as_absent_as_a_missing_one(self):
        with self.assertRaises(EsiConfigError):
            esi("15000", {**ESI_RULE, "gross_wage_ceiling": None})

    def test_an_empty_rule_refuses_rather_than_applying_the_statutory_defaults(self):
        with self.assertRaises(EsiConfigError):
            esi("15000", {})

    def test_a_zero_rate_is_configuration_not_absence(self):
        result = esi("15000", {**ESI_RULE, "employee_rate": 0})
        self.assertEqual(result.employee, Decimal("0"))
        self.assertGreater(result.employer, Decimal("0"))
        self.assertTrue(result.eligible)

    def test_the_figures_are_not_consulted_when_esi_does_not_apply(self):
        # An employee outside the scheme needs no rule, so an empty config is fine here.
        result = esi("15000", {}, applicable=False)
        self.assertFalse(result.eligible)
        self.assertEqual(result.employee, Decimal("0"))


class Eligibility(unittest.TestCase):
    def test_below_the_ceiling_is_covered(self):
        result = esi("20999")
        self.assertTrue(result.eligible)
        self.assertEqual(result.employee, rupees(Decimal("20999") * Decimal("0.0075")))

    def test_exactly_at_the_ceiling_is_covered(self):
        # The rule excludes wages *exceeding* the ceiling, so the ceiling itself is inside.
        result = esi("21000")
        self.assertTrue(result.eligible)
        self.assertEqual(result.employee, rupees(Decimal("21000") * Decimal("0.0075")))

    def test_one_rupee_above_the_ceiling_is_outside_the_scheme(self):
        result = esi("21001")
        self.assertFalse(result.eligible)
        self.assertEqual(result.employee, Decimal("0"))
        self.assertEqual(result.employer, Decimal("0"))

    def test_a_paisa_above_the_ceiling_is_outside_the_scheme(self):
        self.assertFalse(esi("21000.01").eligible)

    def test_being_outside_the_scheme_says_why(self):
        detail = esi("30000").detail
        self.assertFalse(detail["eligible"])
        self.assertTrue(detail["ceiling_exceeded"])
        self.assertIn("exceed the ESI wage ceiling", detail["reason"])

    def test_not_applicable_is_different_from_over_the_ceiling(self):
        # Two zeroes with different causes, and the payslip can tell them apart.
        not_applicable = esi("15000", applicable=False).detail
        over_ceiling = esi("30000").detail
        self.assertNotIn("ceiling_exceeded", not_applicable)
        self.assertTrue(over_ceiling["ceiling_exceeded"])

    def test_eligibility_needs_no_employee_attribute(self):
        # Derived entirely from the wage. If this ever needed a flag on the employee, that
        # would be a model change; today it does not.
        self.assertTrue(esi("10000").eligible)
        self.assertFalse(esi("50000").eligible)


class Rates(unittest.TestCase):
    def test_the_employee_and_employer_rates_differ(self):
        result = esi("20000")
        self.assertEqual(result.employee, rupees(Decimal("20000") * Decimal("0.0075")))
        self.assertEqual(result.employer, rupees(Decimal("20000") * Decimal("0.0325")))
        self.assertGreater(result.employer, result.employee)

    def test_both_are_computed_on_the_same_gross(self):
        detail = esi("20000").detail
        self.assertEqual(detail["wage_basis"], "20000.00")
        self.assertEqual(detail["wage_basis_kind"], "gross_earnings")

    def test_contributions_are_whole_rupees(self):
        result = esi("12345.67")
        for value in (result.employee, result.employer):
            self.assertEqual(value, value.quantize(Decimal("1")))

    def test_rounding_is_half_up(self):
        # 0.75% of 12,345.67 is 92.5925 -> 93.
        self.assertEqual(esi("12345.67").employee, Decimal("93"))

    def test_a_tiny_wage_still_contributes(self):
        # 0.75% of 100 is 0.75 -> 1 rupee. Not zero, because the rounding is half up.
        self.assertEqual(esi("100").employee, Decimal("1"))

    def test_zero_wage_contributes_nothing(self):
        result = esi("0")
        self.assertTrue(result.eligible, "a zero wage is under the ceiling")
        self.assertEqual(result.employee, Decimal("0"))

    def test_the_same_wage_always_gives_the_same_contribution(self):
        self.assertEqual(esi("20000").detail, esi("20000").detail)


# ---------------------------------------------------------------------------
# Through calculate(), where ESI meets the payslip.
# ---------------------------------------------------------------------------


def snapshot(*, base="20000", lop="0", esi_rule=ESI_RULE, esi_applicable=True,
             additional=None):
    statutory = {"required": ["income_tax"],
                 "income_tax": {"version": 1, "rule_id": "it-1", "config": INCOME_TAX_CONFIG}}
    if esi_rule is not None:
        statutory["esi"] = {"rule_id": "esi-1", "version": 1, "source": "platform",
                            "config": esi_rule}
        statutory["required"].append("esi")

    return {
        "employee_json": {"id": "emp-1", "employee_code": "E1", "state_code": None},
        "attendance_json": {"total_days": "30", "employed_days": "30", "lop_units": lop,
                            "months_remaining_in_fy": 12},
        "leave_json": {},
        "compensation_json": {
            "base_amount": base, "currency": "INR", "pay_structure": True,
            "components": [
                {"code": "BASIC", "name": "Basic", "component_type": "earning",
                 "calculation_type": "percentage", "percentage": "100",
                 "percentage_of_code": "BASE", "semantic_role": "basic",
                 "taxable": True, "affects_lop": True, "sequence_no": 1},
            ],
        },
        "tax_json": {"regime": "new", "declared_amount": "0",
                     "pf_applicable": False, "esi_applicable": esi_applicable},
        "statutory_json": statutory,
        "additional_json": additional or [],
        "hra_json": {"applicable": False, "reason": "no rent declared"},
        "exemption_json": {"sections": []},
    }


def line(result, code):
    return next((c for c in result.components if c.code == code), None)


class ThroughTheEngine(unittest.TestCase):
    def test_the_employee_contribution_is_a_statutory_deduction(self):
        employee_line = line(calculate(snapshot()), "ESI_EMPLOYEE")
        self.assertEqual(employee_line.component_type, "deduction")
        self.assertTrue(employee_line.is_statutory)
        self.assertEqual(employee_line.amount, Decimal("150"))

    def test_the_employer_contribution_does_not_reduce_net_pay(self):
        result = calculate(snapshot())
        employer_line = line(result, "ESI_EMPLOYER")
        self.assertEqual(employer_line.component_type, "employer_contribution")
        self.assertEqual(employer_line.amount, Decimal("650"))
        self.assertEqual(
            result.net_amount,
            result.gross_amount - result.deduction_amount - result.tax_amount,
        )
        self.assertEqual(result.employer_contribution, employer_line.amount)

    def test_turning_esi_off_raises_net_pay_by_the_employee_contribution(self):
        with_esi = calculate(snapshot())
        without = calculate(snapshot(esi_applicable=False))
        self.assertEqual(without.net_amount - with_esi.net_amount, Decimal("150"))
        self.assertEqual(without.employer_contribution, Decimal("0.00"))

    def test_employee_esi_does_not_reduce_taxable_income(self):
        # Established behaviour (ADR-014): ESI is not deductible from salary income the way
        # PF and professional tax are. Asserted so ESI work cannot quietly change it.
        self.assertFalse(line(calculate(snapshot()), "ESI_EMPLOYEE").exempted_from_income_tax)

    def test_the_employer_contribution_is_not_an_employee_tax_deduction(self):
        self.assertFalse(line(calculate(snapshot()), "ESI_EMPLOYER").exempted_from_income_tax)

    def test_a_high_earner_has_no_esi_lines_at_all(self):
        result = calculate(snapshot(base="50000"))
        self.assertIsNone(line(result, "ESI_EMPLOYEE"))
        self.assertIsNone(line(result, "ESI_EMPLOYER"))

    def test_loss_of_pay_can_bring_an_employee_into_the_scheme(self):
        # 25,000 gross is over the ceiling; ten LOP days of thirty leaves 16,666.67, which is
        # under it. That follows from the basis being gross earnings, not from any
        # ESI-specific leave rule.
        self.assertIsNone(line(calculate(snapshot(base="25000")), "ESI_EMPLOYEE"))
        covered = line(calculate(snapshot(base="25000", lop="10")), "ESI_EMPLOYEE")
        self.assertIsNotNone(covered)
        self.assertEqual(covered.detail["wage_basis"], "16666.67")

    def test_additional_salary_is_part_of_the_gross_and_can_end_coverage(self):
        # A bonus that lifts gross over the ceiling takes the employee out of the scheme for
        # that period. Again a consequence of the basis, not a bonus-specific rule.
        self.assertIsNotNone(line(calculate(snapshot()), "ESI_EMPLOYEE"))
        with_bonus = calculate(snapshot(additional=[
            {"code": "BONUS", "name": "Bonus", "component_type": "earning",
             "amount": "5000", "kind": "bonus", "taxable": True},
        ]))
        self.assertIsNone(line(with_bonus, "ESI_EMPLOYEE"))

    def test_a_misconfigured_rule_fails_this_employee_by_name(self):
        cfg = {k: v for k, v in ESI_RULE.items() if k != "employee_rate"}
        with self.assertRaises(PayrollError) as caught:
            calculate(snapshot(esi_rule=cfg))
        message = str(caught.exception)
        self.assertIn("E1", message)
        self.assertIn("employee_rate", message)


class Trace(unittest.TestCase):
    def test_both_lines_explain_the_same_calculation(self):
        result = calculate(snapshot())
        employee_detail = line(result, "ESI_EMPLOYEE").detail
        employer_detail = line(result, "ESI_EMPLOYER").detail

        for key in ("wage_basis", "gross_wage_ceiling", "employee_rate", "employer_rate",
                    "employee_contribution", "employer_contribution", "eligible",
                    "rule_id", "rule_version"):
            self.assertEqual(employee_detail[key], employer_detail[key], key)
        self.assertEqual(employee_detail["side"], "employee")
        self.assertEqual(employer_detail["side"], "employer")

    def test_the_employer_trace_is_no_longer_empty(self):
        # It used to be literally {}, which explained nothing about an employer cost.
        self.assertNotEqual(line(calculate(snapshot()), "ESI_EMPLOYER").detail, {})

    def test_the_trace_identifies_the_rule_that_produced_it(self):
        detail = line(calculate(snapshot()), "ESI_EMPLOYEE").detail
        self.assertEqual(detail["rule_id"], "esi-1")
        self.assertEqual(detail["rule_version"], 1)
        self.assertEqual(detail["rule_source"], "platform")

    def test_the_trace_reconciles_with_the_line_amounts(self):
        result = calculate(snapshot())
        detail = line(result, "ESI_EMPLOYEE").detail
        self.assertEqual(Decimal(detail["employee_contribution"]),
                         line(result, "ESI_EMPLOYEE").amount)
        self.assertEqual(Decimal(detail["employer_contribution"]),
                         line(result, "ESI_EMPLOYER").amount)


class Determinism(unittest.TestCase):
    def test_the_same_snapshot_always_produces_the_same_esi(self):
        snap = snapshot()
        first, second = calculate(snap), calculate(snap)
        self.assertEqual(line(first, "ESI_EMPLOYEE").detail,
                         line(second, "ESI_EMPLOYEE").detail)

    def test_calculating_does_not_mutate_the_snapshot(self):
        snap = snapshot()
        original = copy.deepcopy(snap)
        calculate(snap)
        self.assertEqual(snap, original)

    def test_the_frozen_rule_is_what_decides(self):
        # Two snapshots differing only in their frozen ESI config produce different ESI,
        # which is what makes a historical run reproducible after the live rule changes.
        old_rule = calculate(snapshot())
        new_rule = calculate(snapshot(esi_rule={**ESI_RULE, "employee_rate": 0.01}))
        self.assertEqual(line(old_rule, "ESI_EMPLOYEE").amount, Decimal("150"))
        self.assertEqual(line(new_rule, "ESI_EMPLOYEE").amount, Decimal("200"))

    def test_a_frozen_ceiling_decides_coverage_not_todays_rule(self):
        under_old_ceiling = calculate(snapshot(base="20000"))
        under_lower_ceiling = calculate(
            snapshot(base="20000", esi_rule={**ESI_RULE, "gross_wage_ceiling": 15000})
        )
        self.assertIsNotNone(line(under_old_ceiling, "ESI_EMPLOYEE"))
        self.assertIsNone(line(under_lower_ceiling, "ESI_EMPLOYEE"))


if __name__ == "__main__":
    unittest.main()
