# ADR-022: ESI eligibility is derived from the wage, and its figures come only from the rule

Status: Accepted
Date: 2026-09-20
Relates to: ADR-005, ADR-014, ADR-020, ADR-021
Scope decided by the PRD, not by general ESIC practice.

## Context

Employees' State Insurance has worked since migration 0006: the rule lives in
`payroll.statutory_rule`, the employee contribution is a deduction, the employer contribution
is an employer cost, and an employee whose gross exceeds the ceiling is outside the scheme.

Two things were wrong with *how* it worked, and they are the ESI counterparts of what
ADR-021 fixed for provident fund.

**Statutory figures had literal fallbacks.** `calculate_esi` read:

```python
ceiling = Decimal(str(config.get("gross_wage_ceiling", 21000)))
employee = rupees(gross * Decimal(str(config.get("employee_rate", 0.0075))))
employer = rupees(gross * Decimal(str(config.get("employer_rate", 0.0325))))
```

Against the PRD's requirement that statutory rules be versioned and effective-dated "rather
than scattered as hard-coded logic", that is three figures scattered as hard-coded logic. The
ceiling is the worst of the three, and not because it is the largest number: **it is not a cap
on the contribution, it is the eligibility test**. A rule without one cannot answer who is
covered, and a fallback silently enrols or excludes real people.

**The employer trace was empty.** Literally `detail={}`. An employer cost with no explanation
of the wage it was computed on, the rate applied, or the rule that set it.

## What the PRD actually says about ESI

The complete evidence — the same two lines that name PF:

| Location | Text |
| --- | --- |
| Domain table | "TDS, PF, **ESI**, PT and versioned rules" |
| §16 | "Initial localization should support TDS/income tax, PF, **ESI**, Professional Tax, gratuity, bonus and related payroll data." |
| §16 | "Statutory rules must be effective-dated and versioned rather than scattered as hard-coded logic." |
| §16 | "Payroll configuration should allow rule changes without changing historical payroll results." |

ESI is named as a supported item. **No ESI sub-feature is defined** — no contribution-period
model, no state variation, no wage-basis configuration, no previous-employer balance.

## Decision

### Nothing statutory is defaulted

Both rates and the ceiling must come from the rule. A missing one raises `EsiConfigError`,
which `calculate()` turns into a `PayrollError` naming the employee, failing that employee and
not the run. Zero is configuration, not absence: a rule may set a rate of zero.

An employee who is *not* covered needs no rule, so the figures are read only after
applicability is settled — an empty config is fine for someone outside the scheme.

### Eligibility is derived, and needs no employee attribute

An employee whose gross for the period is at or under the ceiling is in the scheme; one above
it is out. Nothing else about them is consulted. §9 of the phase brief says not to invent a
generic "ESI eligible" attribute if eligibility can be derived from authoritative data — it
can, so none was added.

The ceiling is inclusive: the rule excludes wages *exceeding* it, so the ceiling itself is
inside the scheme. Tested at ₹20,999 / ₹21,000 / ₹21,001 and at a paisa above.

Being over the ceiling is now recorded distinctly from not being applicable at all. Both
contribute zero; only one of them means "this employee earns too much this period", and the
payslip can now say which.

### The wage basis is gross earnings, and is deliberately not configurable

This is existing behaviour, not an assumption made here: the rule's own key is
`gross_wage_ceiling` and the caller has always passed gross. Unlike provident fund, which
names its contributing components, nothing in the product requirements asks for an ESI basis
other than gross. Making it configurable would be inventing a statutory question nobody asked.

Two consequences follow from the basis rather than from any ESI-specific rule, and both are
tested:

- **Loss of pay can bring someone into the scheme** in a month where it drops their gross
  under the ceiling.
- **A bonus can take someone out of it** for the period in which it is paid.

Neither is a special case for leave or for bonuses. Both are what "the basis is the period's
gross earnings" means.

### ESI is national, with no jurisdiction dimension

`state_code` is null on the ESI rule. §10 says not to reuse professional tax's jurisdiction
merely because both are Indian statutory deductions, and ESI in the supported model is
uniform. No employee-state mechanism was added, and a test asserts no ESI rule is
state-scoped.

### Contribution is per payroll period

There is no contribution-period model in the rule and none was added. The calculation is per
period, on that period's gross, using the rule effective for that period.

### Employee and employer money stay apart

Unchanged, and now asserted. Employee ESI is a `deduction` reducing net pay; employer ESI is
an `employer_contribution`, reported on `salary_slip.employer_contribution` and excluded from
net. Both lines now share one trace — wage basis, ceiling, both rates, both contributions,
eligibility, and the rule's id, version and source — distinguished only by `side`.

### Tax treatment unchanged

Employee ESI does **not** reduce taxable salary income, which ADR-014 established from the
statute (`_REDUCES_TAXABLE_BY_DEFAULT = {"esi": False}`), overridable per rule version.
Employer ESI is not an employee tax deduction. §17 says not to invent a tax rule; neither was
touched, and both are now pinned by tests so ESI work cannot quietly change them.

## Explicitly deferred

| Feature | Status |
| --- | --- |
| Configurable ESI wage basis | Deferred. Not in the PRD; gross is existing behaviour. |
| ESI state/jurisdiction variation | Deferred. Not in the PRD; the rule is national. |
| Contribution-period boundaries | Deferred. Not in the PRD; no such model exists. |
| Previous-employer ESI balance | Deferred. Not in the PRD. |
| ESIC filing / return generation | Out of scope by §26. |

Implementing any would mean originating statutory semantics with nothing to check them
against — the reason the LWF phase stopped at discovery.

## Consequences

- **No payroll output changes.** The seeded platform rule and every test fixture already
  configure all three figures, so nothing that previously calculated now refuses. The E2E
  June baseline is byte-identical: gross ₹96,666.66, TDS ₹3,865.33, net ₹90,801.33.
- **No migration and no schema change.** The rule model already represented ESI adequately.
- **`CALCULATION_VERSION` unchanged** at `in-payroll-2025.6`. No figure any existing snapshot
  produces differs; the change is refusal-where-ambiguous plus explanation.
- **No trigger change**, because no salary-slip column was added. `guard_finalized_slip` was
  captured before the work and verified identical afterwards.
- A tenant override omitting a rate or the ceiling now fails that employee at calculation time
  rather than silently applying the statutory figure. That is the intended behaviour change,
  and it is a refusal rather than a different number.

### Known gaps

- **No ESI opening balance for a mid-year joiner.** The same shape of gap ADR-017 recorded for
  exemption utilisation, ADR-019 for surcharge borne, ADR-020 for PT paid elsewhere and
  ADR-021 for PF. Nothing depends on it today: ESI has no annual ceiling, only a per-period
  wage test.
- **Eligibility is re-tested every period.** An employee whose gross crosses the ceiling
  mid-year moves in or out of the scheme month by month. Real ESIC practice has contribution
  periods that fix coverage for six months at a time; that model is not in the PRD and is not
  implemented, so the per-period behaviour is what this system does and what it documents.
