"""Provident fund: what the rule says, and nothing this file assumes.

The PRD names PF as a supported statutory item and adds two cross-cutting requirements:
statutory rules must be "effective-dated and versioned rather than scattered as hard-coded
logic", and rule changes must not change historical payroll results. Those two are what this
suite is about.

**Nothing statutory is defaulted.** No rate, and not the wage basis, falls back to a literal
in the engine. A rule version that omits one fails that employee rather than deducting a
figure nobody configured — which would look entirely ordinary on the payslip and be wrong.

**Employee and employer money stay apart.** The employee contribution is a deduction and
reduces net pay; the employer contribution is an employer cost and does not. The tests assert
the reconciliation rather than the line types.

Deliberately not tested, because deliberately not implemented: VPF, EDLI, employer
administrative charges, and EPS as a statutory component in its own right. None is in the
PRD. The employer share does carry a pension *split*, which already existed and is
informational only — it is part of the employer contribution, never additional to it.
"""

from __future__ import annotations

import copy
import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.calculation import PayrollError, calculate  # noqa: E402
from app.statutory import PfConfigError, calculate_pf, rupees  # noqa: E402

# The platform rule as seeded in migration 0008, spelled out here so a test that changes one
# key is obviously changing that key.
PF_RULE = {
    "employee_rate": 0.12,
    "employer_rate": 0.12,
    "employer_pension_rate": 0.0833,
    "wage_ceiling": 15000,
    "apply_ceiling": True,
    "basis_component_codes": ["BASIC", "DA"],
}

INCOME_TAX_CONFIG = {
    "regimes": {
        "new": {"slabs": [{"upto": 300000, "rate": 0}, {"upto": None, "rate": 0.2}],
                "standard_deduction": 75000, "rebate_limit": 700000, "rebate_max": 25000,
                "cess_rate": 0.04},
    }
}


def pf(wage, config=None, applicable=True):
    cfg = PF_RULE if config is None else config
    return calculate_pf(Decimal(str(wage)), cfg, applicable=applicable)


# ---------------------------------------------------------------------------


class NothingStatutoryIsDefaulted(unittest.TestCase):
    """PRD: rules are versioned data, "rather than scattered as hard-coded logic"."""

    def test_a_missing_employee_rate_refuses_rather_than_assuming_twelve_percent(self):
        cfg = {k: v for k, v in PF_RULE.items() if k != "employee_rate"}
        with self.assertRaises(PfConfigError) as caught:
            pf("50000", cfg)
        self.assertIn("employee_rate", str(caught.exception))

    def test_a_missing_employer_rate_refuses(self):
        cfg = {k: v for k, v in PF_RULE.items() if k != "employer_rate"}
        with self.assertRaises(PfConfigError):
            pf("50000", cfg)

    def test_a_missing_pension_rate_refuses(self):
        cfg = {k: v for k, v in PF_RULE.items() if k != "employer_pension_rate"}
        with self.assertRaises(PfConfigError):
            pf("50000", cfg)

    def test_a_null_rate_is_as_absent_as_a_missing_one(self):
        cfg = {**PF_RULE, "employee_rate": None}
        with self.assertRaises(PfConfigError):
            pf("50000", cfg)

    def test_a_ceiling_with_no_policy_refuses_rather_than_picking_one(self):
        # Applying the ceiling and not applying it are both real employer policies, and they
        # differ by real money. Nothing in the requirements settles it, so neither does this.
        cfg = {k: v for k, v in PF_RULE.items() if k != "apply_ceiling"}
        with self.assertRaises(PfConfigError) as caught:
            pf("50000", cfg)
        self.assertIn("apply_ceiling", str(caught.exception))

    def test_no_ceiling_at_all_needs_no_policy(self):
        # A rule with no ceiling is unambiguous, so it does not need to say whether one
        # applies.
        cfg = {k: v for k, v in PF_RULE.items() if k not in ("wage_ceiling", "apply_ceiling")}
        result = pf("50000", cfg)
        self.assertEqual(result.employee, rupees(Decimal("6000")))
        self.assertFalse(result.capped)

    def test_a_zero_rate_is_configuration_not_absence(self):
        # Zero is a rate somebody chose. It must not be confused with a missing key.
        result = pf("50000", {**PF_RULE, "employee_rate": 0})
        self.assertEqual(result.employee, Decimal("0"))
        self.assertGreater(result.employer, Decimal("0"))


