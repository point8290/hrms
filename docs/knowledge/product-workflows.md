# Product workflow contract

What a person can actually *do* in this product, who they are, where they start, and where the
work goes next. The other files in this directory describe the system; this one describes the
product experience over it.

It exists because the backend ran a long way ahead of the interface. At the start of the
product-experience phase the API exposed 126 routes and the UI reached 27 of them, so "does
the capability exist?" and "can anyone use it?" had drifted into two different questions. Each
table below answers the second one.

**Rules for maintaining this file**

- A workflow is listed as usable only when it has been walked end to end against the real API.
- A gap is named as a gap. Nothing here describes an intention.
- Routes appear only when the screen exists. A missing destination is recorded in
  `apps/web/src/lib/links.ts` under `UNROUTED`, not invented here.

---

## Roles

Seven roles ship with every tenant (`SYSTEM_ROLES` in `apps/api/src/modules/identity/service.ts`).
Navigation is driven by permissions, not by role name, so a tenant that composes a new role from
existing permissions needs no front-end change.

| Role | Second factor at sign-in | Primary job in the product |
|---|---|---|
| Employee | no | Self-service: attendance, leave, expenses, payslips, own notifications |
| Manager | no | Approvals for their reports, plus everything an Employee does |
| HR Admin | **required** | People records, onboarding, leave and attendance administration |
| Payroll Admin | **required** | Payroll periods and runs through finalization |
| Finance | **required** | Payroll approval and finalization, expense payment |
| Tenant Admin | **required** | Organisation configuration, users, roles, branding |
| Owner | **required** | Everything, including the sensitive permissions |

MFA is not a product choice: any role holding a permission marked `sensitive` (payroll,
compensation, bank, tax, audit) must complete a second factor (ADR-012). Four of the seven roles
do. This matters for demos — those accounts need an authenticator, and the demo script prints
their enrolment secrets rather than weakening the rule.

---

## Workflow coverage

| Journey | Entry point | Screens | Actions | Backend | Notifications | Status |
|---|---|---|---|---|---|---|
| Leave request → approval → result | `/leave`, `/my-work` | Leave, Approvals, Notifications | apply, cancel, approve, reject | `POST /api/leave/applications`, `/api/approvals/:id/decision` | `leave.awaiting_approval`, `leave.approved`, `leave.rejected` | **usable, walked end to end** |
| Expense claim → approval | `/expenses` | Expenses, claim detail, Approvals | create, submit, cancel, approve, reject | `/api/expense-claims*`, `/api/approvals/:id/decision` | `expense.*` | **usable** |
| Attendance correction → approval | `/attendance` | Attendance, Approvals | raise, approve, reject | `/api/attendance/corrections` | `attendance.correction_decided` | **usable** |
| Payroll period → finalization | `/payroll` | Payroll, run detail | create period, start run, attendance-readiness override, review, approve, finalize | `/api/payroll-periods`, `/api/payroll-runs/:id/*` | `payroll.payslip_available` | **usable, walked end to end**; payment batches still have no UI |
| Tenant signup | sign-in screen | Create a workspace | provision tenant and owner | `POST /api/tenants` | — | **usable, walked end to end** |
| Finance expense queue | `/finance` | Finance | sanction, pay | `GET /api/expense-claims?scope=finance`, `/:id/sanction`, `/:id/pay` | `expense.paid` | **usable, walked end to end** |
| Reports | `/reports` | Reports | run, download | `/api/reports*` (9 types) | — | **usable** |
| Tax declarations | `/tax` | Tax | declare, verify | `GET/PUT /api/tax/declarations`, `/:id/verify` | — | **usable** |
| Account security | `/account` | Account | change password, enrol/replace/disable MFA | `/api/auth/change-password`, `/api/account/mfa*` | — | **usable** |
| Compensation | `/organization` → Compensation | Organization | structure, assignment | `/api/compensation/*` | — | **usable** (minimum needed by payroll) |
| Onboarding | `/employees/:id` &rarr; Onboarding, `/my-work` | Employee detail, My work | start plan, complete task | `/api/onboarding/plans`, `/my-tasks`, `/tasks/:id/complete` | `onboarding.task_assigned` | **usable, walked end to end** |
| Employee lifecycle | `/employees` | People, employee detail | create, record change, separate | `POST /api/employees`, `/:id/lifecycle`, `/:id/separate` | `employee.welcome` | **usable, walked end to end** |
| Organisation setup | `/organization` | Organization | companies, locations, departments, designations, grant access | collection endpoints, `POST /api/users` | — | **usable** |
| Notifications → action | `/notifications` | Notifications | read, navigate, set preferences | `/api/notifications*` | — | **usable** |
| Branding | `/settings` | Settings | set identity, colour, density, radius | `/api/tenant/branding` | — | **usable** |
| Role dashboards | `/` | Home | — | the endpoints each section reads | — | **usable** — sections are permission-gated, one framework |
| Compensation | — | — | — | `/api/compensation/*` | — | **no UI** |
| Tax declarations | — | — | — | `/api/tax/*` | — | **no UI** |
| Reporting | — | — | — | `/api/reports*` (9 reports) | — | **no UI** |
| Payment batches | — | — | — | `/api/payment-batches*` | — | **no UI** |

