import type { ReactNode } from 'react';
import { WorkspaceProvider } from './app/data/workspace-context';
import { AppRoutes } from './app/views/AppRoutes';

export function App({ authControls, identity }: { authControls?: ReactNode; identity?: string }) {
  return (
    <WorkspaceProvider identity={identity}>
      <AppRoutes authControls={authControls} />
    </WorkspaceProvider>
  );
}
