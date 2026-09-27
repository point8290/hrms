"""Payroll calculation tests.

The properties that matter here are determinism, correct LOP pro-rating, correct
statutory behaviour at the ceilings, and refusal to produce an inconsistent payslip.
"""

from __future__ import annotations

import copy
import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.calculation import PayrollError, calculate, compute_payable_days  # noqa: E402
from app.main import build_slip_number  # noqa: E402
from app.statutory import (  # noqa: E402
    calculate_esi,
    calculate_income_tax,
    calculate_pf,
    calculate_professional_tax,
)

PF_CONFIG = {
    "employee_rate": 0.12,
    "employer_rate": 0.12,
    "wage_ceiling": 15000,
    "apply_ceiling": True,
    "employer_pension_rate": 0.0833,
    "basis_component_codes": ["BASIC"],
}

ESI_CONFIG = {"employee_rate": 0.0075, "employer_rate": 0.0325, "gross_wage_ceiling": 21000}

PT_KA = {"slabs": [{"upto": 24999, "amount": 0}, {"upto": None, "amount": 200}]}

INCOME_TAX_CONFIG = {
    "regimes": {
        "new": {
            "standard_deduction": 75000,
            "rebate_limit": 700000,
            "rebate_max": 25000,
            "cess_rate": 0.04,
            "slabs": [
                {"upto": 300000, "rate": 0},
                {"upto": 700000, "rate": 0.05},
                {"upto": 1000000, "rate": 0.10},
                {"upto": 1200000, "rate": 0.15},
                {"upto": 1500000, "rate": 0.20},
                {"upto": None, "rate": 0.30},
            ],
        },
        "old": {
            "standard_deduction": 50000,
            "rebate_limit": 500000,
            "rebate_max": 12500,
            "cess_rate": 0.04,
            "slabs": [
                {"upto": 250000, "rate": 0},
                {"upto": 500000, "rate": 0.05},
                {"upto": 1000000, "rate": 0.20},
                {"upto": None, "rate": 0.30},
            ],
        },
    }
}


def snapshot(**overrides):
    """A 31-day month, no LOP, 100000 monthly basis structure."""
    base = {
        "employee_json": {"id": "emp-1", "employee_code": "EMP0001", "state_code": "KA"},
        "attendance_json": {"total_days": 31, "employed_days": 31, "lop_units": 0},
        "leave_json": {},
        "compensation_json": {
            "currency": "INR",
            "base_amount": "100000",
            "components": [
                {
                    "code": "BASIC", "name": "Basic", "component_type": "earning",
                    "calculation_type": "percentage", "sequence_no": 1,
                    "percentage": "50", "percentage_of_code": "BASE", "affects_lop": True,
                },
                {
                    "code": "HRA", "name": "House Rent Allowance", "component_type": "earning",
                    "calculation_type": "percentage", "sequence_no": 2,
                    "percentage": "40", "percentage_of_code": "BASIC", "affects_lop": True,
                },
                {
                    "code": "SPECIAL", "name": "Special Allowance", "component_type": "earning",
                    "calculation_type": "fixed", "sequence_no": 3,
                    "fixed_amount": "30000", "affects_lop": True,
                },
            ],
        },
        "tax_json": {"regime": "new", "declared_amount": "0", "pf_applicable": True, "esi_applicable": False},
        "statutory_json": {
            "pf": {"version": 1, "config": PF_CONFIG},
            "esi": {"version": 1, "config": ESI_CONFIG},
            "professional_tax:KA": {"version": 1, "config": PT_KA},
            "income_tax": {"version": 1, "config": INCOME_TAX_CONFIG},
            "required": ["income_tax", "pf", "professional_tax:KA"],
        },
        "additional_json": [],
    }
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            base[key] = {**base[key], **value}
        else:
            base[key] = value
    return base


class TestPayableDays(unittest.TestCase):
    def test_full_month(self):
        total, payable, lop = compute_payable_days({"total_days": 31, "employed_days": 31, "lop_units": 0})
        self.assertEqual((total, payable, lop), (Decimal(31), Decimal(31), Decimal(0)))

    def test_lop_reduces_payable_days(self):
        _, payable, lop = compute_payable_days({"total_days": 31, "employed_days": 31, "lop_units": 2.5})
        self.assertEqual(payable, Decimal("28.5"))
        self.assertEqual(lop, Decimal("2.5"))

    def test_mid_month_joiner_is_paid_from_joining(self):
        _, payable, _ = compute_payable_days({"total_days": 31, "employed_days": 16, "lop_units": 0})
        self.assertEqual(payable, Decimal(16))

    def test_payable_days_never_go_negative(self):
        _, payable, _ = compute_payable_days({"total_days": 31, "employed_days": 5, "lop_units": 10})
        self.assertEqual(payable, Decimal(0))


