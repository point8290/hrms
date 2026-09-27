"""Payroll calculation.

Input is one payroll_input_snapshot and nothing else (ADR-005). The engine never reads
live employee, attendance, leave or compensation tables — that is what makes a run
reproducible: the same snapshot and the same CALCULATION_VERSION always produce the same
payslip, today or a year from now.

Pure functions, Decimal arithmetic, no I/O.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from .exemptions import ExemptionResult, SectionExemption, calculate_section_exemptions
from .hra import (
    HraAnnual,
    HraError,
    calculate_period_exemption,
    not_applicable,
    regime_allows_hra,
    resolve_role_amounts,
)
from .statutory import (
    ZERO,
    EsiConfigError,
    PfConfigError,
    calculate_esi,
    calculate_income_tax,
    calculate_pf,
    calculate_professional_tax,
    money,
)

# 2025.4 introduced chapter VI-A section caps (80C, 80D and the rest), which before it were
# applied uncapped. 2025.5 added the proof cutoff: a declaration still unproved once the tax
# year's cutoff has passed stops reducing tax. 2025.6 adds surcharge and marginal relief on
# the annual liability. A slip computed under a different version is distinguishable by it,
# and finalized slips keep the version that produced them.
CALCULATION_VERSION = "in-payroll-2025.6"

# Statutory deductions that reduce taxable salary income, unless the rule configuration
# says otherwise. Employee PF is deductible under section 80C and professional tax under
# section 16(iii); ESI is not. Defaulting from the statute rather than from configuration
# means a tenant who has not thought about it still gets the legally correct answer, and a
# tenant in another jurisdiction can override it per rule version.
_REDUCES_TAXABLE_BY_DEFAULT = {"pf": True, "professional_tax": True, "esi": False}


class PayrollError(Exception):
    """A snapshot the engine cannot calculate. Fails this employee, never the whole run."""


@dataclass
class ComponentLine:
    code: str
    name: str
    component_type: str  # earning | deduction | employer_contribution
    amount: Decimal
    is_statutory: bool = False
    # Whether this line entered the income-tax base. Earnings add, deductions subtract.
    taxable: bool = False
    exempted_from_income_tax: bool = False
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass
class PayrollResult:
    employee_id: str
    total_days: Decimal
    payable_days: Decimal
    lop_days: Decimal
    gross_amount: Decimal = ZERO
    deduction_amount: Decimal = ZERO
    tax_amount: Decimal = ZERO
    employer_contribution: Decimal = ZERO
    net_amount: Decimal = ZERO
    # The base income tax was computed on. Persisted so the next period can annualise from
    # what was actually paid rather than re-deriving it from gross.
    taxable_earnings: Decimal = ZERO
    # Section 10(13A), already subtracted from taxable_earnings. Carried separately because
    # the next period's annualisation and any year-end statement need the figure itself, not
    # a difference they would have to reconstruct.
    hra_exemption: Decimal = ZERO
    # Chapter VI-A allowed for the year after caps. An *annual* figure applied to the annual
    # estimate, unlike hra_exemption which is this period's own.
    section_exemption_total: Decimal = ZERO
    currency: str = "INR"
    components: list[ComponentLine] = field(default_factory=list)
    calculation_version: str = CALCULATION_VERSION


def _d(value: Any, default: str = "0") -> Decimal:
    if value is None or value == "":
        return Decimal(default)
    return Decimal(str(value))


def compute_payable_days(attendance: dict[str, Any]) -> tuple[Decimal, Decimal, Decimal]:
    """Total, payable and LOP days for the period.

    Payable days start from the days actually employed, so a mid-month joiner is paid
    from their joining date rather than for the whole month, and LOP is subtracted from
    that rather than from the calendar.
    """
    total = _d(attendance.get("total_days", 0))
    employed = _d(attendance.get("employed_days", total))
    lop = _d(attendance.get("lop_units", 0))

    payable = employed - lop
    if payable < 0:
        payable = ZERO
    return total, payable, lop


def resolve_full_values(
    components: list[dict[str, Any]],
    base_amount: Decimal,
) -> dict[str, Decimal]:
    """Every component's full, un-prorated value, in structure order.

    Un-prorated on purpose: a percentage component resolves against the *full* figure of its
    base, and loss of pay is applied once at the end rather than compounding through the
    chain. `BASE` seeds the map because a structure is conventionally expressed as
    percentages of it.

    Shared with the HRA projection, which needs the same answer for a future period where
    there is no attendance yet and so no pro-rating to apply. One implementation, so a
    projected basic can never be computed by different rules than the paid one.
    """
    full: dict[str, Decimal] = {"BASE": base_amount}

    for component in sorted(components, key=lambda c: int(c.get("sequence_no", 0))):
        # Statutory components come from the pinned rule version, not from the structure.
        if component.get("calculation_type") == "statutory":
            continue

        code = component["code"]
        if component.get("fixed_amount") is not None:
            value = _d(component["fixed_amount"])
        elif component.get("percentage") is not None:
            basis_code = component.get("percentage_of_code") or "BASE"
            basis = full.get(basis_code)
            if basis is None:
                raise PayrollError(
                    f"component {code} is a percentage of {basis_code}, which is not defined "
                    "earlier in the structure"
                )
            value = money(basis * _d(component["percentage"]) / Decimal("100"))
        else:
            raise PayrollError(
                f"component {code} has no fixed amount or percentage; formulas are not supported yet"
            )

        max_amount = component.get("max_amount")
        if max_amount is not None:
            value = min(value, _d(max_amount))

        full[code] = value

    return full


def _pro_rate(amount: Decimal, payable_days: Decimal, total_days: Decimal) -> Decimal:
    if total_days <= 0:
        return ZERO
    return money(amount * payable_days / total_days)


def require_statutory_rules(snapshot: dict[str, Any]) -> None:
    """Refuses an employee whose statutory configuration cannot be resolved.

    Deducting zero because a rule is missing is indistinguishable, on the payslip, from
    deducting zero because none is due — and the first is an under-deduction the employer
    is liable for. The snapshot records which rules this employee's tax profile asserts
    they need; anything absent fails this employee and only this employee.

    The message carries everything an administrator needs to fix it without opening the
    database: who, which rule, which year, which jurisdiction.
    """
    statutory = snapshot.get("statutory_json") or {}
    required = statutory.get("required") or []
    employee = snapshot.get("employee_json") or {}
    tax_info = snapshot.get("tax_json") or {}

    missing = []
    for key in required:
        rule = statutory.get(key)
        if not isinstance(rule, dict) or not rule.get("config"):
            missing.append(key)

    if missing:
        code = employee.get("employee_code") or employee.get("id") or "unknown"
        year = tax_info.get("financial_year") or "unknown financial year"
        state = employee.get("state_code") or "no state"
        raise PayrollError(
            f"employee {code} requires statutory rule(s) {', '.join(sorted(missing))} "
            f"for {year} in jurisdiction IN/{state}, and no effective version is configured. "
            "Payroll will not substitute zero for a rule it cannot resolve."
        )


def _apply_overwrites(
    components: list[dict[str, Any]], additional: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Folds overwriting additional-salary rows into the structure.

    Ordering is the whole point. An overwrite replaces the component's value *before*
    pro-rating and before any percentage resolves against it, so a component defined as a
    percentage of an overwritten one follows the correction instead of the structure's
    original figure. Applying it afterwards, as a second line, would leave every dependent
    component wrong.

    Returns the corrected structure and the additional rows that remain additive.
    """
    overwrites = {row["code"]: row for row in additional if row.get("overwrites_structure")}
    if not overwrites:
        return components, list(additional)

    corrected: list[dict[str, Any]] = []
    applied: set[str] = set()
    for component in components:
        code = component["code"]
        overwrite = overwrites.get(code)
        if overwrite is None:
            corrected.append(component)
            continue

        replaced = dict(component)
        # An overwrite states an amount, so whatever basis the structure used no longer
        # applies — a percentage that stayed alongside a fixed amount would be ambiguous.
        replaced["fixed_amount"] = overwrite["amount"]
        replaced["percentage"] = None
        replaced["percentage_of_code"] = None
        replaced["overwritten_by"] = overwrite["id"]
        corrected.append(replaced)
        applied.add(code)

    unapplied = sorted(set(overwrites) - applied)
    if unapplied:
        raise PayrollError(
            f"additional salary overwrites component(s) {', '.join(unapplied)}, which are not in "
            "this employee's salary structure for the period"
        )

    remaining = [row for row in additional if not row.get("overwrites_structure")]
    return corrected, remaining


