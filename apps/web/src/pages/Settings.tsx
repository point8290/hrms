import { useState } from 'react';
import { get, put } from '../lib/api.ts';
import { applyBranding, brandTokens, contrastRatio, type Branding } from '../lib/branding.ts';
import {
  Alert, Card, ErrorMessage, Field, Loading, Page, Tabs, useLoad,
} from '../components/ui.tsx';

type BrandingForm = Branding & { email_footer: string | null };

/**
 * Tenant settings. Today that is branding; the tabs exist so the next configuration surface
 * has somewhere to go rather than becoming another top-level nav entry.
 *
 * Everything here is `tenant.manage`, which the API enforces independently — this screen is
 * only reachable from the navigation for someone who holds it, and the server refuses anyone
 * who does not even if they type the URL.
 */
export function SettingsPage() {
  const [tab, setTab] = useState('branding');
  return (
    <Page title="Settings" subtitle="How this workspace looks and identifies itself.">
      <Tabs tabs={[{ id: 'branding', label: 'Branding' }]} active={tab} onChange={setTab} />
      <BrandingSettings />
    </Page>
  );
}

type Form = {
  display_name: string; logo_url: string; favicon_url: string;
  primary_color: string; secondary_color: string;
  density: string; radius: string;
  login_tagline: string; email_footer: string;
};

const EMPTY: Form = {
  display_name: '', logo_url: '', favicon_url: '',
  primary_color: '', secondary_color: '',
  density: 'comfortable', radius: 'medium',
  login_tagline: '', email_footer: '',
};

