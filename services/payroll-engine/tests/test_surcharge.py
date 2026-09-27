"""Surcharge and marginal relief on the annual income-tax liability.

The order the Act sets, and every step of it is testable here:

    annual taxable income
      -> slab tax
      -> less section 87A rebate           = base tax
      -> plus surcharge at the band rate   = surcharge before relief
      -> less marginal relief              = surcharge charged
      -> plus cess on (base tax + surcharge)
      = annual tax liability

Two properties carry the suite.

**Surcharge is annual.** The bands are thresholds on the year's total income, so nothing
here takes a monthly figure. A month of a large salary says nothing about whether the year
crosses five million.

**Marginal relief is a guarantee, not an approximation.** Crossing a threshold must never
cost more tax than the income that crossed it:

    tax after relief <= tax payable at the threshold + income above the threshold

That is asserted directly, at every band, rather than by comparing against a number someone
computed by hand once.
"""

from __future__ import annotations

import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.statutory import (  # noqa: E402
    SurchargeConfigError,
    calculate_income_tax,
    calculate_surcharge,
    money,
)

# Slabs without a standard deduction or rebate, so a test that is about surcharge is not
# also about those. The real configuration is exercised through calculate_income_tax below.
SLABS_OLD = [
    {"upto": 250000, "rate": 0},
    {"upto": 500000, "rate": 0.05},
    {"upto": 1000000, "rate": 0.20},
    {"upto": None, "rate": 0.30},
]

BANDS_OLD = [
    {"threshold": 5000000, "rate": 0.10, "marginal_relief": True},
    {"threshold": 10000000, "rate": 0.15, "marginal_relief": True},
    {"threshold": 20000000, "rate": 0.25, "marginal_relief": True},
    {"threshold": 50000000, "rate": 0.37, "marginal_relief": True},
]

# Section 115BAC caps surcharge at 25%: no 37% band.
BANDS_NEW = BANDS_OLD[:3]


def rules(bands=BANDS_OLD, *, slabs=None, surcharge=True, **extra):
    out = {
        "slabs": slabs if slabs is not None else SLABS_OLD,
        "standard_deduction": 0,
        "rebate_limit": 0,
        "rebate_max": 0,
        "cess_rate": 0.04,
        **extra,
    }
    if surcharge is True:
        out["surcharge"] = {"applicable": True, "bands": bands}
    elif surcharge is not None:
        out["surcharge"] = surcharge
    return out


def config(regime="old", **kw):
    return {"regimes": {regime: rules(**kw)}}


def tax_on(income, regime="old", **kw):
    """The whole annual liability for an income, with nothing projected."""
    return calculate_income_tax(
        config(regime=regime, **kw),
        previous_taxable_earnings=Decimal(str(income)),
        recurring_taxable_earnings=Decimal("0"),
        months_remaining=1,
        regime=regime,
    )


# ---------------------------------------------------------------------------


