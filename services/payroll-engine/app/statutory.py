"""India statutory calculations: PF, ESI, Professional Tax and income tax.

Pure functions over a rule configuration. The configuration is always passed in — it is
read from the payroll snapshot, which pinned the exact rule version at run creation — so a
slab change published tomorrow can never alter a run that is already under review
(ADR-005, invariants.md#payroll).

All money is Decimal. Floats would introduce rounding drift that, accumulated over
thousands of payslips, produces reconciliation differences nobody can explain.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

ZERO = Decimal("0.00")


def money(value: Any) -> Decimal:
    """Rounds to paise using banker-free half-up, which is what payroll statements expect."""
    return Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def rupees(value: Any) -> Decimal:
    """Statutory deductions are conventionally reported in whole rupees."""
    return Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP)


class PfConfigError(ValueError):
    """A PF configuration the engine will not guess at. Fails this employee."""


@dataclass(frozen=True)
class PfResult:
    employee: Decimal
    employer: Decimal
    employer_pension: Decimal
    wage_base: Decimal
    capped: bool
    detail: dict[str, Any] = field(default_factory=dict)


def _required_rate(config: dict[str, Any], key: str) -> Decimal:
    """A statutory rate, from the rule and only from the rule.

    No default. A rate that falls back to a literal in this file is exactly the
    "scattered as hard-coded logic" the PRD's statutory-rule requirement rules out: a rule
    version missing its employee rate would deduct twelve percent that nobody configured,
    and the payslip would look entirely ordinary. The same reasoning already governs
    surcharge bands and professional-tax slabs.
    """
    if key not in config or config[key] is None:
        raise PfConfigError(
            f"the provident fund rule does not configure {key}; refusing to apply a rate "
            "nobody set"
        )
    return Decimal(str(config[key]))


def calculate_pf(pf_wage: Decimal, config: dict[str, Any], applicable: bool = True) -> PfResult:
    """Provident Fund on the PF wage.

    What constitutes the PF wage is decided by the caller from the rule's
    `basis_component_codes`, not assumed here — the basis is a statutory question and this
    function never sees the salary structure.

    The wage ceiling is applied when the rule says so. Whether an employer restricts PF to
    the ceiling for higher earners is a policy the rule states; it is not inferred, because
    the two readings differ by real money in both directions and nothing in the product
    requirements settles it.
    """
    if not applicable:
        return PfResult(ZERO, ZERO, ZERO, ZERO, False,
                        {"applicable": False, "reason": "provident fund does not apply to this employee"})
    if pf_wage <= 0:
        return PfResult(ZERO, ZERO, ZERO, ZERO, False,
                        {"applicable": True, "wage_basis": str(money(pf_wage)),
                         "reason": "no provident fund wage was paid this period"})

    employee_rate = _required_rate(config, "employee_rate")
    employer_rate = _required_rate(config, "employer_rate")
    pension_rate = _required_rate(config, "employer_pension_rate")

    ceiling = Decimal(str(config.get("wage_ceiling") or 0))
    if ceiling > 0 and "apply_ceiling" not in config:
        # A configured ceiling with no statement of whether it binds is the one genuinely
        # ambiguous case: applying it under-deducts against not applying it, and both are
        # real employer policies. Refuse rather than pick one.
        raise PfConfigError(
            "the provident fund rule sets a wage ceiling but does not say whether it applies; "
            "set apply_ceiling explicitly"
        )
    apply_ceiling = bool(config.get("apply_ceiling")) and ceiling > 0
    base = min(pf_wage, ceiling) if apply_ceiling else pf_wage

    employee = rupees(base * employee_rate)
    employer_total = rupees(base * employer_rate)
    pension = rupees(base * pension_rate)
    # The employer's share splits between the pension scheme and the PF account; the
    # pension portion can never exceed the total employer contribution.
    pension = min(pension, employer_total)

    return PfResult(
        employee=employee,
        employer=employer_total,
        employer_pension=pension,
        wage_base=money(base),
        capped=apply_ceiling and pf_wage > ceiling,
        detail={
            "applicable": True,
            "wage_basis": str(money(pf_wage)),
            "contributory_wage": str(money(base)),
            "employee_rate": str(employee_rate),
            "employer_rate": str(employer_rate),
            "employer_pension_rate": str(pension_rate),
            "employee_contribution": str(employee),
            "employer_contribution": str(employer_total),
            "employer_pension_share": str(pension),
            "wage_ceiling": str(money(ceiling)) if ceiling > 0 else None,
            "ceiling_applied": apply_ceiling and pf_wage > ceiling,
        },
    )


class EsiConfigError(ValueError):
    """An ESI configuration the engine will not guess at. Fails this employee."""


@dataclass(frozen=True)
class EsiResult:
    employee: Decimal
    employer: Decimal
    eligible: bool
    detail: dict[str, Any] = field(default_factory=dict)


def _required_esi_figure(config: dict[str, Any], key: str) -> Decimal:
    """A statutory figure, from the rule and only from the rule.

    No default, for the same reason provident fund has none (ADR-021): a rate that falls
    back to a literal here is the "scattered as hard-coded logic" the PRD's statutory-rule
    requirement rules out. The ceiling matters most of the three — it is not a cap on the
    contribution but the **eligibility test**, so a rule without one cannot answer who is
    covered at all, and guessing would silently enrol or exclude people.
    """
    if key not in config or config[key] is None:
        raise EsiConfigError(
            f"the employees' state insurance rule does not configure {key}; refusing to "
            "apply a figure nobody set"
        )
    return Decimal(str(config[key]))


def calculate_esi(gross: Decimal, config: dict[str, Any], applicable: bool = True) -> EsiResult:
    """Employees' State Insurance for one payroll period.

    Eligibility is derived from the wage rather than from an attribute on the employee: an
    employee whose gross for the period exceeds the ceiling is outside the scheme, and one
    below it is inside. Nothing else about them is consulted, which is why no "ESI eligible"
    flag exists and none is needed.

    The wage basis is the period's **gross earnings**. That is existing behaviour rather than
    an assumption made here — the rule's own key is `gross_wage_ceiling`, and the caller has
    always passed gross. It is deliberately not configurable: unlike the provident fund,
    which names its contributing components, nothing in the product requirements asks for an
    ESI basis other than gross, and inventing one would be inventing statute.
    """
    if not applicable:
        return EsiResult(ZERO, ZERO, False,
                         {"applicable": False,
                          "reason": "ESI does not apply to this employee"})

    ceiling = _required_esi_figure(config, "gross_wage_ceiling")
    employee_rate = _required_esi_figure(config, "employee_rate")
    employer_rate = _required_esi_figure(config, "employer_rate")

    base_detail = {
        "applicable": True,
        "wage_basis_kind": "gross_earnings",
        "wage_basis": str(money(gross)),
        "gross_wage_ceiling": str(money(ceiling)),
        "employee_rate": str(employee_rate),
        "employer_rate": str(employer_rate),
    }

    if gross > ceiling:
        # Out of the scheme for this period, which is not the same as contributing zero:
        # the payslip should be able to say the wage exceeded the ceiling.
        return EsiResult(ZERO, ZERO, False, {
            **base_detail,
            "eligible": False,
            "ceiling_exceeded": True,
            "employee_contribution": "0",
            "employer_contribution": "0",
            "reason": (
                f"gross earnings {money(gross)} exceed the ESI wage ceiling {money(ceiling)}"
            ),
        })

    employee = rupees(gross * employee_rate)
    employer = rupees(gross * employer_rate)

    return EsiResult(
        employee=employee,
        employer=employer,
        eligible=True,
        detail={
            **base_detail,
            "eligible": True,
            "ceiling_exceeded": False,
            "employee_contribution": str(employee),
            "employer_contribution": str(employer),
        },
    )


class ProfessionalTaxConfigError(ValueError):
    """A PT configuration the engine will not guess at. Fails this employee."""


@dataclass(frozen=True)
class ProfessionalTaxResult:
    """One period's PT, with everything that decided it."""

    amount: Decimal = ZERO
    detail: dict[str, Any] = field(default_factory=dict)


