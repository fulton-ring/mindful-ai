import { ClerkProvider, SignInButton, SignUpButton, UserButton, useAuth } from '@clerk/react';
import type { AppConfig } from '@walden/contracts';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { ACCOUNT_CHANGED_EVENT, bindAccountIdentity } from '../../lib/account-identity';
import { identifyTelemetry } from '../../lib/telemetry';
import { LegalLinks } from '../legal/LegalPage';
import { useEmailSession } from './use-email-session';

type WorkspaceAccess = {
  identity: string;
  getToken?: () => Promise<string | null>;
  controls?: ReactNode;
};
type Props = { config: AppConfig; children(access: WorkspaceAccess): ReactNode };

/** Every mode resolves the same internal account id before opening identity-scoped data. */
export function Authentication({ config, children }: Props) {
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    const invalidate = () => setChanged(true);
    window.addEventListener(ACCOUNT_CHANGED_EVENT, invalidate);
    return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, invalidate);
  }, []);
  if (changed)
    return (
      <main className="empty-state" role="alert">
        <h1>Your sign-in changed</h1>
        <p>Reload Walden before continuing with your account.</p>
        <button onClick={() => location.reload()}>Reload Walden</button>
      </main>
    );
  const auth =
    config.auth ??
    (config.authConfigured && config.clerkPublishableKey
      ? { mode: 'clerk', publishableKey: config.clerkPublishableKey }
      : undefined);
  if (auth?.mode === 'none') return <AccountWorkspace>{children}</AccountWorkspace>;
  if (auth?.mode === 'better-auth') return <EmailWorkspace>{children}</EmailWorkspace>;
  if (auth?.mode === 'clerk')
    return (
      <ClerkProvider publishableKey={auth.publishableKey} afterSignOutUrl="/">
        <ClerkWorkspace>{children}</ClerkWorkspace>
      </ClerkProvider>
    );
  return (
    <main className="empty-state">
      <h1>Walden is being set up</h1>
      <p>Sign-in is not available yet. Please check back soon.</p>
    </main>
  );
}
function AccountWorkspace({
  children,
  getToken,
  controls,
}: Omit<WorkspaceAccess, 'identity'> & { children: Props['children'] }) {
  const [account, setAccount] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const token = await getToken?.();
      const response = await fetch('/api/account', {
        signal: controller.signal,
        credentials: 'same-origin',
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok)
        throw new Error('Your account could not be opened. Reload to sign in again.');
      const value = (await response.json()) as { id?: string };
      if (controller.signal.aborted) return;
      if (!value.id) throw new Error('Your account could not be identified.');
      if (!bindAccountIdentity(value.id)) return;
      if (!controller.signal.aborted) {
        identifyTelemetry(value.id);
        setAccount(value.id);
      }
    })().catch((cause) => {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'Your account could not be opened.');
    });
    return () => {
      controller.abort();
      identifyTelemetry(null);
    };
  }, [getToken]);
  if (error)
    return (
      <main className="empty-state" role="alert">
        <h1>Walden could not open your account</h1>
        <p>{error}</p>
        <button onClick={() => location.reload()}>Reload</button>
      </main>
    );
  if (!account)
    return (
      <main className="empty-state">
        <p>Opening your workspace…</p>
      </main>
    );
  return children({ identity: account, getToken, controls });
}
function ClerkWorkspace({ children }: { children: Props['children'] }) {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  if (!isLoaded)
    return (
      <main className="empty-state">
        <p>Loading sign-in…</p>
      </main>
    );
  if (!isSignedIn)
    return (
      <main className="empty-state">
        <h1>Walden</h1>
        <p>Sign in to continue.</p>
        <div className="button-row">
          <SignInButton mode="modal">
            <button>Sign in</button>
          </SignInButton>
          <SignUpButton mode="modal">
            <button className="primary">Sign up</button>
          </SignUpButton>
        </div>
        <LegalLinks />
      </main>
    );
  return (
    <AccountWorkspace key={userId} getToken={getToken} controls={<UserButton />}>
      {children}
    </AccountWorkspace>
  );
}
function EmailWorkspace({ children }: { children: Props['children'] }) {
  const session = useEmailSession();
  if (session.signedIn === undefined)
    return (
      <main className="empty-state">
        <p>Loading sign-in…</p>
      </main>
    );
  if (!session.signedIn) return <EmailSignIn error={session.error} onSignIn={session.signIn} />;
  return (
    <AccountWorkspace controls={<button onClick={() => void session.signOut()}>Sign out</button>}>
      {(access) => (
        <>
          {session.error && <p role="alert">{session.error}</p>}
          {children(access)}
        </>
      )}
    </AccountWorkspace>
  );
}
function EmailSignIn({
  error: initialError,
  onSignIn,
}: {
  error: string;
  onSignIn(email: string, password: string): Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(initialError);
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setPending(true);
    try {
      await onSignIn(email.trim(), password);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed.');
      setPending(false);
    }
  };
  return (
    <main className="empty-state">
      <h1>Walden</h1>
      <p>Sign in with the account your administrator created.</p>
      <form
        className="grid w-full max-w-sm gap-3 text-left"
        onSubmit={(event) => void submit(event)}
      >
        <label htmlFor="sign-in-email">Email</label>
        <input
          id="sign-in-email"
          className="rounded-md border border-border bg-card px-3 py-2"
          type="email"
          autoComplete="username"
          required
          value={email}
          disabled={pending}
          onChange={(event) => setEmail(event.target.value)}
        />
        <label htmlFor="sign-in-password">Password</label>
        <input
          id="sign-in-password"
          className="rounded-md border border-border bg-card px-3 py-2"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          disabled={pending}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p>Need access or a password reset? Contact your administrator.</p>
      <LegalLinks />
    </main>
  );
}