class BandSelection(unittest.TestCase):
    def test_below_the_first_threshold_there_is_no_surcharge(self):
        result = tax_on("4999999")
        self.assertEqual(result.surcharge, Decimal("0.00"))
        self.assertFalse(result.surcharge_detail["applicable"])
        self.assertIn("does not exceed", result.surcharge_detail["reason"])

    def test_exactly_at_the_threshold_there_is_no_surcharge(self):
        # The Act charges surcharge on income *exceeding* the threshold. Fifty lakh exactly
        # does not exceed fifty lakh.
        result = tax_on("5000000")
        self.assertEqual(result.surcharge, Decimal("0.00"))
        self.assertFalse(result.surcharge_detail["applicable"])

    def test_one_rupee_above_the_threshold_engages_the_band(self):
        result = tax_on("5000001")
        self.assertTrue(result.surcharge_detail["applicable"])
        # Numerically: whether the configured rate reads "0.1" or "0.10" depends on how
        # the rule was written down, and is not something the calculation depends on.
        self.assertEqual(Decimal(result.surcharge_detail["rate"]), Decimal("0.10"))
        self.assertEqual(result.surcharge_detail["threshold"], "5000000.00")

    def test_the_highest_threshold_crossed_is_the_one_that_applies(self):
        for income, rate in [
            ("6000000", "0.10"),
            ("15000000", "0.15"),
            ("30000000", "0.25"),
            ("60000000", "0.37"),
        ]:
            with self.subTest(income=income):
                self.assertEqual(
                    Decimal(tax_on(income).surcharge_detail["rate"]), Decimal(rate)
                )

    def test_bands_are_sorted_however_the_rule_was_written(self):
        scrambled = list(reversed(BANDS_OLD))
        self.assertEqual(
            Decimal(tax_on("15000000", bands=scrambled).surcharge_detail["rate"]),
            Decimal("0.15"),
        )

    def test_surcharge_is_charged_on_tax_not_on_income(self):
        result = tax_on("6000000")
        # 10% of the base tax, not 10% of six million.
        self.assertEqual(result.surcharge_before_relief, money(result.base_tax * Decimal("0.10")))
        self.assertLess(result.surcharge, Decimal("600000"))


class Regime(unittest.TestCase):
    def test_the_new_regime_caps_surcharge_at_twenty_five_percent(self):
        # Six crore under the old regime reaches 37%; under the new regime the band does not
        # exist and 25% is the ceiling. Sharing one band list would be wrong for one of them.
        old = tax_on("60000000", regime="old", bands=BANDS_OLD)
        new = tax_on("60000000", regime="new", bands=BANDS_NEW)
        self.assertEqual(Decimal(old.surcharge_detail["rate"]), Decimal("0.37"))
        self.assertEqual(Decimal(new.surcharge_detail["rate"]), Decimal("0.25"))
        self.assertLess(new.surcharge, old.surcharge)

    def test_each_regime_resolves_its_own_bands(self):
        cfg = {"regimes": {"old": rules(BANDS_OLD), "new": rules(BANDS_NEW)}}
        for regime, rate in [("old", "0.37"), ("new", "0.25")]:
            result = calculate_income_tax(
                cfg, previous_taxable_earnings=Decimal("60000000"),
                recurring_taxable_earnings=Decimal("0"), months_remaining=1, regime=regime,
            )
            self.assertEqual(Decimal(result.surcharge_detail["rate"]), Decimal(rate))