def calculate_professional_tax(
    wage_basis: Decimal,
    config: dict[str, Any] | None,
    *,
    period_month: int | None = None,
    paid_this_year: Decimal = ZERO,
) -> ProfessionalTaxResult:
    """State professional tax for one payroll period.

    A **period** deduction, not an annual liability divided by twelve. The slab figures are
    monthly amounts against a monthly wage, so nothing here goes near the income-tax
    annualisation: an employee is in whichever band this period's earnings put them in, and
    a month of loss of pay that drops them a band pays the lower amount for that month.
    That falls out of the slab rather than being a proration rule, and it is deterministic.

    Three things the previous implementation could not express, each a real part of a real
    state's schedule:

      * **a special month.** Maharashtra charges 300 in February against 200 in the other
        eleven, so the year totals 2,500. The month comes from the payroll period being
        calculated and the amount from the rule; no month number appears in this file.
      * **an annual ceiling.** Never binding for a full year at Maharashtra's amounts, but it
        decides what an employee who transfers state or changes band mid-year pays.
      * **the difference between "this state levies none" and "nobody configured this
        state".** Both used to deduct zero and look identical afterwards.

    The last one is why this returns a result with a reason rather than a bare Decimal.
    """
    if not config:
        # No rule reached the snapshot for this jurisdiction. Node decides whether that is a
        # refusal or an accepted absence; here it is recorded, never guessed at.
        return ProfessionalTaxResult(
            ZERO,
            {"applicable": False, "reason": "no professional tax rule was resolved for this employee"},
        )

    if config.get("applicable") is False:
        return ProfessionalTaxResult(
            ZERO,
            {
                "applicable": False,
                "reason": f"{config.get('state_name') or 'this state'} levies no professional tax",
            },
        )

    slabs = config.get("slabs") or []
    if not slabs:
        raise ProfessionalTaxConfigError(
            "professional tax rule has no slabs; refusing to deduct an amount nobody configured"
        )

    matched = None
    for slab in slabs:
        upto = slab.get("upto")
        if upto is None or wage_basis <= Decimal(str(upto)):
            matched = slab
            break

    if matched is None:
        # Slabs that stop short of the wage with no open-ended band. A gap in the schedule is
        # a configuration error, not a zero.
        raise ProfessionalTaxConfigError(
            f"no professional tax slab covers a wage of {money(wage_basis)}; "
            "the schedule needs an open-ended top band"
        )

    if "amount" not in matched:
        raise ProfessionalTaxConfigError(
            f"professional tax slab {matched!r} has no amount"
        )

    standard = rupees(matched["amount"])
    amount = standard
    detail: dict[str, Any] = {
        "applicable": True,
        "state_name": config.get("state_name"),
        "wage_basis_kind": config.get("wage_basis", "gross_earnings"),
        "wage_basis": str(money(wage_basis)),
        "frequency": config.get("frequency", "monthly"),
        "matched_slab": matched.get("label") or _slab_label(matched),
        "standard_amount": str(standard),
        "special_month_adjustment": "0",
        "annual_cap_applied": False,
    }

    # --- the special instalment ----------------------------------------------
    special = matched.get("special_months") or {}
    if period_month is not None and special:
        # Keys arrive as strings from jsonb and as ints from a literal; accept both rather
        # than depending on how the rule happened to be written down.
        override = special.get(str(period_month), special.get(period_month))
        if override is not None:
            amount = rupees(override)
            detail["special_month_adjustment"] = str(amount - standard)
            detail["special_month"] = period_month

    # --- the annual ceiling ---------------------------------------------------
    cap = config.get("annual_cap")
    if cap is not None:
        remaining = rupees(cap) - rupees(paid_this_year)
        if remaining < ZERO:
            remaining = ZERO
        detail["annual_cap"] = str(rupees(cap))
        detail["paid_this_year"] = str(rupees(paid_this_year))
        if amount > remaining:
            detail["annual_cap_applied"] = True
            detail["uncapped_amount"] = str(amount)
            amount = remaining

    detail["final_amount"] = str(amount)
    return ProfessionalTaxResult(amount, detail)


