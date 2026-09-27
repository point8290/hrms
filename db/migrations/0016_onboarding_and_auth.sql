-- 0016 onboarding task orchestration, and the auth flows the MVP was missing.
--
-- Onboarding follows mature HR behaviour: a reusable
-- template of activities, instantiated per new joiner, each activity owned by a role or a
-- specific person, with due dates relative to the joining date and a mandatory flag that
-- gates completion.

-- Onboarding is the first occupant of this schema; recruitment proper follows later.
CREATE SCHEMA IF NOT EXISTS recruitment;

CREATE TABLE recruitment.onboarding_template (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- Narrowing rules: the most specific matching template wins when a plan is created.
  department_id  uuid REFERENCES core.department(id),
  designation_id uuid REFERENCES core.designation(id),
  employment_type text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
SELECT app.enable_tenant_rls('recruitment.onboarding_template');
SELECT app.add_updated_at_trigger('recruitment.onboarding_template');

CREATE TABLE recruitment.onboarding_template_task (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES recruitment.onboarding_template(id) ON DELETE CASCADE,
  sequence_no integer NOT NULL,
  title       text NOT NULL,
  description text,
  category    text NOT NULL DEFAULT 'general'
                CHECK (category IN ('general', 'document', 'it_asset', 'training',
                                    'bank_details', 'tax_declaration', 'introduction')),
  -- reporting_manager and hr resolve at plan time; employee means the joiner themselves.
  owner_kind  text NOT NULL DEFAULT 'hr'
                CHECK (owner_kind IN ('employee', 'reporting_manager', 'hr', 'role')),
  owner_role_id uuid REFERENCES identity.role(id),
  -- Negative means before the joining date (offer paperwork, asset ordering).
  due_offset_days integer NOT NULL DEFAULT 0,
  is_mandatory boolean NOT NULL DEFAULT true,
  -- When set, completing the task requires a document of this type to exist.
  requires_document_type text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, sequence_no)
);
SELECT app.enable_tenant_rls('recruitment.onboarding_template_task');

CREATE TABLE recruitment.onboarding_plan (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL REFERENCES core.employee(id) ON DELETE CASCADE,
  template_id   uuid REFERENCES recruitment.onboarding_template(id),
  template_name text NOT NULL,
  joining_date  date NOT NULL,
  status        text NOT NULL DEFAULT 'in_progress'
                  CHECK (status IN ('in_progress', 'completed', 'cancelled')),
  completed_at  timestamptz,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- One live plan per employee; a re-onboard cancels the old one first.
  UNIQUE (tenant_id, employee_id)
);
SELECT app.enable_tenant_rls('recruitment.onboarding_plan');
SELECT app.add_updated_at_trigger('recruitment.onboarding_plan');

CREATE TABLE recruitment.onboarding_task (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  plan_id       uuid NOT NULL REFERENCES recruitment.onboarding_plan(id) ON DELETE CASCADE,
  sequence_no   integer NOT NULL,
  title         text NOT NULL,
  description   text,
  category      text NOT NULL DEFAULT 'general',
  -- Resolved at plan time. A task nobody owns cannot be chased, so this is NOT NULL for
  -- any task that was resolvable; unresolvable ones fall back to the plan creator.
  owner_employee_id uuid REFERENCES core.employee(id),
  owner_role_id uuid REFERENCES identity.role(id),
  due_date      date NOT NULL,
  is_mandatory  boolean NOT NULL DEFAULT true,
  requires_document_type text,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped')),
  completed_by  uuid,
  completed_at  timestamptz,
  completion_note text,
  document_id   uuid REFERENCES documents.document(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('recruitment.onboarding_task');
SELECT app.add_updated_at_trigger('recruitment.onboarding_task');
CREATE INDEX idx_onboarding_task_owner
  ON recruitment.onboarding_task (tenant_id, owner_employee_id, status)
  WHERE status IN ('pending', 'in_progress');
CREATE INDEX idx_onboarding_task_plan ON recruitment.onboarding_task (plan_id, sequence_no);
CREATE INDEX idx_onboarding_task_overdue
  ON recruitment.onboarding_task (tenant_id, due_date)
  WHERE status IN ('pending', 'in_progress');

-- ---------------------------------------------------------------- auth

-- Single-use, short-lived tokens for password reset and email verification.
-- Stored hashed for the same reason refresh tokens are: a database leak must not hand an
-- attacker a working reset link.
CREATE TABLE identity.auth_token (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES identity.app_user(id) ON DELETE CASCADE,
  -- Not tenant-scoped: a user is global, and a reset must work before a tenant is chosen.
  purpose    text NOT NULL CHECK (purpose IN ('password_reset', 'email_verification')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  requested_ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- rls:exempt identity.auth_token global user identity; a reset must work before a tenant is chosen
CREATE INDEX idx_auth_token_user ON identity.auth_token (user_id, purpose)
  WHERE consumed_at IS NULL;

COMMENT ON TABLE identity.auth_token IS
  'RLS-exempt by design: keyed on the global app_user, and password reset happens before any tenant context exists. Reachable only by the platform role.';

ALTER TABLE identity.app_user
  ADD COLUMN failed_login_count integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN password_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN mfa_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN identity.app_user.locked_until IS
  'Set after repeated failed logins. Throttles credential stuffing without a permanent lockout that an attacker could use to deny service to a real user.';

INSERT INTO identity.permission (code, description, sensitive) VALUES
  ('onboarding.read.self', 'View own onboarding tasks', false),
  ('onboarding.read',      'View onboarding plans and tasks', false),
  ('onboarding.manage',    'Create onboarding templates and plans', false)
ON CONFLICT (code) DO UPDATE
  SET description = EXCLUDED.description, sensitive = EXCLUDED.sensitive;