class MarginalRelief(unittest.TestCase):
    """The guarantee, asserted as a guarantee."""

    def assert_never_costs_more_than_it_earns(self, threshold, incomes, bands=BANDS_OLD):
        at_threshold = tax_on(str(threshold), bands=bands)
        liability_at_threshold = at_threshold.base_tax + at_threshold.surcharge
        for income in incomes:
            with self.subTest(income=income):
                here = tax_on(str(income), bands=bands)
                excess = Decimal(str(income)) - Decimal(str(threshold))
                self.assertLessEqual(
                    here.base_tax + here.surcharge,
                    liability_at_threshold + excess,
                    f"crossing {threshold} cost more than the {excess} that crossed it",
                )

    def test_the_guarantee_holds_at_the_first_threshold(self):
        self.assert_never_costs_more_than_it_earns(
            5000000, [5000001, 5000100, 5010000, 5100000, 5190000, 5200000, 5500000],
        )

    def test_the_guarantee_holds_at_every_threshold(self):
        for threshold in [5000000, 10000000, 20000000, 50000000]:
            self.assert_never_costs_more_than_it_earns(
                threshold,
                [threshold + 1, threshold + 10000, threshold + 250000, threshold + 1000000],
            )

    def test_a_worked_example(self):
        # Basic 51,00,000 taxable, old regime, no deduction.
        #   base tax    12,500 + 1,00,000 + 12,30,000 = 13,42,500
        #   surcharge   10% of that                   =  1,34,250
        #   at 50L      12,500 + 1,00,000 + 12,00,000 = 13,12,500, no surcharge
        #   excess                                     =  1,00,000
        #   relief      (13,42,500 + 1,34,250) - 13,12,500 - 1,00,000 = 64,250
        result = tax_on("5100000")
        self.assertEqual(result.base_tax, Decimal("1342500.00"))
        self.assertEqual(result.surcharge_before_relief, Decimal("134250.00"))
        self.assertEqual(result.marginal_relief, Decimal("64250.00"))
        self.assertEqual(result.surcharge, Decimal("70000.00"))
        # Cess on base tax plus the relieved surcharge, never on the unrelieved figure.
        self.assertEqual(result.cess, Decimal("56500.00"))
        self.assertEqual(result.annual_tax, Decimal("1469000.00"))

    def test_relief_is_near_total_one_rupee_over(self):
        result = tax_on("5000001")
        self.assertTrue(result.surcharge_detail["relief_applied"])
        # A rupee of extra income must not cost more than a rupee of extra tax.
        self.assertLess(result.surcharge, Decimal("1.00"))

    def test_relief_stops_biting_once_income_is_far_enough_above(self):
        result = tax_on("5500000")
        self.assertEqual(result.marginal_relief, Decimal("0.00"))
        self.assertEqual(result.surcharge, result.surcharge_before_relief)
        self.assertFalse(result.surcharge_detail["relief_applied"])

    def test_partial_relief_between_the_two(self):
        result = tax_on("5100000")
        self.assertGreater(result.marginal_relief, Decimal("0"))
        self.assertLess(result.marginal_relief, result.surcharge_before_relief)

    def test_relief_never_reaches_into_the_base_tax(self):
        # Relief cancels surcharge and stops. It is not a refund of income tax.
        for income in ["5000001", "10000001", "20000001", "50000001"]:
            with self.subTest(income=income):
                result = tax_on(income)
                self.assertGreaterEqual(result.surcharge, Decimal("0"))
                self.assertLessEqual(result.marginal_relief, result.surcharge_before_relief)

    def test_relief_at_a_higher_band_compares_against_the_band_below(self):
        # At one crore the employee already pays 10% surcharge, so the comparison is against
        # that, not against an unsurcharged figure. Comparing against zero would over-relieve.
        result = tax_on("10000001")
        at_threshold = tax_on("10000000")
        self.assertEqual(Decimal(at_threshold.surcharge_detail["rate"]), Decimal("0.10"))
        self.assertEqual(
            Decimal(result.surcharge_detail["tax_at_threshold"]),
            at_threshold.base_tax + at_threshold.surcharge,
        )

    def test_a_band_may_switch_relief_off(self):
        no_relief = [{"threshold": 5000000, "rate": 0.10, "marginal_relief": False}]
        result = tax_on("5000001", bands=no_relief)
        self.assertEqual(result.marginal_relief, Decimal("0.00"))
        self.assertEqual(result.surcharge, result.surcharge_before_relief)
        self.assertFalse(result.surcharge_detail["marginal_relief_available"])


class FailClosed(unittest.TestCase):
    def test_a_rule_version_with_no_surcharge_key_is_recorded_not_assumed(self):
        # Pre-surcharge rule versions exist and must keep calculating. The distinction that
        # matters is that the trace says why there was none, so "no surcharge was due" can be
        # told apart from "nobody configured whether any was".
        result = tax_on("60000000", surcharge=None)
        self.assertEqual(result.surcharge, Decimal("0.00"))
        self.assertIn("declares no surcharge bands", result.surcharge_detail["reason"])

    def test_a_year_that_levies_none_says_so_explicitly(self):
        result = tax_on("60000000", surcharge={"applicable": False})
        self.assertEqual(result.surcharge, Decimal("0.00"))
        self.assertIn("not levied", result.surcharge_detail["reason"])

    def test_a_band_missing_its_rate_raises_rather_than_guessing(self):
        with self.assertRaises(SurchargeConfigError):
            tax_on("6000000", bands=[{"threshold": 5000000}])

    def test_a_band_missing_its_threshold_raises(self):
        with self.assertRaises(SurchargeConfigError):
            tax_on("6000000", bands=[{"rate": 0.10}])

    def test_a_malformed_surcharge_block_raises(self):
        with self.assertRaises(SurchargeConfigError):
            tax_on("6000000", surcharge="ten percent")

    def test_an_empty_band_list_is_recorded(self):
        result = tax_on("60000000", surcharge={"applicable": True, "bands": []})
        self.assertIn("no bands", result.surcharge_detail["reason"])


