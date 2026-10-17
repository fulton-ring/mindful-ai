// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { AppConfig } from '@walden/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { beginIdentitySession } from '../../../lib/account-identity';
import { Authentication } from '../Authentication';

const clerk = vi.hoisted(() => ({
  provider: vi.fn(),
  auth: {
    isLoaded: true,
    isSignedIn: true,
    userId: 'clerk-subject',
    getToken: async () => 'clerk-token',
  },
}));
vi.mock('@clerk/react', () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => {
    clerk.provider();
    return children;
  },
  useAuth: () => clerk.auth,
  UserButton: () => <button>Clerk account</button>,
  SignInButton: ({ children }: { children: React.ReactNode }) => children,
  SignUpButton: ({ children }: { children: React.ReactNode }) => children,
}));
beforeEach(() => beginIdentitySession());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const config = (mode: 'none' | 'clerk' | 'better-auth') =>
  ({
    authConfigured: true,
    modelConfigured: false,
    auth: mode === 'clerk' ? { mode, publishableKey: 'pk_test' } : { mode },
  }) as AppConfig;
const workspace = ({ identity, controls }: { identity: string; controls?: React.ReactNode }) => (
  <div>
    Workspace {identity}
    {controls}
  </div>
);
it('opens auth-free workspaces with the stable server account and no Clerk provider', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ id: 'internal-single-user', authMode: 'none' })),
  );
  const view = render(<Authentication config={config('none')}>{workspace}</Authentication>);
  await waitFor(() => expect(view.getByText('Workspace internal-single-user')).toBeTruthy());
  expect(clerk.provider).not.toHaveBeenCalled();
});
it('uses the internal account id instead of the Clerk subject', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(Response.json({ id: 'internal-clerk-account', authMode: 'clerk' }));
  vi.stubGlobal('fetch', fetch);
  const view = render(<Authentication config={config('clerk')}>{workspace}</Authentication>);
  await waitFor(() => expect(view.getByText('Workspace internal-clerk-account')).toBeTruthy());
  expect(new Headers(fetch.mock.calls[0][1].headers).get('authorization')).toBe(
    'Bearer clerk-token',
  );
  expect(view.queryByText('clerk-subject')).toBeNull();
});
it('signs into an operator-created Better Auth account and signs out', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(null))
    .mockResolvedValueOnce(Response.json({ user: { id: 'auth-user' } }))
    .mockResolvedValueOnce(Response.json({ id: 'internal-email-account', authMode: 'better-auth' }))
    .mockResolvedValueOnce(Response.json({ success: true }));
  vi.stubGlobal('fetch', fetch);
  const view = render(<Authentication config={config('better-auth')}>{workspace}</Authentication>);
  await waitFor(() => expect(view.getByLabelText('Email')).toBeTruthy());
  expect(view.queryByRole('button', { name: /sign up/i })).toBeNull();
  fireEvent.change(view.getByLabelText('Email'), { target: { value: 'owner@example.test' } });
  fireEvent.change(view.getByLabelText('Password'), { target: { value: 'password-for-test' } });
  fireEvent.click(view.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(view.getByText('Workspace internal-email-account')).toBeTruthy());
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
    email: 'owner@example.test',
    password: 'password-for-test',
  });
  fireEvent.click(view.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(view.getByLabelText('Email')).toBeTruthy());
  expect(fetch.mock.calls[3][0]).toBe('/api/auth/sign-out');
});
it('requires a fresh document before another signed-in account can open', async () => {
  const previous = clerk.auth.userId;
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: 'account-first' }))
      .mockResolvedValueOnce(Response.json({ id: 'account-second' })),
  );
  try {
    const view = render(<Authentication config={config('clerk')}>{workspace}</Authentication>);
    await waitFor(() => expect(view.getByText('Workspace account-first')).toBeTruthy());
    clerk.auth.userId = 'new-clerk-subject';
    view.rerender(<Authentication config={config('clerk')}>{workspace}</Authentication>);
    await waitFor(() => expect(view.getByRole('button', { name: 'Reload Walden' })).toBeTruthy());
    expect(view.queryByText('Workspace account-second')).toBeNull();
    expect(view.queryByText('Workspace account-first')).toBeNull();
  } finally {
    clerk.auth.userId = previous;
  }
});

it('clears the old Better Auth workspace when a focus check finds another account', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ user: { id: 'auth-a' } }))
      .mockResolvedValueOnce(Response.json({ id: 'account-a' }))
      .mockResolvedValueOnce(Response.json({ user: { id: 'auth-b' } })),
  );
  const view = render(<Authentication config={config('better-auth')}>{workspace}</Authentication>);
  await waitFor(() => expect(view.getByText('Workspace account-a')).toBeTruthy());
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(view.getByRole('button', { name: 'Reload Walden' })).toBeTruthy());
  expect(view.queryByText('Workspace account-a')).toBeNull();
});
it('invalidates a workspace when another tab broadcasts an auth change', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ user: { id: 'auth-a' } }))
      .mockResolvedValueOnce(Response.json({ id: 'account-a' })),
  );
  const view = render(<Authentication config={config('better-auth')}>{workspace}</Authentication>);
  await waitFor(() => expect(view.getByText('Workspace account-a')).toBeTruthy());
  fireEvent(
    window,
    new StorageEvent('storage', { key: 'walden:auth-session', newValue: 'changed' }),
  );
  await waitFor(() => expect(view.getByRole('button', { name: 'Reload Walden' })).toBeTruthy());
  expect(view.queryByText('Workspace account-a')).toBeNull();
});