def _slab_label(slab: dict[str, Any]) -> str:
    """A readable band for a rule that did not supply one."""
    upto = slab.get("upto")
    return f"up to {upto}" if upto is not None else "above the highest band"


@dataclass(frozen=True)
class IncomeTaxResult:
    #: Estimated taxable salary for the whole year, before exemptions.
    annual_gross_taxable: Decimal
    #: After the standard deduction and any allowed declared deductions.
    annual_taxable: Decimal
    annual_tax: Decimal
    monthly_tax: Decimal
    rebate_applied: Decimal
    cess: Decimal
    #: The part of the annual estimate that is a projection rather than an actual.
    projected_future: Decimal
    regime: str
    #: Income tax after the rebate and before surcharge. The base surcharge is charged on.
    base_tax: Decimal = ZERO
    #: Surcharge at the band rate, before any relief.
    surcharge_before_relief: Decimal = ZERO
    #: Reduction under the marginal-relief rule. Zero when the rule does not bite.
    marginal_relief: Decimal = ZERO
    #: What is actually charged: surcharge_before_relief less marginal_relief, floored at 0.
    surcharge: Decimal = ZERO
    #: The band that applied, and why. Empty when no threshold was crossed.
    surcharge_detail: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SurchargeBand:
    threshold: Decimal
    rate: Decimal
    marginal_relief: bool


