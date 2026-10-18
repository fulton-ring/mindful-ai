// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { DEFAULT_APP_POLICY } from '@walden/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { accountPolicy, clearAccountPolicy } from '../../../lib/account-policy';
import { AccountPolicyGate } from '../AccountPolicyGate';

afterEach(() => {
  cleanup();
  clearAccountPolicy();
  vi.unstubAllGlobals();
});
it('waits for the authenticated policy, applies it, and resets it after leaving the account', async () => {
  const value = {
    planId: 'unlimited',
    policy: { ...DEFAULT_APP_POLICY, messages: { limit: null, windowHours: 4 } },
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(value)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <AccountPolicyGate identity="alice">
        <p>Private workspace</p>
      </AccountPolicyGate>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(view.getByText('Private workspace')).toBeTruthy());
  expect(accountPolicy()).toEqual({ identity: 'alice', value });
  view.unmount();
  expect(accountPolicy().identity).toBeNull();
});
it('blocks policy-dependent actions on policy failures and lets the account retry', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValue(Response.json({ planId: 'default', policy: DEFAULT_APP_POLICY }));
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <AccountPolicyGate identity="alice">
        <p>Private workspace</p>
      </AccountPolicyGate>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(view.getByRole('alert')).toBeTruthy());
  expect(view.queryByText('Private workspace')).toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(view.getByText('Private workspace')).toBeTruthy());
});

it('updates policy in place without discarding drafts when the account plan changes', async () => {
  const { useState } = await import('react');
  const { act } = await import('@testing-library/react');
  function Draft() {
    const [value, setValue] = useState('');
    return (
      <input
        aria-label="Unsaved draft"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    );
  }
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ planId: 'default', policy: DEFAULT_APP_POLICY })),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <AccountPolicyGate identity="alice">
        <Draft />
      </AccountPolicyGate>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(view.getByLabelText('Unsaved draft')).toBeTruthy());
  fireEvent.change(view.getByLabelText('Unsaved draft'), { target: { value: 'Keep my draft' } });
  await act(async () => {
    client.setQueryData(['account-policy', 'alice'], {
      planId: 'unlimited',
      policy: { ...DEFAULT_APP_POLICY, uploads: { maxBytes: null, maxFiles: null } },
    });
  });
  await waitFor(() => expect(accountPolicy().value.planId).toBe('unlimited'));
  expect((view.getByLabelText('Unsaved draft') as HTMLInputElement).value).toBe('Keep my draft');
});

it('keeps drafts mounted but inert during a failed policy refresh and preserves them after retry', async () => {
  const { useState } = await import('react');
  const { act } = await import('@testing-library/react');
  function Draft() {
    const [value, setValue] = useState('');
    return (
      <input
        aria-label="Unsaved draft"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    );
  }
  const value = { planId: 'default', policy: DEFAULT_APP_POLICY };
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(value))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValue(Response.json(value)),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <AccountPolicyGate identity="alice">
        <Draft />
      </AccountPolicyGate>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(view.getByLabelText('Unsaved draft')).toBeTruthy());
  fireEvent.change(view.getByLabelText('Unsaved draft'), { target: { value: 'Keep my draft' } });
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['account-policy', 'alice'] });
  });
  await waitFor(() => expect(view.getByRole('alert')).toBeTruthy());
  expect((view.getByLabelText('Unsaved draft') as HTMLInputElement).value).toBe('Keep my draft');
  expect(view.getByLabelText('Unsaved draft').closest('[inert]')).toBeTruthy();
  fireEvent.click(view.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(view.queryByRole('alert')).toBeNull());
  expect((view.getByLabelText('Unsaved draft') as HTMLInputElement).value).toBe('Keep my draft');
  expect(view.getByLabelText('Unsaved draft').closest('[inert]')).toBeNull();
});