def calculate(snapshot: dict[str, Any]) -> PayrollResult:
    """Calculates one employee's payslip from their frozen snapshot."""
    employee = snapshot.get("employee_json") or {}
    attendance = snapshot.get("attendance_json") or {}
    compensation = snapshot.get("compensation_json") or {}
    tax_info = snapshot.get("tax_json") or {}
    statutory = snapshot.get("statutory_json") or {}
    additional = list(snapshot.get("additional_json") or [])

    employee_id = employee.get("id")
    if not employee_id:
        raise PayrollError("snapshot is missing employee identity")

    require_statutory_rules(snapshot)

    # A supplementary run corrects a period the regular run already paid. It pays the
    # one-off amounts attached to it and nothing else; re-running the structure would pay
    # the employee a second full salary.
    pay_structure = bool(compensation.get("pay_structure", True))

    if pay_structure and not compensation.get("components"):
        raise PayrollError("no salary structure resolved for this period")
    if not pay_structure and not additional:
        raise PayrollError("a supplementary run needs at least one additional salary amount to pay")

    total_days, payable_days, lop_days = compute_payable_days(attendance)

    result = PayrollResult(
        employee_id=employee_id,
        total_days=total_days,
        payable_days=payable_days,
        lop_days=lop_days,
        currency=compensation.get("currency", "INR"),
    )

    base_amount = _d(compensation.get("base_amount", 0))
    structure_components = list(compensation.get("components") or []) if pay_structure else []
    structure_components, additional = _apply_overwrites(structure_components, additional)
    components = sorted(structure_components, key=lambda c: int(c.get("sequence_no", 0)))

    # Full (un-prorated) values, so a percentage component resolves against the full
    # figure of its base and LOP is applied once, at the end, rather than compounding.
    full_values = resolve_full_values(components, base_amount)
    earnings: list[ComponentLine] = []
    structure_deductions: list[ComponentLine] = []

    for component in components:
        code = component["code"]

        if component.get("calculation_type", "fixed") == "statutory":
            # Statutory components are computed below from the rule configuration, not
            # from the structure, so that the rule version in the snapshot is the authority.
            continue

        value = full_values[code]

        affects_lop = bool(component.get("affects_lop", True))
        payable_value = _pro_rate(value, payable_days, total_days) if affects_lop else money(value)

        detail = {
            "full_amount": str(money(value)),
            "pro_rated": affects_lop,
            "payable_days": str(payable_days),
            "total_days": str(total_days),
        }
        if component.get("overwritten_by"):
            detail["overwritten_by_additional_salary"] = component["overwritten_by"]

        line = ComponentLine(
            code=code,
            name=component.get("name", code),
            component_type=component["component_type"],
            amount=payable_value,
            taxable=bool(component.get("taxable", True)),
            exempted_from_income_tax=bool(component.get("exempted_from_income_tax", False)),
            detail=detail,
        )
        (earnings if component["component_type"] == "earning" else structure_deductions).append(line)

    # One-off amounts are never pro-rated: a bonus or an arrear is a fixed sum for the
    # period, not a daily rate. They are also never projected forward when estimating the
    # year's income — see the annualisation below.
    one_off_taxable = ZERO
    for entry in additional:
        amount = _d(entry.get("amount", 0))
        is_earning = amount >= 0
        line = ComponentLine(
            code=entry.get("code", "ADDITIONAL"),
            name=entry.get("name", "Additional"),
            component_type="earning" if is_earning else "deduction",
            amount=money(abs(amount)),
            taxable=bool(entry.get("taxable", True)),
            exempted_from_income_tax=bool(entry.get("exempted_from_income_tax", False)),
            detail={
                "kind": entry.get("kind"),
                "source": entry.get("source_type") or "additional_salary",
                "source_id": entry.get("source_id"),
                "pro_rated": False,
            },
        )
        if is_earning and line.taxable:
            one_off_taxable += line.amount
        (earnings if is_earning else structure_deductions).append(line)

    gross = money(sum((line.amount for line in earnings), ZERO))

    # ----------------------------------------------------------- provident fund
    #
    # The PF wage is whichever earning components the rule names, **as actually paid this
    # period** — so loss of pay reduces the PF wage exactly as it reduces the salary, and a
    # mid-month joiner contributes on what they were paid. That falls out of reading the
    # computed lines rather than the structure, and is the same mechanism HRA uses.
    #
    # Which components those are is not assumed. Not gross, not basic, not basic plus DA:
    # the rule says, and a rule that does not say fails this employee rather than having
    # this file pick.
    pf_rule = statutory.get("pf") or {}
    pf_config = pf_rule.get("config", {})
    pf_applicable = bool(tax_info.get("pf_applicable", True))

    if pf_applicable and "basis_component_codes" not in pf_config:
        raise PayrollError(
            "the provident fund rule does not say which salary components form the PF wage; "
            "set basis_component_codes rather than leaving the basis to be assumed"
        )

    pf_basis_codes = list(pf_config.get("basis_component_codes") or [])
    contributing = [line for line in earnings if line.code in pf_basis_codes]
    pf_wage = money(sum((line.amount for line in contributing), ZERO))

    try:
        pf = calculate_pf(pf_wage, pf_config, applicable=pf_applicable)
    except PfConfigError as err:
        # A misconfigured rule fails this employee and only this employee, reusing the
        # per-employee isolation the rest of the statutory path already has.
        raise PayrollError(
            f"employee {employee.get('employee_code') or employee.get('id')}: {err}"
        ) from err

    # Shared by both PF lines so the deduction and the employer contribution are explained
    # by the same figures rather than two partial views that could drift.
    pf_trace = {
        **pf.detail,
        "contributing_components": [
            {"code": line.code, "amount": str(line.amount)} for line in contributing
        ],
        "rule_id": pf_rule.get("rule_id"),
        "rule_version": pf_rule.get("version"),
        "rule_source": pf_rule.get("source"),
    }

    # ------------------------------------------------------------------- ESI
    #
    # Eligibility is derived from the period's gross against the configured ceiling, not
    # from any attribute on the employee — which is why no "ESI eligible" flag exists. The
    # wage basis is gross earnings, so loss of pay moves an employee into the scheme in a
    # month where it drops them under the ceiling, and that follows from the basis rather
    # than from any ESI-specific rule about leave.
    esi_rule = statutory.get("esi") or {}
    try:
        esi = calculate_esi(
            gross,
            esi_rule.get("config", {}),
            applicable=bool(tax_info.get("esi_applicable", False)),
        )
    except EsiConfigError as err:
        raise PayrollError(
            f"employee {employee.get('employee_code') or employee.get('id')}: {err}"
        ) from err

    # Shared by both ESI lines so the deduction and the employer contribution are explained
    # by the same figures rather than two views that could drift.
    esi_trace = {
        **esi.detail,
        "rule_id": esi_rule.get("rule_id"),
        "rule_version": esi_rule.get("version"),
        "rule_source": esi_rule.get("source"),
    }

    # ------------------------------------------------------- professional tax
    #
    # Everything that decides PT was resolved and frozen by Node: which state, how that
    # state was arrived at, which rule version, and how much PT this tax year has already
    # taken. The engine looks nothing up — there is no path from here to the rule table.
    #
    # PT is deliberately independent of the income-tax regime. An employee electing the new
    # regime still pays their state's professional tax; the two are different levies by
    # different governments and coupling them would be wrong in both directions.
    pt_context = tax_info.get("professional_tax") or {}
    state_code = pt_context.get("state_code") or employee.get("state_code")
    pt_rule = (statutory.get(f"professional_tax:{state_code}") or {}) if state_code else {}

    if pt_context.get("required") and not pt_rule.get("config"):
        # The tenant asserted every employee must resolve to a configured jurisdiction, and
        # this one did not. Fails this employee, never the run.
        raise PayrollError(
            f"professional tax is required for employee {employee.get('employee_code') or employee.get('id')}, "
            f"but {pt_context.get('reason') or f'no rule is configured for state {state_code}'}"
        )

    pt_result = calculate_professional_tax(
        gross,
        pt_rule.get("config"),
        period_month=pt_context.get("period_month"),
        paid_this_year=_d(pt_context.get("paid_this_year", 0)),
    )
    professional_tax = pt_result.amount

    statutory_deductions: list[ComponentLine] = []
    if pf.employee > 0:
        statutory_deductions.append(
            ComponentLine("PF_EMPLOYEE", "Provident Fund", "deduction", pf.employee, True,
                          exempted_from_income_tax=_reduces_taxable(pf_config, "pf"),
                          detail={**pf_trace, "side": "employee",
                                  # Kept under their established names so an older payslip
                                  # still reads the same way.
                                  "wage_base": str(pf.wage_base), "capped": pf.capped})
        )
    if esi.employee > 0:
        statutory_deductions.append(
            ComponentLine("ESI_EMPLOYEE", "ESI", "deduction", esi.employee, True,
                          exempted_from_income_tax=_reduces_taxable(esi_rule.get("config", {}), "esi"),
                          detail={**esi_trace, "side": "employee",
                                  # Kept under its established name so an older payslip reads.
                                  "gross": str(gross)})
        )
    if professional_tax > 0:
        statutory_deductions.append(
            ComponentLine("PT", "Professional Tax", "deduction", professional_tax, True,
                          exempted_from_income_tax=_reduces_taxable(
                              pt_rule.get("config") or {}, "professional_tax"),
                          detail={
                              **pt_result.detail,
                              # The jurisdiction and how it was arrived at, so a payslip can
                              # answer "why Karnataka" as well as "why 200".
                              "jurisdiction": state_code,
                              "jurisdiction_source": pt_context.get("state_source"),
                              "rule_id": pt_rule.get("rule_id"),
                              "rule_version": pt_rule.get("version"),
                              "rule_source": pt_rule.get("source"),
                              "rule_effective_from": pt_context.get("rule_effective_from"),
                              # Kept under its old name so an older payslip still reads.
                              "state": state_code,
                          })
        )

    income_tax_rule = statutory.get("income_tax") or {}
    income_tax_config = income_tax_rule.get("config", {})
    regime = tax_info.get("regime", "new")

    # ------------------------------------------------------------- HRA exemption
    #
    # Computed here, after the earning lines exist, because the least-of-three is measured
    # against the basic and the allowance *as actually paid* — which means after percentage
    # resolution and after loss of pay. Reading them off the finished lines is what makes
    # this reuse the existing LOP model rather than becoming a second one.
    hra = _hra_for_period(
        snapshot.get("hra_json") or {},
        earnings=earnings,
        components=components,
        regime=regime,
        config=income_tax_config,
        pay_structure=pay_structure,
    )

    # ---------------------------------------------------------------- income tax
    #
    # The taxable base is what the component flags say it is: earnings marked taxable, less
    # deductions marked exempt. Both halves matter — taxing a non-taxable reimbursement
    # over-deducts, and ignoring that employee PF and professional tax reduce taxable salary
    # over-deducts again.
    taxable_earnings = money(sum((line.amount for line in earnings if line.taxable), ZERO))
    pre_tax_deductions = money(
        sum(
            (line.amount for line in structure_deductions + statutory_deductions
             if line.exempted_from_income_tax),
            ZERO,
        )
    )
    current_taxable = taxable_earnings - pre_tax_deductions

    # The exemption enters here and nowhere else: it reduces the income tax is assessed on.
    # It is not a deduction from pay and it does not touch gross — the allowance was still
    # received, and the employee was still paid it.
    period_exemption = hra.period.period_hra_exemption
    current_taxable -= period_exemption
    if current_taxable < 0:
        current_taxable = ZERO

    # Only the recurring part of this period is projected forward. A bonus paid once is not
    # evidence that eleven more are coming, and projecting it would over-deduct for the rest
    # of the year and then have to be unwound.
    recurring_taxable = current_taxable - min(one_off_taxable, current_taxable)

    # ------------------------------------------------- chapter VI-A exemptions
    #
    # Annual, and applied to the annual estimate rather than to this period. Each section is
    # capped against its own ceiling, resolved for this tax year and frozen in the snapshot.
    section_exemptions = _section_exemptions(
        snapshot, regime=regime, pay_structure=pay_structure, employee=employee
    )

    months_remaining = int(attendance.get("months_remaining_in_fy", 12) or 12)
    tax = calculate_income_tax(
        opening_taxable_earnings=_d(tax_info.get("opening_taxable_earnings", 0)),
        previous_taxable_earnings=_d(tax_info.get("previous_taxable_earnings", 0)),
        current_taxable_earnings=current_taxable,
        recurring_taxable_earnings=recurring_taxable if pay_structure else ZERO,
        # What the remaining periods will exempt, each evaluated on the rent and salary that
        # will actually apply to it. Passed separately rather than folded into `recurring`
        # precisely so it is not multiplied: a rent declaration that ends in December
        # contributes to the periods up to December and to no others.
        projected_exemption=hra.projected if pay_structure else ZERO,
        config=income_tax_config,
        regime=regime,
        declared_deductions=section_exemptions.total,
        months_remaining=months_remaining,
        already_deducted=_d(tax_info.get("tax_deducted_ytd", 0)),
    )

    if tax.monthly_tax > 0:
        statutory_deductions.append(
            ComponentLine("TDS", "Income Tax (TDS)", "deduction", tax.monthly_tax, True,
                          detail={"regime": tax.regime,
                                  "annual_gross_taxable": str(tax.annual_gross_taxable),
                                  "annual_taxable": str(tax.annual_taxable),
                                  "annual_tax": str(tax.annual_tax), "rebate": str(tax.rebate_applied),
                                  "months_remaining": months_remaining,
                                  "current_taxable": str(current_taxable),
                                  "projected_future": str(tax.projected_future),
                                  "opening_taxable": str(_d(tax_info.get("opening_taxable_earnings", 0))),
                                  "deducted_ytd": str(_d(tax_info.get("tax_deducted_ytd", 0))),
                                  "hra_exemption_this_period": str(period_exemption),
                                  "hra_exemption_projected": str(hra.projected),
                                  "section_exemptions": str(section_exemptions.total),
                                  # The annual liability, step by step, in the order the Act
                                  # sets it. Enough to re-derive the figure without the rule
                                  # tables, which is the point: last year's payslip must be
                                  # explainable from last year's snapshot.
                                  "base_tax": str(tax.base_tax),
                                  "surcharge_before_relief": str(tax.surcharge_before_relief),
                                  "marginal_relief": str(tax.marginal_relief),
                                  "surcharge": str(tax.surcharge),
                                  "cess": str(tax.cess),
                                  "surcharge_detail": tax.surcharge_detail,
                                  "rule_version": income_tax_rule.get("version")})
        )

    employer_lines: list[ComponentLine] = []
    if pf.employer > 0:
        employer_lines.append(
            ComponentLine("PF_EMPLOYER", "Provident Fund (Employer)", "employer_contribution", pf.employer, True,
                          detail={**pf_trace, "side": "employer",
                                  "pension_share": str(pf.employer_pension)})
        )
    if esi.employer > 0:
        employer_lines.append(
            ComponentLine("ESI_EMPLOYER", "ESI (Employer)", "employer_contribution", esi.employer, True,
                          detail={**esi_trace, "side": "employer"})
        )

    all_deductions = structure_deductions + statutory_deductions
    deduction_total = money(sum((line.amount for line in all_deductions if line.code != "TDS"), ZERO))
    tax_total = money(sum((line.amount for line in all_deductions if line.code == "TDS"), ZERO))

    # An informational line, not a total. It moves no money, so it is appended after the
    # sums above and is excluded from gross, deductions and net by its own type. It exists
    # so the payslip can answer "why was my taxable income that figure" without anyone
    # having to reconstruct it.
    exemption_lines: list[ComponentLine] = []
    if hra.period.applicable:
        exemption_lines.append(
            ComponentLine(
                "HRA_EXEMPTION",
                "HRA Exemption (section 10(13A))",
                "exemption",
                period_exemption,
                True,
                detail=hra.as_detail(),
            )
        )

    # One line per section, on the same footing as the HRA line: informational, excluded
    # from every total by its type, and carrying the whole calculation so a payslip can
    # answer "why was only 150,000 of my 200,000 allowed" without a reconstruction.
    for section in section_exemptions.sections:
        exemption_lines.append(
            ComponentLine(
                f"EXEMPTION_{section.section_code}",
                f"{section.name} (section {section.section_code})",
                "exemption",
                section.allowed_exemption,
                True,
                detail=section.as_detail(),
            )
        )

    result.components = earnings + all_deductions + employer_lines + exemption_lines
    result.gross_amount = gross
    result.deduction_amount = deduction_total
    result.tax_amount = tax_total
    result.taxable_earnings = current_taxable
    result.hra_exemption = period_exemption
    result.section_exemption_total = section_exemptions.total
    result.employer_contribution = money(sum((line.amount for line in employer_lines), ZERO))
    result.net_amount = money(gross - deduction_total - tax_total)

    validate(result)
    return result


