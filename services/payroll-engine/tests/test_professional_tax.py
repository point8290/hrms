"""Professional tax: a state levy, a period deduction, and explicitly not income tax.

Three properties carry the suite.

**PT is a period deduction.** The slab amounts are monthly amounts against a monthly wage.
Nothing here goes near the income-tax annualisation, and there is no `annual / 12` anywhere:
an employee is in whichever band this period's earnings put them in.

**PT is independent of the income-tax regime.** An employee electing the new regime still
pays their state's professional tax. Different levies, different governments.

**An unsupported state is not a zero.** "This state levies no PT" and "nobody configured this
state" used to be indistinguishable on a payslip. They are now different answers with
different reasons, and only one of them can be made a refusal.
"""

from __future__ import annotations

import copy
import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.calculation import PayrollError, calculate  # noqa: E402
from app.statutory import (  # noqa: E402
    ProfessionalTaxConfigError,
    calculate_professional_tax,
)

# Karnataka: a flat 200 above the exemption limit, no special month, no ceiling.
KA = {
    "applicable": True,
    "state_name": "Karnataka",
    "wage_basis": "gross_earnings",
    "frequency": "monthly",
    "slabs": [
        {"upto": 24999, "amount": 0, "label": "up to 24,999"},
        {"upto": None, "amount": 200, "label": "25,000 and above"},
    ],
}

# Maharashtra: 175 in the middle band, 200 above it, 300 in February, 2,500 for the year.
MH = {
    "applicable": True,
    "state_name": "Maharashtra",
    "wage_basis": "gross_earnings",
    "frequency": "monthly",
    "slabs": [
        {"upto": 7500, "amount": 0, "label": "up to 7,500"},
        {"upto": 10000, "amount": 175, "label": "7,501 to 10,000"},
        {"upto": None, "amount": 200, "label": "above 10,000", "special_months": {"2": 300}},
    ],
    "annual_cap": 2500,
}


def pt(wage, config=KA, *, month=None, paid=0):
    return calculate_professional_tax(
        Decimal(str(wage)), config, period_month=month, paid_this_year=Decimal(str(paid))
    )


# ---------------------------------------------------------------------------


class Slabs(unittest.TestCase):
    def test_below_the_threshold_is_nil(self):
        self.assertEqual(pt("24998").amount, Decimal("0"))

    def test_exactly_at_the_exemption_limit_is_nil(self):
        # The Karnataka band is "up to 24,999", so 24,999 is inside it.
        self.assertEqual(pt("24999").amount, Decimal("0"))

    def test_one_rupee_above_the_limit_engages_the_band(self):
        self.assertEqual(pt("25000").amount, Decimal("200"))

    def test_a_paisa_above_the_limit_engages_the_band(self):
        self.assertEqual(pt("24999.01").amount, Decimal("200"))

    def test_every_maharashtra_band(self):
        for wage, amount in [
            ("7500", "0"), ("7500.01", "175"), ("9999", "175"),
            ("10000", "175"), ("10000.01", "200"), ("500000", "200"),
        ]:
            with self.subTest(wage=wage):
                self.assertEqual(pt(wage, MH).amount, Decimal(amount))

    def test_zero_wage_is_nil_rather_than_an_error(self):
        # A full month of loss of pay. The employee earned nothing, so the lowest band
        # applies; that falls out of the slab rather than being a proration rule.
        self.assertEqual(pt("0", MH).amount, Decimal("0"))

    def test_the_matched_band_is_named_in_the_trace(self):
        self.assertEqual(pt("25000").detail["matched_slab"], "25,000 and above")
        self.assertEqual(pt("8000", MH).detail["matched_slab"], "7,501 to 10,000")

    def test_amounts_are_whole_rupees(self):
        # PT is conventionally reported and remitted in whole rupees, which is what the
        # engine's rupees() helper already does for statutory deductions.
        result = pt("25000.99")
        self.assertEqual(result.amount, result.amount.quantize(Decimal("1")))


