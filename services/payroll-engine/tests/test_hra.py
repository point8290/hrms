"""HRA exemption under section 10(13A).

Three things are being pinned down, and the third is the one the phase is really about.

  1. The least-of-three arithmetic, at its boundaries, in Decimal.
  2. That an exemption can never be negative and never exceed the allowance received.
  3. That the *year* is the sum of its periods — each evaluated on the basic, allowance and
     rent that actually apply to it — and never one period multiplied by twelve. A promotion
     in July, a move in October, a lease that ends in December and a leaver in November all
     produce different answers under the two readings, and the naive one under-deducts.
"""

from __future__ import annotations

import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.calculation import PayrollError, calculate  # noqa: E402
from app.hra import (  # noqa: E402
    METRO,
    NON_METRO,
    HraError,
    calculate_period_exemption,
    regime_allows_hra,
    resolve_role_amounts,
)
from app.statutory import calculate_income_tax  # noqa: E402

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


def exemption(actual_hra, basic, rent, metro=NON_METRO, config=None):
    return calculate_period_exemption(
        actual_hra=Decimal(str(actual_hra)),
        basic=Decimal(str(basic)),
        rent_paid=Decimal(str(rent)),
        metro_classification=metro,
        config=config or {},
    )


# ---------------------------------------------------------------------------


class LeastOfThree(unittest.TestCase):
    def test_the_worked_example_from_the_specification(self):
        # Basic 50,000 / HRA 20,000 / rent 25,000 / metro.
        #   A actual HRA        20,000
        #   B 25,000 - 5,000    20,000
        #   C 50% of 50,000     25,000
        result = exemption(20000, 50000, 25000, METRO)
        self.assertEqual(result.actual_hra_limit, Decimal("20000.00"))
        self.assertEqual(result.rent_minus_ten_percent_basic, Decimal("20000.00"))
        self.assertEqual(result.salary_limit, Decimal("25000.00"))
        self.assertEqual(result.period_hra_exemption, Decimal("20000.00"))

    def test_insufficient_rent_yields_zero_not_a_negative_exemption(self):
        # Rent 4,000 against 10% of basic = 5,000, so limit B is -1,000. Exempting a negative
        # amount would *increase* taxable income, which is the wrong direction and absurd.
        result = exemption(20000, 50000, 4000)
        self.assertEqual(result.rent_minus_ten_percent_basic, Decimal("-1000.00"))
        self.assertEqual(result.period_hra_exemption, Decimal("0.00"))

    def test_metro_uses_fifty_percent_of_basic(self):
        # Rent is generous, so limit C binds and the classification decides the answer.
        result = exemption(40000, 50000, 90000, METRO)
        self.assertEqual(result.salary_limit, Decimal("25000.00"))
        self.assertEqual(result.period_hra_exemption, Decimal("25000.00"))

    def test_non_metro_uses_forty_percent_of_basic(self):
        result = exemption(40000, 50000, 90000, NON_METRO)
        self.assertEqual(result.salary_limit, Decimal("20000.00"))
        self.assertEqual(result.period_hra_exemption, Decimal("20000.00"))

    def test_exemption_never_exceeds_the_allowance_actually_received(self):
        # Enormous rent, generous basic — and still only 8,000 of allowance to exempt. There
        # is nothing else to exempt; the rest of the rent is paid out of taxed income.
        result = exemption(8000, 100000, 500000, METRO)
        self.assertEqual(result.period_hra_exemption, Decimal("8000.00"))
        self.assertEqual(result.period_hra_exemption, result.actual_hra)

    def test_records_which_limit_bound_by_recording_all_three(self):
        result = exemption(20000, 50000, 25000, METRO)
        detail = result.as_detail()
        for key in (
            "actual_hra", "basic", "rent_paid", "ten_percent_basic",
            "rent_minus_ten_percent_basic", "metro_classification", "salary_percentage",
            "salary_limit", "actual_hra_limit", "period_hra_exemption",
        ):
            self.assertIn(key, detail, key)

    def test_rates_are_configurable_per_rule_version(self):
        # Another jurisdiction, or a change to rule 2A, is a rule version rather than a code
        # change. The defaults come from the statute so a tenant who supplies nothing is
        # still legally correct.
        result = exemption(
            40000, 50000, 90000, METRO,
            config={"hra_exemption": {"metro_percent": "60", "basic_percent": "5"}},
        )
        self.assertEqual(result.salary_limit, Decimal("30000.00"))
        self.assertEqual(result.ten_percent_basic, Decimal("2500.00"))


