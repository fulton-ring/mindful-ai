// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { MessageBudget } from '@walden/contracts';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../../lib/api';
import { useMessageBudget } from '../use-message-budget';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('refetches the budget when the window resets, without a page reload', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const resetsAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const spent: MessageBudget = { used: 20, limit: 20, windowHours: 4, resetsAt };
  const fresh: MessageBudget = { used: 0, limit: 20, windowHours: 4, resetsAt: null };
  const budget = vi.spyOn(api, 'budget').mockResolvedValueOnce(spent).mockResolvedValue(fresh);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useMessageBudget(), { wrapper });
  await vi.waitFor(() => expect(result.current.budget).toEqual(spent));

  await act(() => vi.advanceTimersByTimeAsync(60 * 60_000 + 1_500));
  await vi.waitFor(() => expect(result.current.budget).toEqual(fresh));
  expect(budget).toHaveBeenCalledTimes(2);
});