class Precision(unittest.TestCase):
    def test_every_figure_is_decimal(self):
        result = tax_on("5100000")
        for value in (result.base_tax, result.surcharge_before_relief,
                      result.marginal_relief, result.surcharge, result.cess,
                      result.annual_tax, result.monthly_tax):
            self.assertIsInstance(value, Decimal)

    def test_figures_are_rounded_to_paise_by_the_shared_helper(self):
        # money() is the engine's one rounding boundary; no ad-hoc round() anywhere here.
        result = tax_on("5000001")
        for value in (result.surcharge_before_relief, result.marginal_relief,
                      result.surcharge, result.annual_tax):
            self.assertEqual(value, value.quantize(Decimal("0.01")))

    def test_a_paisa_over_the_threshold_still_engages_relief(self):
        result = tax_on("5000000.01")
        self.assertTrue(result.surcharge_detail["applicable"])
        self.assertLess(result.surcharge, Decimal("1.00"))

    def test_the_same_input_always_gives_the_same_output(self):
        first, second = tax_on("5100000"), tax_on("5100000")
        self.assertEqual(first.annual_tax, second.annual_tax)
        self.assertEqual(first.marginal_relief, second.marginal_relief)
        self.assertEqual(first.surcharge_detail, second.surcharge_detail)


class Trace(unittest.TestCase):
    def test_the_trace_explains_the_whole_path(self):
        detail = tax_on("5100000").surcharge_detail
        for key in (
            "applicable", "threshold", "rate", "base_tax", "surcharge_before_relief",
            "tax_at_threshold", "income_above_threshold", "liability_before_relief",
            "marginal_relief", "surcharge_after_relief", "relief_applied",
        ):
            self.assertIn(key, detail, key)

    def test_the_trace_reconciles_arithmetically(self):
        result = tax_on("5100000")
        detail = result.surcharge_detail
        self.assertEqual(
            Decimal(detail["surcharge_before_relief"]) - Decimal(detail["marginal_relief"]),
            Decimal(detail["surcharge_after_relief"]),
        )
        self.assertEqual(
            result.annual_tax,
            money(result.base_tax + result.surcharge + result.cess),
        )