class SpecialMonth(unittest.TestCase):
    def test_february_carries_the_larger_instalment(self):
        self.assertEqual(pt("50000", MH, month=2).amount, Decimal("300"))

    def test_every_other_month_is_ordinary(self):
        for month in [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]:
            with self.subTest(month=month):
                self.assertEqual(pt("50000", MH, month=month).amount, Decimal("200"))

    def test_the_adjustment_is_shown_separately_from_the_standard_amount(self):
        detail = pt("50000", MH, month=2).detail
        self.assertEqual(detail["standard_amount"], "200")
        self.assertEqual(detail["special_month_adjustment"], "100")
        self.assertEqual(detail["final_amount"], "300")
        self.assertEqual(detail["special_month"], 2)

    def test_the_special_instalment_belongs_to_its_band_only(self):
        # The 175 band has no February instalment. Putting the special month beside the slabs
        # rather than on one would have made this ambiguous.
        self.assertEqual(pt("9000", MH, month=2).amount, Decimal("175"))

    def test_a_state_with_no_special_month_is_unaffected_by_february(self):
        self.assertEqual(pt("50000", KA, month=2).amount, Decimal("200"))

    def test_no_month_number_appears_in_the_engine(self):
        # The month comes from the payroll period and the amount from the rule. A state that
        # loaded its instalment in a different month needs only different data.
        march_rule = copy.deepcopy(MH)
        march_rule["slabs"][2]["special_months"] = {"3": 400}
        self.assertEqual(pt("50000", march_rule, month=3).amount, Decimal("400"))
        self.assertEqual(pt("50000", march_rule, month=2).amount, Decimal("200"))


class AnnualCap(unittest.TestCase):
    def test_a_full_year_lands_exactly_on_the_ceiling(self):
        # Eleven ordinary months plus February. The ceiling is never binding for a full year
        # at these amounts, which is the point of checking.
        total = sum(
            (pt("50000", MH, month=m).amount for m in range(1, 13)), Decimal("0")
        )
        self.assertEqual(total, Decimal("2500"))

    def test_the_ceiling_binds_once_the_year_is_spent(self):
        self.assertEqual(pt("50000", MH, month=6, paid=2400).amount, Decimal("100"))
        self.assertEqual(pt("50000", MH, month=6, paid=2500).amount, Decimal("0"))

    def test_the_ceiling_never_produces_a_negative(self):
        self.assertEqual(pt("50000", MH, month=6, paid=9999).amount, Decimal("0"))

    def test_the_ceiling_is_shown_in_the_trace_when_it_bites(self):
        detail = pt("50000", MH, month=6, paid=2400).detail
        self.assertTrue(detail["annual_cap_applied"])
        self.assertEqual(detail["uncapped_amount"], "200")
        self.assertEqual(detail["final_amount"], "100")
        self.assertEqual(detail["annual_cap"], "2500")
        self.assertEqual(detail["paid_this_year"], "2400")

    def test_a_state_with_no_ceiling_is_uncapped(self):
        detail = pt("50000", KA, paid=999999).detail
        self.assertFalse(detail["annual_cap_applied"])
        self.assertNotIn("annual_cap", detail)

    def test_the_ceiling_applies_after_the_special_instalment(self):
        # February's 300 capped down to whatever is left of the year's ceiling.
        self.assertEqual(pt("50000", MH, month=2, paid=2400).amount, Decimal("100"))