def _section_exemptions(
    snapshot: dict[str, Any],
    *,
    regime: str,
    pay_structure: bool,
    employee: dict[str, Any],
) -> ExemptionResult:
    """Chapter VI-A for the year, or nothing, with the reason either way.

    Two snapshots produce nothing here, for different reasons.

    A **supplementary** run corrects a period whose regular run already applied the year's
    exemptions. Applying them again would exempt the same income twice.

    A snapshot written **before section caps existed** carries no tax year in
    `exemption_json` — the column's default. Those runs applied `tax_json.declared_amount`
    uncapped, and a recalculation has to keep applying it or it would not reproduce the
    payslip it is recalculating. That is the only place the legacy figure is still read.
    """
    exemption_json = snapshot.get("exemption_json") or {}
    tax_info = snapshot.get("tax_json") or {}

    if not pay_structure:
        return ExemptionResult()

    if not exemption_json.get("tax_year_id"):
        legacy = _d(tax_info.get("declared_amount", 0))
        if legacy <= ZERO:
            return ExemptionResult()
        return ExemptionResult(
            total=money(legacy),
            sections=[
                SectionExemption(
                    section_code="LEGACY",
                    name="Declared deductions (pre-cap snapshot)",
                    declared_amount=money(legacy),
                    eligible_amount=money(legacy),
                    configured_cap=money(legacy),
                    allowed_exemption=money(legacy),
                    reason="snapshot predates section ceilings; the figure it was calculated "
                           "with is reapplied unchanged so the run reproduces",
                )
            ],
        )

    label = employee.get("employee_code") or employee.get("id") or "this employee"
    return calculate_section_exemptions(
        exemption_json, regime=regime, employee_label=f"employee {label}"
    )


