# ADR-021: Provident fund rates are configuration, and the engine will not guess at them

Status: Accepted
Date: 2026-09-20
Relates to: ADR-005, ADR-014, ADR-019, ADR-020
Supersedes nothing. Scope decided by the PRD, not by general Indian PF practice.

## Context

Provident fund has worked since migration 0006: the rule lives in `payroll.statutory_rule`,
the employee contribution is a deduction, the employer contribution is an employer cost, and
the wage basis is the configured components as actually paid. None of that needed changing.

What did need changing is one sentence in the PRD. §16 requires that

> Statutory rules must be effective-dated and versioned rather than **scattered as hard-coded
> logic**.

and `calculate_pf` read like this:

```python
employee = rupees(base * Decimal(str(config.get("employee_rate", 0.12))))
employer_total = rupees(base * Decimal(str(config.get("employer_rate", 0.12))))
pension = rupees(base * Decimal(str(config.get("employer_pension_rate", 0.0833))))
apply_ceiling = bool(config.get("apply_ceiling", True))
pf_basis_codes = pf_config.get("basis_component_codes", ["BASIC"])
```

Five statutory figures with literal fallbacks. A rule version missing its employee rate would
deduct twelve percent that nobody configured, and the payslip would look entirely ordinary.
The same reasoning already governs surcharge bands (ADR-019) and professional-tax slabs
(ADR-020), both of which refuse rather than assume; PF was the one that did not.

## What the PRD actually says about PF

The complete evidence, quoted:

| Location | Text |
| --- | --- |
| Domain table | "TDS, PF, ESI, PT and versioned rules" |
| §16 | "Initial localization should support TDS/income tax, PF, ESI, Professional Tax, gratuity, bonus and related payroll data." |
| §16 | "Statutory rules must be effective-dated and versioned rather than scattered as hard-coded logic." |
| §16 | "Payroll configuration should allow rule changes without changing historical payroll results." |

That is all. The PRD names PF as a supported item and imposes two cross-cutting requirements
on how statutory rules are represented. **It defines no PF sub-feature** — no VPF, no EDLI,
no administrative charges, no EPS as a component in its own right, and no ceiling policy.

## Decision

### Nothing statutory is defaulted

The three rates and the wage basis must come from the rule. A missing one raises
`PfConfigError`, which `calculate()` turns into a `PayrollError` naming the employee — so it
fails that employee and not the run, reusing the isolation the rest of the statutory path has.

The ceiling is a special case worth stating. A rule with **no** ceiling is unambiguous and
needs no policy. A rule that sets a ceiling but does not say whether it binds is refused,
because applying it and not applying it are both real employer policies that differ by real
money, and nothing in the product requirements settles which is meant. §8 of the phase brief
says not to invent an opt-in/mandatory policy; refusing is how that is honoured without
picking one.

Zero is configuration, not absence: a rule may set a rate of zero and that is respected.

### The wage basis is named by the rule, never assumed

Not gross, not basic, not basic-plus-DA. The rule's `basis_component_codes` names the
components and the engine sums **those lines as actually paid this period**, which is what
makes loss of pay reduce the PF wage exactly as it reduces the salary, and a mid-month joiner
contribute on what they were paid. Reading the computed lines rather than the structure is
the same mechanism HRA uses.

A consequence worth naming: an additional-salary line participates only if its component code
is in the basis. A bonus paid under a `BONUS` component does not raise the PF wage. That
follows from the rule naming its components — it is not a special case for bonuses.

### The trace explains the figure without the rule table

Both PF lines now carry the same trace: wage basis, contributory wage, the contributing
component codes and amounts, all three rates, both contributions, the ceiling and whether it
bound, and the rule's id, version and source. The two lines share one structure rather than
holding two partial views that could drift, distinguished only by `side`.

This is what PRD line 322 needs to be checkable: a finalized payslip is explainable from its
own snapshot and trace, with no reference to today's rule.

### Employee and employer money stay apart

Unchanged, and now asserted rather than assumed. The employee contribution is a `deduction`
and reduces net pay; the employer contribution is an `employer_contribution`, is reported on
`salary_slip.employer_contribution`, and is excluded from net. The employer's pension share is
a **split of the employer's own contribution**, never an additional charge — the engine caps
it at the employer total.

Employee PF reduces taxable salary income under section 80C (ADR-014). Employer PF does not,
and a test now pins that so PF work cannot quietly make an employer cost an employee tax
deduction.

## Explicitly deferred, with reasons

None of these is in the PRD, and none is implemented:

| Feature | Status |
| --- | --- |
| VPF | Deferred. Not in the PRD; zero references in the codebase. |
| EDLI | Deferred. Not in the PRD; zero references in the codebase. |
| Employer administrative charges | Deferred. Not in the PRD; zero references. |
| EPS as a statutory component | Deferred. A pension *split* of the employer share already existed and is informational; it was preserved and not expanded into a component. |
| Previous-employer PF opening balance | Deferred. Not in the PRD. |
| Ceiling policy (mandatory vs opt-in) | Not invented. The rule states it; an ambiguous rule is refused. |

Implementing any of them would mean originating statutory semantics with nothing to check
them against — the same reason the LWF phase stopped at discovery.

## Consequences

- **No payroll output changes.** The seeded platform rule and every test fixture already
  configure all five figures, so nothing that previously calculated now refuses. The E2E
  June baseline is byte-identical: gross ₹96,666.66, TDS ₹3,865.33, net ₹90,801.33, PF ₹1,800.
- **No migration.** The rule model already represented PF adequately; §22 says not to create a
  migration to demonstrate progress, and none was.
- **`CALCULATION_VERSION` unchanged** at `in-payroll-2025.6`. No figure any existing snapshot
  produces differs; the change is refusal-where-ambiguous plus explanation. Bumping it would
  imply finalized slips were computed differently, which they were not.
- **No trigger change**, because no salary-slip column was added.
- A tenant override that omits a rate now fails that employee at calculation time rather than
  silently applying the statutory default. That is the intended behaviour change, and it is a
  refusal rather than a different number.

### Known gaps

- **No PF opening balance for a mid-year joiner.** The same shape of gap ADR-017 recorded for
  exemption utilisation, ADR-019 for surcharge borne and ADR-020 for PT paid elsewhere. PF has
  no annual ceiling in the current model, so nothing depends on it today.
- **`apply_ceiling` is per rule, not per employee.** An employer that restricts PF to the
  ceiling for some employees and not others cannot express that. Nothing in the PRD asks for
  it, and modelling it would mean deciding a policy question the requirements do not raise.