class UnsupportedAndUnconfigured(unittest.TestCase):
    def test_no_rule_is_recorded_not_silently_zero(self):
        result = pt("50000", None)
        self.assertEqual(result.amount, Decimal("0"))
        self.assertFalse(result.detail["applicable"])
        self.assertIn("no professional tax rule was resolved", result.detail["reason"])

    def test_a_state_that_levies_none_says_so_differently(self):
        result = pt("50000", {"applicable": False, "state_name": "Sikkim"})
        self.assertEqual(result.amount, Decimal("0"))
        self.assertIn("Sikkim levies no professional tax", result.detail["reason"])

    def test_the_two_zeroes_are_distinguishable(self):
        unconfigured = pt("50000", None).detail["reason"]
        levies_none = pt("50000", {"applicable": False}).detail["reason"]
        self.assertNotEqual(unconfigured, levies_none)

    def test_a_rule_with_no_slabs_raises_rather_than_deducting_nothing(self):
        with self.assertRaises(ProfessionalTaxConfigError):
            pt("50000", {"applicable": True, "slabs": []})

    def test_a_schedule_that_does_not_cover_the_wage_raises(self):
        # Bands that stop short with no open-ended top is a gap in the schedule, not a zero.
        truncated = {"applicable": True, "slabs": [{"upto": 10000, "amount": 200}]}
        with self.assertRaises(ProfessionalTaxConfigError):
            pt("50000", truncated)

    def test_a_slab_with_no_amount_raises(self):
        with self.assertRaises(ProfessionalTaxConfigError):
            pt("50000", {"applicable": True, "slabs": [{"upto": None}]})


# ---------------------------------------------------------------------------
# Through calculate(), where PT meets the rest of the payslip.
# ---------------------------------------------------------------------------

INCOME_TAX_CONFIG = {
    "regimes": {
        "old": {"slabs": [{"upto": 250000, "rate": 0}, {"upto": None, "rate": 0.3}],
                "standard_deduction": 50000, "rebate_limit": 500000, "rebate_max": 12500,
                "cess_rate": 0.04},
        "new": {"slabs": [{"upto": 300000, "rate": 0}, {"upto": None, "rate": 0.2}],
                "standard_deduction": 75000, "rebate_limit": 700000, "rebate_max": 25000,
                "cess_rate": 0.04},
    }
}


def snapshot(*, state="KA", rule=KA, regime="old", month=6, paid="0", required=False,
             base="50000", lop="0", source="tax_profile"):
    statutory = {"required": ["income_tax"],
                 "income_tax": {"version": 1, "rule_id": "it-1", "config": INCOME_TAX_CONFIG}}
    if rule is not None and state:
        statutory[f"professional_tax:{state}"] = {
            "rule_id": "pt-1", "version": 2, "source": "platform", "config": rule,
        }
    return {
        "employee_json": {"id": "emp-1", "employee_code": "E1", "state_code": state},
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
        "tax_json": {
            "regime": regime, "declared_amount": "0",
            "pf_applicable": False, "esi_applicable": False,
            "professional_tax": {
                "state_code": state, "state_source": source, "rule_resolved": rule is not None,
                "rule_key": f"professional_tax:{state}" if state else None,
                "rule_effective_from": "2026-04-01", "required": required,
                "period_month": month, "paid_this_year": paid,
            },
        },
        "statutory_json": statutory,
        "additional_json": [],
        "hra_json": {"applicable": False, "reason": "no rent declared"},
        "exemption_json": {"sections": []},
    }


def pt_line(result):
    return next((c for c in result.components if c.code == "PT"), None)