class AnnualNotMonthly(unittest.TestCase):
    """Surcharge is decided by the year's income, which is what annualisation produces."""

    def test_a_threshold_crossed_only_because_of_projected_income(self):
        # 4.5L a month actually paid so far, 11 months still to come. One month is nowhere
        # near any threshold; the year is well over the first one.
        result = calculate_income_tax(
            config(), current_taxable_earnings=Decimal("450000"),
            recurring_taxable_earnings=Decimal("450000"),
            months_remaining=12, regime="old",
        )
        self.assertEqual(result.annual_gross_taxable, Decimal("5400000.00"))
        self.assertTrue(result.surcharge_detail["applicable"])

    def test_opening_income_can_be_what_crosses_the_threshold(self):
        # A mid-year joiner whose previous employer already paid them most of the year's
        # income. Without the opening facts this employee looks well under the threshold.
        without = calculate_income_tax(
            config(), current_taxable_earnings=Decimal("400000"),
            recurring_taxable_earnings=Decimal("400000"), months_remaining=6, regime="old",
        )
        with_opening = calculate_income_tax(
            config(), opening_taxable_earnings=Decimal("3200000"),
            current_taxable_earnings=Decimal("400000"),
            recurring_taxable_earnings=Decimal("400000"), months_remaining=6, regime="old",
        )
        self.assertFalse(without.surcharge_detail["applicable"])
        self.assertTrue(with_opening.surcharge_detail["applicable"])

    def test_monthly_tds_spreads_the_annual_liability_net_of_what_was_withheld(self):
        result = calculate_income_tax(
            config(), previous_taxable_earnings=Decimal("2550000"),
            current_taxable_earnings=Decimal("425000"),
            recurring_taxable_earnings=Decimal("425000"),
            months_remaining=6, already_deducted=Decimal("500000"), regime="old",
        )
        outstanding = result.annual_tax - Decimal("500000")
        # The existing reconciliation, unchanged: what is left, over the months left.
        self.assertEqual(result.monthly_tax, money(outstanding / Decimal("6")))

    def test_ytd_withholding_is_not_double_counted(self):
        nothing_withheld = calculate_income_tax(
            config(), previous_taxable_earnings=Decimal("5400000"),
            recurring_taxable_earnings=Decimal("0"), months_remaining=1, regime="old",
        )
        some_withheld = calculate_income_tax(
            config(), previous_taxable_earnings=Decimal("5400000"),
            recurring_taxable_earnings=Decimal("0"), months_remaining=1,
            already_deducted=Decimal("100000"), regime="old",
        )
        # Same annual liability including surcharge; only what is still to collect differs.
        self.assertEqual(nothing_withheld.annual_tax, some_withheld.annual_tax)
        self.assertEqual(
            nothing_withheld.monthly_tax - some_withheld.monthly_tax, Decimal("100000.00"),
        )

    def test_surcharge_is_never_computed_on_the_monthly_figure(self):
        # One month of 4.5L, and it is the last month of the year with nothing before it.
        # The year is 4.5L, under every threshold, so there must be no surcharge — even
        # though twelve such months would have crossed one.
        result = calculate_income_tax(
            config(), current_taxable_earnings=Decimal("450000"),
            recurring_taxable_earnings=Decimal("450000"),
            months_remaining=1, regime="old",
        )
        self.assertEqual(result.annual_gross_taxable, Decimal("450000.00"))
        self.assertEqual(result.surcharge, Decimal("0.00"))


class InteractionWithExistingBehaviour(unittest.TestCase):
    def test_the_rebate_still_applies_and_comes_before_surcharge(self):
        result = tax_on("400000", rebate_limit=500000, rebate_max=12500)
        self.assertGreater(result.rebate_applied, Decimal("0"))
        self.assertEqual(result.surcharge, Decimal("0.00"))

    def test_the_standard_deduction_still_reduces_the_base(self):
        with_deduction = tax_on("5050000", standard_deduction=75000)
        # 50.5L less 75,000 is under the threshold, so no surcharge — the threshold is on
        # taxable income, not on gross.
        self.assertEqual(with_deduction.annual_taxable, Decimal("4975000.00"))
        self.assertEqual(with_deduction.surcharge, Decimal("0.00"))

    def test_cess_is_charged_once_on_tax_plus_relieved_surcharge(self):
        result = tax_on("5100000")
        self.assertEqual(
            result.cess,
            money((result.base_tax + result.surcharge) * Decimal("0.04")),
        )

    def test_a_pre_surcharge_config_produces_exactly_what_it_always_did(self):
        # The regression that matters most: every existing rule version has no surcharge
        # block, and must keep producing the figure it produced before this phase.
        legacy = tax_on("1200000", surcharge=None)
        expected_base = (
            Decimal("250000") * Decimal("0")
            + Decimal("250000") * Decimal("0.05")
            + Decimal("500000") * Decimal("0.20")
            + Decimal("200000") * Decimal("0.30")
        )
        self.assertEqual(legacy.base_tax, money(expected_base))
        self.assertEqual(legacy.cess, money(expected_base * Decimal("0.04")))
        self.assertEqual(legacy.annual_tax, money(expected_base * Decimal("1.04")))


if __name__ == "__main__":
    unittest.main()
