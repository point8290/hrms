# ADR-020: Professional tax follows the workplace, not the income-tax regime

Status: Accepted
Date: 2026-09-18
Relates to: ADR-005, ADR-014, ADR-017, ADR-018, ADR-019

## Context

Professional tax is levied by **states**, not by the union. It was already implemented in
outline — `payroll.statutory_rule` has carried `rule_type = 'professional_tax'` with a
`state_code` since migration 0006, Karnataka and Maharashtra were seeded in 0008, and
`core.tax_profile.pt_state_code` is effective-dated and already resolved as at the period end.

What was missing was not the framework. It was three things the framework could not say.

1. **Maharashtra's actual schedule.** ₹200 a month for eleven months and ₹300 in February, so
   the year totals ₹2,500. The seeded rule had a flat ₹200 and no way to express either the
   February instalment or the annual ceiling.
2. **What the slab thresholds measure.** The engine used gross earnings. Nothing recorded
   that as the intended basis, so a reader could not tell intent from accident.
3. **The difference between "this state levies none" and "nobody configured this state."**
   Both deducted zero and were indistinguishable afterwards.

## Decision

### The jurisdiction chain, written down

```
1. core.tax_profile.pt_state_code   — an assertion of liability. Authoritative.
2. core.location.state_code         — where the employee works. A location fact.
```

Both resolve **as at the payroll period's end**, never today. Residential address is
deliberately not in the chain: the system holds no residential state, PT follows the place of
employment, and inferring it from where someone lives would be a guess dressed as a fact.

The precedence matters because the two differ in *force*, not just in order. ADR-014 decided
that an explicit `pt_state_code` makes PT mandatory for that employee while a location-derived
state does not, and that stands — reversing it would fail closed on every tenant with an
office in a state nobody has configured. What is new is that the snapshot now records which
of the two was used (`state_source`), so a payslip can answer "why Karnataka" as well as
"why 200".

`payroll.tenant_payroll_policy.require_professional_tax` is the opt-in for tenants who want
the stricter reading: every employee must resolve to a configured rule or payroll refuses
them. Default false reproduces today's behaviour exactly.

### Historical jurisdiction falls out of effective dating

A transfer is a **new** effective-dated tax-profile row, not an edit. So a September payroll
recalculated after an October transfer still resolves September's state, and the pre-transfer
row survives. No new structure was needed for this; it was already true and is now tested.

### Rules stay in `payroll.statutory_rule`

No second statutory-rule framework. That table is already state-specific, effective-dated,
versioned, tenant-overridable, non-overlapping per scope and RLS-protected — every property
§4 asks for. Version 1 of each state's rule is closed at 2026-03-31 and version 2 carries the
same amounts plus the structure that was missing; superseding rather than editing, per ADR-005.

The special instalment sits **on the slab it modifies**:

```json
{"upto": null, "amount": 200, "special_months": {"2": 300}, "label": "above 10,000"}
```

rather than in a month table beside the slabs, because that is exactly where the ambiguity
would otherwise be — Maharashtra's ₹175 band has *no* February instalment, and a month-keyed
list next to the slabs could not say so. No month number appears anywhere in Python: the month
comes from the payroll period being calculated and the amount from the rule.

### PT is a period deduction, and not annualised

The slab amounts are monthly amounts against a monthly wage. Nothing goes near the income-tax
annualisation pipeline and there is no `annual / 12` anywhere. **Wage basis is the period's
gross earnings** — which is what the engine already used and what the seeded thresholds
(₹7,500 / ₹10,000 / ₹25,000) are plainly scaled for. It is now named in the rule
(`wage_basis: "gross_earnings"`) so a future state whose basis differs has somewhere to say so.

Consequences of that basis, all deliberate and all tested:

| situation | behaviour |
| --- | --- |
| loss of pay | the *band* moves, the amount is not pro-rated |
| full month of LOP | zero earnings → lowest band → nil |
| joining or leaving mid-month | whatever that period's earnings put them in |
| bonus, arrears, additional salary | included; a bonus can lift an employee over the limit for that month |
| supplementary run | PT is charged on what the run pays |

Pro-rating the *amount* was rejected: no supported state's schedule asks for it, and inventing
a proration rule would be inventing statute.

### PT is independent of the income-tax regime

An employee electing the new regime still pays their state's professional tax. Different
levies, different governments. The engine resolves PT from the frozen jurisdiction context and
never consults `regime`, surcharge, marginal relief or any exemption. PT does still *reduce*
taxable salary income under section 16(iii), which is a separate fact and was already true.

### An unsupported state is recorded, never a silent zero

Three distinguishable outcomes, and the reason travels on the snapshot and the trace:

- rule configured → calculate
- `applicable: false` → this state genuinely levies none
- no rule at all → **not supported by this deployment**, recorded with the state and the date

A rule with no slabs, a schedule that stops short of the wage with no open-ended top band, or
a slab with no amount **raises**, failing that one employee. A gap in a schedule is a
configuration error, not a zero.

**Supported states are Karnataka and Maharashtra.** This is not nationwide PT support and is
not claimed to be.

### Rounding

`rupees()` — whole rupees, HALF_UP — which is what the engine already used for statutory
deductions and what PT is conventionally remitted in. No new rounding was introduced.

### No new salary-slip field, and no trigger change

PT is already a statutory deduction line, and the trace now carries the whole story:
jurisdiction, how it was resolved, rule id, version, source and effective date, wage basis,
matched slab, standard amount, special-month adjustment, annual cap and final amount. A column
holding a copy of one line's amount would be a second source of truth that could disagree with
it. `payroll.guard_finalized_slip` was inspected from `pg_proc.prosrc` and **not modified**.

## Consequences

- **No existing payroll figure changes.** Both states keep the same ordinary-month amount;
  only February in Maharashtra differs, and only from FY 2026-27. The E2E June baseline is
  byte-identical: gross ₹96,666.66, TDS ₹3,865.33, net ₹90,801.33, PT ₹200.
- `calculate_professional_tax` returns a result with its reasoning instead of a bare Decimal.
  Two existing unit tests read `.amount`; their asserted figures are unchanged.
- **`CALCULATION_VERSION` was not incremented.** No figure any existing snapshot produces
  changes: the February instalment and the ceiling only exist in rule versions that no
  finalized run has consumed, and the rest of the change is explanation. Bumping it would
  imply finalized slips were computed differently, which they were not.
- Rule changes affect **future payroll only**. A finalized run reads the config frozen in its
  snapshot; publishing a new version never reaches back.

### Known limitations

- **Annual ceiling scope.** The cap is enforced against PT deducted in *this* tenant's
  finalized slips for the tax year. An employee who joins mid-year having already paid PT
  elsewhere has no opening PT figure, so their ceiling is assessed as if unused — the same
  shape of gap ADR-017 recorded for exemption utilisation and ADR-019 for surcharge borne.
  Documented rather than invented.
- **Location is not itself effective-dated.** `core.employee.location_id` has no history, so
  an employee who physically relocates without a tax-profile assertion has their *historical*
  payroll resolved against today's location. The authoritative path (`pt_state_code`) is
  effective-dated and unaffected; a tenant relying on the location fallback for a transferring
  employee should assert the state instead. Closing this needs an effective-dated employment
  location, which is a larger change than this phase.
- Deferred and unchanged: HRA rent-proof cutoff, previous-employer exemption utilisation,
  opening surcharge borne, LWF, PF enhancements, gratuity.
