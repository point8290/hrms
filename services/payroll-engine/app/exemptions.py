"""Chapter VI-A exemption caps: 80C, 80D and the rest.

The chain, and every step of it matters:

    declared amount
        -> eligibility        what a verifier accepted, if anyone has looked
        -> eligible amount
        -> statutory cap      from the rule frozen for *this* tax year
        -> allowed exemption  min(eligible, cap), never negative

Two things this module is careful not to do.

It does not confuse the cap with eligibility. Declaring 200,000 under 80C and having 180,000
accepted does not make the allowed exemption 150,000 *of the declared* figure — it makes it
min(180,000, 150,000). The ceiling applies last, to whatever survived eligibility.

And it does not treat an annual cap as a monthly one. There is no monthly 80C: the
declaration is an annual figure, the ceiling is an annual ceiling, and both are applied to
the annual estimate the tax engine already builds. Nothing here is multiplied by twelve and
nothing is divided by it.

Every limit comes from the snapshot. There is no `if section == "80C": limit = 150000`
anywhere, and there must never be: the ceiling is a Finance Act number that changes, and a
copy of it compiled into the engine would silently disagree with the configured one.

## The proof cutoff

A declaration states an intention; proof is what turns it into a deduction. Four states
matter, and they are not interchangeable:

    declared    stated, nobody has looked yet
    verified    proof examined and accepted
    rejected    proof examined and refused
    unverified  still unproved once the cutoff has passed

Only the first three are stored. `unverified` is decided per payroll run — the same row is
`declared` for a December run and `unverified` for a February one — so Node derives it and
freezes it as `effective_status`.

**No date is compared here.** `cutoff_passed` arrives as a boolean that Node computed once,
against the payroll period's end. That is deliberate: a second comparison in a second
language is a second set of boundary and timezone assumptions, and the two would eventually
disagree about 31 January.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from .statutory import ZERO, money


class ExemptionError(Exception):
    """A section the engine cannot resolve. Fails this employee, never the whole run."""


@dataclass
class SectionExemption:
    """One section's result, with every figure that produced it."""

    section_code: str
    name: str
    declared_amount: Decimal = ZERO
    eligible_amount: Decimal = ZERO
    configured_cap: Decimal = ZERO
    allowed_exemption: Decimal = ZERO
    rule_version: int | None = None
    rule_source: str | None = None
    tax_year: str | None = None
    applicable: bool = True
    capped: bool = False
    reason: str | None = None
    # Proof state, as it applied to this run.
    status: str = "declared"
    effective_status: str = "declared"
    proof_cutoff_date: str | None = None
    cutoff_passed: bool = False

    def as_detail(self) -> dict[str, Any]:
        detail = {
            "section_code": self.section_code,
            "name": self.name,
            "tax_year": self.tax_year,
            "rule_version": self.rule_version,
            "rule_source": self.rule_source,
            "declared_amount": str(self.declared_amount),
            "eligible_amount": str(self.eligible_amount),
            "configured_cap": str(self.configured_cap),
            "allowed_exemption": str(self.allowed_exemption),
            "applicable": self.applicable,
            # The proof story, kept whole. "Declared 150,000, allowed nothing because the
            # cutoff passed" is a different conversation from "declared nothing", and an
            # employee asking in June deserves the first answer rather than a blank.
            "status": self.status,
            "effective_status": self.effective_status,
            "proof_cutoff_date": self.proof_cutoff_date,
            "cutoff_passed": self.cutoff_passed,
            # Visible on purpose: "declared 200,000, allowed 150,000" is a different
            # conversation from "declared 150,000, allowed 150,000", and storing only the
            # final figure makes them indistinguishable.
            "capped_by_statute": self.capped,
        }
        if self.reason:
            detail["reason"] = self.reason
        return detail


@dataclass
class ExemptionResult:
    total: Decimal = ZERO
    sections: list[SectionExemption] = field(default_factory=list)

    def as_detail(self) -> dict[str, Any]:
        return {
            "total_allowed": str(self.total),
            "sections": [s.as_detail() for s in self.sections],
        }


def _d(value: Any, default: str = "0") -> Decimal:
    if value is None or value == "":
        return Decimal(default)
    return Decimal(str(value))


