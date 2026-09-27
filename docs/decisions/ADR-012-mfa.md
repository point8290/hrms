# ADR-012: TOTP, required of anyone holding a sensitive permission

Status: Accepted
Date: 2026-09-16

## Context

Every salary, bank account number and tax declaration in the system was reachable with one
password. A password is the credential most likely to be reused, phished or present in a
breach dump, and the blast radius here is not "an account" — it is every employee's pay and
account details in a tenant.

Separation of duties was already in place: bank and tax permissions are separate from
general HR administration, sensitive actions are audited, and payroll approval and
finalization are distinct permissions. None of that helps if the single factor guarding all
of them is a reused password.

## Problem

Decide the second factor, and decide who must have one.

## Options — the factor

1. **SMS one-time codes.** Highest adoption, and delivered over a channel the account holder
   does not control. SIM swap is a routine, documented attack against payroll systems
   specifically, not a theoretical one.
2. **Email one-time codes.** The reset channel and the second factor become the same
   channel, so compromising the mailbox compromises both.
3. **WebAuthn / passkeys.** Strongest, and it requires a device registration flow, a
   recovery story for lost authenticators, and browser support assumptions this product
   cannot make of every HR user on every corporate desktop.
4. **TOTP (RFC 6238).** Works offline, works in every authenticator app, and the secret
   never leaves the device or the database.

## Options — the requirement

A. Optional for everyone. B. Required of everyone. C. Required of anyone holding a
permission the catalog marks `sensitive`.

## Decision

**TOTP, and option C.**

Enforcement is one rule: *anyone who holds a sensitive permission must have an active
authenticator, and cannot complete a login without one.* "Sensitive" is not a second list —
it is `identity.permission.sensitive`, the same flag that already decides what the audit
trail treats as privileged.

The check lives in `login()`, before any token is issued, not in a route guard. A route guard
can be missed by a new route; a login that cannot mint a token cannot be.

It is re-checked on every refresh. Someone granted a privileged role mid-session would
otherwise keep a compliant-looking session for the life of their refresh token — up to
thirty days — without ever enrolling.

A tenant may additionally set `require_mfa` to demand a factor of every member. That is a
stricter opt-in; the privileged requirement is unconditional.

## Reason

One definition of "privileged", not two. A permission added in a later migration and marked
sensitive is covered automatically, with nobody remembering to update an enforcement list —
which is the failure mode of every hand-maintained security list.

TOTP over SMS because the threat is credential theft by someone who can also social-engineer
a mobile carrier, and that is precisely the attacker a payroll system attracts. TOTP over
WebAuthn because WebAuthn's recovery story for a lost device, in a product where the locked
-out user may be the only person who can run payroll, is a larger design problem than this
phase should open. WebAuthn remains the right next step, and the `method` column exists to
hold it.

Option B was rejected because it would require every employee checking their own attendance
to carry an authenticator, which converts a security control into an adoption problem — and
an adoption problem gets solved by someone turning the control off.

## Consequences

- The login endpoint can return a **challenge** rather than a session. Clients must handle
  `mfa_required` with `stage: "verify" | "enroll"`. The challenge token proves the password
  step, expires in five minutes, has its own JWT audience so `authenticate` rejects it, and
  carries no access.
- Enrolment and login completion are one step. A separate "now sign in again" is where people
  abandon the flow, and an administrator who abandons enrolment is an administrator without a
  second factor.
- The TOTP secret is stored **encrypted** (AES-256-GCM, `FIELD_ENCRYPTION_KEY`) rather than
  hashed, because verification needs the secret itself. A stolen table dump is therefore not
  immediately a set of working authenticators; rotating that key means re-encrypting, and is
  not a routine operation.
- Recovery codes are hashed like passwords, shown exactly once, single-use, and invalidated
  wholesale on re-enrolment. Using one is audited as a sensitive action: it means a lost
  device, or someone who should not have had the codes.
- `last_used_counter` makes every TOTP code single-use inside its own 30-second window. A
  code observed over someone's shoulder is spent.
- Removing the factor requires the password **and** a current code, and is refused outright
  for a privileged account. A hijacked session must not be able to strip the control that
  would have stopped it.
- MFA is not implemented in the web client yet. The API contract is complete and tested; the
  UI is a remaining gap, recorded as such.