class ThroughTheEngine(unittest.TestCase):
    def test_pt_is_a_statutory_deduction_line(self):
        line = pt_line(calculate(snapshot()))
        self.assertIsNotNone(line)
        self.assertEqual(line.component_type, "deduction")
        self.assertTrue(line.is_statutory)
        self.assertEqual(line.amount, Decimal("200"))

    def test_pt_reduces_net_pay_and_the_taxable_base(self):
        # Section 16(iii): professional tax is deductible from salary income.
        result = calculate(snapshot())
        self.assertTrue(pt_line(result).exempted_from_income_tax)
        self.assertEqual(result.net_amount,
                         result.gross_amount - result.deduction_amount - result.tax_amount)

    def test_the_trace_explains_the_jurisdiction_and_the_rule(self):
        detail = pt_line(calculate(snapshot())).detail
        self.assertEqual(detail["jurisdiction"], "KA")
        self.assertEqual(detail["jurisdiction_source"], "tax_profile")
        self.assertEqual(detail["rule_id"], "pt-1")
        self.assertEqual(detail["rule_version"], 2)
        self.assertEqual(detail["rule_source"], "platform")
        self.assertEqual(detail["rule_effective_from"], "2026-04-01")
        self.assertEqual(detail["wage_basis"], "50000.00")
        self.assertEqual(detail["wage_basis_kind"], "gross_earnings")
        self.assertEqual(detail["matched_slab"], "25,000 and above")
        self.assertEqual(detail["final_amount"], "200")

    def test_pt_is_independent_of_the_income_tax_regime(self):
        # The same state, the same wage, both regimes. PT must not move.
        old = calculate(snapshot(regime="old"))
        new = calculate(snapshot(regime="new"))
        self.assertEqual(pt_line(old).amount, pt_line(new).amount)
        self.assertEqual(pt_line(old).amount, Decimal("200"))

    def test_the_engine_uses_the_frozen_jurisdiction_not_the_employee_record(self):
        snap = snapshot(state="MH", rule=MH, month=2)
        # employee_json still says MH, but what decides is the frozen PT context.
        self.assertEqual(pt_line(calculate(snap)).amount, Decimal("300"))

    def test_an_unsupported_state_deducts_nothing_and_says_why(self):
        result = calculate(snapshot(state="TN", rule=None))
        # No PT line at all, because nothing was deducted — but the run succeeds, which is
        # the deliberate ADR-014 behaviour for a location-derived state.
        self.assertIsNone(pt_line(result))
        self.assertEqual(result.deduction_amount, Decimal("0.00"))

    def test_a_required_jurisdiction_with_no_rule_fails_this_employee(self):
        with self.assertRaises(PayrollError) as caught:
            calculate(snapshot(state="TN", rule=None, required=True))
        message = str(caught.exception)
        self.assertIn("E1", message)
        self.assertIn("professional tax is required", message)

    def test_loss_of_pay_moves_the_band_rather_than_prorating_the_amount(self):
        # 15 days of LOP on 50,000 leaves 25,000 gross — still the top Karnataka band.
        full = calculate(snapshot(lop="0"))
        half = calculate(snapshot(lop="15"))
        self.assertEqual(pt_line(full).amount, Decimal("200"))
        self.assertEqual(pt_line(half).amount, Decimal("200"))

        # Enough LOP to drop below the exemption limit and PT falls away entirely. That is
        # the slab doing its work, not a proration rule.
        heavy = calculate(snapshot(lop="20"))
        self.assertIsNone(pt_line(heavy))

    def test_additional_salary_is_part_of_the_wage_basis(self):
        # The basis is the period's gross earnings, which includes one-off amounts. A bonus
        # that lifts an employee over the exemption limit makes PT due that month.
        snap = snapshot(base="20000")
        self.assertIsNone(pt_line(calculate(snap)), "setup: below the limit on salary alone")

        snap["additional_json"] = [
            {"code": "BONUS", "name": "Bonus", "component_type": "earning",
             "amount": "10000", "kind": "bonus", "taxable": True},
        ]
        self.assertEqual(pt_line(calculate(snap)).amount, Decimal("200"))

    def test_a_supplementary_run_still_charges_pt_on_what_it_pays(self):
        snap = snapshot()
        snap["compensation_json"]["pay_structure"] = False
        snap["additional_json"] = [
            {"code": "ARREAR", "name": "Arrears", "component_type": "earning",
             "amount": "30000", "kind": "arrear", "taxable": True},
        ]
        # PT is a levy on the period's earnings, and a supplementary run pays earnings.
        self.assertEqual(pt_line(calculate(snap)).amount, Decimal("200"))

    def test_determinism_and_no_mutation(self):
        snap = snapshot(state="MH", rule=MH, month=2, paid="2400")
        original = copy.deepcopy(snap)
        first, second = calculate(snap), calculate(snap)
        self.assertEqual(pt_line(first).amount, pt_line(second).amount)
        self.assertEqual(pt_line(first).detail, pt_line(second).detail)
        self.assertEqual(snap, original)


if __name__ == "__main__":
    unittest.main()
