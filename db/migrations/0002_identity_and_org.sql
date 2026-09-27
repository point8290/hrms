-- 0002 identity, rbac and organization structure.

-- ---------------------------------------------------------------- tenancy root

CREATE TABLE identity.tenant (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,
  timezone      text NOT NULL DEFAULT 'Asia/Kolkata',
  locale        text NOT NULL DEFAULT 'en-IN',
  currency      text NOT NULL DEFAULT 'INR',
  country_code  text NOT NULL DEFAULT 'IN',
  fy_start_month smallint NOT NULL DEFAULT 4 CHECK (fy_start_month BETWEEN 1 AND 12),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
SELECT app.add_updated_at_trigger('identity.tenant');
-- The isolation root keys on `id` rather than `tenant_id`: a request can read its own
-- tenant's configuration and nothing else. Provisioning happens via the platform role.
ALTER TABLE identity.tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self_isolation ON identity.tenant
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());
COMMENT ON TABLE identity.tenant IS
  'Isolation root. Readable only as your own tenant; created and suspended by the platform role.';

-- Global identity. A person has one login and may belong to several tenants.
CREATE TABLE identity.app_user (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  password_hash  text NOT NULL,
  full_name      text NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'invited')),
  email_verified boolean NOT NULL DEFAULT false,
  mfa_secret     text,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- Case-insensitive uniqueness without depending on the citext extension.
CREATE UNIQUE INDEX app_user_email_key ON identity.app_user (lower(email));
SELECT app.add_updated_at_trigger('identity.app_user');

CREATE TABLE identity.tenant_membership (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES identity.app_user(id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  is_owner   boolean NOT NULL DEFAULT false,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
SELECT app.enable_tenant_rls('identity.tenant_membership');
SELECT app.add_updated_at_trigger('identity.tenant_membership');
CREATE INDEX idx_membership_user ON identity.tenant_membership (user_id);

-- Permission codes are global; roles that grant them are tenant-owned.
CREATE TABLE identity.permission (
  code        text PRIMARY KEY,
  description text NOT NULL,
  sensitive   boolean NOT NULL DEFAULT false
);

CREATE TABLE identity.role (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
SELECT app.enable_tenant_rls('identity.role');
SELECT app.add_updated_at_trigger('identity.role');

CREATE TABLE identity.role_permission (
  tenant_id       uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  role_id         uuid NOT NULL REFERENCES identity.role(id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES identity.permission(code),
  PRIMARY KEY (role_id, permission_code)
);
SELECT app.enable_tenant_rls('identity.role_permission');

CREATE TABLE identity.membership_role (
  tenant_id     uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES identity.tenant_membership(id) ON DELETE CASCADE,
  role_id       uuid NOT NULL REFERENCES identity.role(id) ON DELETE CASCADE,
  PRIMARY KEY (membership_id, role_id)
);
SELECT app.enable_tenant_rls('identity.membership_role');

CREATE TABLE identity.refresh_token (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES identity.app_user(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('identity.refresh_token');
CREATE INDEX idx_refresh_token_user ON identity.refresh_token (tenant_id, user_id);

-- ---------------------------------------------------------------- organization

CREATE TABLE core.company (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  name           text NOT NULL,
  legal_name     text NOT NULL,
  tax_identifier text,
  pf_number      text,
  esi_number     text,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
SELECT app.enable_tenant_rls('core.company');
SELECT app.add_updated_at_trigger('core.company');

CREATE TABLE core.location (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  name       text NOT NULL,
  timezone   text NOT NULL DEFAULT 'Asia/Kolkata',
  address    text,
  state_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
SELECT app.enable_tenant_rls('core.location');
SELECT app.add_updated_at_trigger('core.location');
COMMENT ON COLUMN core.location.timezone IS 'Attendance resolves shift windows in this timezone, never the server timezone.';

CREATE TABLE core.branch (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  company_id  uuid NOT NULL REFERENCES core.company(id) ON DELETE CASCADE,
  location_id uuid REFERENCES core.location(id),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, name)
);
SELECT app.enable_tenant_rls('core.branch');
SELECT app.add_updated_at_trigger('core.branch');

CREATE TABLE core.department (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  parent_id  uuid REFERENCES core.department(id),
  name       text NOT NULL,
  code       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
SELECT app.enable_tenant_rls('core.department');
SELECT app.add_updated_at_trigger('core.department');

CREATE TABLE core.designation (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES identity.tenant(id) ON DELETE CASCADE,
  name       text NOT NULL,
  grade      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
SELECT app.enable_tenant_rls('core.designation');
SELECT app.add_updated_at_trigger('core.designation');