class Boundaries(unittest.TestCase):
    def test_rent_exactly_ten_percent_of_basic(self):
        result = exemption(20000, 50000, 5000)
        self.assertEqual(result.rent_minus_ten_percent_basic, Decimal("0.00"))
        self.assertEqual(result.period_hra_exemption, Decimal("0.00"))

    def test_one_rupee_below_ten_percent_of_basic(self):
        result = exemption(20000, 50000, 4999)
        self.assertEqual(result.rent_minus_ten_percent_basic, Decimal("-1.00"))
        self.assertEqual(result.period_hra_exemption, Decimal("0.00"))

    def test_one_rupee_above_ten_percent_of_basic(self):
        result = exemption(20000, 50000, 5001)
        self.assertEqual(result.rent_minus_ten_percent_basic, Decimal("1.00"))
        self.assertEqual(result.period_hra_exemption, Decimal("1.00"))

    def test_exactly_the_metro_limit(self):
        # Rent chosen so limit B lands exactly on 50% of basic.
        result = exemption(30000, 50000, 30000, METRO)
        self.assertEqual(result.salary_limit, Decimal("25000.00"))
        self.assertEqual(result.rent_minus_ten_percent_basic, Decimal("25000.00"))
        self.assertEqual(result.period_hra_exemption, Decimal("25000.00"))

    def test_exactly_the_non_metro_limit(self):
        result = exemption(30000, 50000, 25000, NON_METRO)
        self.assertEqual(result.salary_limit, Decimal("20000.00"))
        self.assertEqual(result.rent_minus_ten_percent_basic, Decimal("20000.00"))
        self.assertEqual(result.period_hra_exemption, Decimal("20000.00"))

    def test_hra_exactly_equal_to_the_exemption(self):
        result = exemption(15000, 50000, 25000, METRO)
        self.assertEqual(result.period_hra_exemption, Decimal("15000.00"))

    def test_hra_below_every_other_limit(self):
        result = exemption(1000, 50000, 40000, METRO)
        self.assertEqual(result.period_hra_exemption, Decimal("1000.00"))

    def test_zero_hra(self):
        result = exemption(0, 50000, 25000, METRO)
        self.assertEqual(result.period_hra_exemption, Decimal("0.00"))
        self.assertIn("no house rent allowance", result.reason)

    def test_zero_rent(self):
        result = exemption(20000, 50000, 0, METRO)
        self.assertEqual(result.period_hra_exemption, Decimal("0.00"))
        self.assertIn("does not exceed 10% of basic", result.reason)

    def test_zero_basic(self):
        # A full-LOP month. Both the rent limit and the salary limit collapse to nothing,
        # and no allowance was paid either.
        result = exemption(0, 0, 25000, METRO)
        self.assertEqual(result.salary_limit, Decimal("0.00"))
        self.assertEqual(result.period_hra_exemption, Decimal("0.00"))

    def test_zero_everything(self):
        self.assertEqual(exemption(0, 0, 0).period_hra_exemption, Decimal("0.00"))

    def test_negative_inputs_are_clamped_rather_than_propagated(self):
        result = exemption(-5000, -1000, -200, METRO)
        self.assertEqual(result.period_hra_exemption, Decimal("0.00"))

    def test_arithmetic_is_decimal_throughout(self):
        # A third of a rupee, repeated, is exactly where binary floating point drifts.
        result = exemption("16666.67", "41666.67", "20833.33", METRO)
        for value in (
            result.actual_hra, result.basic, result.rent_paid, result.ten_percent_basic,
            result.rent_minus_ten_percent_basic, result.salary_limit,
            result.period_hra_exemption,
        ):
            self.assertIsInstance(value, Decimal)
        self.assertEqual(result.ten_percent_basic, Decimal("4166.67"))
        self.assertEqual(result.period_hra_exemption, Decimal("16666.66"))

    def test_rounding_is_half_up_at_the_paisa(self):
        # 10% of 12,345.55 is 1,234.555, which rounds up rather than to even.
        result = exemption(50000, "12345.55", 50000)
        self.assertEqual(result.ten_percent_basic, Decimal("1234.56"))