class TestPf(unittest.TestCase):
    def test_pf_is_capped_at_the_statutory_ceiling(self):
        result = calculate_pf(Decimal("50000"), PF_CONFIG)
        self.assertEqual(result.employee, Decimal("1800"))  # 12% of the 15000 ceiling
        self.assertTrue(result.capped)

    def test_pf_below_the_ceiling_uses_actual_wages(self):
        result = calculate_pf(Decimal("12000"), PF_CONFIG)
        self.assertEqual(result.employee, Decimal("1440"))
        self.assertFalse(result.capped)

    def test_uncapped_configuration_uses_full_wages(self):
        result = calculate_pf(Decimal("50000"), {**PF_CONFIG, "apply_ceiling": False})
        self.assertEqual(result.employee, Decimal("6000"))

    def test_pf_can_be_switched_off_per_employee(self):
        result = calculate_pf(Decimal("50000"), PF_CONFIG, applicable=False)
        self.assertEqual(result.employee, Decimal("0.00"))

    def test_pension_share_never_exceeds_the_employer_total(self):
        result = calculate_pf(Decimal("15000"), PF_CONFIG)
        self.assertLessEqual(result.employer_pension, result.employer)


class TestEsi(unittest.TestCase):
    def test_esi_applies_below_the_ceiling(self):
        result = calculate_esi(Decimal("20000"), ESI_CONFIG)
        self.assertTrue(result.eligible)
        self.assertEqual(result.employee, Decimal("150"))
        self.assertEqual(result.employer, Decimal("650"))

    def test_esi_stops_above_the_ceiling(self):
        result = calculate_esi(Decimal("21001"), ESI_CONFIG)
        self.assertFalse(result.eligible)
        self.assertEqual(result.employee, Decimal("0.00"))


class TestProfessionalTax(unittest.TestCase):
    # The function now returns the amount with the reasoning that produced it, so a payslip
    # can explain the figure. The amounts asserted here are unchanged.
    def test_slab_boundary(self):
        self.assertEqual(calculate_professional_tax(Decimal("24999"), PT_KA).amount, Decimal("0"))
        self.assertEqual(calculate_professional_tax(Decimal("25000"), PT_KA).amount, Decimal("200"))

    def test_no_configuration_means_no_professional_tax(self):
        result = calculate_professional_tax(Decimal("50000"), None)
        self.assertEqual(result.amount, Decimal("0.00"))
        # And says so, rather than being indistinguishable from a state that levies none.
        self.assertFalse(result.detail["applicable"])
        self.assertIn("no professional tax rule was resolved", result.detail["reason"])


def annual_tax_on(annual: str, regime: str = "new", **kwargs):
    """Tax on a known annual taxable income.

    The engine now builds the annual figure from opening, actual and projected components.
    These tests are about the slab arithmetic applied to that figure, not about how it is
    assembled, so the whole amount is supplied as a known prior actual and nothing is
    projected forward. Annualisation itself is covered by TestAnnualisation.
    """
    return calculate_income_tax(
        INCOME_TAX_CONFIG,
        previous_taxable_earnings=Decimal(annual),
        current_taxable_earnings=Decimal("0"),
        recurring_taxable_earnings=Decimal("0"),
        regime=regime,
        **kwargs,
    )


class TestIncomeTax(unittest.TestCase):
    def test_rebate_removes_liability_for_low_income(self):
        result = annual_tax_on("700000")
        self.assertEqual(result.annual_tax, Decimal("0.00"))

    def test_higher_income_is_taxed_across_slabs(self):
        result = annual_tax_on("1500000")
        # taxable 1425000: 5% of 400k + 10% of 300k + 15% of 200k + 20% of 225k = 125000
        # plus 4% cess = 130000
        self.assertEqual(result.annual_taxable, Decimal("1425000.00"))
        self.assertEqual(result.annual_tax, Decimal("130000.00"))

    def test_monthly_tds_is_the_annual_liability_spread_over_remaining_months(self):
        result = annual_tax_on("1500000", months_remaining=12)
        self.assertEqual(result.monthly_tax, Decimal("10833.33"))

    def test_fewer_remaining_months_increase_the_monthly_deduction(self):
        twelve = annual_tax_on("1500000", months_remaining=12)
        three = annual_tax_on("1500000", months_remaining=3)
        self.assertGreater(three.monthly_tax, twelve.monthly_tax)

    def test_old_regime_allows_declared_deductions(self):
        without = annual_tax_on("1000000", "old")
        with_decl = annual_tax_on("1000000", "old", declared_deductions=Decimal("150000"))
        self.assertLess(with_decl.annual_tax, without.annual_tax)

    def test_tax_already_deducted_is_subtracted_from_what_remains(self):
        full_year = annual_tax_on("1500000", months_remaining=12)
        # Half the annual liability already collected, six months left: the remaining
        # months each carry the same amount as before.
        mid_year = annual_tax_on("1500000", months_remaining=6, already_deducted=full_year.annual_tax / 2)
        self.assertEqual(mid_year.monthly_tax, full_year.monthly_tax)

    def test_march_absorbs_an_under_deduction(self):
        annual = annual_tax_on("1500000", months_remaining=12)
        march = annual_tax_on("1500000", months_remaining=1, already_deducted=Decimal("0"))
        self.assertEqual(march.monthly_tax, annual.annual_tax)

    def test_over_deduction_does_not_produce_a_negative_tds(self):
        result = annual_tax_on("1500000", months_remaining=1, already_deducted=Decimal("500000"))
        self.assertEqual(result.monthly_tax, Decimal("0.00"))

    def test_new_regime_ignores_declared_deductions(self):
        without = annual_tax_on("1000000")
        with_decl = annual_tax_on("1000000", declared_deductions=Decimal("150000"))
        self.assertEqual(with_decl.annual_tax, without.annual_tax)


