import { useEffect, useRef, useState } from 'react';
import { invalidateAccountIdentity } from '../../lib/account-identity';
import { storageKeys } from '../../lib/storage-keys';

type AuthResult = { user?: { id?: string }; error?: { message?: string }; message?: string } | null;
async function emailAuth(path: string, body?: unknown): Promise<AuthResult> {
  const response = await fetch(`/api/auth/${path}`, {
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  const result = (await response.json()) as AuthResult;
  if (!response.ok)
    throw new Error(
      result?.error?.message ?? result?.message ?? 'Sign-in failed. Check your email and password.',
    );
  return result;
}
function watchAuthChanges(check: () => void) {
  const channel =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('walden-auth');
  if (channel) channel.onmessage = () => invalidateAccountIdentity();
  const storage = (event: StorageEvent) => {
    if (event.key === storageKeys.authSession) invalidateAccountIdentity();
  };
  const visible = () => {
    if (document.visibilityState === 'visible') check();
  };
  window.addEventListener('focus', check);
  window.addEventListener('storage', storage);
  document.addEventListener('visibilitychange', visible);
  return {
    publish() {
      channel?.postMessage({ type: 'auth-changed' });
      try {
        localStorage.setItem(storageKeys.authSession, `${Date.now()}:${Math.random()}`);
      } catch {
        /* Focus revalidation remains available when storage is blocked. */
      }
    },
    close() {
      channel?.close();
      window.removeEventListener('focus', check);
      window.removeEventListener('storage', storage);
      document.removeEventListener('visibilitychange', visible);
    },
  };
}

export function useEmailSession() {
  const [signedIn, setSignedIn] = useState<boolean>();
  const [error, setError] = useState('');
  const user = useRef<string | null | undefined>(undefined);
  const changes = useRef<ReturnType<typeof watchAuthChanges> | null>(null);
  useEffect(() => {
    let active = true;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const session = await emailAuth('get-session');
        if (!active) return;
        const next = session?.user?.id ?? null;
        if (user.current !== undefined && user.current !== next) return invalidateAccountIdentity();
        user.current = next;
        setSignedIn(Boolean(next));
      } catch {
        if (active && user.current === undefined) {
          setSignedIn(false);
          setError('The sign-in service could not be reached. Try again.');
        }
      } finally {
        checking = false;
      }
    };
    changes.current = watchAuthChanges(() => void check());
    void check();
    return () => {
      active = false;
      changes.current?.close();
      changes.current = null;
    };
  }, []);
  return {
    signedIn,
    error,
    async signIn(email: string, password: string) {
      const result = await emailAuth('sign-in/email', { email, password });
      if (!result?.user?.id)
        throw new Error('Your sign-in session could not be verified. Try again.');
      user.current = result.user.id;
      changes.current?.publish();
      setError('');
      setSignedIn(true);
    },
    async signOut() {
      try {
        await emailAuth('sign-out', {});
        user.current = null;
        changes.current?.publish();
        setSignedIn(false);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Sign-out failed.');
      }
    },
  };
}