class Ceiling(unittest.TestCase):
    def test_below_the_ceiling_uses_actual_wages(self):
        result = pf("14999")
        self.assertEqual(result.wage_base, Decimal("14999.00"))
        self.assertFalse(result.capped)
        self.assertEqual(result.employee, rupees(Decimal("14999") * Decimal("0.12")))

    def test_exactly_at_the_ceiling_is_not_capped(self):
        result = pf("15000")
        self.assertEqual(result.wage_base, Decimal("15000.00"))
        self.assertFalse(result.capped, "at the ceiling is not above it")
        self.assertEqual(result.employee, Decimal("1800"))

    def test_one_rupee_above_the_ceiling_is_capped(self):
        result = pf("15001")
        self.assertEqual(result.wage_base, Decimal("15000.00"))
        self.assertTrue(result.capped)
        self.assertEqual(result.employee, Decimal("1800"))

    def test_far_above_the_ceiling_still_contributes_on_the_ceiling(self):
        self.assertEqual(pf("500000").employee, Decimal("1800"))

    def test_a_rule_that_switches_the_ceiling_off_contributes_on_full_wages(self):
        result = pf("50000", {**PF_RULE, "apply_ceiling": False})
        self.assertEqual(result.wage_base, Decimal("50000.00"))
        self.assertFalse(result.capped)
        self.assertEqual(result.employee, Decimal("6000"))


class EmployeeAndEmployer(unittest.TestCase):
    def test_both_sides_are_computed_on_the_same_contributory_wage(self):
        result = pf("15001")
        self.assertEqual(result.employee, Decimal("1800"))
        self.assertEqual(result.employer, Decimal("1800"))
        self.assertEqual(result.wage_base, Decimal("15000.00"))

    def test_the_pension_share_is_part_of_the_employer_contribution(self):
        # A split of the employer's own money, never an extra charge on top of it.
        result = pf("15000")
        self.assertLessEqual(result.employer_pension, result.employer)
        self.assertEqual(result.employer_pension, rupees(Decimal("15000") * Decimal("0.0833")))

    def test_the_pension_share_can_never_exceed_the_employer_contribution(self):
        result = pf("15000", {**PF_RULE, "employer_pension_rate": 0.99})
        self.assertEqual(result.employer_pension, result.employer)

    def test_not_applicable_contributes_nothing_on_either_side(self):
        result = pf("50000", applicable=False)
        self.assertEqual(result.employee, Decimal("0"))
        self.assertEqual(result.employer, Decimal("0"))
        self.assertFalse(result.detail["applicable"])

    def test_zero_wage_contributes_nothing_and_says_why(self):
        result = pf("0")
        self.assertEqual(result.employee, Decimal("0"))
        self.assertIn("no provident fund wage", result.detail["reason"])


class Rounding(unittest.TestCase):
    def test_contributions_are_whole_rupees(self):
        # PF is remitted in whole rupees, which is what the engine's rupees() helper does for
        # statutory deductions. No new rounding was introduced for this phase.
        result = pf("12345.67", {**PF_RULE, "apply_ceiling": False})
        for value in (result.employee, result.employer, result.employer_pension):
            self.assertEqual(value, value.quantize(Decimal("1")))

    def test_rounding_is_half_up(self):
        # 12% of 12,345.67 is 1,481.4804 -> 1,481.
        self.assertEqual(pf("12345.67", {**PF_RULE, "apply_ceiling": False}).employee,
                         Decimal("1481"))

    def test_the_same_wage_always_gives_the_same_contribution(self):
        self.assertEqual(pf("15001").employee, pf("15001").employee)
        self.assertEqual(pf("15001").detail, pf("15001").detail)


# ---------------------------------------------------------------------------
# Through calculate(), where PF meets the salary structure and the payslip.
# ---------------------------------------------------------------------------


def snapshot(*, base="40000", lop="0", pf_rule=PF_RULE, pf_applicable=True,
             components=None, additional=None):
    statutory = {"required": ["income_tax"],
                 "income_tax": {"version": 1, "rule_id": "it-1", "config": INCOME_TAX_CONFIG}}
    if pf_rule is not None:
        statutory["pf"] = {"rule_id": "pf-1", "version": 1, "source": "platform",
                           "config": pf_rule}
        statutory["required"].append("pf")

    default_components = [
        {"code": "BASIC", "name": "Basic", "component_type": "earning",
         "calculation_type": "percentage", "percentage": "50", "percentage_of_code": "BASE",
         "semantic_role": "basic", "taxable": True, "affects_lop": True, "sequence_no": 1},
        {"code": "DA", "name": "Dearness Allowance", "component_type": "earning",
         "calculation_type": "percentage", "percentage": "20", "percentage_of_code": "BASIC",
         "taxable": True, "affects_lop": True, "sequence_no": 2},
        {"code": "SPECIAL", "name": "Special Allowance", "component_type": "earning",
         "calculation_type": "percentage", "percentage": "30", "percentage_of_code": "BASE",
         "taxable": True, "affects_lop": True, "sequence_no": 3},
    ]
    return {
        "employee_json": {"id": "emp-1", "employee_code": "E1", "state_code": None},
        "attendance_json": {"total_days": "30", "employed_days": "30", "lop_units": lop,
                            "months_remaining_in_fy": 12},
        "leave_json": {},
        "compensation_json": {
            "base_amount": base, "currency": "INR", "pay_structure": True,
            "components": components if components is not None else default_components,
        },
        "tax_json": {"regime": "new", "declared_amount": "0",
                     "pf_applicable": pf_applicable, "esi_applicable": False},
        "statutory_json": statutory,
        "additional_json": additional or [],
        "hra_json": {"applicable": False, "reason": "no rent declared"},
        "exemption_json": {"sections": []},
    }


