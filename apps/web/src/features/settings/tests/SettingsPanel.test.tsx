// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../lib/api';
import { SettingsPanel } from '../SettingsPanel';

beforeEach(() => {
  vi.spyOn(api, 'accountPrivacy').mockResolvedValue({
    enabled: true,
    acknowledged: true,
    version: '2026-09-20',
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderSettings(onClose = vi.fn()) {
  // Mirror the app's defaults (main.tsx) so caching behaves as in production.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 20_000, retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SettingsPanel
        personas={[]}
        onEditPersona={vi.fn()}
        onCreatePersona={vi.fn()}
        onDeletePersona={vi.fn()}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { ...view, onClose };
}

describe('SettingsPanel modal', () => {
  it('uses local tabs without changing the page URL', () => {
    history.replaceState(null, '', '/conversations/thread-1');
    const view = renderSettings();

    expect(view.getByRole('dialog')).toBeTruthy();
    expect(view.getByRole('heading', { name: 'Settings' })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: /personas/i }));

    expect(view.getByRole('heading', { name: 'Personas' })).toBeTruthy();
    expect(location.pathname).toBe('/conversations/thread-1');
  });

  it('closes from the top-right control and Escape', () => {
    const first = renderSettings();
    fireEvent.click(first.getByRole('button', { name: 'Close settings' }));
    expect(first.onClose).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = renderSettings();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });
});

it('shows account controls and removes unavailable sections', () => {
  const view = renderSettings();
  expect(view.queryByRole('button', { name: /appearance|connections/i })).toBeNull();
  expect(view.getByRole('button', { name: 'Delete account' })).toBeTruthy();
  expect(view.getByRole('checkbox', { name: 'Share browser analytics' })).toBeTruthy();
  expect(view.getByRole('link', { name: 'Privacy Policy' })).toBeTruthy();
  expect(view.getByRole('link', { name: 'Terms of Service' })).toBeTruthy();
});

it('keeps unavailable connectors disabled', () => {
  const view = renderSettings();
  const connectors = view.getByRole('button', { name: 'Connectors' });
  expect(connectors.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(connectors);
  expect(view.getByRole('heading', { name: 'Account' })).toBeTruthy();
});

it('requires explicit confirmation before account deletion', () => {
  const view = renderSettings();
  fireEvent.click(view.getByRole('button', { name: 'Delete account' }));
  const confirm = view.getByRole('button', {
    name: 'Permanently delete account',
  }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.change(view.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
  expect(confirm.disabled).toBe(false);
  fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
  expect(view.queryByRole('button', { name: 'Permanently delete account' })).toBeNull();
});

it('shows usage with the remaining message limit and when it resets', async () => {
  const resetsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  vi.spyOn(api, 'usage').mockResolvedValue({
    budget: { used: 6, limit: 20, windowHours: 4, resetsAt },
    messagesSent: 4,
    favoritePersona: 'Mentor',
  });
  const view = renderSettings();
  fireEvent.click(view.getByRole('button', { name: /usage/i }));
  expect(await view.findByText('Messages sent')).toBeTruthy();
  const meter = view.getByRole('meter', { name: 'Message limit remaining' });
  expect(meter.getAttribute('aria-valuenow')).toBe('14');
  expect(meter.getAttribute('aria-valuemax')).toBe('20');
  expect(view.getByText(/^Resets at /)).toBeTruthy();
});

it('refetches usage each time the section opens', async () => {
  const usage = vi.spyOn(api, 'usage').mockResolvedValue({
    budget: { used: 1, limit: 20, windowHours: 4, resetsAt: null },
    messagesSent: 1,
    favoritePersona: null,
  });
  const view = renderSettings();
  fireEvent.click(view.getByRole('button', { name: /usage/i }));
  await view.findByText('Messages sent');
  fireEvent.click(view.getByRole('button', { name: /account/i }));
  fireEvent.click(view.getByRole('button', { name: /usage/i }));
  await waitFor(() => expect(usage).toHaveBeenCalledTimes(2));
});

it('shows a full bar and no reset time before a window opens', async () => {
  vi.spyOn(api, 'usage').mockResolvedValue({
    budget: { used: 0, limit: 20, windowHours: 4, resetsAt: null },
    messagesSent: 0,
    favoritePersona: null,
  });
  const view = renderSettings();
  fireEvent.click(view.getByRole('button', { name: /usage/i }));
  expect(
    (await view.findByRole('meter', { name: 'Message limit remaining' })).getAttribute(
      'aria-valuenow',
    ),
  ).toBe('20');
  expect(view.queryByText(/Resets at/)).toBeNull();
});

it('keeps account deletion failures visible and retryable', async () => {
  const remove = vi.spyOn(api, 'deleteAccount').mockRejectedValue(new Error('Please try again.'));
  const view = renderSettings();
  fireEvent.click(view.getByRole('button', { name: 'Delete account' }));
  fireEvent.change(view.getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
  fireEvent.click(view.getByRole('button', { name: 'Permanently delete account' }));
  expect(await view.findByRole('alert')).toHaveProperty('textContent', 'Please try again.');
  expect(remove).toHaveBeenCalledTimes(1);
  expect(
    (view.getByRole('button', { name: 'Permanently delete account' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
