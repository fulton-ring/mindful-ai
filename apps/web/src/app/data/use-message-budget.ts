import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MessageBudget } from '@walden/contracts';
import { useEffect } from 'react';
import { api } from '../../lib/api';

const KEY = ['budget'];

/**
 * The account's message budget. Each admitted turn reports its charge, a failed
 * send refetches, and the budget refetches itself when the window resets.
 */
export function useMessageBudget() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: KEY, queryFn: api.budget, staleTime: 0 });
  const resetsAt = query.data?.resetsAt;
  useEffect(() => {
    if (!resetsAt) return;
    const timer = setTimeout(
      () => void client.invalidateQueries({ queryKey: KEY }),
      Math.max(0, Date.parse(resetsAt) - Date.now()) + 1_000,
    );
    return () => clearTimeout(timer);
  }, [client, resetsAt]);
  return {
    budget: query.data ?? null,
    /** A known budget is stored; none refetches it. Usage shows the same budget. */
    update(value?: MessageBudget) {
      if (value) client.setQueryData(KEY, value);
      else void client.invalidateQueries({ queryKey: KEY });
      void client.invalidateQueries({ queryKey: ['usage'] });
    },
  };
}