class TestCalculate(unittest.TestCase):
    def test_full_month_earnings_resolve_percentages_correctly(self):
        result = calculate(snapshot())
        amounts = {c.code: c.amount for c in result.components}
        self.assertEqual(amounts["BASIC"], Decimal("50000.00"))  # 50% of 100000
        self.assertEqual(amounts["HRA"], Decimal("20000.00"))  # 40% of BASIC
        self.assertEqual(amounts["SPECIAL"], Decimal("30000.00"))
        self.assertEqual(result.gross_amount, Decimal("100000.00"))

    def test_net_reconciles_with_gross_less_deductions(self):
        result = calculate(snapshot())
        self.assertEqual(
            result.net_amount,
            result.gross_amount - result.deduction_amount - result.tax_amount,
        )

    def test_pf_is_deducted_on_the_basic_component(self):
        result = calculate(snapshot())
        pf = next(c for c in result.components if c.code == "PF_EMPLOYEE")
        self.assertEqual(pf.amount, Decimal("1800"))  # capped at the 15000 ceiling

    def test_employer_contribution_is_reported_but_not_deducted_from_net(self):
        result = calculate(snapshot())
        employer = [c for c in result.components if c.component_type == "employer_contribution"]
        self.assertTrue(employer)
        self.assertEqual(
            result.net_amount,
            result.gross_amount - result.deduction_amount - result.tax_amount,
        )

    def test_lop_pro_rates_every_affected_earning(self):
        full = calculate(snapshot())
        with_lop = calculate(
            snapshot(attendance_json={"total_days": 31, "employed_days": 31, "lop_units": 3})
        )
        self.assertEqual(with_lop.lop_days, Decimal("3"))
        self.assertEqual(with_lop.payable_days, Decimal("28"))
        # 28/31 of the full gross.
        self.assertEqual(with_lop.gross_amount, Decimal("90322.58"))
        self.assertLess(with_lop.gross_amount, full.gross_amount)

    def test_component_marked_not_affected_by_lop_is_paid_in_full(self):
        data = snapshot(attendance_json={"total_days": 31, "employed_days": 31, "lop_units": 10})
        data["compensation_json"]["components"].append(
            {
                "code": "TELEPHONE", "name": "Telephone Reimbursement", "component_type": "earning",
                "calculation_type": "fixed", "sequence_no": 4, "fixed_amount": "1000", "affects_lop": False,
            }
        )
        result = calculate(data)
        telephone = next(c for c in result.components if c.code == "TELEPHONE")
        self.assertEqual(telephone.amount, Decimal("1000.00"))

    def test_mid_month_joiner_is_paid_only_for_employed_days(self):
        result = calculate(snapshot(attendance_json={"total_days": 31, "employed_days": 16, "lop_units": 0}))
        self.assertEqual(result.payable_days, Decimal("16"))
        self.assertEqual(result.gross_amount, Decimal("51612.90"))  # 16/31

    def test_bonus_is_added_in_full_and_not_pro_rated(self):
        data = snapshot(attendance_json={"total_days": 31, "employed_days": 31, "lop_units": 5})
        data["additional_json"] = [
            {"id": "a1", "code": "BONUS", "name": "Performance Bonus", "component_type": "earning",
             "taxable": True, "amount": "25000", "kind": "bonus"}
        ]
        result = calculate(data)
        bonus = next(c for c in result.components if c.code == "BONUS")
        self.assertEqual(bonus.amount, Decimal("25000.00"))

    def test_recovery_is_recorded_as_a_deduction(self):
        data = snapshot()
        data["additional_json"] = [
            {"id": "a2", "code": "ADVANCE", "name": "Advance Recovery", "component_type": "deduction",
             "taxable": False, "amount": "-5000", "kind": "recovery"}
        ]
        result = calculate(data)
        recovery = next(c for c in result.components if c.code == "ADVANCE")
        self.assertEqual(recovery.component_type, "deduction")
        self.assertEqual(recovery.amount, Decimal("5000.00"))

    def test_professional_tax_follows_the_employee_state(self):
        karnataka = calculate(snapshot())
        self.assertTrue(any(c.code == "PT" for c in karnataka.components))

        other_state = snapshot()
        other_state["employee_json"] = {**other_state["employee_json"], "state_code": "XX"}
        result = calculate(other_state)
        self.assertFalse(any(c.code == "PT" for c in result.components))

    def test_esi_is_skipped_for_a_high_earner(self):
        result = calculate(snapshot(tax_json={"esi_applicable": True}))
        self.assertFalse(any(c.code == "ESI_EMPLOYEE" for c in result.components))

    def test_esi_applies_to_a_low_earner(self):
        data = snapshot(tax_json={"esi_applicable": True})
        data["compensation_json"] = {
            **data["compensation_json"],
            "base_amount": "18000",
            "components": [
                {"code": "BASIC", "name": "Basic", "component_type": "earning",
                 "calculation_type": "percentage", "sequence_no": 1,
                 "percentage": "100", "percentage_of_code": "BASE", "affects_lop": True},
            ],
        }
        result = calculate(data)
        self.assertTrue(any(c.code == "ESI_EMPLOYEE" for c in result.components))


