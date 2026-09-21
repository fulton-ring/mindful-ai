import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  useRouter,
} from '@tanstack/react-router';
import type { AppConfig } from '@walden/contracts';
import type { ReactNode } from 'react';
import { App } from './App';
import { track } from './lib/telemetry';

export type AppRouterContext = {
  config: AppConfig;
  authControls?: ReactNode;
  identity?: string;
};

function WorkspaceRoute() {
  const { config, authControls, identity } = useRouter().options.context;
  return <App config={config} authControls={authControls} identity={identity} />;
}

const rootRoute = createRootRouteWithContext<AppRouterContext>()({ component: WorkspaceRoute });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/' });
const conversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/conversations/$conversationId',
  validateSearch: (search: Record<string, unknown>) => ({
    branch: typeof search.branch === 'string' && search.branch ? search.branch : undefined,
  }),
});
const noteRoute = createRoute({ getParentRoute: () => rootRoute, path: '/notes/$noteId' });
const routeTree = rootRoute.addChildren([indexRoute, conversationRoute, noteRoute]);

export const router = createRouter({
  routeTree,
  context: { config: undefined!, authControls: undefined, identity: undefined },
});

router.subscribe('onResolved', () => {
  track('page_viewed', { route: router.state.location.pathname });
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
