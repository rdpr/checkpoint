import { Appearance } from './Appearance';
import { useState, type FormEvent } from 'react';
import {
  ArrowRight,
  ShieldCheck,
} from 'lucide-react';
import type { User } from '../shared/types';
import { post, errorText } from './api';
import { Brand, ErrorMessage } from './ui';

export function Auth({
  needsSetup,
  setupAllowed,
  invitation,
  inviteName,
  onSignedIn,
  entraEnabled = false,
  requireSso = false,
}: {
  needsSetup: boolean;
  entraEnabled?: boolean;
  requireSso?: boolean;
  setupAllowed: boolean;
  invitation: string | null;
  inviteName: string | null;
  onSignedIn: (user: User) => void;
}) {
  const [register, setRegister] = useState(!!invitation),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const creating = needsSetup || (!!invitation && register && !requireSso);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const result = await post<{ user: User }>(
        needsSetup
          ? '/auth/setup'
          : creating
            ? '/auth/register'
            : '/auth/login',
        { ...data, invitation },
      );
      if (invitation && !creating)
        await post('/invitations/accept', { token: invitation });
      onSignedIn(result.user);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-layout">
      <div className="auth-story">
        <Brand />
        <div className="auth-message">
          <h1>
            Review the plan.
            <br />
            Keep the decision.
          </h1>
        </div>
        <div className="auth-appearance">
          <Appearance />
        </div>
        <div className="auth-footer">
          <ShieldCheck size={16} /> Self-hosted. Your team, your data.
        </div>
      </div>
      <main className="auth-form-wrap">
        <form onSubmit={submit} className="auth-form">
          {entraEnabled && !needsSetup && (
            <>
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    const result = await post<{ url: string }>(
                      '/auth/entra/start',
                      { invitation: invitation ?? undefined },
                    );
                    try {
                      if (!sessionStorage.getItem('pw-return'))
                        sessionStorage.setItem(
                          'pw-return',
                          JSON.stringify({
                            url: location.pathname + location.search,
                          }),
                        );
                    } catch {}
                    location.assign(result.url);
                  } catch (e) {
                    setError(errorText(e));
                    setBusy(false);
                  }
                }}
              >
                Sign in with Microsoft
              </button>
              <p className="small muted">
                {requireSso
                  ? 'Microsoft sign-in is required. Password sign-in is reserved for administrator recovery.'
                  : 'Existing account? Sign in with your password first, then connect Microsoft from Account.'}
              </p>
            </>
          )}
          <h2>
            {needsSetup
              ? 'Create owner account'
              : creating
                ? 'Join the workspace'
                : 'Sign in'}
          </h2>
          {(needsSetup || invitation) && <p className="muted">
            {needsSetup
              ? 'Create the owner account to get started. Teammates join by invitation.'
              : invitation
                ? `You’ve been invited to ${inviteName ?? 'a workspace'}. ${creating ? 'Create an account to join.' : 'Sign in to accept.'}`
                : ''}
          </p>}
          <ErrorMessage message={error} />
          {needsSetup && !setupAllowed ? (
            <ErrorMessage message="First-time setup is only available on the local server. Ask the administrator to create the owner account locally." />
          ) : (
            <>
              {creating && (
                <label>
                  Your name
                  <input
                    name="name"
                    autoComplete="name"
                    placeholder="Alex Morgan"
                    maxLength={80}
                    required
                  />
                </label>
              )}
              <label>
                Email address
                <input
                  name="email"
                  type="email"
                  autoComplete="username"
                  placeholder="you@yourteam.com"
                  required
                />
              </label>
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  autoComplete={creating ? 'new-password' : 'current-password'}
                  minLength={12}
                  maxLength={256}
                  placeholder={
                    creating ? 'At least 12 characters' : 'Your password'
                  }
                  required
                />
              </label>
              <button className="button primary full" disabled={busy}>
                {busy
                  ? 'Please wait…'
                  : needsSetup
                    ? 'Create your workspace'
                    : creating
                      ? 'Create account & join'
                      : 'Sign in'}
                <ArrowRight size={17} />
              </button>
            </>
          )}
          {invitation && !needsSetup && !requireSso && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setRegister(!register);
                setError(null);
              }}
            >
              {register
                ? 'Already have an account? Sign in'
                : 'New here? Create an account'}
            </button>
          )}
        </form>
      </main>
    </div>
  );
}