def line(result, code):
    return next((c for c in result.components if c.code == code), None)


class WageBasis(unittest.TestCase):
    def test_only_the_components_the_rule_names_contribute(self):
        # base 40,000 -> BASIC 20,000, DA 4,000, SPECIAL 12,000.
        # The rule names BASIC and DA, so the PF wage is 24,000 — not gross, and not basic.
        result = calculate(snapshot())
        detail = line(result, "PF_EMPLOYEE").detail
        self.assertEqual(detail["wage_basis"], "24000.00")
        self.assertEqual(
            sorted(c["code"] for c in detail["contributing_components"]), ["BASIC", "DA"],
        )

    def test_a_component_outside_the_basis_is_excluded(self):
        result = calculate(snapshot())
        codes = [c["code"] for c in line(result, "PF_EMPLOYEE").detail["contributing_components"]]
        self.assertNotIn("SPECIAL", codes)

    def test_changing_the_basis_changes_the_wage(self):
        result = calculate(snapshot(pf_rule={**PF_RULE, "basis_component_codes": ["BASIC"]}))
        self.assertEqual(line(result, "PF_EMPLOYEE").detail["wage_basis"], "20000.00")

    def test_a_rule_that_does_not_name_a_basis_fails_this_employee(self):
        cfg = {k: v for k, v in PF_RULE.items() if k != "basis_component_codes"}
        with self.assertRaises(PayrollError) as caught:
            calculate(snapshot(pf_rule=cfg))
        self.assertIn("which salary components form the PF wage", str(caught.exception))

    def test_a_misconfigured_rate_fails_this_employee_by_name(self):
        cfg = {k: v for k, v in PF_RULE.items() if k != "employee_rate"}
        with self.assertRaises(PayrollError) as caught:
            calculate(snapshot(pf_rule=cfg))
        message = str(caught.exception)
        self.assertIn("E1", message)
        self.assertIn("employee_rate", message)

    def test_loss_of_pay_reduces_the_pf_wage_as_it_reduces_the_salary(self):
        # Six LOP days of thirty: the PF wage falls with the earnings that form it.
        result = calculate(snapshot(lop="6"))
        self.assertEqual(line(result, "PF_EMPLOYEE").detail["wage_basis"], "19200.00")

    def test_a_full_month_of_lop_contributes_nothing(self):
        result = calculate(snapshot(lop="30"))
        self.assertIsNone(line(result, "PF_EMPLOYEE"))

    def test_an_additional_salary_outside_the_basis_does_not_raise_the_pf_wage(self):
        # A bonus is its own component and is not in basis_component_codes, so it does not
        # enter the PF wage. That follows from the rule naming its components; it is not a
        # special case for bonuses.
        result = calculate(snapshot(additional=[
            {"code": "BONUS", "name": "Bonus", "component_type": "earning",
             "amount": "50000", "kind": "bonus", "taxable": True},
        ]))
        self.assertEqual(line(result, "PF_EMPLOYEE").detail["wage_basis"], "24000.00")


class PayslipReconciliation(unittest.TestCase):
    def test_the_employee_contribution_is_a_deduction(self):
        employee_line = line(calculate(snapshot()), "PF_EMPLOYEE")
        self.assertEqual(employee_line.component_type, "deduction")
        self.assertTrue(employee_line.is_statutory)

    def test_the_employer_contribution_is_not_a_deduction(self):
        employer_line = line(calculate(snapshot()), "PF_EMPLOYER")
        self.assertEqual(employer_line.component_type, "employer_contribution")

    def test_the_employer_contribution_does_not_reduce_net_pay(self):
        result = calculate(snapshot())
        employer_line = line(result, "PF_EMPLOYER")
        self.assertGreater(employer_line.amount, Decimal("0"))
        # Net reconciles from gross and the employee's own deductions alone.
        self.assertEqual(
            result.net_amount,
            result.gross_amount - result.deduction_amount - result.tax_amount,
        )
        # And the employer's money is reported on its own total.
        self.assertEqual(result.employer_contribution, employer_line.amount)

    def test_turning_pf_off_raises_net_pay_by_the_employee_contribution(self):
        with_pf = calculate(snapshot())
        without = calculate(snapshot(pf_applicable=False))
        employee_pf = line(with_pf, "PF_EMPLOYEE").amount
        self.assertEqual(without.net_amount - with_pf.net_amount, employee_pf)
        self.assertEqual(without.employer_contribution, Decimal("0.00"))

    def test_the_employee_contribution_reduces_taxable_income(self):
        # Section 80C. Established behaviour (ADR-014), asserted here so PF work cannot
        # quietly regress it.
        self.assertTrue(line(calculate(snapshot()), "PF_EMPLOYEE").exempted_from_income_tax)

    def test_the_employer_contribution_is_not_an_employee_tax_deduction(self):
        self.assertFalse(line(calculate(snapshot()), "PF_EMPLOYER").exempted_from_income_tax)


