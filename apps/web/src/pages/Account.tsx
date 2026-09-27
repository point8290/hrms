import { useState } from 'react';
import { currentSession, get, post } from '../lib/api.ts';
import {
  Alert, Badge, Card, Definitions, ErrorMessage, Field, Loading, Page, Tabs, useLoad,
} from '../components/ui.tsx';

type MfaState = {
  enrolled: boolean;
  status: string;
  unused_recovery_codes: number;
  required: boolean;
  session_verified: boolean;
};

/**
 * The account's own security settings.
 *
 * These endpoints existed and had no screen, which meant nobody could change their password
 * or replace a lost authenticator without an administrator touching their credentials — the
 * situation the self-service re-enrolment path was written to avoid.
 *
 * Nothing here weakens the second-factor rule. Whether MFA is required is decided by the
 * server from the permissions the account holds, and disabling it still demands both the
 * password and a current code.
 */
export function AccountPage() {
  const [tab, setTab] = useState('security');
  const session = currentSession();

  return (
    <Page title="Your account" subtitle={session?.user.email}>
      <Tabs tabs={[{ id: 'security', label: 'Security' }]} active={tab} onChange={setTab} />
      <ChangePassword />
      <TwoFactor />
    </Page>
  );
}

function ChangePassword() {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (!form.currentPassword) found.currentPassword = 'Required.';
    // The server enforces its own strength rule; this is the length it will not go below.
    if (form.newPassword.length < 12) found.newPassword = 'At least 12 characters.';
    if (form.newPassword !== form.confirm) found.confirm = 'These do not match.';
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      await post('/api/auth/change-password', {
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      });
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Password">
      <ErrorMessage error={error} />
      {done && (
        <Alert kind="success">
          Password changed. Other sessions signed in with the old password are revoked.
        </Alert>
      )}

      <form onSubmit={submit}>
        <Field label="Current password" required htmlFor="a-current" error={errors.currentPassword}>
          <input id="a-current" type="password" autoComplete="current-password"
            value={form.currentPassword}
            aria-invalid={errors.currentPassword ? 'true' : undefined}
            onChange={(e) => { setForm({ ...form, currentPassword: e.target.value }); setDone(false); }} />
        </Field>
        <div className="row">
          <Field label="New password" required htmlFor="a-new" error={errors.newPassword}
            hint="At least 12 characters.">
            <input id="a-new" type="password" autoComplete="new-password" value={form.newPassword}
              aria-invalid={errors.newPassword ? 'true' : undefined}
              onChange={(e) => setForm({ ...form, newPassword: e.target.value })} />
          </Field>
          <Field label="Confirm" required htmlFor="a-confirm" error={errors.confirm}>
            <input id="a-confirm" type="password" autoComplete="new-password" value={form.confirm}
              aria-invalid={errors.confirm ? 'true' : undefined}
              onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
          </Field>
        </div>
        <button className="primary" type="submit" disabled={busy}>Change password</button>
      </form>
    </Card>
  );
}

