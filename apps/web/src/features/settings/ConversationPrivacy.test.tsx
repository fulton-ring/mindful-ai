// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { ConversationPrivacy } from './ConversationPrivacy';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('starts enabled and lets users decline before any acknowledgement is stored', async () => {
  vi.spyOn(api, 'accountPrivacy').mockResolvedValue({
    enabled: true,
    acknowledged: false,
    version: 'v',
  });
  const save = vi
    .spyOn(api, 'setAccountPrivacy')
    .mockResolvedValue({ enabled: false, acknowledged: true, version: 'v' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ConversationPrivacy notice />
    </QueryClientProvider>,
  );
  const checkbox = await view.findByRole('checkbox', { name: 'Help improve Walden' });
  expect((checkbox as HTMLInputElement).checked).toBe(true);
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(checkbox);
  fireEvent.click(view.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(false, 'v'));
  await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
});
it('keeps a failed save visible without pretending the preference changed', async () => {
  vi.spyOn(api, 'accountPrivacy').mockResolvedValue({
    enabled: true,
    acknowledged: true,
    version: 'v',
  });
  vi.spyOn(api, 'setAccountPrivacy').mockRejectedValue(new Error('offline'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ConversationPrivacy />
    </QueryClientProvider>,
  );
  const checkbox = await view.findByRole('checkbox', { name: 'Help improve Walden' });
  await waitFor(() => expect((checkbox as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(checkbox);
  await view.findByRole('alert');
  expect((checkbox as HTMLInputElement).checked).toBe(true);
});