def calculate_section_exemptions(
    exemption_json: dict[str, Any],
    *,
    regime: str,
    employee_label: str = "this employee",
) -> ExemptionResult:
    """Every declared section, capped independently.

    Independently is the whole point: 80C and 80D have separate ceilings and one being over
    its limit says nothing about the other. A single total compared against a single cap
    would be a different — and wrong — calculation.

    Fails closed. A declared section whose rule could not be resolved raises rather than
    defaulting to unlimited, to zero, or to last year's number. Any of those would produce a
    confident figure nobody configured; the exception names the employee, the section, the
    year and the rule so an administrator can fix it.
    """
    result = ExemptionResult()

    for section in exemption_json.get("sections") or []:
        code = str(section.get("section_code") or "").strip()
        if not code:
            raise ExemptionError(
                f"{employee_label} has a tax declaration with no section code; "
                "payroll cannot resolve an exemption for it"
            )

        # Fail closed. The snapshot carries the reason Node could not resolve a rule rather
        # than dropping the section, so the failure surfaces here with something actionable
        # instead of quietly exempting nothing.
        if section.get("unresolved_reason") or section.get("max_amount") is None:
            raise ExemptionError(
                f"{employee_label} declared an exemption under section {code}, but "
                + str(
                    section.get("unresolved_reason")
                    or f"no exemption rule could be resolved for tax year "
                       f"{exemption_json.get('tax_year_label')}"
                )
                + ". Configure the section ceiling for that year, or withdraw the declaration."
            )

        result.sections.append(
            _one_section(
                section, regime=regime, tax_year=exemption_json.get("tax_year_label")
            )
        )

    result.total = money(
        sum((s.allowed_exemption for s in result.sections), ZERO)
    )
    return result


def _one_section(
    section: dict[str, Any], *, regime: str, tax_year: str | None = None
) -> SectionExemption:
    code = str(section["section_code"])
    declared = money(max(ZERO, _d(section.get("declared_amount"))))
    cap = money(max(ZERO, _d(section.get("max_amount"))))

    status = str(section.get("status") or "declared")
    # Derived by Node and frozen, because whether the cutoff has passed is a fact about this
    # payroll run rather than about the declaration row.
    effective = str(section.get("effective_status") or status)

    out = SectionExemption(
        section_code=code,
        name=str(section.get("name") or code),
        declared_amount=declared,
        configured_cap=cap,
        rule_version=section.get("rule_version"),
        rule_source=section.get("rule_source"),
        # Part of the explanation, not decoration: a ceiling means nothing without the year
        # it belonged to, and the year is what the rule was resolved against.
        tax_year=tax_year,
        status=status,
        effective_status=effective,
        proof_cutoff_date=section.get("proof_cutoff_date"),
        cutoff_passed=bool(section.get("cutoff_passed")),
    )

    # --- regime applicability ------------------------------------------------
    #
    # Section 115BAC trades most of chapter VI-A away for lower slabs. Applying a section the
    # elected regime does not give would exempt fully taxable income, for everyone on it.
    regimes = section.get("applicable_regimes") or []
    if regime not in regimes:
        out.applicable = False
        out.reason = (
            f"section {code} is not available under the {regime} regime "
            f"(configured for: {', '.join(sorted(regimes)) or 'no regime'})"
        )
        return out

    # --- proof ---------------------------------------------------------------
    #
    # Upstream of the ceiling and a different question. The declared amount is never altered
    # by any of this: it is what the employee said, and it stays on the record whatever the
    # proof turned out to be.
    if effective == "rejected":
        out.eligible_amount = ZERO
        out.reason = f"the proof for section {code} was rejected"
        return out

    if effective == "unverified":
        # Declared, never proved, and the cutoff has gone. Nothing is deleted and nothing is
        # retroactive — the periods already finalized keep whatever they allowed, and the
        # periods still to come allow nothing under this section.
        out.eligible_amount = ZERO
        out.reason = (
            f"section {code} was declared but never proved, and the proof cutoff "
            f"({out.proof_cutoff_date}) had passed by {section.get('cutoff_reference_date')}"
        )
        return out

    eligible_raw = section.get("eligible_amount")
    eligible = declared if eligible_raw is None else money(max(ZERO, _d(eligible_raw)))
    # Nobody may be found eligible for more than they declared.
    if eligible > declared:
        eligible = declared
    out.eligible_amount = eligible

    # --- the ceiling, last ---------------------------------------------------
    allowed = min(eligible, cap)
    if allowed < ZERO:
        allowed = ZERO
    out.allowed_exemption = money(allowed)
    out.capped = eligible > cap

    if out.allowed_exemption == ZERO and declared > ZERO:
        out.reason = f"the ceiling for section {code} is {cap}"
    elif out.capped:
        out.reason = (
            f"eligible {eligible} exceeds the section {code} ceiling of {cap}; "
            f"{out.allowed_exemption} allowed"
        )

    return out