---

## The leave journey, as an example of the pattern

Every approval journey in the product has the same shape, and the screens are built to make
each hand-off visible:

```
Employee              applies                 /leave
  → workflow instance created                 backend
  → approval task assigned                    backend
Manager               sees a count            sidebar badge
  → opens the request with its context        /approvals  (GET /api/approvals/:id)
  → approves or rejects with a reason         POST /api/approvals/:id/decision
  → ledger movement in the same transaction   backend
Employee              notified                /notifications
  → sees the new status and balance           /leave
```

The step that used to be missing is the third one. The approvals list carries only enough to
triage; `GET /api/approvals/:id` carries the request itself — dates, amount, reason, routing,
history — because approving without it is a rubber stamp rather than a decision.

---

## What "My Work" aggregates

`/my-work` is the product's answer to "what needs me?". It has no store of its own; every item
is authoritative backend state:

| Item | Source | Who sees it |
|---|---|---|
| Approval tasks | `GET /api/approvals` | anyone with an approve permission |
| Onboarding tasks | `GET /api/onboarding/my-tasks` | task owner |
| Own leave awaiting a decision | `GET /api/leave/applications` | the requester |
| Unsubmitted expense claims | `GET /api/expense-claims` | the claimant |

There is deliberately no fourth category invented for completeness. If the product cannot point
at a record, it shows nothing.

---

## Branding

Tenant branding is configuration, never a fork. `identity.tenant_branding` holds it, the API
serves it, and `apps/web/src/lib/branding.ts` turns it into CSS custom properties that every
component already consumes.

| Level | What a tenant controls | Where |
|---|---|---|
| 1 — identity | display name, logo, favicon, sign-in tagline, email footer | `/settings` |
| 2 — theme | primary colour, accent colour, density, corner radius | `/settings` |
| 3 — product configuration | **not branding** — roles, workflow definitions, payroll and notification policy | their own surfaces |

Two rules hold this together:

- **Components consume semantic tokens** (`--brand`, `--danger`, `--radius-md`) and never a
  client-specific name. A token called `--acme-blue` would be a fork in disguise.
- **A tenant cannot break readability.** The raw brand colour is used for solid fills only.
  Anything that carries text uses `--brand-ink`, the same hue darkened until it clears 4.5:1,
  and `--brand-contrast` picks black or white for labels sitting on the brand colour. A tenant
  who picks `#ffd400` gets a yellow product, not an unreadable one.

There is no free-form CSS field, by design: it would be both an XSS surface and an unbounded
support commitment.

---

## Known gaps

Recorded here so they stay visible rather than being rediscovered.

1. **Deep links are partial.** PRD s.18.7 asks that notifications link to the entity. They do
   where a screen exists; `UNROUTED` in `lib/links.ts` lists the entity types with no
   destination. No fake URL is generated for those.
3. **Payroll stops at `finalized`.** `payment_pending` and `paid` exist in the backend and in
   the run's state machine; the payment-batch screens do not.
4. **`payroll_finalized` still has no defined recipient** (PRD s.18.4 names it, s.19 lists the
   event, neither says who receives it). Unchanged from the notifications phase.
5. **Tenant-level notification policy** (PRD s.20) remains unimplemented; only the employee
   layer exists.
6. **Still API-only:** expense advances, leave accrual/carry-forward jobs, onboarding template
   authoring and task skip, attendance bulk check-in and recalculation, payroll recovery and
   stalled-run operations, branches beyond create, role and permission administration,
   statutory rule and tax-year configuration, document listing outside receipts and payslips.
7. **Tenant identity is not editable** — timezone, locale, currency and financial-year start
   have no update endpoint, deliberately: changing them retrospectively would move every
   historical payroll period and tax year. The Organization page shows them read-only.

## Defects this phase found by executing the product

Kept because each one was invisible to inspection and only appeared when the workflow was
actually walked.

- **Calendar dates shifted a day.** `date` columns serialised through UTC, so an approver saw
  the wrong leave dates. Fixed by sending them as text.
- **Cross-tenant organisation references were accepted.** PostgreSQL evaluates foreign keys
  with row security bypassed, so `companyId` pointing at another tenant's company satisfied
  the constraint. Nothing leaked — the row carried the right `tenant_id` — but every read
  inner-joins the company, RLS hid it, and the employee HR had just created vanished from the
  directory. `assertOrgReferences` now checks each reference against the tenant.
- **Document upload could never work against the local driver.** A presigned PUT carries the
  file's own content type; Fastify had a parser only for `application/octet-stream` and
  answered 415. It worked against S3 because those bytes never reach Fastify.
- **The dev proxy did not forward `/internal`,** where the local driver's presigned URLs live,
  so uploads and downloads 404ed in development while working in production.
