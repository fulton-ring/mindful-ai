import { ClerkProvider, SignInButton, SignUpButton, UserButton, useAuth } from '@clerk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import type { AppConfig } from '@walden/contracts';
import { type ReactNode, StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { setTokenProvider } from './lib/api';
import { identifyTelemetry, initializeTelemetry, track } from './lib/telemetry';
import { router } from './router';
import './styles/tokens.css';

const root = createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
function Workspace({
  config,
  identity,
  getToken,
  controls,
}: {
  config: AppConfig;
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
    const previous = sessionStorage.getItem('walden:identity');
    if (previous && previous !== identity) {
      for (const key of Object.keys(sessionStorage))
        if (key.startsWith('walden:draft:') || key.startsWith('walden:proposal:'))
          sessionStorage.removeItem(key);
      localStorage.removeItem('walden:last-note');
    }
    sessionStorage.setItem('walden:identity', identity);
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
        <RouterProvider router={router} context={{ config, authControls: controls, identity }} />
      </QueryClientProvider>
    </>
  );
}
function ClerkWorkspace({ config }: { config: AppConfig }) {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  useEffect(() => {
    if (isLoaded) identifyTelemetry(isSignedIn ? userId : null);
  }, [isLoaded, isSignedIn, userId]);
  if (!isLoaded)
    return (
      <main className="empty-state">
        <p>Loading sign-in…</p>
      </main>
    );
  const controls = isSignedIn ? (
    <UserButton />
  ) : (
    <div className="button-row">
      <SignInButton mode="modal">
        <button>Sign in</button>
      </SignInButton>
      <SignUpButton mode="modal">
        <button className="primary">Sign up</button>
      </SignUpButton>
    </div>
  );
  if (!isSignedIn)
    return (
      <main className="empty-state">
        <h1>Walden</h1>
        <p>Sign in to continue.</p>
        {controls}
      </main>
    );
  return (
    <Workspace
      key={userId}
      identity={userId}
      config={config}
      getToken={getToken}
      controls={controls}
    />
  );
}
async function boot() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error(`Configuration request failed (${response.status})`);
    const config = (await response.json()) as AppConfig;
    void initializeTelemetry(config.telemetry).then(() => {
      track('page_viewed', { route: location.pathname });
    });
    if (!config.authConfigured || !config.clerkPublishableKey) {
      root.render(
        <main className="empty-state">
          <h1>Walden is being set up</h1>
          <p>Sign-in is not available yet. Please check back soon.</p>
        </main>,
      );
      return;
    }
    root.render(
      <StrictMode>
        <ClerkProvider publishableKey={config.clerkPublishableKey} afterSignOutUrl="/">
          <ClerkWorkspace config={config} />
        </ClerkProvider>
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