class SurchargeConfigError(ValueError):
    """A surcharge configuration the engine will not guess at. Fails this employee."""


def _surcharge_bands(rules: dict[str, Any]) -> tuple[list[SurchargeBand], str | None]:
    """The bands for this regime, or a stated reason there are none.

    Three outcomes, and the difference between the second and third is the whole point of
    §5's "never silently use a fallback":

      * bands configured      -> use them
      * `applicable: false`   -> this year/regime genuinely levies no surcharge
      * no `surcharge` key    -> a rule version that predates surcharge support

    The third is recorded in the trace rather than treated as zero, so a run that charged no
    surcharge can be told apart from a run where nobody had configured whether it should.
    A malformed band is neither: it raises, because a threshold with no rate is a
    configuration error and guessing at it would put a wrong number on a payslip.
    """
    raw = rules.get("surcharge")
    if raw is None:
        return [], "this income tax rule version declares no surcharge bands"
    if not isinstance(raw, dict):
        raise SurchargeConfigError("surcharge configuration must be an object")
    if raw.get("applicable") is False:
        return [], "surcharge is not levied for this tax year and regime"

    bands: list[SurchargeBand] = []
    for entry in raw.get("bands") or []:
        if "threshold" not in entry or "rate" not in entry:
            raise SurchargeConfigError(
                f"surcharge band {entry!r} is missing a threshold or a rate"
            )
        bands.append(
            SurchargeBand(
                threshold=Decimal(str(entry["threshold"])),
                rate=Decimal(str(entry["rate"])),
                marginal_relief=bool(entry.get("marginal_relief", True)),
            )
        )

    if not bands:
        return [], "surcharge is configured with no bands"

    # Low to high, so "the highest threshold crossed" is unambiguous however the rule was
    # written down.
    bands.sort(key=lambda b: b.threshold)
    return bands, None


def _slab_tax(taxable: Decimal, rules: dict[str, Any]) -> Decimal:
    """Income tax on a taxable figure, before rebate, surcharge and cess.

    Extracted so marginal relief can ask the same question about a different income — the
    tax at the threshold — and get an answer computed by identical rules. Two
    implementations of the slab walk would eventually disagree, and the disagreement would
    show up as a few hundred rupees of relief nobody could account for.
    """
    tax = ZERO
    previous_ceiling = Decimal("0")
    for slab in rules.get("slabs", []):
        upto = slab.get("upto")
        ceiling = Decimal(str(upto)) if upto is not None else None
        rate = Decimal(str(slab.get("rate", 0)))

        if ceiling is None:
            slice_amount = max(ZERO, taxable - previous_ceiling)
        else:
            slice_amount = max(ZERO, min(taxable, ceiling) - previous_ceiling)
            previous_ceiling = ceiling

        tax += slice_amount * rate
        if ceiling is not None and taxable <= ceiling:
            break
    return tax


def _tax_after_rebate(taxable: Decimal, rules: dict[str, Any]) -> tuple[Decimal, Decimal]:
    """Slab tax less any section 87A rebate. Returns (tax, rebate)."""
    tax = _slab_tax(taxable, rules)
    rebate = ZERO
    rebate_limit = Decimal(str(rules.get("rebate_limit", 0) or 0))
    if rebate_limit > 0 and taxable <= rebate_limit:
        rebate = min(tax, Decimal(str(rules.get("rebate_max", 0) or 0)))
        tax -= rebate
    return tax, rebate


