"""HRA exemption under section 10(13A) and rule 2A.

The exemption is the **least of three** figures, evaluated for a payroll period:

    A  the house rent allowance actually received for the period
    B  the rent paid for the period, less 10% of the basic for the period
    C  50% of the basic (metro) or 40% (non-metro)

    exemption = max(0, min(A, B, C))

Every one of those is a *period* figure, and that is the whole design. A year is the sum of
its periods, not one period multiplied by twelve:

    Payroll period
        -> period exemption (least of three, on that period's own inputs)
        -> accumulate what has already been paid
        -> project each remaining period on the inputs that will apply to it
        -> tax-year exemption
        -> annual taxable income

The two readings diverge for anyone whose circumstances change: a promotion in July, a move
in October, a joiner in September, a lease that ends in December. The naive reading is wrong
in a direction that under-deducts, and under-deduction is the employer's liability under
section 192.

Nothing here reads a database or a component name. The basic and the allowance arrive
already identified by `semantic_role`, the metro classification arrives already resolved as
`METRO` or `NON_METRO`, and the rent arrives from the frozen snapshot.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from .statutory import ZERO, money

# Section 10(13A) read with rule 2A. Defaults live here, in the statute's own terms, rather
# than in configuration a tenant has to know to supply — a tenant who has not thought about
# it still gets the legally correct answer. A rule version may override any of them, which is
# how a later slab change or a different jurisdiction is expressed without a code change.
DEFAULT_HRA_RULE = {
    "metro_percent": "50",
    "non_metro_percent": "40",
    "basic_percent": "10",
}

METRO = "METRO"
NON_METRO = "NON_METRO"

#: Section 10(13A) is a salary exemption the old regime allows and the new regime does not.
#: Keyed the same way the rest of the engine keys regimes, and overridable per rule version.
_ALLOWED_BY_REGIME = {"old": True, "new": False}


class HraError(Exception):
    """An HRA input the engine cannot resolve. Fails this employee, never the whole run."""


@dataclass
class HraExemption:
    """One period's exemption, with every figure that produced it.

    Persisted whole onto the payslip. A person asking in eighteen months why their exemption
    was what it was gets an answer from the payslip rather than from a reconstruction, and
    once the run is finalized it cannot change.
    """

    actual_hra: Decimal = ZERO
    basic: Decimal = ZERO
    rent_paid: Decimal = ZERO
    ten_percent_basic: Decimal = ZERO
    rent_minus_ten_percent_basic: Decimal = ZERO
    metro_classification: str = NON_METRO
    salary_percentage: Decimal = ZERO
    salary_limit: Decimal = ZERO
    actual_hra_limit: Decimal = ZERO
    period_hra_exemption: Decimal = ZERO
    applicable: bool = False
    reason: str | None = None

    def as_detail(self) -> dict[str, Any]:
        """The explanation, as strings so no float ever touches a stored figure."""
        detail = {
            "actual_hra": str(self.actual_hra),
            "basic": str(self.basic),
            "rent_paid": str(self.rent_paid),
            "ten_percent_basic": str(self.ten_percent_basic),
            "rent_minus_ten_percent_basic": str(self.rent_minus_ten_percent_basic),
            "metro_classification": self.metro_classification,
            "salary_percentage": str(self.salary_percentage),
            "salary_limit": str(self.salary_limit),
            "actual_hra_limit": str(self.actual_hra_limit),
            "period_hra_exemption": str(self.period_hra_exemption),
            "applicable": self.applicable,
        }
        if self.reason:
            detail["reason"] = self.reason
        return detail


@dataclass
class HraAnnual:
    """The tax-year picture: this period, and what the remaining periods will add."""

    period: HraExemption
    projected: Decimal = ZERO
    segments: list[dict[str, Any]] = field(default_factory=list)

    def as_detail(self) -> dict[str, Any]:
        detail = self.period.as_detail()
        detail["projected_remaining_exemption"] = str(self.projected)
        detail["projection_segments"] = self.segments
        return detail


def _d(value: Any, default: str = "0") -> Decimal:
    if value is None or value == "":
        return Decimal(default)
    return Decimal(str(value))


def regime_allows_hra(config: dict[str, Any], regime: str) -> bool:
    """Whether this regime exempts HRA at all.

    The new regime under section 115BAC gives up section 10(13A) in exchange for lower
    slabs. Getting this wrong is not a rounding error: it exempts income that is fully
    taxable, for every employee on the new regime.
    """
    regimes = config.get("regimes", {}) or {}
    rules = regimes.get(regime)
    if isinstance(rules, dict) and "allows_hra_exemption" in rules:
        return bool(rules["allows_hra_exemption"])
    return _ALLOWED_BY_REGIME.get(regime, False)


def _rule(config: dict[str, Any]) -> dict[str, Any]:
    merged = dict(DEFAULT_HRA_RULE)
    override = config.get("hra_exemption")
    if isinstance(override, dict):
        merged.update({k: v for k, v in override.items() if v is not None})
    return merged


def calculate_period_exemption(
    *,
    actual_hra: Decimal,
    basic: Decimal,
    rent_paid: Decimal,
    metro_classification: str,
    config: dict[str, Any] | None = None,
) -> HraExemption:
    """The least of three, for one payroll period.

    Every guard here is a real case rather than defensive padding. Rent below 10% of basic
    makes limit B negative, which would otherwise *increase* taxable income by exempting a
    negative amount. Zero basic makes limits B and C zero. Zero HRA makes limit A zero, and
    an exemption can never exceed the allowance actually received — there is nothing to
    exempt.
    """
    rule = _rule(config or {})

    actual_hra = money(max(ZERO, actual_hra))
    basic = money(max(ZERO, basic))
    rent_paid = money(max(ZERO, rent_paid))

    is_metro = metro_classification == METRO
    salary_percentage = _d(rule["metro_percent"] if is_metro else rule["non_metro_percent"])
    basic_percentage = _d(rule["basic_percent"])

    # B: rent over and above a tenth of the basic. Negative when the rent is token or the
    # basic is large, and a negative exemption is not a thing.
    ten_percent_basic = money(basic * basic_percentage / Decimal("100"))
    rent_minus = money(rent_paid - ten_percent_basic)

    # C: a proportion of the basic, higher in the four cities the Act names.
    salary_limit = money(basic * salary_percentage / Decimal("100"))

    exemption = min(actual_hra, rent_minus, salary_limit)
    if exemption < ZERO:
        exemption = ZERO

    result = HraExemption(
        actual_hra=actual_hra,
        basic=basic,
        rent_paid=rent_paid,
        ten_percent_basic=ten_percent_basic,
        rent_minus_ten_percent_basic=rent_minus,
        metro_classification=METRO if is_metro else NON_METRO,
        salary_percentage=salary_percentage,
        salary_limit=salary_limit,
        # Named for what it is: limit A is the allowance itself, and it is also the ceiling.
        actual_hra_limit=actual_hra,
        period_hra_exemption=money(exemption),
        applicable=True,
    )

    if result.period_hra_exemption == ZERO:
        result.reason = _zero_reason(result)
    return result


def _zero_reason(result: HraExemption) -> str:
    """Why an exemption came out at zero. A blank line on a payslip explains nothing."""
    if result.actual_hra == ZERO:
        return "no house rent allowance was received for this period"
    if result.basic == ZERO:
        return "no basic salary for this period, so both rent and salary limits are zero"
    if result.rent_minus_ten_percent_basic <= ZERO:
        return (
            f"rent of {result.rent_paid} does not exceed 10% of basic "
            f"({result.ten_percent_basic})"
        )
    return "the least of the three limits is zero"


def not_applicable(reason: str) -> HraExemption:
    """A period with no exemption, and the reason on the record."""
    return HraExemption(applicable=False, reason=reason)


def resolve_role_amounts(
    lines: list[Any],
    components: list[dict[str, Any]],
) -> tuple[Decimal, Decimal]:
    """Basic and HRA as actually paid this period, found by role and never by name.

    Taken from the computed lines rather than from the structure, which is what makes this
    reuse the existing loss-of-pay model instead of becoming a second one: a component
    marked `affects_lop` has already been pro-rated by the time it gets here, so an employee
    who lost four days has their exemption measured against the basic they were actually
    paid.

    Two components claiming the same role is an ambiguity, not something to resolve by
    ordering — it fails this employee, with both codes named.
    """
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

    paid = {line.code: line.amount for line in lines}
    basic = paid.get(roles.get("basic", ""), ZERO)
    actual_hra = paid.get(roles.get("house_rent_allowance", ""), ZERO)
    return basic, actual_hra
