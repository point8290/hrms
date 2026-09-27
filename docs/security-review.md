# Security review — production boundary hardening

Date: 2026-09-16
Scope: the MVP as implemented, reviewed against the threat of an attacker who has one valid
set of credentials, or one foothold in the estate.

This is a review of *what is built*, not a checklist of what could be. Every finding below
is either fixed with a reference to the fix, or recorded as an accepted risk with the reason.

---

## 1. Tenant isolation

The single worst failure this system can have is one tenant reading another's payroll.

**Controls.** `tenant_id` on every tenant-owned table; PostgreSQL RLS as the enforcement
boundary; transaction-local context (`SET LOCAL app.tenant_id`), never session-level, because
a pooled connection would carry it into the next tenant's request; a boot probe that refuses
to start the API if its own connection can bypass RLS.

**Reviewed at five layers**, because the context is established in five different places and
any one of them getting it wrong is a leak:

| Layer | Where the tenant comes from | Test |
| --- | --- | --- |
| HTTP | the `tid` claim of a verified token | `tenant-context.test.ts` |
| Queue consumer | the event envelope | `tenant-context.test.ts` |
| Scheduled job | the tenant being ticked | `scheduler.test.ts`, `tenant-context.test.ts` |
| Outbox publisher | the row's own `tenant_id` | `tenant-context.test.ts` |
| Repository | `withTenant()`, validated as a UUID | `tenant-isolation.test.ts` |

**Explicitly tested as ignored:** a tenant id supplied in a header, in a query string, or
implied by an aggregate id belonging to another tenant. All are ignored; none widens what the
caller can see.

**Finding — none.** No path was found that takes a tenant from client-controlled input.

**Accepted design note.** Tables are `ENABLE`, not `FORCE ROW LEVEL SECURITY`. The isolation
boundary is the *role*: `hrms_app` is a non-owner without `BYPASSRLS`, and the API refuses to
boot otherwise. `FORCE` would additionally apply policies to `hrms_owner`, which runs
migrations and `identity.purge_tenant()` — both legitimately cross-tenant. Under `FORCE`
those would not error; they would silently affect zero rows. A backfill that quietly does
nothing is a worse failure than the one `FORCE` prevents. `scripts/db/validate-migrations.mjs`
asserts the role property that actually carries the weight, and does so in CI.

---

## 2. Authentication

**Fixed this phase.** A password alone reached every salary, bank account and tax record.
Anyone holding a permission the catalog marks `sensitive` now needs a second factor (ADR-012),
enforced in `login()` before a token is issued and re-checked on every refresh.

**Reviewed:**

- *Enumeration.* Wrong password, unknown email and absent membership all return the same
  message after the same work (`burnPasswordTime`). The password-reset endpoint returns the
  same body whether or not the address exists. Confirmed by test.
- *Brute force.* Login is limited to 10 per 5 minutes per key; MFA verification to 10 per 15
  minutes. Six digits is a million possibilities, which a generous limit makes tractable.
  Account lockout is applied before the password is even checked, so a lockout cannot be
  probed by timing.
- *Token theft.* Refresh tokens are single-use and rotated. Reuse of a rotated token revokes
  every session for that user and writes a sensitive audit row. A ten-second grace window
  distinguishes a double-submit from theft — without it, a user on a flaky network is logged
  out for retrying.
- *Replay.* A TOTP code is spent when used (`last_used_counter`), so a shoulder-surfed code
  is worthless for the rest of its window.
- *Secret handling.* TOTP secrets are AES-256-GCM encrypted; recovery codes are hashed like
  passwords and shown once. Verified by test that neither appears in the database in the
  clear.
- *Downgrade.* The MFA challenge token has its own JWT audience, so `authenticate` rejects it.
  A half-finished login cannot be used as a session.

**Finding — accepted risk.** An access token issued before a privileged role was granted
remains valid, without MFA, until it expires (15 minutes). Mitigated by the refresh-time
re-check, which revokes every session for that user. Shortening the access TTL further would
cost more than it buys.

**Finding — gap.** MFA is not implemented in the web client. The API contract is complete and
tested; a client that does not handle `mfa_required` will simply fail to log a privileged user
in. Recorded, not hidden.

---

## 3. Authorization

Permission codes rather than roles, with self-service permissions (`*.read.self`) distinct
from broad ones, so an employee can read their own record and nothing else.

**Reviewed:** every route registers `authenticate` except the thirteen that must not
(tenant signup, login, refresh, password reset, email verification, the three MFA challenge
endpoints, and four health endpoints). Enumerated mechanically rather than by reading, and the
list matches the intended set exactly.

**Finding — none.**

---

## 4. `/internal/*`

The concern is real: a route is not private because it is named `internal`.

There is exactly one: `GET,PUT /internal/files/*`, the local-storage driver's object
endpoint, which exists so development mirrors the S3 presigned-URL flow.

**Controls, in order:**

1. It returns 404 unless `STORAGE_DRIVER=local`. In production `STORAGE_DRIVER=s3` is
   enforced by configuration validation at boot — `config.ts` refuses to start with
   `local` when `NODE_ENV=production` — so the route is dead code in production.
2. Even in development it requires an HMAC signature over the key and an expiry, verified in
   constant time. An unsigned or expired request gets 403.
3. The key is tenant-prefixed, so a signature for one tenant's object cannot reach another's.

**Finding — accepted.** The control that matters most is the boot-time configuration guard:
`config.ts` throws on `STORAGE_DRIVER=local` when `NODE_ENV=production`, so a production
process holding that setting does not start at all. Configuration is parsed once and cached,
so the route's per-request check reads the same validated value — it is defence in depth
against a non-production environment, not a second independent control. The signature check
is the independent one.