class Trace(unittest.TestCase):
    def test_both_lines_explain_the_same_calculation(self):
        result = calculate(snapshot())
        employee_detail = line(result, "PF_EMPLOYEE").detail
        employer_detail = line(result, "PF_EMPLOYER").detail

        for key in ("wage_basis", "contributory_wage", "employee_rate", "employer_rate",
                    "employee_contribution", "employer_contribution", "rule_id",
                    "rule_version", "contributing_components"):
            self.assertEqual(employee_detail[key], employer_detail[key], key)
        self.assertEqual(employee_detail["side"], "employee")
        self.assertEqual(employer_detail["side"], "employer")

    def test_the_trace_identifies_the_rule_that_produced_it(self):
        detail = line(calculate(snapshot()), "PF_EMPLOYEE").detail
        self.assertEqual(detail["rule_id"], "pf-1")
        self.assertEqual(detail["rule_version"], 1)
        self.assertEqual(detail["rule_source"], "platform")

    def test_the_trace_reconciles_with_the_line_amounts(self):
        result = calculate(snapshot())
        detail = line(result, "PF_EMPLOYEE").detail
        self.assertEqual(Decimal(detail["employee_contribution"]),
                         line(result, "PF_EMPLOYEE").amount)
        self.assertEqual(Decimal(detail["employer_contribution"]),
                         line(result, "PF_EMPLOYER").amount)

    def test_the_trace_shows_the_ceiling_when_it_binds(self):
        # base 200,000 -> BASIC 100,000 + DA 20,000 = 120,000, well over the ceiling.
        detail = line(calculate(snapshot(base="200000")), "PF_EMPLOYEE").detail
        self.assertTrue(detail["ceiling_applied"])
        self.assertEqual(detail["wage_basis"], "120000.00")
        self.assertEqual(detail["contributory_wage"], "15000.00")
        self.assertEqual(detail["wage_ceiling"], "15000.00")

    def test_the_trace_shows_the_ceiling_not_binding(self):
        # base 20,000 -> BASIC 10,000 + DA 2,000 = 12,000, under the 15,000 ceiling.
        detail = line(calculate(snapshot(base="20000")), "PF_EMPLOYEE").detail
        self.assertFalse(detail["ceiling_applied"])
        self.assertEqual(detail["wage_basis"], "12000.00")
        self.assertEqual(detail["contributory_wage"], "12000.00")


class Determinism(unittest.TestCase):
    def test_the_same_snapshot_always_produces_the_same_pf(self):
        snap = snapshot(base="200000")
        first, second = calculate(snap), calculate(snap)
        self.assertEqual(line(first, "PF_EMPLOYEE").amount, line(second, "PF_EMPLOYEE").amount)
        self.assertEqual(line(first, "PF_EMPLOYEE").detail, line(second, "PF_EMPLOYEE").detail)

    def test_calculating_does_not_mutate_the_snapshot(self):
        snap = snapshot()
        original = copy.deepcopy(snap)
        calculate(snap)
        self.assertEqual(snap, original)

    def test_a_frozen_rule_is_what_decides_not_any_live_lookup(self):
        # The engine is handed the rule. Two snapshots differing only in their frozen PF
        # config produce different PF, which is what makes a historical run reproducible
        # after the live rule changes.
        # A wage under the ceiling, so the rate is what differs rather than the cap.
        # base 20,000 -> PF wage 12,000; 12% is 1,440 and 10% is 1,200.
        old_rule = calculate(snapshot(base="20000"))
        new_rule = calculate(snapshot(base="20000",
                                      pf_rule={**PF_RULE, "employee_rate": 0.10}))
        self.assertEqual(line(old_rule, "PF_EMPLOYEE").amount, Decimal("1440"))
        self.assertEqual(line(new_rule, "PF_EMPLOYEE").amount, Decimal("1200"))


if __name__ == "__main__":
    unittest.main()
