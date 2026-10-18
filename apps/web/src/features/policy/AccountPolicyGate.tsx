import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect } from 'react';
import {
  clearAccountPolicy,
  loadAccountPolicy,
  setAccountPolicy,
  useAccountPolicySnapshot,
} from '../../lib/account-policy';

/** Wait for account-specific limits before mounting controls that can create account data. */
export function AccountPolicyGate({
  identity,
  children,
}: {
  identity: string;
  children: ReactNode;
}) {
  const query = useQuery({
    queryKey: ['account-policy', identity],
    queryFn: loadAccountPolicy,
    retry: false,
  });
  const applied = useAccountPolicySnapshot();
  useEffect(() => {
    if (query.data) setAccountPolicy(identity, query.data);
  }, [identity, query.data]);
  useEffect(() => () => clearAccountPolicy(identity), [identity]);
  const errorNotice = query.error && (
    <main className="empty-state" role="alert">
      <h1>Your account settings could not be loaded</h1>
      <p>{query.error.message}</p>
      <button onClick={() => void query.refetch()}>Try again</button>
    </main>
  );
  if (!query.data || applied.identity !== identity)
    return (
      errorNotice || (
        <main className="empty-state">
          <p>Loading your account settings…</p>
        </main>
      )
    );
  return (
    <>
      {errorNotice}
      <div className="contents" inert={Boolean(query.error)}>
        {children}
      </div>
    </>
  );
}