class Regime(unittest.TestCase):
    def test_the_old_regime_allows_the_exemption(self):
        self.assertTrue(regime_allows_hra(INCOME_TAX_CONFIG, "old"))

    def test_the_new_regime_does_not(self):
        # Section 115BAC gives up 10(13A) for lower slabs. Exempting here would exempt
        # income that is fully taxable, for every employee on the regime.
        self.assertFalse(regime_allows_hra(INCOME_TAX_CONFIG, "new"))

    def test_a_rule_version_may_say_otherwise(self):
        config = {"regimes": {"new": {"allows_hra_exemption": True}}}
        self.assertTrue(regime_allows_hra(config, "new"))

    def test_an_unknown_regime_does_not_exempt(self):
        self.assertFalse(regime_allows_hra(INCOME_TAX_CONFIG, "something-else"))


class RoleIdentification(unittest.TestCase):
    """Basic and HRA are found by role, never by code or display name."""

    class Line:
        def __init__(self, code, amount):
            self.code = code
            self.amount = Decimal(str(amount))

    def test_finds_components_whatever_they_are_called(self):
        components = [
            {"code": "SALARY_CORE", "semantic_role": "basic"},
            {"code": "ACCOM_ALLOW", "semantic_role": "house_rent_allowance"},
            {"code": "HRA", "semantic_role": None},
        ]
        lines = [self.Line("SALARY_CORE", 50000), self.Line("ACCOM_ALLOW", 20000),
                 self.Line("HRA", 99999)]
        basic, hra = resolve_role_amounts(lines, components)
        # Not the component that happens to be *called* HRA.
        self.assertEqual(basic, Decimal("50000"))
        self.assertEqual(hra, Decimal("20000"))

    def test_missing_roles_give_zero_rather_than_a_guess(self):
        basic, hra = resolve_role_amounts(
            [self.Line("BASIC", 50000)], [{"code": "BASIC", "semantic_role": None}]
        )
        self.assertEqual(basic, Decimal("0"))
        self.assertEqual(hra, Decimal("0"))

    def test_two_components_claiming_one_role_is_refused(self):
        with self.assertRaises(HraError) as caught:
            resolve_role_amounts(
                [self.Line("B1", 1), self.Line("B2", 2)],
                [{"code": "B1", "semantic_role": "basic"},
                 {"code": "B2", "semantic_role": "basic"}],
            )
        self.assertIn("B1", str(caught.exception))
        self.assertIn("B2", str(caught.exception))


class ProjectedExemption(unittest.TestCase):
    """The tax-year term, which is handed over as a total rather than multiplied here."""

    def test_the_projection_reduces_the_annual_estimate(self):
        without = calculate_income_tax(
            INCOME_TAX_CONFIG, current_taxable_earnings=Decimal("100000"),
            recurring_taxable_earnings=Decimal("100000"), months_remaining=12, regime="old",
        )
        with_relief = calculate_income_tax(
            INCOME_TAX_CONFIG, current_taxable_earnings=Decimal("100000"),
            recurring_taxable_earnings=Decimal("100000"),
            projected_exemption=Decimal("110000"), months_remaining=12, regime="old",
        )
        self.assertEqual(
            without.annual_gross_taxable - with_relief.annual_gross_taxable,
            Decimal("110000.00"),
        )

    def test_a_projection_larger_than_future_income_floors_at_zero(self):
        # Cannot make the rest of the year owe negative income.
        result = calculate_income_tax(
            INCOME_TAX_CONFIG, current_taxable_earnings=Decimal("50000"),
            recurring_taxable_earnings=Decimal("50000"),
            projected_exemption=Decimal("10000000"), months_remaining=12, regime="old",
        )
        self.assertEqual(result.projected_future, Decimal("0"))
        self.assertEqual(result.annual_gross_taxable, Decimal("50000.00"))

    def test_no_projection_in_the_final_period(self):
        # March: nothing is still scheduled, so nothing is projected and no exemption with it.
        result = calculate_income_tax(
            INCOME_TAX_CONFIG, current_taxable_earnings=Decimal("100000"),
            recurring_taxable_earnings=Decimal("100000"),
            projected_exemption=Decimal("20000"), months_remaining=1, regime="old",
        )
        self.assertEqual(result.projected_future, Decimal("0"))