def _hra_for_period(
    hra_json: dict[str, Any],
    *,
    earnings: list[ComponentLine],
    components: list[dict[str, Any]],
    regime: str,
    config: dict[str, Any],
    pay_structure: bool,
) -> HraAnnual:
    """This period's exemption, and what the remaining periods will add.

    Every refusal below is recorded rather than silently returning zero, because "no
    exemption" and "we never asked for rent" look identical on a payslip otherwise, and only
    one of them is something the employee can fix.
    """
    if not pay_structure:
        return HraAnnual(period=not_applicable(
            "supplementary runs pay no salary structure, so no HRA is received"
        ))
    if not hra_json.get("applicable"):
        return HraAnnual(period=not_applicable(
            hra_json.get("reason") or "no rent declared for this tax year"
        ))
    if not regime_allows_hra(config, regime):
        # Section 115BAC gives up section 10(13A) in exchange for lower slabs. Exempting
        # here would exempt income that is fully taxable, for every employee on the regime.
        return HraAnnual(period=not_applicable(
            f"the {regime} regime does not allow the section 10(13A) exemption"
        ))

    basic, actual_hra = resolve_role_amounts(earnings, components)
    if actual_hra == ZERO:
        return HraAnnual(period=not_applicable(
            "this salary structure has no component with the role 'house_rent_allowance'"
            if not _has_role(components, "house_rent_allowance")
            else "no house rent allowance was paid for this period"
        ))

    period = calculate_period_exemption(
        actual_hra=actual_hra,
        basic=basic,
        rent_paid=_d(hra_json.get("rent_amount", 0)),
        metro_classification=_metro(hra_json.get("metro_classification")),
        config=config,
    )

    projected, segments = _project_hra(hra_json, config=config)
    return HraAnnual(period=period, projected=projected, segments=segments)


