-- 0021 multi-factor authentication.
--
-- Payroll, bank details and tax profiles are reachable with one password. A password is the
-- credential most likely to be reused, phished or found in a breach dump, and the blast
-- radius here is every employee's salary and account number — so a second factor is not a
-- hardening nicety, it is the control that makes the sensitive permissions defensible.
--
-- TOTP rather than SMS: an SMS code travels over a channel the account holder does not
-- control, and SIM swap is a routine attack on payroll systems specifically.
--
-- Not tenant-scoped, for the same reason `identity.app_user` is not: a person has one login
-- and one authenticator across every workspace they belong to. Scoping the factor per tenant
-- would mean enrolling the same phone repeatedly, and would leak which workspaces an email
-- belongs to during enrolment.

-- rls:exempt identity.user_mfa global user credential; a person has one authenticator across every tenant
CREATE TABLE identity.user_mfa (
  user_id           uuid PRIMARY KEY REFERENCES identity.app_user(id) ON DELETE CASCADE,
  method            text NOT NULL DEFAULT 'totp' CHECK (method IN ('totp')),

  -- AES-256-GCM, via FIELD_ENCRYPTION_KEY. Stored encrypted rather than hashed because
  -- verification needs the secret itself; encryption at least means a stolen table dump is
  -- not immediately a set of working authenticators.
  secret_encrypted  text NOT NULL,

  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'active')),

  -- The last TOTP step this user successfully used. A code is valid for thirty seconds;
  -- without this, one observed over someone's shoulder stays usable for the rest of its
  -- window. Recording it makes every code strictly single-use.
  last_used_counter bigint,

  confirmed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
SELECT app.add_updated_at_trigger('identity.user_mfa');

COMMENT ON TABLE identity.user_mfa IS
  'One authenticator per person, across every tenant. `pending` until a first code is verified.';

-- rls:exempt identity.mfa_recovery_code belongs to the global user record, like user_mfa
CREATE TABLE identity.mfa_recovery_code (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES identity.app_user(id) ON DELETE CASCADE,
  -- Hashed with the same function as a password: a recovery code *is* a credential, and a
  -- readable list of them in the database is a bypass of the factor it backs up.
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_mfa_recovery_user ON identity.mfa_recovery_code (user_id) WHERE used_at IS NULL;

COMMENT ON TABLE identity.mfa_recovery_code IS
  'Single-use codes for a lost authenticator. Shown once at enrolment and never again.';

-- Whether this tenant requires a second factor of everyone, not only of privileged roles.
-- Privileged enforcement is unconditional and lives in code; this is the stricter opt-in.
ALTER TABLE identity.tenant
  ADD COLUMN require_mfa boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN identity.tenant.require_mfa IS
  'Require MFA of every member. Holders of sensitive permissions are required to enrol regardless.';