function BrandingSettings() {
  const branding = useLoad(() => get<BrandingForm>('/api/tenant/branding'), []);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (branding.loading) return <Loading label="Loading branding" />;
  if (branding.error) return <ErrorMessage error={branding.error} />;

  // The API returns nulls for anything unset; a form field wants a string.
  const current: Form = form ?? {
    ...EMPTY,
    ...(Object.fromEntries(
      Object.entries(branding.data ?? {})
        .filter(([key]) => key in EMPTY)
        .map(([key, value]) => [key, value == null ? '' : String(value)]),
    ) as Partial<Form>),
  };

  const set = (key: keyof Form, value: string) => {
    setSaved(false);
    setForm({ ...current, [key]: value });
  };

  /**
   * Contrast is checked here as well as derived in the token layer, so an administrator is
   * told *before* saving that their colour is unusable as text. The product will still stay
   * readable either way — brandTokens darkens it — but silently changing somebody's brand
   * without telling them is worse than explaining why it looks different.
   */
  const chosen = /^#[0-9a-fA-F]{6}$/.test(current.primary_color) ? current.primary_color : null;
  const ratio = chosen ? contrastRatioOf(chosen) : null;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = await put<BrandingForm>('/api/tenant/branding', {
        displayName: current.display_name.trim() || null,
        logoUrl: current.logo_url.trim() || null,
        faviconUrl: current.favicon_url.trim() || null,
        primaryColor: current.primary_color.trim() || null,
        secondaryColor: current.secondary_color.trim() || null,
        density: current.density,
        radius: current.radius,
        loginTagline: current.login_tagline.trim() || null,
        emailFooter: current.email_footer.trim() || null,
      });
      // Apply immediately, so the administrator sees the result rather than being told to
      // reload. This is the same call the shell makes on sign-in.
      applyBranding(payload);
      setSaved(true);
      branding.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ErrorMessage error={error} />
      {saved && <Alert kind="success">Branding saved and applied.</Alert>}

      <form onSubmit={save}>
        <Card title="Identity">
          <div className="row">
            <Field
              label="Display name"
              htmlFor="b-name"
              hint="Shown in the sidebar and on the sign-in screen."
            >
              <input id="b-name" value={current.display_name} onChange={(e) => set('display_name', e.target.value)} />
            </Field>
            <Field label="Sign-in tagline" htmlFor="b-tagline">
              <input id="b-tagline" value={current.login_tagline} onChange={(e) => set('login_tagline', e.target.value)} />
            </Field>
          </div>
          <div className="row">
            <Field label="Logo URL" htmlFor="b-logo" hint="An https:// URL, or a path beginning with /.">
              <input id="b-logo" value={current.logo_url} onChange={(e) => set('logo_url', e.target.value)} />
            </Field>
            <Field label="Favicon URL" htmlFor="b-favicon">
              <input id="b-favicon" value={current.favicon_url} onChange={(e) => set('favicon_url', e.target.value)} />
            </Field>
          </div>
        </Card>

        <Card title="Theme">
          <div className="row">
            <Field label="Primary colour" htmlFor="b-primary" hint="Six-digit hex, for example #1f5eff.">
              <div className="inline">
                <input
                  id="b-primary"
                  value={current.primary_color}
                  placeholder="#1f5eff"
                  onChange={(e) => set('primary_color', e.target.value)}
                />
                <input
                  type="color"
                  aria-label="Pick the primary colour"
                  style={{ width: 44, padding: 2 }}
                  value={chosen ?? '#1f5eff'}
                  onChange={(e) => set('primary_color', e.target.value)}
                />
              </div>
            </Field>
            <Field label="Accent colour" htmlFor="b-secondary">
              <input
                id="b-secondary"
                value={current.secondary_color}
                placeholder="optional"
                onChange={(e) => set('secondary_color', e.target.value)}
              />
            </Field>
          </div>

          <div className="row">
            <Field label="Density" htmlFor="b-density" hint="Compact tightens tables, not text size.">
              <select id="b-density" value={current.density} onChange={(e) => set('density', e.target.value)}>
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </select>
            </Field>
            <Field label="Corner style" htmlFor="b-radius">
              <select id="b-radius" value={current.radius} onChange={(e) => set('radius', e.target.value)}>
                <option value="sharp">Sharp</option>
                <option value="medium">Medium</option>
                <option value="round">Round</option>
              </select>
            </Field>
          </div>

          {chosen && ratio !== null && ratio < 4.5 && (
            <Alert kind="warning">
              This colour only reaches {ratio.toFixed(1)}:1 against a white background, below
              the 4.5:1 needed for readable text. It will still be used for buttons and
              highlights; a darker version of the same hue is used wherever it has to carry
              text, so the product stays legible.
            </Alert>
          )}

          <BrandPreview values={current} />
        </Card>

        <Card title="Email">
          <Field
            label="Email footer"
            htmlFor="b-footer"
            hint="Appended to notification emails. Plain text — no markup."
          >
            <textarea id="b-footer" value={current.email_footer} onChange={(e) => set('email_footer', e.target.value)} />
          </Field>
        </Card>

        <div className="inline" style={{ marginTop: 16 }}>
          <button className="primary" type="submit" disabled={busy}>Save branding</button>
          <button type="button" disabled={busy} onClick={() => { setForm(null); setSaved(false); }}>
            Reset
          </button>
          <span className="muted small">
            Applies to everyone in this workspace, and to nobody outside it.
          </span>
        </div>
      </form>
    </>
  );
}

/** What the chosen colours actually produce, using the same derivation the product uses. */
function BrandPreview({ values }: { values: Form }) {
  const tokens = brandTokens({
    primary_color: values.primary_color || null,
    secondary_color: values.secondary_color || null,
    density: values.density as 'comfortable' | 'compact',
    radius: values.radius as 'sharp' | 'medium' | 'round',
  } as Partial<Branding>);

  return (
    <div style={{ marginTop: 8 }}>
      <div className="t-meta" style={{ marginBottom: 6 }}>Preview</div>
      <div
        className="inline"
        style={{
          padding: 14,
          border: '1px solid var(--border)',
          borderRadius: tokens['--radius-lg'],
          background: 'var(--surface)',
        }}
      >
        <span
          style={{
            background: tokens['--brand'],
            color: tokens['--brand-contrast'],
            padding: '7px 14px',
            borderRadius: tokens['--radius-sm'],
            fontWeight: 550,
          }}
        >
          Primary action
        </span>
        <span style={{ color: tokens['--brand-ink'], fontWeight: 600 }}>A link</span>
        <span
          style={{
            background: tokens['--brand-soft'],
            color: tokens['--brand-ink'],
            padding: '4px 10px',
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          Selected
        </span>
      </div>
    </div>
  );
}

function contrastRatioOf(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return contrastRatio(
    { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 },
    { r: 255, g: 255, b: 255 },
  );
}