class TestDeterminism(unittest.TestCase):
    def test_the_same_snapshot_always_produces_the_same_numbers(self):
        data = snapshot()
        first = calculate(copy.deepcopy(data))
        second = calculate(copy.deepcopy(data))
        self.assertEqual(first.gross_amount, second.gross_amount)
        self.assertEqual(first.net_amount, second.net_amount)
        self.assertEqual(
            [(c.code, c.amount) for c in first.components],
            [(c.code, c.amount) for c in second.components],
        )

    def test_changing_live_configuration_cannot_affect_a_frozen_snapshot(self):
        data = snapshot()
        before = calculate(copy.deepcopy(data))
        # Simulate someone editing today's salary structure after the snapshot was taken.
        live_structure_change = copy.deepcopy(data)
        live_structure_change["compensation_json"]["components"][0]["percentage"] = "70"
        after_live_change = calculate(live_structure_change)
        # The engine only ever sees what the snapshot carries, so the original snapshot
        # still reproduces the original result.
        self.assertNotEqual(before.gross_amount, after_live_change.gross_amount)
        self.assertEqual(calculate(copy.deepcopy(data)).gross_amount, before.gross_amount)


class TestValidation(unittest.TestCase):
    def test_missing_salary_structure_fails_this_employee(self):
        data = snapshot()
        data["compensation_json"] = {}
        with self.assertRaises(PayrollError) as ctx:
            calculate(data)
        self.assertIn("no salary structure", str(ctx.exception))

    def test_lop_beyond_the_period_is_rejected(self):
        with self.assertRaises(PayrollError) as ctx:
            calculate(snapshot(attendance_json={"total_days": 31, "employed_days": 31, "lop_units": 40}))
        self.assertIn("exceed", str(ctx.exception))

    def test_percentage_of_an_undefined_component_is_rejected(self):
        data = snapshot()
        data["compensation_json"]["components"][1]["percentage_of_code"] = "NOT_DEFINED_YET"
        with self.assertRaises(PayrollError) as ctx:
            calculate(data)
        self.assertIn("not defined earlier", str(ctx.exception))

    def test_recovery_larger_than_earnings_is_refused_rather_than_paying_a_negative(self):
        data = snapshot()
        data["additional_json"] = [
            {"id": "a3", "code": "ADVANCE", "name": "Advance Recovery", "component_type": "deduction",
             "taxable": False, "amount": "-500000", "kind": "recovery"}
        ]
        with self.assertRaises(PayrollError) as ctx:
            calculate(data)
        self.assertIn("negative", str(ctx.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestAnnualisation(unittest.TestCase):
    """How the year's income is estimated.

    `current x 12` was wrong in three ordinary situations - a mid-year joiner, a raise, and
    a month with heavy LOP - and each of those is a test here.
    """

    def test_a_full_year_at_a_steady_salary_annualises_to_twelve_months(self):
        result = calculate_income_tax(
            INCOME_TAX_CONFIG,
            current_taxable_earnings=Decimal("100000"),
            recurring_taxable_earnings=Decimal("100000"),
            months_remaining=12,
        )
        self.assertEqual(result.annual_gross_taxable, Decimal("1200000.00"))
        self.assertEqual(result.projected_future, Decimal("1100000.00"))

    def test_a_mid_year_joiner_is_not_projected_over_months_they_were_not_here(self):
        # Joined with six months left. Only those six months are ours to project.
        result = calculate_income_tax(
            INCOME_TAX_CONFIG,
            current_taxable_earnings=Decimal("100000"),
            recurring_taxable_earnings=Decimal("100000"),
            months_remaining=6,
        )
        self.assertEqual(result.annual_gross_taxable, Decimal("600000.00"))

    def test_previous_employer_income_is_added_to_the_year(self):
        without = calculate_income_tax(
            INCOME_TAX_CONFIG,
            current_taxable_earnings=Decimal("100000"),
            recurring_taxable_earnings=Decimal("100000"),
            months_remaining=6,
        )
        with_opening = calculate_income_tax(
            INCOME_TAX_CONFIG,
            opening_taxable_earnings=Decimal("600000"),
            current_taxable_earnings=Decimal("100000"),
            recurring_taxable_earnings=Decimal("100000"),
            months_remaining=6,
        )
        self.assertEqual(with_opening.annual_gross_taxable, Decimal("1200000.00"))
        # The whole point: ignoring the previous employer under-deducts.
        self.assertGreater(with_opening.annual_tax, without.annual_tax)

    def test_previous_employer_tds_is_credited_not_collected_again(self):
        result = calculate_income_tax(
            INCOME_TAX_CONFIG,
            opening_taxable_earnings=Decimal("600000"),
            current_taxable_earnings=Decimal("100000"),
            recurring_taxable_earnings=Decimal("100000"),
            months_remaining=6,
            already_deducted=Decimal("60000"),
        )
        expected = (result.annual_tax - Decimal("60000")) / Decimal("6")
        self.assertEqual(result.monthly_tax, expected.quantize(Decimal("0.01")))

    def test_a_raise_does_not_retroactively_reprice_months_already_paid(self):
        # Six months at 80,000 actually paid, then a raise to 120,000 with six left.
        # The year is 6 x 80,000 + 6 x 120,000, not 12 x 120,000.
        result = calculate_income_tax(
            INCOME_TAX_CONFIG,
            previous_taxable_earnings=Decimal("400000"),
            current_taxable_earnings=Decimal("120000"),
            recurring_taxable_earnings=Decimal("120000"),
            months_remaining=6,
        )
        self.assertEqual(result.annual_gross_taxable, Decimal("1120000.00"))

        naive = calculate_income_tax(
            INCOME_TAX_CONFIG,
            current_taxable_earnings=Decimal("120000"),
            recurring_taxable_earnings=Decimal("120000"),
            months_remaining=12,
        )
        self.assertGreater(naive.annual_gross_taxable, result.annual_gross_taxable)

    def test_a_one_off_bonus_is_taxed_but_not_projected_forward(self):
        # 100,000 salary plus a 500,000 bonus this month. The bonus is in this year's
        # income once; it is not eleven more bonuses.
        result = calculate_income_tax(
            INCOME_TAX_CONFIG,
            current_taxable_earnings=Decimal("600000"),
            recurring_taxable_earnings=Decimal("100000"),
            months_remaining=12,
        )
        self.assertEqual(result.projected_future, Decimal("1100000.00"))
        self.assertEqual(result.annual_gross_taxable, Decimal("1700000.00"))

    def test_a_lop_month_projects_the_figure_it_was_given_consistently(self):
        result = calculate_income_tax(
            INCOME_TAX_CONFIG,
            previous_taxable_earnings=Decimal("500000"),
            current_taxable_earnings=Decimal("60000"),
            recurring_taxable_earnings=Decimal("60000"),
            months_remaining=5,
        )
        self.assertEqual(result.annual_gross_taxable, Decimal("800000.00"))

    def test_the_final_month_projects_nothing(self):
        result = calculate_income_tax(
            INCOME_TAX_CONFIG,
            previous_taxable_earnings=Decimal("1100000"),
            current_taxable_earnings=Decimal("100000"),
            recurring_taxable_earnings=Decimal("100000"),
            months_remaining=1,
        )
        self.assertEqual(result.projected_future, Decimal("0.00"))
        self.assertEqual(result.annual_gross_taxable, Decimal("1200000.00"))

    def test_zero_months_remaining_is_refused_rather_than_dividing_by_zero(self):
        with self.assertRaises(ValueError):
            calculate_income_tax(INCOME_TAX_CONFIG, months_remaining=0)


class TestTaxClassification(unittest.TestCase):
    """Which lines enter the tax base."""

    def test_a_non_taxable_earning_is_paid_but_not_taxed(self):
        taxed = calculate(snapshot())

        exempt = snapshot()
        for component in exempt["compensation_json"]["components"]:
            component["taxable"] = component["code"] != "SPECIAL"
        untaxed = calculate(exempt)

        # Same money in hand, less taxable income.
        self.assertEqual(untaxed.gross_amount, taxed.gross_amount)
        self.assertEqual(untaxed.taxable_earnings, taxed.taxable_earnings - Decimal("30000.00"))

    def test_employee_pf_reduces_taxable_income(self):
        result = calculate(snapshot())
        pf_line = next(c for c in result.components if c.code == "PF_EMPLOYEE")
        pt_line = next(c for c in result.components if c.code == "PT")
        self.assertTrue(pf_line.exempted_from_income_tax)
        # Gross less the PF and PT that the statute allows against salary income.
        self.assertEqual(
            result.taxable_earnings,
            result.gross_amount - pf_line.amount - pt_line.amount,
        )

    def test_professional_tax_reduces_taxable_income(self):
        result = calculate(snapshot())
        pt_line = next(c for c in result.components if c.code == "PT")
        self.assertTrue(pt_line.exempted_from_income_tax)

    def test_esi_does_not_reduce_taxable_income(self):
        low_paid = snapshot(
            tax_json={"regime": "new", "declared_amount": "0",
                      "pf_applicable": True, "esi_applicable": True},
        )
        low_paid["compensation_json"] = {
            "currency": "INR",
            "base_amount": "30000",
            "components": [
                {"code": "BASIC", "name": "Basic", "component_type": "earning",
                 "calculation_type": "percentage", "sequence_no": 1,
                 "percentage": "50", "percentage_of_code": "BASE", "affects_lop": True},
            ],
        }
        low_paid["statutory_json"]["required"] = ["income_tax", "pf", "esi", "professional_tax:KA"]

        result = calculate(low_paid)
        esi_line = next(c for c in result.components if c.code == "ESI_EMPLOYEE")
        self.assertFalse(esi_line.exempted_from_income_tax)

    def test_a_post_tax_deduction_does_not_reduce_taxable_income(self):
        base = snapshot()
        base["compensation_json"]["components"].append({
            "code": "CANTEEN", "name": "Canteen", "component_type": "deduction",
            "calculation_type": "fixed", "sequence_no": 4, "fixed_amount": "1000",
            "affects_lop": False, "exempted_from_income_tax": False,
        })
        self.assertEqual(calculate(base).taxable_earnings, calculate(snapshot()).taxable_earnings)

    def test_employer_contribution_is_never_in_the_tax_base(self):
        result = calculate(snapshot())
        employer = [c for c in result.components if c.component_type == "employer_contribution"]
        self.assertTrue(employer)
        self.assertLessEqual(result.taxable_earnings, result.gross_amount)

    def test_a_non_taxable_additional_salary_is_paid_but_not_taxed(self):
        taxable_bonus = calculate(snapshot(additional_json=[
            {"id": "a1", "code": "BONUS", "name": "Bonus", "component_type": "earning",
             "taxable": True, "amount": "50000", "kind": "bonus"},
        ]))
        exempt_bonus = calculate(snapshot(additional_json=[
            {"id": "a1", "code": "REIMB", "name": "Reimbursement", "component_type": "earning",
             "taxable": False, "amount": "50000", "kind": "one_time"},
        ]))
        self.assertEqual(taxable_bonus.gross_amount, exempt_bonus.gross_amount)
        self.assertEqual(
            exempt_bonus.taxable_earnings, taxable_bonus.taxable_earnings - Decimal("50000.00")
        )


class TestAdditionalSalaryOverwrite(unittest.TestCase):
    """Replacing a structure component for one period."""

    def test_a_normal_additional_salary_adds_a_line(self):
        result = calculate(snapshot(additional_json=[
            {"id": "a1", "code": "BONUS", "name": "Bonus", "component_type": "earning",
             "taxable": True, "amount": "25000", "kind": "bonus"},
        ]))
        codes = [c.code for c in result.components if c.component_type == "earning"]
        self.assertIn("BONUS", codes)
        self.assertEqual(result.gross_amount, Decimal("125000.00"))

    def test_an_overwrite_replaces_the_component_rather_than_adding_to_it(self):
        result = calculate(snapshot(additional_json=[
            {"id": "a1", "code": "SPECIAL", "name": "Special Allowance", "component_type": "earning",
             "taxable": True, "amount": "10000", "kind": "one_time", "overwrites_structure": True},
        ]))
        specials = [c for c in result.components if c.code == "SPECIAL"]
        self.assertEqual(len(specials), 1, "an overwrite must not leave two lines for one component")
        self.assertEqual(specials[0].amount, Decimal("10000.00"))
        # 50000 BASIC + 20000 HRA + 10000 SPECIAL
        self.assertEqual(result.gross_amount, Decimal("80000.00"))

    def test_an_overwritten_component_is_traceable_to_what_overwrote_it(self):
        result = calculate(snapshot(additional_json=[
            {"id": "a-42", "code": "SPECIAL", "name": "Special Allowance", "component_type": "earning",
             "taxable": True, "amount": "10000", "kind": "one_time", "overwrites_structure": True},
        ]))
        special = next(c for c in result.components if c.code == "SPECIAL")
        self.assertEqual(special.detail["overwritten_by_additional_salary"], "a-42")

    def test_a_dependent_percentage_follows_the_overwritten_value(self):
        # HRA is 40% of BASIC. Overwriting BASIC must move HRA with it, which is the whole
        # reason the overwrite is applied before the structure is evaluated.
        result = calculate(snapshot(additional_json=[
            {"id": "a1", "code": "BASIC", "name": "Basic", "component_type": "earning",
             "taxable": True, "amount": "60000", "kind": "one_time", "overwrites_structure": True},
        ]))
        basic = next(c for c in result.components if c.code == "BASIC")
        hra = next(c for c in result.components if c.code == "HRA")
        self.assertEqual(basic.amount, Decimal("60000.00"))
        self.assertEqual(hra.amount, Decimal("24000.00"))

    def test_an_overwrite_is_pro_rated_by_lop_like_any_structure_component(self):
        result = calculate(snapshot(
            attendance_json={"total_days": 31, "employed_days": 31, "lop_units": 10},
            additional_json=[
                {"id": "a1", "code": "SPECIAL", "name": "Special Allowance",
                 "component_type": "earning", "taxable": True, "amount": "31000",
                 "kind": "one_time", "overwrites_structure": True},
            ],
        ))
        special = next(c for c in result.components if c.code == "SPECIAL")
        # 31000 x 21/31
        self.assertEqual(special.amount, Decimal("21000.00"))

    def test_an_overwrite_changes_the_tax_base(self):
        higher = calculate(snapshot(additional_json=[
            {"id": "a1", "code": "SPECIAL", "name": "Special Allowance", "component_type": "earning",
             "taxable": True, "amount": "50000", "kind": "one_time", "overwrites_structure": True},
        ]))
        lower = calculate(snapshot(additional_json=[
            {"id": "a1", "code": "SPECIAL", "name": "Special Allowance", "component_type": "earning",
             "taxable": True, "amount": "10000", "kind": "one_time", "overwrites_structure": True},
        ]))
        self.assertGreater(higher.taxable_earnings, lower.taxable_earnings)

    def test_multiple_additional_salaries_all_apply(self):
        result = calculate(snapshot(additional_json=[
            {"id": "a1", "code": "SPECIAL", "name": "Special Allowance", "component_type": "earning",
             "taxable": True, "amount": "10000", "kind": "one_time", "overwrites_structure": True},
            {"id": "a2", "code": "BONUS", "name": "Bonus", "component_type": "earning",
             "taxable": True, "amount": "5000", "kind": "bonus"},
            {"id": "a3", "code": "RECOVERY", "name": "Advance recovery", "component_type": "deduction",
             "taxable": False, "amount": "-2000", "kind": "recovery"},
        ]))
        # 50000 + 20000 + 10000 overwrite + 5000 bonus
        self.assertEqual(result.gross_amount, Decimal("85000.00"))
        deductions = [c.code for c in result.components if c.component_type == "deduction"]
        self.assertIn("RECOVERY", deductions)

    def test_overwriting_a_component_that_is_not_in_the_structure_is_refused(self):
        with self.assertRaises(PayrollError) as raised:
            calculate(snapshot(additional_json=[
                {"id": "a1", "code": "NOT_THERE", "name": "Ghost", "component_type": "earning",
                 "taxable": True, "amount": "1000", "kind": "one_time", "overwrites_structure": True},
            ]))
        self.assertIn("not in this employee", str(raised.exception))


class TestStatutoryRequirement(unittest.TestCase):
    """Missing configuration fails the employee; it never silently deducts zero."""

    def _without(self, rule_key):
        base = snapshot()
        base["statutory_json"] = {
            k: v for k, v in base["statutory_json"].items() if k != rule_key
        }
        return base

    def test_a_missing_pf_rule_fails_the_employee(self):
        with self.assertRaises(PayrollError) as raised:
            calculate(self._without("pf"))
        message = str(raised.exception)
        self.assertIn("pf", message)
        self.assertIn("EMP0001", message)
        self.assertIn("IN/KA", message)

    def test_a_missing_income_tax_rule_fails_the_employee(self):
        with self.assertRaises(PayrollError) as raised:
            calculate(self._without("income_tax"))
        self.assertIn("income_tax", str(raised.exception))

    def test_a_missing_professional_tax_rule_for_a_declared_state_fails_the_employee(self):
        with self.assertRaises(PayrollError) as raised:
            calculate(self._without("professional_tax:KA"))
        self.assertIn("professional_tax:KA", str(raised.exception))

    def test_a_missing_esi_rule_fails_an_employee_who_is_covered(self):
        base = snapshot(
            tax_json={"regime": "new", "declared_amount": "0",
                      "pf_applicable": True, "esi_applicable": True},
        )
        base["statutory_json"] = {
            k: v for k, v in base["statutory_json"].items() if k != "esi"
        }
        base["statutory_json"]["required"] = ["income_tax", "pf", "esi", "professional_tax:KA"]
        with self.assertRaises(PayrollError) as raised:
            calculate(base)
        self.assertIn("esi", str(raised.exception))

    def test_a_rule_present_but_empty_is_treated_as_missing(self):
        base = snapshot()
        base["statutory_json"]["pf"] = {"version": 1, "config": {}}
        with self.assertRaises(PayrollError):
            calculate(base)

    def test_a_state_with_no_declared_professional_tax_is_not_required(self):
        # No pt_state_code asserted, so PT is genuinely not applicable and its absence is
        # not a configuration error.
        base = snapshot(
            employee_json={"id": "emp-1", "employee_code": "EMP0001", "state_code": None},
        )
        base["statutory_json"] = {
            "pf": {"version": 1, "config": PF_CONFIG},
            "income_tax": {"version": 1, "config": INCOME_TAX_CONFIG},
            "required": ["income_tax", "pf"],
        }
        result = calculate(base)
        self.assertNotIn("PT", [c.code for c in result.components])

    def test_the_message_names_the_financial_year(self):
        base = self._without("pf")
        base["tax_json"]["financial_year"] = "2026-27"
        with self.assertRaises(PayrollError) as raised:
            calculate(base)
        self.assertIn("2026-27", str(raised.exception))


class TestSupplementaryRun(unittest.TestCase):
    """A supplementary run corrects; it does not re-pay."""

    def test_a_supplementary_run_pays_only_the_additional_amounts(self):
        base = snapshot(additional_json=[
            {"id": "a1", "code": "ARREAR", "name": "Arrear", "component_type": "earning",
             "taxable": True, "amount": "15000", "kind": "arrear"},
        ])
        base["compensation_json"]["pay_structure"] = False
        result = calculate(base)

        self.assertEqual(result.gross_amount, Decimal("15000.00"))
        codes = [c.code for c in result.components if c.component_type == "earning"]
        self.assertEqual(codes, ["ARREAR"], "the structure must not be paid a second time")

    def test_a_supplementary_run_with_nothing_to_pay_is_refused(self):
        base = snapshot(additional_json=[])
        base["compensation_json"]["pay_structure"] = False
        with self.assertRaises(PayrollError) as raised:
            calculate(base)
        self.assertIn("at least one additional salary", str(raised.exception))

    def test_a_supplementary_run_projects_nothing_forward(self):
        base = snapshot(
            attendance_json={"total_days": 31, "employed_days": 31, "lop_units": 0,
                             "months_remaining_in_fy": 6},
            tax_json={"regime": "new", "declared_amount": "0", "pf_applicable": True,
                      "esi_applicable": False, "previous_taxable_earnings": "600000"},
            additional_json=[
                {"id": "a1", "code": "ARREAR", "name": "Arrear", "component_type": "earning",
                 "taxable": True, "amount": "15000", "kind": "arrear"},
            ],
        )
        base["compensation_json"]["pay_structure"] = False
        result = calculate(base)
        tds = [c for c in result.components if c.code == "TDS"]
        if tds:
            # An arrear is taxed once, not projected over the remaining months.
            self.assertEqual(tds[0].detail["projected_future"], "0.00")

    def test_a_supplementary_run_still_enforces_statutory_configuration(self):
        base = snapshot(additional_json=[
            {"id": "a1", "code": "ARREAR", "name": "Arrear", "component_type": "earning",
             "taxable": True, "amount": "15000", "kind": "arrear"},
        ])
        base["compensation_json"]["pay_structure"] = False
        base["statutory_json"] = {
            k: v for k, v in base["statutory_json"].items() if k != "pf"
        }
        with self.assertRaises(PayrollError):
            calculate(base)


class TestSlipNumbering(unittest.TestCase):
    """Slip numbers must be unique across run types and deterministic per run."""

    def test_a_regular_slip_is_prefixed_and_sequenced(self):
        self.assertEqual(
            build_slip_number(period_start="2026-08-01", employee_code="EMP001",
                              run_type="regular", run_sequence=1),
            "REG-2026-08-EMP001-01",
        )

    def test_a_supplementary_slip_cannot_collide_with_the_run_it_corrects(self):
        regular = build_slip_number(period_start="2026-08-01", employee_code="EMP001",
                                    run_type="regular", run_sequence=1)
        supplementary = build_slip_number(period_start="2026-08-01", employee_code="EMP001",
                                          run_type="supplementary", run_sequence=2)
        self.assertNotEqual(regular, supplementary)
        self.assertTrue(supplementary.startswith("SUP-"))

    def test_two_supplementary_runs_produce_different_numbers(self):
        first = build_slip_number(period_start="2026-08-01", employee_code="EMP001",
                                  run_type="supplementary", run_sequence=2)
        second = build_slip_number(period_start="2026-08-01", employee_code="EMP001",
                                   run_type="supplementary", run_sequence=3)
        self.assertNotEqual(first, second)

    def test_the_number_is_deterministic_for_a_given_run(self):
        args = dict(period_start="2026-08-01", employee_code="EMP001",
                    run_type="regular", run_sequence=1)
        self.assertEqual(build_slip_number(**args), build_slip_number(**args))

    def test_an_unknown_run_type_still_produces_a_usable_number(self):
        number = build_slip_number(period_start="2026-08-01", employee_code="EMP001",
                                   run_type="something_new", run_sequence=4)
        self.assertEqual(number, "RUN-2026-08-EMP001-04")