function TwoFactor() {
  const state = useLoad(() => get<MfaState>('/api/account/mfa'), []);
  const [mode, setMode] = useState<'idle' | 'enrolling' | 'disabling'>('idle');

  if (state.loading) return <Loading label="Loading your security settings" />;
  if (state.error) return <ErrorMessage error={state.error} />;
  if (!state.data) return null;

  const mfa = state.data;

  return (
    <Card
      title="Two-factor authentication"
      actions={
        mode === 'idle' ? (
          <span className="inline">
            <button className="small" onClick={() => setMode('enrolling')}>
              {mfa.enrolled ? 'Replace authenticator' : 'Set up'}
            </button>
            {mfa.enrolled && !mfa.required && (
              <button className="small ghost" onClick={() => setMode('disabling')}>Turn off</button>
            )}
          </span>
        ) : undefined
      }
    >
      <Definitions
        items={[
          {
            label: 'Status',
            value: <Badge value={mfa.enrolled ? 'active' : 'pending'} />,
          },
          {
            label: 'Required for your role',
            value: mfa.required ? 'Yes — it cannot be turned off' : 'No',
          },
          {
            label: 'Unused recovery codes',
            value: <span className="t-num">{mfa.unused_recovery_codes}</span>,
          },
        ]}
      />

      {mfa.required && !mfa.enrolled && (
        <Alert kind="warning">
          Your role can read salary, bank or tax data, so an authenticator is required. You will
          be asked to set one up the next time you sign in.
        </Alert>
      )}

      {mfa.enrolled && mfa.unused_recovery_codes === 0 && (
        <Alert kind="warning">
          You have no recovery codes left. Replacing your authenticator issues a fresh set.
        </Alert>
      )}

      {mode === 'enrolling' && (
        <Enrol
          onCancel={() => setMode('idle')}
          onDone={() => { setMode('idle'); state.reload(); }}
        />
      )}
      {mode === 'disabling' && (
        <Disable
          onCancel={() => setMode('idle')}
          onDone={() => { setMode('idle'); state.reload(); }}
        />
      )}
    </Card>
  );
}

/**
 * Enrolling or replacing an authenticator from inside a session.
 *
 * Replacing issues a new secret and a new set of recovery codes, and the old authenticator
 * stops working the moment the new one is confirmed — which is what lets somebody who still
 * has their session but lost their phone recover without anyone handling their credentials.
 */
function Enrol({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const offer = useLoad(
    () => post<{ secret: string; otpauth_uri: string; recovery_codes: string[] }>(
      '/api/account/mfa/enroll', {}),
    [],
  );
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setCodeError('Enter the six digits from your authenticator.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post('/api/account/mfa/confirm', { code: code.trim() });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="divider" />
      <ErrorMessage error={offer.error} />
      <ErrorMessage error={error} />

      {offer.loading && <Loading label="Preparing a new authenticator" />}

      {offer.data && (
        <>
          <Field label="Setup key" htmlFor="acc-secret"
            hint="Add this to your authenticator app.">
            <input id="acc-secret" className="mono" readOnly value={offer.data.secret}
              onFocus={(e) => e.currentTarget.select()} />
          </Field>

          <details style={{ marginBottom: 12 }}>
            <summary className="small">Recovery codes — save these now</summary>
            <p className="muted small" style={{ marginBottom: 6 }}>
              Each works once. They are stored hashed, so this is the only time they can be
              shown.
            </p>
            <ul className="mono small" style={{ margin: 0, paddingLeft: 18 }}>
              {offer.data.recovery_codes.map((c) => <li key={c}>{c}</li>)}
            </ul>
          </details>

          <form onSubmit={confirm}>
            <Field label="Code from your authenticator" required htmlFor="acc-code" error={codeError}>
              <input id="acc-code" inputMode="numeric" autoComplete="one-time-code" value={code}
                aria-invalid={codeError ? 'true' : undefined}
                onChange={(e) => { setCode(e.target.value); if (codeError) setCodeError(null); }} />
            </Field>
            <div className="inline">
              <button className="primary" type="submit" disabled={busy}>Confirm</button>
              <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
            </div>
          </form>
        </>
      )}
    </>
  );
}

/** Turning the second factor off. Requires the password and a current code. */
function Disable({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/account/mfa/disable', { password, code: code.trim() });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="divider" />
      <Alert kind="warning">
        Turning this off leaves your password as the only thing protecting this account.
      </Alert>
      <ErrorMessage error={error} />

      <form onSubmit={submit}>
        <div className="row">
          <Field label="Your password" required htmlFor="d-pass">
            <input id="d-pass" type="password" autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Current code" required htmlFor="d-code">
            <input id="d-code" inputMode="numeric" autoComplete="one-time-code" value={code}
              onChange={(e) => setCode(e.target.value)} />
          </Field>
        </div>
        <div className="inline">
          <button className="danger" type="submit" disabled={busy}>Turn off</button>
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </form>
    </>
  );
}