# ---------------------------------------------------------------------------
# End to end through calculate(), which is where the period and the year meet.
# ---------------------------------------------------------------------------


def structure(basic_pct="50", hra_pct="40"):
    return [
        {"code": "BASIC", "name": "Basic", "component_type": "earning",
         "calculation_type": "percentage", "percentage": basic_pct, "percentage_of_code": "BASE",
         "semantic_role": "basic", "taxable": True, "affects_lop": True, "sequence_no": 1},
        {"code": "HRA", "name": "House Rent Allowance", "component_type": "earning",
         "calculation_type": "percentage", "percentage": hra_pct, "percentage_of_code": "BASIC",
         "semantic_role": "house_rent_allowance", "taxable": True, "affects_lop": True,
         "sequence_no": 2},
    ]


def snapshot(*, base="100000", rent="25000", metro="metro", regime="old", projection=None,
             lop="0", total_days="30", employed_days=None, applicable=True,
             months_remaining=12, components=None, **tax):
    return {
        "employee_json": {"id": "emp-1", "employee_code": "E1", "state_code": None},
        "attendance_json": {
            "total_days": total_days,
            "employed_days": employed_days if employed_days is not None else total_days,
            "lop_units": lop,
            "months_remaining_in_fy": months_remaining,
        },
        "leave_json": {},
        "compensation_json": {
            "base_amount": base,
            "currency": "INR",
            "components": components if components is not None else structure(),
        },
        "tax_json": {
            "regime": regime,
            "declared_amount": "0",
            # Off on purpose. PF and ESI have their own suites; leaving them on would make
            # every figure below depend on two statutory rules instead of the one under test.
            "pf_applicable": False,
            "esi_applicable": False,
            **tax,
        },
        "statutory_json": {
            "required": ["income_tax"],
            "income_tax": {"version": 1, "config": INCOME_TAX_CONFIG},
        },
        "additional_json": [],
        "hra_json": {
            "applicable": applicable,
            "rent_amount": rent,
            "metro_classification": metro,
            "projection": projection if projection is not None else [],
        },
    }


def hra_line(result):
    return next((c for c in result.components if c.code == "HRA_EXEMPTION"), None)