No other Node route is named or treated as internal. The Python engines expose
`POST /internal/close-day`, and they are reached in normal operation only by polling SQS.

**Finding — open, blocking their deployment.** The engines are not in Terraform yet
(`infra/README.md` records them as planned), so there is no security group asserting that
nothing can reach that endpoint. The rule is written down here so it is a requirement rather
than an oversight when they are deployed: **the engine services get a security group with no
ingress from the ALB and no ingress at all**, in the same shape as the worker's. Until then
they run only in `docker compose`, where they are on a private network with no published
port.

---

## 5. Data at rest and in transit

- TLS terminated at the ALB with a TLS 1.2 floor; **no port 80 listener at all**, not even a
  redirect, because a redirect is a request that already travelled in the clear and this
  API's requests carry bearer tokens.
- `rds.force_ssl = 1`, so the database refuses an unencrypted connection.
- Redis has transit and at-rest encryption and an auth token.
- S3: KMS with a dedicated key, bucket policy denying non-TLS and non-KMS writes, all four
  public-access blocks, versioning, and access logging.
- SQS: KMS-encrypted queues.
- Bank account numbers and TOTP secrets are AES-256-GCM encrypted at the field level, so a
  database dump is not immediately a list of account numbers.

**Finding — none.**

---

## 6. Secrets

No credential appears in the repository, in Terraform state as plaintext, in a task
definition's `environment`, or in an access key.

- Secrets Manager holds the values; Terraform creates only the containers, so a value never
  passes through a plan or a state file.
- ECS injects them through `secrets`, not `environment`, so they are invisible to
  `ecs:DescribeTaskDefinition` — a much wider audience than those who should read a database
  password.
- AWS access is entirely by task role. The SQS and S3 clients are constructed with a region
  and nothing else; the SDK's default provider chain resolves the role. There is no key to
  leak, rotate or commit.
- The API and worker have **different** task roles. The API can send messages and presign
  objects; it cannot receive or delete a message. A compromised API task cannot drain the
  payroll queue.

**Finding — none.**

---

## 7. Logging and telemetry

The rule: identifiers and counts may be recorded; values may not.

- Fastify's logger redacts `authorization`, `cookie`, and the password, admin password,
  account number and refresh token body fields.
- Audit rows pass through `redact()` before being written, so the trail records *that* a
  secret changed, never the secret.
- Span attributes are restricted by an **allow-list** of key names, not a deny-list, so a
  future attribute nobody anticipated fails closed. Verified by a test that attempts to
  record a name, an email, a salary, an account number, a PAN, a password, a refresh token
  and an OTP secret, and asserts all eight are dropped.
- Error spans carry the error *type*, never the message. A PostgreSQL unique-violation
  message quotes the row that violated the constraint, and that row is employee data.
- Health responses were checked for connection strings, hosts and credentials by test.

**Finding — fixed this phase.** Before the allow-list, nothing prevented an attribute
containing payroll data from being exported to a third-party trace store.

---

## 8. Input handling

Zod schemas on every body, params and query; a 5 MB body limit; helmet; CORS restricted to
configured origins in production. Database integrity errors are translated to 409/422 rather
than surfacing as 500s that leak constraint names.

**Reviewed for injection.** Every query is parameterised. The one place a value reaches SQL
outside a parameter is `SET LOCAL app.tenant_id`, which is why `withTenant()` validates the
tenant id against a UUID regex and throws otherwise — tested with `' OR 1=1 --`.

**Finding — none.**

---

## 9. Availability and abuse

- Rate limiting is shared through Redis; the API refuses to start in production without
  `REDIS_URL`, because a per-process limit silently multiplies by the instance count.
- It fails **open**. This is a deliberate trade and worth stating plainly: a Redis outage
  degrades the limit rather than taking the API down. Isolation and authorization are
  enforced elsewhere and are unaffected — proven by a test that drives the API against a
  Redis failing every command and asserts authentication and tenant isolation still hold.
- SQS messages are capped at 256 KiB by an explicit check, so a change that starts embedding
  employee data in an event fails locally and loudly rather than in production.
- A poison message is dead-lettered after five receives rather than looping for ever, in both
  the SQS and the local driver.

**Finding — none.**

---

## 10. Deletion and retention

`identity.purge_tenant()` is the only path that may delete from an append-only table. It sets
`app.purge_mode` transaction-locally, is executable only by the platform role, permits DELETE
and never UPDATE — history can be removed wholesale under an authorised erasure, but never
quietly rewritten — and every purge writes to `identity.tenant_purge_log`, which outlives the
tenant it names.

**Finding — none.**

---

## Summary

| # | Area | Status |
| --- | --- | --- |
| 1 | Tenant isolation | No finding |
| 2 | Authentication | MFA added; one accepted risk, one recorded gap (web client) |
| 3 | Authorization | No finding |
| 4 | `/internal/*` | Accepted, caveat recorded |
| 5 | Encryption | No finding |
| 6 | Secrets | No finding |
| 7 | Logging and telemetry | Fixed: span attribute allow-list |
| 8 | Input handling | No finding |
| 9 | Availability | No finding |
| 10 | Deletion | No finding |

### Not in scope, and therefore not claimed

Penetration testing, dependency CVE scanning in CI, WAF rules, GuardDuty, and a formal threat
model workshop. Each is listed in `infra/README.md` as planned rather than quietly omitted.