def calculate_surcharge(
    taxable: Decimal,
    base_tax: Decimal,
    rules: dict[str, Any],
) -> tuple[Decimal, Decimal, Decimal, dict[str, Any]]:
    """Surcharge and marginal relief on an **annual** taxable income.

    Annual, never monthly, and that is not a simplification: the bands are thresholds on the
    year's total income, so a month of a large salary tells you nothing about whether the
    year crosses five million. Applying a band to one month's figure would surcharge an
    employee who never reaches the threshold and miss one who reaches it in March.

    Marginal relief, implemented as the statute states it rather than approximated. When
    income crosses a threshold, the surcharge can cost more than the income that triggered
    it — an employee earning a rupee over fifty lakh would otherwise pay over a lakh more
    tax than one earning a rupee under. So the increase in tax is capped at the increase in
    income:

        relief = (tax + surcharge at I) - (tax payable at the threshold) - (I - threshold)

    taken when positive. The result satisfies, by construction:

        tax after relief <= tax at the threshold + income above the threshold

    Relief is computed on tax **before** cess, which is then charged on the relieved figure.
    Charging cess first and relieving afterwards would relieve 4% too much.

    Returns (before_relief, relief, after_relief, trace).
    """
    bands, reason = _surcharge_bands(rules)
    if not bands:
        return ZERO, ZERO, ZERO, {"applicable": False, "reason": reason}

    # The highest band whose threshold the income exceeds. Strictly exceeds: an income of
    # exactly fifty lakh is not *above* fifty lakh, and the Act charges surcharge on income
    # exceeding the threshold.
    band = None
    for candidate in bands:
        if taxable > candidate.threshold:
            band = candidate

    if band is None:
        return ZERO, ZERO, ZERO, {
            "applicable": False,
            "reason": (
                f"annual taxable income {money(taxable)} does not exceed the first surcharge "
                f"threshold of {money(bands[0].threshold)}"
            ),
            "first_threshold": str(money(bands[0].threshold)),
        }

    before_relief = base_tax * band.rate

    trace: dict[str, Any] = {
        "applicable": True,
        "threshold": str(money(band.threshold)),
        "rate": str(band.rate),
        "base_tax": str(money(base_tax)),
        "surcharge_before_relief": str(money(before_relief)),
        "marginal_relief_available": band.marginal_relief,
    }

    if not band.marginal_relief:
        trace["marginal_relief"] = "0.00"
        trace["surcharge_after_relief"] = str(money(before_relief))
        return money(before_relief), ZERO, money(before_relief), trace

    # What an employee earning exactly the threshold would pay: slab tax at the threshold,
    # plus the surcharge of the band *below* this one, because at exactly the threshold this
    # band does not yet apply.
    tax_at_threshold, _ = _tax_after_rebate(band.threshold, rules)
    lower_rate = ZERO
    for candidate in bands:
        if band.threshold > candidate.threshold:
            lower_rate = candidate.rate
    liability_at_threshold = tax_at_threshold + (tax_at_threshold * lower_rate)

    excess_income = taxable - band.threshold
    liability_here = base_tax + before_relief
    relief = liability_here - liability_at_threshold - excess_income
    if relief < ZERO:
        relief = ZERO
    # Relief only ever cancels the surcharge; it never reaches into the base tax.
    if relief > before_relief:
        relief = before_relief

    after_relief = before_relief - relief

    trace.update({
        "tax_at_threshold": str(money(liability_at_threshold)),
        "income_above_threshold": str(money(excess_income)),
        "liability_before_relief": str(money(liability_here)),
        "marginal_relief": str(money(relief)),
        "surcharge_after_relief": str(money(after_relief)),
        "relief_applied": relief > ZERO,
    })

    return money(before_relief), money(relief), money(after_relief), trace