class ThroughTheEngine(unittest.TestCase):
    def test_the_exemption_reduces_taxable_income_and_nothing_else(self):
        # Basic 50,000, HRA 20,000, rent 25,000, metro -> exemption 20,000.
        result = calculate(snapshot())

        self.assertEqual(result.hra_exemption, Decimal("20000.00"))
        # Gross is untouched: the allowance was received and paid.
        self.assertEqual(result.gross_amount, Decimal("70000.00"))
        self.assertEqual(result.taxable_earnings, Decimal("50000.00"))
        # And it is not a deduction: net pay is unchanged by it.
        self.assertEqual(
            result.net_amount,
            result.gross_amount - result.deduction_amount - result.tax_amount,
        )

    def test_the_exemption_line_is_informational_and_moves_no_money(self):
        result = calculate(snapshot())
        line = hra_line(result)
        self.assertIsNotNone(line)
        self.assertEqual(line.component_type, "exemption")
        self.assertEqual(line.amount, Decimal("20000.00"))

        earnings = sum((c.amount for c in result.components if c.component_type == "earning"),
                       Decimal("0"))
        deductions = sum((c.amount for c in result.components if c.component_type == "deduction"),
                         Decimal("0"))
        self.assertEqual(earnings, result.gross_amount)
        self.assertEqual(deductions, result.deduction_amount + result.tax_amount)

    def test_the_explanation_is_persisted_with_every_figure(self):
        detail = hra_line(calculate(snapshot())).detail
        self.assertEqual(detail["actual_hra"], "20000.00")
        self.assertEqual(detail["basic"], "50000.00")
        self.assertEqual(detail["rent_paid"], "25000.00")
        self.assertEqual(detail["ten_percent_basic"], "5000.00")
        self.assertEqual(detail["rent_minus_ten_percent_basic"], "20000.00")
        self.assertEqual(detail["metro_classification"], "METRO")
        self.assertEqual(detail["salary_percentage"], "50")
        self.assertEqual(detail["salary_limit"], "25000.00")
        self.assertEqual(detail["actual_hra_limit"], "20000.00")
        self.assertEqual(detail["period_hra_exemption"], "20000.00")

    def test_the_new_regime_gets_no_exemption(self):
        result = calculate(snapshot(regime="new"))
        self.assertEqual(result.hra_exemption, Decimal("0"))
        self.assertEqual(result.taxable_earnings, Decimal("70000.00"))

    def test_no_rent_declared_means_no_exemption_and_a_stated_reason(self):
        snap = snapshot(applicable=False)
        snap["hra_json"]["reason"] = "no rent declared for this tax year"
        result = calculate(snap)
        self.assertEqual(result.hra_exemption, Decimal("0"))
        # No line at all, rather than a zero line pretending something was considered.
        self.assertIsNone(hra_line(result))

    def test_a_structure_with_no_hra_role_exempts_nothing(self):
        plain = [{"code": "BASIC", "name": "Basic", "component_type": "earning",
                  "calculation_type": "percentage", "percentage": "50",
                  "percentage_of_code": "BASE", "semantic_role": "basic",
                  "taxable": True, "affects_lop": True, "sequence_no": 1}]
        result = calculate(snapshot(components=plain))
        self.assertEqual(result.hra_exemption, Decimal("0"))

    def test_two_components_claiming_the_basic_role_fails_this_employee(self):
        ambiguous = structure() + [
            {"code": "BASIC_2", "name": "Basic (other)", "component_type": "earning",
             "calculation_type": "fixed", "fixed_amount": "1000",
             "semantic_role": "basic", "taxable": True, "affects_lop": True, "sequence_no": 3},
        ]
        with self.assertRaises(HraError):
            calculate(snapshot(components=ambiguous))


class LopInteraction(unittest.TestCase):
    """HRA is pro-rated by the existing LOP model; rent is not. A landlord is not paid by
    attendance, and the basic the rent is measured against is the basic actually paid."""

    def test_no_lop(self):
        result = calculate(snapshot(lop="0"))
        self.assertEqual(result.hra_exemption, Decimal("20000.00"))

    def test_partial_lop_reduces_basic_and_hra_together(self):
        # Six LOP days out of thirty: everything pro-rated by 24/30 = 0.8.
        result = calculate(snapshot(lop="6"))
        detail = hra_line(result).detail
        self.assertEqual(detail["basic"], "40000.00")
        self.assertEqual(detail["actual_hra"], "16000.00")
        # Rent is untouched by LOP.
        self.assertEqual(detail["rent_paid"], "25000.00")
        #   A 16,000 | B 25,000 - 4,000 = 21,000 | C 50% of 40,000 = 20,000
        self.assertEqual(result.hra_exemption, Decimal("16000.00"))

    def test_full_lop_leaves_nothing_to_exempt(self):
        result = calculate(snapshot(lop="30"))
        self.assertEqual(result.gross_amount, Decimal("0.00"))
        self.assertEqual(result.hra_exemption, Decimal("0.00"))

    def test_a_component_exempt_from_pro_rating_is_not_reduced(self):
        fixed_hra = structure()
        fixed_hra[1] = {**fixed_hra[1], "calculation_type": "fixed", "fixed_amount": "20000",
                        "percentage": None, "percentage_of_code": None, "affects_lop": False}
        result = calculate(snapshot(lop="6", components=fixed_hra))
        detail = hra_line(result).detail
        self.assertEqual(detail["actual_hra"], "20000.00")
        self.assertEqual(detail["basic"], "40000.00")

    def test_a_mid_month_joiner_is_measured_on_what_they_were_paid(self):
        # Employed for 15 of 30 days. Basic 25,000, HRA 10,000, rent still 25,000.
        result = calculate(snapshot(employed_days="15"))
        detail = hra_line(result).detail
        self.assertEqual(detail["basic"], "25000.00")
        self.assertEqual(detail["actual_hra"], "10000.00")
        #   A 10,000 | B 25,000 - 2,500 = 22,500 | C 50% of 25,000 = 12,500
        self.assertEqual(result.hra_exemption, Decimal("10000.00"))


