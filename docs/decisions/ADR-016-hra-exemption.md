# ADR-016: HRA exemption is a period calculation that a tax year accumulates

Status: Accepted
Date: 2026-09-16
Relates to: ADR-003, ADR-005, ADR-014, ADR-015
Reference: Income Tax Act section 10(13A) read with rule 2A; section 115BAC for the new regime

## Context

House rent allowance is exempt from tax up to the **least of three** figures:

```
A  the house rent allowance actually received
B  the rent paid, less 10% of basic
C  50% of basic in a metro, 40% elsewhere
```

The arithmetic is not the hard part. Three other things are.

**Which component is the basic?** Nothing in the schema said. `statutory_type` identified PF,
ESI and professional tax, but the ordinary components that statute nonetheless singles out
were distinguishable only by a code or a display name — so a tenant calling theirs
`BASIC_PAY`, or an engine matching on the string "HRA", would produce a confidently wrong
number on a real person's payslip.

**What is the rent?** It cannot be inferred from salary, from location or from bank data. It
also changes mid-year: people move, and leases renew.

**What does the exemption mean annually?** This is the one that decides the design.

## Decision

### The exemption is evaluated per payroll period, and the year is the sum of its periods

```
Payroll period
    -> period exemption (least of three, on that period's own basic, allowance and rent)
    -> accumulate the periods already paid
    -> project each remaining period on the inputs that will apply to it
    -> tax-year exemption
    -> annual taxable income
```

The rejected alternative is `current month's exemption × 12`. It is wrong for anyone whose
circumstances change — a promotion in July, a house move in October, a joiner in September, a
lease ending in December, a leaver in November — and it is wrong in the direction that
under-deducts, which is the employer's liability under section 192.

**Accumulation is free and needs no ledger.** Each period's exemption is subtracted from that
period's taxable earnings before they are written to the slip, and ADR-014's annualisation
already sums `salary_slip.taxable_earnings` over the year's finalized slips. So the
year-to-date exemption is effective-dated by construction, with nothing to keep in step.

**Projection is explicit, and is the only new term.** Node walks the remaining periods of the
tax year one at a time — asking separately for each whether the employee is still employed,
what salary applies and what rent applies — and collapses only adjacent periods that answer
identically into a segment. The engine evaluates the least-of-three per segment and multiplies
by a *count of periods*. `calculate_income_tax` gained one argument,
`projected_exemption`, which is a total the caller has already worked out rather than a rate to
be multiplied, precisely because an exemption is not proportional to salary the way the rest
of the annualisation is.

### Components say what they are

`salary_component.semantic_role`, currently `basic` or `house_rent_allowance`. Migration 0025
backfills the exact codes `BASIC` and `HRA` that this system has been seeding since 0006;
anything else is the tenant's to set, and until they do the exemption is **zero rather than
guessed**. Two components claiming one role fails that employee, naming both codes — an
ambiguity, not something to resolve by ordering.

### Metro classification is stated, never derived

`core.location.metro_classification`, with an optional override on the rent declaration
because people do not always rent where they work. The engine receives `METRO` or `NON_METRO`
already resolved and frozen; it holds no city list.

Default `non_metro`. The two errors are not symmetric: classifying a metro as non-metro
under-states the exemption and over-deducts, which the employee reclaims when they file; the
reverse under-deducts, which is the employer's problem. It is also the default that leaves
every existing tenant's figures unchanged.

### Rent declarations are their own effective-dated record

`compensation.rent_declaration`, not a key inside `tax_declaration`'s jsonb — that table is one
row per employee per year holding a single investment total, and rent has dates, its own proof
lifecycle and its own verified amount. A GIST exclusion constraint stops two declarations
covering one day, because rent for a given day decides how much tax is withheld and must have
one answer.

`status` is `declared` / `verified` / `rejected`, which is the vocabulary phase 4 will act on.
This phase honours a rejection (it contributes nothing) and calculates a verified declaration
on its verified amount. **The proof cutoff itself is not implemented here.**

### The exemption is not a deduction, and gets its own line type

`salary_slip_component.component_type` gains `exemption`. It moves no money: gross, deductions
and net are all unchanged by it, and the engine's `validate()` sums by type so it is excluded
without further change. The line carries the full explanation — every one of the three limits,
which one bound, and the projection segments — and `salary_slip.hra_exemption` carries the
figure for the next period's annualisation to read without unpacking jsonb.

Both are covered by the finalized-slip guard. An explanation that could be rewritten after the
fact is worth nothing in a dispute, so migration 0029 also closed a pre-existing gap: the
component rows of a finalized slip were unprotected.

### The new regime does not exempt HRA

Section 115BAC trades section 10(13A) away for lower slabs. Defaulted from the statute and
overridable per rule version, the same pattern ADR-014 established for which deductions reduce
taxable income. Getting this wrong would exempt fully taxable income for every employee on the
new regime.

### LOP reuses the existing model rather than adding one

The least-of-three is measured against the basic and the allowance **as actually paid** — after
percentage resolution and after loss of pay — which the engine reads off the component lines it
has already computed. Rent is *not* pro-rated: a landlord is not paid by attendance.

A future period carries no loss of pay because none has happened yet, so the projection assumes
full-salary periods. That is the same assumption the existing annualisation already makes about
recurring pay, and any divergence is corrected in the period it occurs and spread over the
periods that remain.

## Consequences

- **No existing payroll figure changes.** The end-to-end journey's June run is byte-identical:
  gross ₹96,666.66, TDS ₹3,865.33, net ₹90,801.33. Exemption requires a rent declaration, and
  the table did not exist before this phase, so every pre-existing employee's exemption is zero
  — which is exactly what their finalized slips already applied.
- **A tenant must configure two things to get any exemption**: a `semantic_role` on their basic
  and allowance components, and a rent declaration. Both absences are recorded on the snapshot
  with a reason, so "no exemption" never looks like "nobody asked".
- **`CALCULATION_VERSION` moved to `in-payroll-2025.3`.** Finalized slips keep the version that
  produced them.
- `payroll_input_snapshot.hra_json` is a new frozen input section. Snapshots written before it
  default to `{"applicable": false}`, so recalculating an old run still reproduces its figures.
- Deferred by design, and explicitly out of scope: the proof cutoff date (phase 4), section
  exemption caps (phase 3), and dearness allowance forming part of the HRA base — the last
  needs a `dearness_allowance` role and a rule saying when DA counts, which is a phase of its
  own.