def calculate_income_tax(
    config: dict[str, Any],
    *,
    opening_taxable_earnings: Decimal = ZERO,
    previous_taxable_earnings: Decimal = ZERO,
    current_taxable_earnings: Decimal = ZERO,
    recurring_taxable_earnings: Decimal | None = None,
    projected_exemption: Decimal = ZERO,
    regime: str = "new",
    declared_deductions: Decimal = ZERO,
    months_remaining: int = 12,
    already_deducted: Decimal = ZERO,
) -> IncomeTaxResult:
    """TDS on the year's estimated salary income, net of what has already been withheld.

    The annual estimate is built from what is known plus what is scheduled, never from
    multiplying this month by twelve:

        annual = opening              income from a previous employer this year
               + previous             what we have actually paid, from finalized slips
               + current              this period
               + recurring × (months_remaining - 1)     what is still scheduled
               - projected_exemption                     what those periods will exempt

    Each term earns its place. Without *opening*, a mid-year joiner looks like a low earner
    and is under-deducted all year — a section 192(2) exposure for the employer and a
    self-assessment bill for the employee. Without *previous*, a raise in September would be
    projected backwards over months that were paid at the old salary, and October's
    deduction would spike to correct a liability that never existed. And projecting
    *recurring* rather than *current* is what stops a one-off bonus being treated as
    eleven more to come.

    *projected_exemption* is the odd one out, and deliberately so. It is a total the caller
    has already worked out period by period, not a rate to be multiplied here — because an
    exemption is not proportional to salary the way the rest of this is. Rent changes on its
    own schedule and can stop partway through the year, so the only correct way to project
    it is to evaluate each remaining period separately and hand over the sum. Multiplying a
    monthly exemption by the months left would be wrong for anyone who moves house, and
    wrong in the direction that under-deducts.

    *current_taxable_earnings* arrives with this period's own exemption already subtracted,
    which is also what gets written to the payslip — so next period's *previous* term picks
    the accumulation up for free, effective-dated, with no separate ledger to keep in step.

    The monthly figure is then (annual liability - already withheld) / months remaining.
    Both terms matter: subtracting what was withheld stops the same tax being collected
    twice, and dividing by the months left spreads any correction over the rest of the year
    instead of retrospectively changing payslips that have been finalized.

    The annual liability itself is built in the order the Act sets, and the order matters at
    every step:

        annual taxable income
          -> slab tax
          -> less section 87A rebate                  = base tax
          -> plus surcharge at the band rate          = surcharge before relief
          -> less marginal relief                     = surcharge charged
          -> plus health and education cess on (base tax + surcharge)
          = annual tax liability

    Surcharge is annual because its thresholds are thresholds on the year's total income.
    One month of a large salary says nothing about whether the year crosses five million,
    so a monthly band test would surcharge someone who never gets there and miss someone
    who does in March.
    """
    if months_remaining < 1:
        raise ValueError(f"months_remaining must be at least 1, got {months_remaining}")

    # A supplementary run, or a period with no recurring salary, projects nothing forward.
    recurring = current_taxable_earnings if recurring_taxable_earnings is None else recurring_taxable_earnings
    if recurring < 0:
        recurring = ZERO

    projected_future = money(recurring * Decimal(months_remaining - 1)) - money(projected_exemption)
    # An exemption cannot make future income negative; at worst it cancels it entirely.
    if projected_future < ZERO:
        projected_future = ZERO

    annual_gross_taxable = money(
        opening_taxable_earnings + previous_taxable_earnings + current_taxable_earnings + projected_future
    )

    regimes = config.get("regimes", {})
    rules = regimes.get(regime) or regimes.get("new") or {}

    standard_deduction = Decimal(str(rules.get("standard_deduction", 0)))
    # The old regime allows declared investments; the new regime does not.
    allowed_deductions = declared_deductions if regime == "old" else ZERO

    taxable = annual_gross_taxable - standard_deduction - allowed_deductions
    if taxable < 0:
        taxable = ZERO

    # Slabs, then the section 87A rebate. Both live in helpers because marginal relief has
    # to ask the same question about the income at the threshold, and two implementations of
    # the slab walk would eventually disagree by a few hundred rupees nobody could account
    # for.
    tax, rebate = _tax_after_rebate(taxable, rules)

    # Surcharge sits between the rebate and the cess, which is the order the Act sets: it is
    # charged on the income tax after rebate, and the cess is then charged on tax plus
    # surcharge. Putting cess first would under-charge it; relieving after cess would
    # over-relieve by the cess rate.
    surcharge_before, marginal_relief, surcharge, surcharge_detail = calculate_surcharge(
        taxable, tax, rules
    )

    cess = (tax + surcharge) * Decimal(str(rules.get("cess_rate", 0.04)))
    annual_tax = money(tax + surcharge + cess)

    # Over-deduction earlier in the year produces a negative remainder. TDS is not
    # refunded through payroll, so the monthly figure floors at zero and the excess is
    # reclaimed by the employee when they file.
    outstanding = max(ZERO, annual_tax - already_deducted)

    return IncomeTaxResult(
        annual_gross_taxable=annual_gross_taxable,
        annual_taxable=money(taxable),
        annual_tax=annual_tax,
        monthly_tax=money(outstanding / Decimal(months_remaining)),
        rebate_applied=money(rebate),
        cess=money(cess),
        projected_future=projected_future,
        regime=regime,
        base_tax=money(tax),
        surcharge_before_relief=surcharge_before,
        marginal_relief=marginal_relief,
        surcharge=surcharge,
        surcharge_detail=surcharge_detail,
    )