class TaxYearProjection(unittest.TestCase):
    """The part the phase is really about: the year is the sum of its periods."""

    def test_a_uniform_year_projects_each_remaining_period_separately(self):
        projection = [{
            "from": "2026-05-01", "to": "2027-03-31", "periods": 11,
            "rent_amount": "25000", "metro_classification": "metro",
            "base_amount": "100000", "components": structure(),
        }]
        result = calculate(snapshot(projection=projection, months_remaining=12))
        detail = hra_line(result).detail
        # Eleven remaining periods at 20,000 each. Arrived at by evaluating a segment and
        # multiplying by a *count of periods*, not by assuming twelve months.
        self.assertEqual(detail["projected_remaining_exemption"], "220000.00")
        self.assertEqual(detail["period_hra_exemption"], "20000.00")

    def test_a_mid_year_raise_is_projected_at_the_new_salary(self):
        # April-June basic 40,000 / HRA 16,000; July-March basic 50,000 / HRA 20,000.
        # Calculating June, with the raise already recorded as a future assignment.
        projection = [{
            "from": "2026-07-01", "to": "2027-03-31", "periods": 9,
            "rent_amount": "25000", "metro_classification": "metro",
            "base_amount": "100000", "components": structure(),
        }]
        result = calculate(snapshot(
            base="80000", projection=projection, months_remaining=10,
        ))
        detail = hra_line(result).detail
        #   June: basic 40,000, HRA 16,000, rent 25,000, metro
        #     A 16,000 | B 25,000 - 4,000 = 21,000 | C 20,000  ->  16,000
        self.assertEqual(detail["basic"], "40000.00")
        self.assertEqual(detail["period_hra_exemption"], "16000.00")

        segments = detail["projection_segments"]
        self.assertEqual(len(segments), 1)
        # July onward: basic 50,000 -> 20,000 each, nine of them. Emphatically not
        # 16,000 x 9 = 144,000, which is what "current exemption x remaining" would give.
        self.assertEqual(segments[0]["per_period_exemption"], "20000.00")
        self.assertEqual(segments[0]["segment_exemption"], "180000.00")
        self.assertNotEqual(segments[0]["segment_exemption"], "144000.00")

    def test_rent_that_ends_mid_year_contributes_only_to_the_periods_it_covers(self):
        # Rent until December, none after. The second segment has no declaration, so its
        # rent is zero and it exempts nothing.
        projection = [
            {"from": "2026-05-01", "to": "2026-12-31", "periods": 8,
             "rent_amount": "25000", "metro_classification": "metro",
             "base_amount": "100000", "components": structure()},
            {"from": "2027-01-01", "to": "2027-03-31", "periods": 3,
             "rent_amount": "0", "metro_classification": "metro",
             "base_amount": "100000", "components": structure()},
        ]
        result = calculate(snapshot(projection=projection, months_remaining=12))
        detail = hra_line(result).detail
        segments = detail["projection_segments"]
        self.assertEqual(segments[0]["segment_exemption"], "160000.00")
        self.assertEqual(segments[1]["per_period_exemption"], "0.00")
        self.assertEqual(segments[1]["segment_exemption"], "0.00")
        # Eight periods, not eleven. The naive reading would claim 220,000.
        self.assertEqual(detail["projected_remaining_exemption"], "160000.00")

    def test_a_move_between_metro_and_non_metro_changes_the_limit_partway(self):
        projection = [
            {"from": "2026-05-01", "to": "2026-09-30", "periods": 5,
             "rent_amount": "90000", "metro_classification": "metro",
             "base_amount": "100000", "components": structure()},
            {"from": "2026-10-01", "to": "2027-03-31", "periods": 6,
             "rent_amount": "90000", "metro_classification": "non_metro",
             "base_amount": "100000", "components": structure()},
        ]
        result = calculate(snapshot(rent="90000", projection=projection, months_remaining=12))
        segments = hra_line(result).detail["projection_segments"]
        # Metro: min(20,000 HRA, 85,000, 25,000) = 20,000.
        self.assertEqual(segments[0]["per_period_exemption"], "20000.00")
        # Non-metro: 40% of 50,000 = 20,000 now binds equally, so still 20,000 — but the
        # limit that produced it changed, and the record says so.
        self.assertEqual(segments[1]["metro_classification"], "NON_METRO")

    def test_a_leaver_is_not_projected_past_their_last_day(self):
        # Node stops emitting segments after the exit date, so a November leaver calculated
        # in June projects five periods and not ten.
        projection = [{
            "from": "2026-07-01", "to": "2026-11-30", "periods": 5,
            "rent_amount": "25000", "metro_classification": "metro",
            "base_amount": "100000", "components": structure(),
        }]
        result = calculate(snapshot(projection=projection, months_remaining=10))
        detail = hra_line(result).detail
        # Five periods of exemption, then nothing. Ten remaining months would claim 180,000.
        self.assertEqual(detail["projected_remaining_exemption"], "100000.00")
        self.assertEqual(len(detail["projection_segments"]), 1)

    def test_the_final_period_of_the_year_projects_nothing(self):
        # March. Nothing is still scheduled, so the plan is empty and the year's exemption is
        # whatever the finalized slips already carry plus this period's.
        result = calculate(snapshot(months_remaining=1, projection=[]))
        detail = hra_line(result).detail
        self.assertEqual(detail["projected_remaining_exemption"], "0.00")
        self.assertEqual(detail["projection_segments"], [])

    def test_ytd_accumulation_comes_from_what_was_actually_paid(self):
        # previous_taxable_earnings is the sum of finalized slips' taxable_earnings, which is
        # already net of each of those periods' own exemptions. So the accumulation needs no
        # separate ledger and is effective-dated for free.
        result = calculate(snapshot(
            months_remaining=9,
            previous_taxable_earnings="150000",
            tax_deducted_ytd="10000",
        ))
        tds = next(c for c in result.components if c.code == "TDS")
        # This period's own exemption is already out of the figure that will be written to
        # the slip, so next period's `previous_taxable_earnings` picks the accumulation up
        # with no separate ledger to keep in step.
        self.assertEqual(tds.detail["current_taxable"], "50000.00")
        self.assertEqual(tds.detail["hra_exemption_this_period"], "20000.00")
        # 150,000 already earned (net of those periods' exemptions) + 50,000 now + projection.
        self.assertEqual(result.taxable_earnings, Decimal("50000.00"))

    def test_a_supplementary_run_exempts_and_projects_nothing(self):
        snap = snapshot()
        snap["compensation_json"]["pay_structure"] = False
        snap["additional_json"] = [
            {"code": "BONUS", "name": "Bonus", "component_type": "earning",
             "amount": "10000", "kind": "bonus", "taxable": True},
        ]
        snap["hra_json"]["projection"] = [{
            "from": "2026-05-01", "to": "2027-03-31", "periods": 11,
            "rent_amount": "25000", "metro_classification": "metro",
            "base_amount": "100000", "components": structure(),
        }]
        result = calculate(snap)
        # No salary structure was paid, so no allowance was received and there is nothing to
        # exempt — and projecting the structure's exemption would exempt income the
        # supplementary run does not pay.
        self.assertEqual(result.hra_exemption, Decimal("0"))
        self.assertIsNone(hra_line(result))


class Determinism(unittest.TestCase):
    def test_the_same_snapshot_always_produces_the_same_exemption(self):
        snap = snapshot(projection=[{
            "from": "2026-05-01", "to": "2027-03-31", "periods": 11,
            "rent_amount": "25000", "metro_classification": "metro",
            "base_amount": "100000", "components": structure(),
        }])
        first = calculate(snap)
        second = calculate(snap)
        self.assertEqual(first.hra_exemption, second.hra_exemption)
        self.assertEqual(first.taxable_earnings, second.taxable_earnings)
        self.assertEqual(hra_line(first).detail, hra_line(second).detail)

    def test_calculating_does_not_mutate_the_snapshot(self):
        # The snapshot is frozen input. An engine that edited it would make the second
        # calculation of the same run differ from the first.
        import copy
        snap = snapshot()
        original = copy.deepcopy(snap)
        calculate(snap)
        self.assertEqual(snap, original)


if __name__ == "__main__":
    unittest.main()