def _project_hra(
    hra_json: dict[str, Any],
    *,
    config: dict[str, Any],
) -> tuple[Decimal, list[dict[str, Any]]]:
    """The exemption the remaining periods of the tax year will produce.

    Walks the segments the snapshot froze — each one a stretch over which the rent, the
    classification and the salary are all constant — and evaluates the least-of-three
    separately for each. The only multiplication is by the number of *whole payroll periods*
    in a segment, which is a count and not an assumption.

    This is what the phase brief means by "never current x remaining months". A raise in
    July is projected at the July figure; a lease that ends in December contributes to the
    periods up to December and to none after it; a leaver contributes nothing past their
    last day, because Node did not put those periods in the plan.

    Future periods carry no loss of pay, because none has happened yet. That makes the
    projection an estimate of full-salary months, which is the same assumption the existing
    annualisation already makes about recurring pay — and any divergence is corrected in the
    period it actually occurs, spread over the months that remain.
    """
    total = ZERO
    explained: list[dict[str, Any]] = []

    for segment in hra_json.get("projection") or []:
        periods = int(segment.get("periods", 0) or 0)
        if periods <= 0:
            continue

        values = resolve_full_values(
            list(segment.get("components") or []),
            _d(segment.get("base_amount", 0)),
        )
        roles = _roles(list(segment.get("components") or []))
        basic = values.get(roles.get("basic", ""), ZERO)
        actual_hra = values.get(roles.get("house_rent_allowance", ""), ZERO)

        exemption = calculate_period_exemption(
            actual_hra=actual_hra,
            basic=basic,
            rent_paid=_d(segment.get("rent_amount", 0)),
            metro_classification=_metro(segment.get("metro_classification")),
            config=config,
        )
        segment_total = money(exemption.period_hra_exemption * Decimal(periods))
        total += segment_total

        explained.append({
            "from": segment.get("from"),
            "to": segment.get("to"),
            "periods": periods,
            "basic": str(basic),
            "actual_hra": str(actual_hra),
            "rent_paid": str(_d(segment.get("rent_amount", 0))),
            "metro_classification": exemption.metro_classification,
            "per_period_exemption": str(exemption.period_hra_exemption),
            "segment_exemption": str(segment_total),
        })

    return money(total), explained


