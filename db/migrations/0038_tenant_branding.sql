-- ---------------------------------------------------------------------------
-- 0038 — Tenant branding (white-label configuration).
--
-- One product codebase, many client brands. The alternative — a per-customer frontend fork —
-- is what this table exists to prevent, so everything a brand can change lives here as data
-- and is consumed as design tokens by the same React application.
--
-- What this table deliberately is NOT:
--
--   * not a stylesheet. There is no free-form CSS column, because arbitrary CSS injected by a
--     tenant is both a maintenance problem and an XSS surface. A brand chooses from a bounded
--     set of knobs; it does not ship code.
--   * not a feature-flag table. PRD s.17 Level 3 (enabled modules, terminology, approval
--     policy) is product configuration, not branding, and it is governed by permissions and
--     workflow definitions that already exist. Mixing the two here would let a visual setting
--     change what a tenant may do.
--   * not a per-user preference. Branding is the company's identity, the same for everyone
--     who signs in to it.
--
-- Branding is tenant data and carries RLS like everything else. The one deliberate exception
-- is the *public* read path used by the sign-in screen: a person who has not authenticated yet
-- still needs to see their employer's logo, and at that point there is no tenant context to
-- set. That read is served by a function that takes a slug, returns only presentational
-- columns, and is documented at its definition below.
-- ---------------------------------------------------------------------------

CREATE TABLE identity.tenant_branding (
  tenant_id uuid PRIMARY KEY REFERENCES identity.tenant(id) ON DELETE CASCADE,

  -- Level 1 — identity. Display name is separate from identity.tenant.name so a brand can
  -- present "Acme" while the legal record stays "Acme Private Limited".
  display_name  text,
  logo_url      text,
  favicon_url   text,

  -- Level 1/2 — colour. Stored as 6-digit hex and validated here rather than in the
  -- application, so no code path can write a value the stylesheet cannot use.
  primary_color   text CHECK (primary_color   ~ '^#[0-9a-fA-F]{6}$'),
  secondary_color text CHECK (secondary_color ~ '^#[0-9a-fA-F]{6}$'),

  -- Level 2 — theme shape. Constrained to named options rather than free numbers: a tenant
  -- picks a density, it does not set a pixel value that could break every table in the product.
  density text NOT NULL DEFAULT 'comfortable' CHECK (density IN ('comfortable', 'compact')),
  radius  text NOT NULL DEFAULT 'medium'      CHECK (radius  IN ('sharp', 'medium', 'round')),

  -- Level 1 — sign-in screen. A short line of text, not markup.
  login_tagline text CHECK (login_tagline IS NULL OR length(login_tagline) <= 160),

  -- Level 1 — email identity. The address itself stays in configuration: letting a tenant set
  -- an arbitrary From address is a deliverability and spoofing decision, not a branding one.
  email_footer text CHECK (email_footer IS NULL OR length(email_footer) <= 400),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE identity.tenant_branding ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON identity.tenant_branding
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.tenant_branding TO hrms_app, hrms_platform;

CREATE TRIGGER touch_identity_tenant_branding
  BEFORE UPDATE ON identity.tenant_branding
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON TABLE identity.tenant_branding IS
  'Per-tenant white-label configuration (PRD s.16/s.17 Levels 1-2). Consumed as design tokens; never as CSS.';

-- ---------------------------------------------------------------------------
-- The sign-in read path.
--
-- SECURITY DEFINER because the caller has no tenant context yet — they are looking at a login
-- form. The exposure is deliberately minimal and bounded:
--
--   * it takes a slug, which the person typing it already knows;
--   * it returns only what a login screen paints, and no row from any other table;
--   * it returns nothing for a suspended or closed tenant, so a deactivated workspace does not
--     keep advertising itself;
--   * it cannot be used to enumerate, because a miss and a non-existent slug are identical.
--
-- Everything else about a tenant still requires authentication.
-- ---------------------------------------------------------------------------

CREATE FUNCTION identity.public_branding(p_slug text)
RETURNS TABLE (
  slug            text,
  display_name    text,
  logo_url        text,
  favicon_url     text,
  primary_color   text,
  secondary_color text,
  density         text,
  radius          text,
  login_tagline   text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = identity, pg_temp
AS $$
  SELECT t.slug,
         COALESCE(b.display_name, t.name),
         b.logo_url,
         b.favicon_url,
         b.primary_color,
         b.secondary_color,
         COALESCE(b.density, 'comfortable'),
         COALESCE(b.radius, 'medium'),
         b.login_tagline
    FROM identity.tenant t
    LEFT JOIN identity.tenant_branding b ON b.tenant_id = t.id
   WHERE t.slug = p_slug
     AND t.status = 'active';
$$;

REVOKE ALL ON FUNCTION identity.public_branding(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.public_branding(text) TO hrms_app, hrms_platform;

COMMENT ON FUNCTION identity.public_branding(text) IS
  'Pre-authentication branding for the sign-in screen. Presentational columns only, active tenants only.';
