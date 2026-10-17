import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import type { AppConfig } from '@walden/contracts';
import { type ReactNode, StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
// Keyframes for Streamdown's streaming word animation (`animated` in AnnotatedText).
import 'streamdown/styles.css';
import { Authentication } from './features/auth/Authentication';
import { LegalPage } from './features/legal/LegalPage';
import { beginIdentitySession } from './lib/account-identity';
import { setTokenProvider } from './lib/api';
import { setRuntimeConfig } from './lib/runtime-config';
import { isIdentityScopedDraftKey, storageKeys } from './lib/storage-keys';
import { initializeTelemetry, track } from './lib/telemetry';
import { router } from './router';
import './styles/tokens.css';

const root = createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
function Workspace({
  identity,
  getToken,
  controls,
}: {
  identity: string;
  getToken?: () => Promise<string | null>;
  controls?: ReactNode;
}) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 20_000, retry: 1 } } }),
  );
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setTokenProvider(getToken ?? null);
    const previous = sessionStorage.getItem(storageKeys.identity);
    if (previous && previous !== identity) {
      for (const key of Object.keys(sessionStorage))
        if (isIdentityScopedDraftKey(key)) sessionStorage.removeItem(key);
      localStorage.removeItem(storageKeys.lastNote);
    }
    sessionStorage.setItem(storageKeys.identity, identity);
    setReady(true);
    return () => {
      setTokenProvider(null);
      client.clear();
    };
  }, [client, getToken, identity]);
  if (!ready)
    return (
      <main className="empty-state">
        <p>Opening your workspace…</p>
      </main>
    );
  return (
    <>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} context={{ authControls: controls, identity }} />
      </QueryClientProvider>
    </>
  );
}
async function boot() {
  if (location.pathname === '/privacy' || location.pathname === '/terms') {
    root.render(<LegalPage kind={location.pathname === '/privacy' ? 'privacy' : 'terms'} />);
    return;
  }
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error(`Configuration request failed (${response.status})`);
    const config = (await response.json()) as AppConfig;
    beginIdentitySession();
    setRuntimeConfig(config);
    void initializeTelemetry(config.telemetry).then(() => {
      track('page_viewed', { route: location.pathname });
    });
    root.render(
      <StrictMode>
        <Authentication config={config}>
          {(access) => <Workspace key={access.identity} {...access} />}
        </Authentication>
      </StrictMode>,
    );
  } catch (cause) {
    root.render(
      <main className="empty-state" role="alert">
        <h1>Walden could not start</h1>
        <p>{cause instanceof Error ? cause.message : 'Configuration is unavailable.'}</p>
        <button onClick={() => location.reload()}>Try again</button>
      </main>,
    );
  }
}
void boot();
