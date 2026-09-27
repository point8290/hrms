import { useEffect, useState, type FormEvent } from 'react';
import {
  beginEnrolment, confirmEnrolment, login, signUp, verifySecondFactor, type Session,
} from '../lib/api.ts';
import { applyBranding, fetchPublicBranding, type Branding } from '../lib/branding.ts';
import { Alert, Card, ErrorMessage, Field } from '../components/ui.tsx';

/**
 * Everything that happens before there is a session: signing in, completing a second factor,
 * and creating a workspace.
 *
 * These live together because they are one decision for the person in front of them — "get me
 * into the product" — and because the second factor is not an edge case here. Any role holding
 * a sensitive permission must complete one, which is most administrative roles, so a sign-in
 * screen that cannot carry a challenge cannot admit an administrator at all.
 */
type Screen =
  | { name: 'signIn' }
  | { name: 'enroll'; challengeToken: string }
  | { name: 'verify'; challengeToken: string }
  | { name: 'signUp' }
  | { name: 'signedUp'; slug: string; email: string };

export function LoginPage({ onSignedIn }: { onSignedIn: (session: Session) => void }) {
  const [screen, setScreen] = useState<Screen>({ name: 'signIn' });
  const [slug, setSlug] = useState('');
  const [branding, setBranding] = useState<Branding | null>(null);

  // Branding is fetched once the workspace name settles. A failed or unknown lookup leaves
  // the product's own identity in place — nobody should be unable to sign in because a logo
  // could not be loaded.
  useEffect(() => {
    const value = slug.trim();
    if (value.length < 2) {
      setBranding(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void fetchPublicBranding(value).then((result) => {
        if (cancelled) return;
        setBranding(result);
        applyBranding(result);
      });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slug]);

  return (
    <div className="login-page">
      <div className="login-card">
        <Card>
          {branding && screen.name !== 'signUp' && (
            <div className="login-brand">
              {branding.logo_url
                ? <img src={branding.logo_url} alt={branding.display_name ?? ''} />
                : <span className="brand-mark">
                    {(branding.display_name ?? '?').slice(0, 1).toUpperCase()}
                  </span>}
              <span className="t-title">{branding.display_name}</span>
            </div>
          )}

          {screen.name === 'signIn' && (
            <SignIn
              slug={slug}
              onSlug={setSlug}
              tagline={branding?.login_tagline ?? null}
              onSignedIn={onSignedIn}
              onChallenge={(stage, challengeToken) =>
                setScreen(stage === 'enroll'
                  ? { name: 'enroll', challengeToken }
                  : { name: 'verify', challengeToken })}
              onSignUp={() => setScreen({ name: 'signUp' })}
            />
          )}

          {screen.name === 'enroll' && (
            <Enrol
              challengeToken={screen.challengeToken}
              onSignedIn={onSignedIn}
              onCancel={() => setScreen({ name: 'signIn' })}
            />
          )}

          {screen.name === 'verify' && (
            <Verify
              challengeToken={screen.challengeToken}
              onSignedIn={onSignedIn}
              onCancel={() => setScreen({ name: 'signIn' })}
            />
          )}

          {screen.name === 'signUp' && (
            <SignUp
              onCancel={() => setScreen({ name: 'signIn' })}
              onCreated={(created) => {
                setSlug(created.slug);
                setScreen({ name: 'signedUp', ...created });
              }}
            />
          )}

          {screen.name === 'signedUp' && (
            <>
              <h1>Workspace created</h1>
              <Alert kind="success">
                <strong>{screen.slug}</strong> is ready. Sign in as <strong>{screen.email}</strong>{' '}
                to set it up.
              </Alert>
              <p className="muted small">
                You hold every permission in this workspace, including salary and bank data, so
                you will be asked to set up an authenticator the first time you sign in.
              </p>
              <button className="primary" style={{ width: '100%' }}
                onClick={() => setScreen({ name: 'signIn' })}>
                Go to sign in
              </button>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function SignIn({
  slug, onSlug, tagline, onSignedIn, onChallenge, onSignUp,
}: {
  slug: string;
  onSlug: (value: string) => void;
  tagline: string | null;
  onSignedIn: (session: Session) => void;
  onChallenge: (stage: 'enroll' | 'verify', token: string) => void;
  onSignUp: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const outcome = await login(slug.trim(), email.trim(), password);
      if (outcome.kind === 'session') onSignedIn(outcome.session);
      else onChallenge(outcome.stage, outcome.challengeToken);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Sign in</h1>
      <p className="muted small" style={{ marginTop: 0 }}>
        {tagline ?? 'Use your workspace address and work email.'}
      </p>

      <ErrorMessage error={error} />

      <form onSubmit={submit}>
        <Field label="Workspace" htmlFor="slug">
          <input id="slug" value={slug} onChange={(e) => onSlug(e.target.value)}
            placeholder="acme" autoComplete="organization" required />
        </Field>
        <Field label="Email" htmlFor="email">
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            autoComplete="username" required />
        </Field>
        <Field label="Password" htmlFor="password">
          <input id="password" type="password" value={password}
            onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <div className="divider" />
      <p className="muted small" style={{ margin: 0 }}>
        New here?{' '}
        <button type="button" className="ghost small" onClick={onSignUp}>
          Create a workspace
        </button>
      </p>
    </>
  );
}

/**
 * First-time authenticator setup.
 *
 * The secret and the recovery codes are shown exactly once — the server stores them hashed
 * and this response is the only copy — so the screen says so rather than letting somebody
 * click past them. Confirming completes the sign-in in the same step, because an enrolment
 * that ends with "now log in again" is where people abandon the flow.
 */
function Enrol({
  challengeToken, onSignedIn, onCancel,
}: { challengeToken: string; onSignedIn: (session: Session) => void; onCancel: () => void }) {
  const [offer, setOffer] = useState<{ secret: string; otpauth_uri: string; recovery_codes: string[] } | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    beginEnrolment(challengeToken)
      .then((result) => { if (!cancelled) setOffer(result); })
      .catch((err) => { if (!cancelled) setError(err); });
    return () => { cancelled = true; };
  }, [challengeToken]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setCodeError('Enter the six digits from your authenticator.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await confirmEnrolment(challengeToken, code.trim()));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Set up your authenticator</h1>
      <p className="muted small" style={{ marginTop: 0 }}>
        Your role can read salary, bank and tax data, so it needs a second factor.
      </p>

      <ErrorMessage error={error} />

      {offer && (
        <>
          <Field label="Setup key" htmlFor="mfa-secret"
            hint="Add this to an authenticator app such as Google Authenticator or 1Password.">
            <input id="mfa-secret" className="mono" readOnly value={offer.secret}
              onFocus={(e) => e.currentTarget.select()} />
          </Field>

          <details style={{ marginBottom: 12 }}>
            <summary className="small">Recovery codes — save these now</summary>
            <p className="muted small" style={{ marginBottom: 6 }}>
              Each works once, if you lose your authenticator. They are stored hashed, so this
              is the only time they can be shown.
            </p>
            <ul className="mono small" style={{ margin: 0, paddingLeft: 18 }}>
              {offer.recovery_codes.map((c) => <li key={c}>{c}</li>)}
            </ul>
          </details>

          <form onSubmit={submit}>
            <Field label="Code from your authenticator" required htmlFor="mfa-code" error={codeError}>
              <input id="mfa-code" inputMode="numeric" autoComplete="one-time-code"
                value={code} aria-invalid={codeError ? 'true' : undefined}
                onChange={(e) => { setCode(e.target.value); if (codeError) setCodeError(null); }} />
            </Field>
            <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Confirming…' : 'Confirm and sign in'}
            </button>
          </form>
        </>
      )}

      {!offer && !error && <p className="muted small">Preparing your authenticator…</p>}

      <div className="divider" />
      <button type="button" className="ghost small" onClick={onCancel}>Back to sign in</button>
    </>
  );
}

/** Second factor for an account that already has an authenticator. */
function Verify({
  challengeToken, onSignedIn, onCancel,
}: { challengeToken: string; onSignedIn: (session: Session) => void; onCancel: () => void }) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const entered = value.trim();
    if (!useRecovery && !/^\d{6}$/.test(entered)) {
      setFieldError('Enter the six digits from your authenticator.');
      return;
    }
    if (useRecovery && entered.length < 8) {
      setFieldError('Recovery codes are longer than that.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await verifySecondFactor(
        challengeToken,
        useRecovery ? { recoveryCode: entered } : { code: entered },
      ));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Two-factor authentication</h1>
      <ErrorMessage error={error} />

      <form onSubmit={submit}>
        <Field
          label={useRecovery ? 'Recovery code' : 'Code from your authenticator'}
          required
          htmlFor="mfa-input"
          error={fieldError}
        >
          <input id="mfa-input" value={value}
            inputMode={useRecovery ? 'text' : 'numeric'}
            autoComplete={useRecovery ? 'off' : 'one-time-code'}
            aria-invalid={fieldError ? 'true' : undefined}
            onChange={(e) => { setValue(e.target.value); if (fieldError) setFieldError(null); }} />
        </Field>
        <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Verifying…' : 'Verify'}
        </button>
      </form>

      <div className="divider" />
      <div className="inline">
        <button type="button" className="ghost small"
          onClick={() => { setUseRecovery(!useRecovery); setValue(''); setFieldError(null); }}>
          {useRecovery ? 'Use my authenticator' : 'Use a recovery code'}
        </button>
        <button type="button" className="ghost small" onClick={onCancel}>Back to sign in</button>
      </div>
    </>
  );
}

/**
 * Creating a workspace.
 *
 * Only the fields `POST /api/tenants` accepts. The tenant id is assigned by the server and is
 * never client-supplied. Timezone, currency and country are effectively permanent — they
 * anchor every payroll period and tax year — so the form says so rather than presenting them
 * as settings that can be revisited.
 */
function SignUp({
  onCancel, onCreated,
}: { onCancel: () => void; onCreated: (created: { slug: string; email: string }) => void }) {
  const [form, setForm] = useState({
    tenantName: '', slug: '', adminName: '', adminEmail: '', adminPassword: '',
    timezone: 'Asia/Kolkata', currency: 'INR', countryCode: 'IN',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const set = (key: string, value: string) => setForm({ ...form, [key]: value });

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (form.tenantName.trim().length < 2) found.tenantName = 'Required.';
    // Mirrors the server's own slug rule, so the person is told before the request.
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(form.slug.trim())) {
      found.slug = '3–40 characters: lowercase letters, numbers and hyphens.';
    }
    if (form.adminName.trim().length < 2) found.adminName = 'Required.';
    if (!form.adminEmail.trim()) found.adminEmail = 'Required.';
    if (form.adminPassword.length < 12) found.adminPassword = 'At least 12 characters.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      await signUp({
        tenantName: form.tenantName.trim(),
        slug: form.slug.trim().toLowerCase(),
        adminName: form.adminName.trim(),
        adminEmail: form.adminEmail.trim(),
        adminPassword: form.adminPassword,
        timezone: form.timezone,
        currency: form.currency,
        countryCode: form.countryCode,
      });
      onCreated({ slug: form.slug.trim().toLowerCase(), email: form.adminEmail.trim() });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Create a workspace</h1>
      <p className="muted small" style={{ marginTop: 0 }}>
        You will be its owner, with access to everything in it.
      </p>

      <ErrorMessage error={error} />

      <form onSubmit={submit}>
        <Field label="Organization name" required htmlFor="s-name" error={errors.tenantName}>
          <input id="s-name" value={form.tenantName}
            aria-invalid={errors.tenantName ? 'true' : undefined}
            onChange={(e) => set('tenantName', e.target.value)} />
        </Field>

        <Field label="Workspace address" required htmlFor="s-slug" error={errors.slug}
          hint="What everyone types to sign in. It cannot be changed later.">
          <input id="s-slug" value={form.slug} placeholder="acme"
            aria-invalid={errors.slug ? 'true' : undefined}
            onChange={(e) => set('slug', e.target.value.toLowerCase())} />
        </Field>

        <div className="divider" />

        <Field label="Your name" required htmlFor="s-admin" error={errors.adminName}>
          <input id="s-admin" value={form.adminName}
            aria-invalid={errors.adminName ? 'true' : undefined}
            onChange={(e) => set('adminName', e.target.value)} />
        </Field>
        <Field label="Your work email" required htmlFor="s-email" error={errors.adminEmail}>
          <input id="s-email" type="email" value={form.adminEmail}
            aria-invalid={errors.adminEmail ? 'true' : undefined}
            onChange={(e) => set('adminEmail', e.target.value)} />
        </Field>
        <Field label="Password" required htmlFor="s-pass" error={errors.adminPassword}
          hint="At least 12 characters.">
          <input id="s-pass" type="password" value={form.adminPassword} autoComplete="new-password"
            aria-invalid={errors.adminPassword ? 'true' : undefined}
            onChange={(e) => set('adminPassword', e.target.value)} />
        </Field>

        <div className="divider" />

        <div className="row">
          <Field label="Timezone" htmlFor="s-tz">
            <input id="s-tz" value={form.timezone} onChange={(e) => set('timezone', e.target.value)} />
          </Field>
          <Field label="Currency" htmlFor="s-cur">
            <input id="s-cur" maxLength={3} value={form.currency}
              onChange={(e) => set('currency', e.target.value.toUpperCase())} />
          </Field>
          <Field label="Country" htmlFor="s-country">
            <input id="s-country" maxLength={2} value={form.countryCode}
              onChange={(e) => set('countryCode', e.target.value.toUpperCase())} />
          </Field>
        </div>
        <p className="muted small">
          These anchor every payroll period and tax year, so they are fixed once the workspace
          exists.
        </p>

        <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Creating…' : 'Create workspace'}
        </button>
      </form>

      <div className="divider" />
      <button type="button" className="ghost small" onClick={onCancel}>Back to sign in</button>
    </>
  );
}