def _roles(components: list[dict[str, Any]]) -> dict[str, str]:
    """Role -> component code, refusing an ambiguity rather than picking one."""
    roles: dict[str, str] = {}
    for component in components:
        role = component.get("semantic_role")
        if not role:
            continue
        if role in roles and roles[role] != component["code"]:
            raise HraError(
                f"components {roles[role]} and {component['code']} both claim the role "
                f"'{role}'; exactly one component may be the {role.replace('_', ' ')}"
            )
        roles[role] = component["code"]
    return roles


def _has_role(components: list[dict[str, Any]], role: str) -> bool:
    return any(c.get("semantic_role") == role for c in components)


def _metro(value: Any) -> str:
    """Normalises what the snapshot froze. The engine never decides this for itself."""
    return "METRO" if str(value or "").lower() in ("metro", "METRO".lower()) else "NON_METRO"


def _reduces_taxable(config: dict[str, Any], rule_type: str) -> bool:
    """Whether this statutory deduction reduces taxable salary income."""
    return bool(config.get("reduces_taxable_income", _REDUCES_TAXABLE_BY_DEFAULT.get(rule_type, False)))


def validate(result: PayrollResult) -> None:
    """Consistency checks before a result is allowed to become a payslip.

    These are cheap and catch the class of bug that is most expensive to discover later:
    a payslip that is internally inconsistent, or one that pays a negative amount because
    deductions exceeded earnings.
    """
    if result.lop_days > result.total_days:
        raise PayrollError(f"LOP days ({result.lop_days}) exceed the period length ({result.total_days})")

    if result.payable_days < 0:
        raise PayrollError("payable days cannot be negative")

    expected_net = (result.gross_amount - result.deduction_amount - result.tax_amount).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )
    if expected_net != result.net_amount:
        raise PayrollError(
            f"net pay {result.net_amount} does not reconcile with gross {result.gross_amount} "
            f"minus deductions {result.deduction_amount} and tax {result.tax_amount}"
        )

    if result.net_amount < 0:
        raise PayrollError(
            f"net pay is negative ({result.net_amount}); recoveries exceed earnings and need manual review"
        )

    earnings_total = money(sum((c.amount for c in result.components if c.component_type == "earning"), ZERO))
    if earnings_total != result.gross_amount:
        raise PayrollError(f"earning lines total {earnings_total} but gross is {result.gross_amount}")

    if result.taxable_earnings > result.gross_amount:
        raise PayrollError(
            f"taxable earnings {result.taxable_earnings} exceed gross {result.gross_amount}"
        )
